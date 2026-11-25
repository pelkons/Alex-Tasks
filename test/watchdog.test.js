'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createWatchdog } = require('../lib/watchdog');
const hb = require('../lib/heartbeat');

const T0 = Date.parse('2026-11-25T11:00:00+02:00');
const MIN = 60000;
function setup({ token = 'TOKEN', telegramFails = false } = {}) {
  const db = open(':memory:');
  const store = createStore(db);
  db.prepare("INSERT INTO settings (key,value) VALUES ('telegram_chat_id','42')").run();
  const calls = [], tg = [], mail = [], killed = [];
  const down = new Set(); // services that stay inactive
  const systemctl = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'is-active') return { code: down.has(args[1]) ? 3 : 0, stdout: down.has(args[1]) ? 'failed' : 'active' };
    return { code: 0, stdout: '' };
  };
  const web = { local: 200, pub: 200 };
  const fetch = async (url) => ({ status: url.startsWith('http://127') ? web.local : web.pub });
  const wd = createWatchdog(db, store, {
    systemctl, fetch, localUrl: 'http://127.0.0.1:8110', publicUrl: 'https://tasks.example', token,
    sendTelegram: async (t) => { if (telegramFails) throw new Error('telegram down'); tg.push(t); },
    sendEmailText: async (t) => { mail.push(t); },
    killChildren: () => { killed.push(1); return 1; },
    isQuiet: () => false,
  });
  const beat = (key, at) => db.prepare('INSERT INTO heartbeat (key, at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at').run(key, new Date(at).toISOString());
  const beatAll = (at) => { for (const k of ['runner_start', 'loop', 'mail_poll', 'telegram_poll']) beat(k, at); };
  const restarts = () => calls.filter((c) => c.startsWith('restart'));
  return { db, wd, calls, tg, mail, killed, down, web, beat, beatAll, restarts };
}
const failing = (r) => r.components.filter((c) => !c.ok).map((c) => c.id);

test('everything fresh: all components are green and nothing is done', async () => {
  const s = setup(); s.beatAll(T0 - MIN);
  const r = await s.wd.run(T0);
  assert.deepEqual(failing(r), []);
  assert.equal(r.actions.length, 0);
  assert.equal(s.restarts().length, 0);
});

test('a stale heartbeat restarts the runner once, then the owner is told at the next check, and not restarted again', async () => {
  const s = setup();
  s.beatAll(T0 - 20 * MIN); // loop, mail and telegram all stale
  let r = await s.wd.run(T0);
  assert.deepEqual(failing(r).sort(), ['loop', 'mail', 'telegram']);
  assert.deepEqual(s.restarts(), ['restart mesimot-runner'], 'one restart, only of the affected service');
  assert.equal(s.tg.length + s.mail.length, 0, 'no alert yet');
  // still stale five minutes later (the restart did not help)
  r = await s.wd.run(T0 + 5 * MIN);
  assert.equal(s.restarts().length, 1, 'no second restart');
  assert.equal(s.mail.length, 1, 'telegram is one of the problems, so the alert goes by email');
  assert.match(s.mail[0], /הרצה ודואר/);
  assert.equal(s.tg.length, 0);
  // another check an hour later: at most one alert per 2 hours
  await s.wd.run(T0 + 65 * MIN);
  assert.equal(s.mail.length, 1);
  await s.wd.run(T0 + 130 * MIN);
  assert.equal(s.mail.length, 2, 'after 2 hours the next alert is allowed');
  assert.equal(s.restarts().length, 1);
});

test('recovery: the issue clears and a single recovery notice is sent', async () => {
  const s = setup(); s.beatAll(T0 - 20 * MIN);
  await s.wd.run(T0); await s.wd.run(T0 + 5 * MIN);
  assert.equal(s.mail.length, 1);
  s.beatAll(T0 + 9 * MIN);
  const r = await s.wd.run(T0 + 10 * MIN);
  assert.deepEqual(failing(r), []);
  assert.equal(s.tg.length, 1);
  assert.match(s.tg[0], /חזר לפעול/);
  await s.wd.run(T0 + 15 * MIN);
  assert.equal(s.tg.length, 1, 'only once');
});

test('a failure that fixes itself after the restart sends nothing at all', async () => {
  const s = setup(); s.beatAll(T0 - 20 * MIN);
  await s.wd.run(T0);
  s.beatAll(T0 + 4.5 * MIN);
  await s.wd.run(T0 + 5 * MIN);
  assert.equal(s.tg.length + s.mail.length, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM watchdog_state').get().c, 0);
});

test('an inactive service and a dead site: the right services are restarted, the alert goes by Telegram', async () => {
  const s = setup(); s.beatAll(T0 - MIN);
  s.down.add('mesimot-tunnel'); s.web.pub = 502;
  let r = await s.wd.run(T0);
  assert.deepEqual(failing(r).sort(), ['public', 'svc:mesimot-tunnel']);
  assert.deepEqual(s.restarts(), ['restart mesimot-tunnel'], 'the public URL fails while the site answers locally: the tunnel is the culprit');
  s.beatAll(T0 + 4 * MIN);
  await s.wd.run(T0 + 5 * MIN);
  assert.equal(s.restarts().length, 1);
  assert.equal(s.tg.length, 1);
  assert.match(s.tg[0], /גישה מבחוץ/);
  assert.equal(s.mail.length, 0);
  // the public URL may answer 302 (login redirect)
  s.down.clear(); s.web.pub = 302; s.beatAll(T0 + 9 * MIN);
  r = await s.wd.run(T0 + 10 * MIN);
  assert.deepEqual(failing(r), []);
});

test('the local site not answering restarts the site service', async () => {
  const s = setup(); s.beatAll(T0 - MIN);
  s.web.local = 500;
  await s.wd.run(T0);
  assert.deepEqual(s.restarts(), ['restart mesimot']);
});

test('when Telegram cannot be reached the alert falls back to email; no telegram check without a token', async () => {
  const s = setup({ telegramFails: true }); s.beatAll(T0 - MIN);
  s.down.add('mesimot');
  await s.wd.run(T0); await s.wd.run(T0 + 5 * MIN);
  assert.equal(s.mail.length, 1);
  const n = setup({ token: '' }); n.beatAll(T0 - MIN); n.db.prepare("DELETE FROM heartbeat WHERE key='telegram_poll'").run();
  const r = await n.wd.run(T0);
  assert.ok(!r.components.some((c) => c.id === 'telegram'));
  assert.deepEqual(failing(r), []);
});

test('a claude run stuck for more than 15 minutes is killed and marked interrupted; a recent one is left alone', async () => {
  const s = setup(); s.beatAll(T0 - MIN);
  const old = s.db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'chat')").run(new Date(T0 - 20 * MIN).toISOString()).lastInsertRowid;
  const recent = s.db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'batch')").run(new Date(T0 - 5 * MIN).toISOString()).lastInsertRowid;
  const r = await s.wd.run(T0);
  assert.equal(s.killed.length, 1);
  assert.equal(s.db.prepare('SELECT error FROM claude_runs WHERE id=?').get(old).error, 'interrupted');
  assert.ok(s.db.prepare('SELECT finished_at FROM claude_runs WHERE id=?').get(old).finished_at);
  assert.equal(s.db.prepare('SELECT finished_at FROM claude_runs WHERE id=?').get(recent).finished_at, null);
  assert.deepEqual(r.actions.map((a) => a.stuck_run), [old]);
});

test('quiet hours hold an alert back until the quiet time ends', async () => {
  const s = setup();
  let quiet = true;
  const wd = require('../lib/watchdog').createWatchdog(s.db, createStore(s.db), { systemctl: () => ({ code: 0, stdout: 'active' }), fetch: async () => ({ status: 200 }), localUrl: 'http://x', publicUrl: '', token: '', sendEmailText: async (t) => s.mail.push(t), sendTelegram: async (t) => s.tg.push(t), isQuiet: () => quiet });
  s.beatAll(T0 - 20 * MIN);
  await wd.run(T0); await wd.run(T0 + 5 * MIN);
  assert.equal(s.mail.length + s.tg.length, 0);
  quiet = false;
  await wd.run(T0 + 10 * MIN);
  assert.equal(s.mail.length + s.tg.length, 1);
});

test('the settings status card endpoint answers with a green/red state per component', async () => {
  process.env.MESIMOT_NO_SYSTEMD = '1'; process.env.MESIMOT_PUBLIC_URL = '';
  const auth = require('../lib/auth');
  const { build } = require('../lib/server');
  const db = open(':memory:');
  auth.setPassword(db, 'correct horse battery'); auth.resetFailures();
  const app = build({ db, token: 't', loginDelayMs: 0 });
  const r0 = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct horse battery' } });
  const web = { cookie: `mesimot_session=${r0.cookies[0].value}`, 'x-mesimot': '1' };
  hb.beat(db, 'loop'); hb.beat(db, 'mail_poll');
  const h = (await app.inject({ method: 'GET', url: '/api/health', headers: web })).json();
  const byId = Object.fromEntries(h.components.map((c) => [c.id, c.ok]));
  assert.equal(byId.loop, true); assert.equal(byId.mail, true); assert.equal(byId.claude, true);
  assert.ok('site' in byId);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 401);
});

test('the local Telegram Bot API server is watched only once the bot uses it; a dead one is restarted', async () => {
  const s = setup(); s.beatAll(T0 - MIN);
  let r = await s.wd.run(T0);
  assert.ok(!r.components.some((c) => c.id === 'botapi'), 'not configured: not watched');
  const db = s.db;
  const calls = [];
  const wd = require('../lib/watchdog').createWatchdog(db, createStore(db), {
    systemctl: (a) => { calls.push(a.join(' ')); return a[0] === 'is-active' ? { code: a[1] === 'mesimot-botapi' ? 3 : 0, stdout: a[1] === 'mesimot-botapi' ? 'failed' : 'active' } : { code: 0, stdout: '' }; },
    fetch: async (url) => { if (url.startsWith('http://127.0.0.1:8081')) throw new Error('refused'); return { status: 200 }; },
    noSystemd: false, localUrl: 'http://127.0.0.1:8110', publicUrl: '', token: '', botapiBase: 'http://127.0.0.1:8081', isQuiet: () => false, sendTelegram: async () => {}, sendEmailText: async () => {},
  });
  r = await wd.run(T0);
  assert.deepEqual(r.components.filter((c) => !c.ok).map((c) => c.id).sort(), ['botapi', 'svc:mesimot-botapi']);
  assert.deepEqual(calls.filter((c) => c.startsWith('restart')), ['restart mesimot-botapi']);
});

test('Proton Bridge: watched only with the imap provider; a failing IMAP login restarts the Bridge (not the runner) and stale mail follows it', async () => {
  const s = setup(); s.beatAll(T0 - MIN);
  s.db.prepare("UPDATE heartbeat SET at=? WHERE key='mail_poll'").run(new Date(T0 - 20 * MIN).toISOString());
  const calls = [];
  const mk = (imap, ping) => require('../lib/watchdog').createWatchdog(s.db, createStore(s.db), {
    systemctl: (a) => { calls.push(a.join(' ')); return a[0] === 'is-active' ? { code: 0, stdout: 'active' } : { code: 0, stdout: '' }; },
    fetch: async () => ({ status: 200 }), noSystemd: false, localUrl: 'http://127.0.0.1:8110', publicUrl: '', token: '', imap, mailPing: ping, isQuiet: () => false, sendTelegram: async () => {}, sendEmailText: async () => {},
  });
  let r = await mk(false).run(T0);
  assert.ok(!r.components.some((c) => c.id === 'bridge_login'), 'not watched with agentmail');
  calls.length = 0; s.db.prepare('DELETE FROM watchdog_state').run();
  r = await mk(true, async () => { throw new Error('login refused'); }).run(T0);
  assert.ok(r.components.find((c) => c.id === 'bridge_login' && !c.ok));
  assert.deepEqual(calls.filter((c) => c.startsWith('restart')), ['restart proton-bridge'], 'the Bridge is restarted, not the runner');
});
