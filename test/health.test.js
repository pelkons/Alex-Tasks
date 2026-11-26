'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs'); const http = require('http');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-health-'));
process.env.MESIMOT_FILES = path.join(TMP, 'files'); process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(TMP, 'k'); process.env.MESIMOT_NO_OUTBOX_KEY = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');
const { createStore } = require('../lib/store');
const { createHealth } = require('../lib/health');

function setup(over = {}) {
  const db = open(':memory:'); const store = createStore(db); const told = []; const calls = []; const state = { down: new Set(), quiet: false, smoke: { ok: true, facts: { rows: 12, chat_bubbles: 5 }, problems: [] }, now: Date.parse('2026-12-02T10:00:00Z'), mail: true, tg: true };
  const bdir = path.join(TMP, 'backups'); fs.mkdirSync(bdir, { recursive: true }); fs.writeFileSync(path.join(bdir, 'mesimot-2026-12-02.db.gz'), 'x'); fs.utimesSync(path.join(bdir, 'mesimot-2026-12-02.db.gz'), new Date(state.now - 3600000), new Date(state.now - 3600000));
  for (const k of ['mail_poll', 'telegram_poll', 'loop']) db.prepare('INSERT INTO heartbeat (key, at) VALUES (?,?)').run(k, new Date(state.now - 60000).toISOString());
  const h = createHealth(db, store, {
    nowMs: () => state.now, localUrl: 'http://x', password: 'pw', apiToken: 't', backupDir: bdir, dbFile: path.join(TMP, 'none.db'),
    systemctl: (a) => { calls.push(a.join(' ')); const u = a[a.length - 1].replace(/\.(timer|service)$/, ''); if (a[0] === 'is-active') return { code: 0, stdout: state.down.has(u) ? 'inactive' : 'active' }; if (a[0] === 'show') return { code: 0, stdout: 'success' }; return { code: 0, stdout: '' }; },
    fetch: async (url) => { if (/getMe/.test(url)) return { ok: true, json: async () => ({ ok: state.tg }) }; return { ok: true, status: 200, json: async () => (/tasks/.test(url) ? [{ id: 1 }] : /chat/.test(url) ? [{}] : {}) }; },
    smoke: async () => state.smoke, mailPing: async () => { if (!state.mail) throw new Error('refused'); }, tgToken: 'T', tgBase: 'http://tg', chrome: 'x',
    isQuiet: () => state.quiet, tell: async (t) => { told.push(t); return 'telegram' }, ...over });
  return { db, store, h, state, told, calls };
}
const by = (r, id) => r.results.find((x) => x.id === id);

test('everything healthy: all green, summary says so, nothing is alerted', async () => {
  const s = setup(); const r = await s.h.run();
  assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.equal(s.told.length, 0); assert.equal(s.h.summary(), 'כל המערכות תקינות');
  assert.ok(by(r, 'ui:local') && by(r, 'api:tasks') && by(r, 'svc:mesimot') && by(r, 'timer:mesimot-health') && by(r, 'data:backup'));
  assert.ok(s.h.status().length >= 20);
});

test('a blank or broken page is RED and CRITICAL, alerted once at any hour, again only after 6 h, with one recovery notice', async () => {
  const s = setup(); s.state.quiet = true; s.state.smoke = { ok: false, facts: {}, problems: ['רשימת המשימות ריקה במסך (0 שורות) אף ש-/api/tasks מחזיר 179'] };
  let r = await s.h.run(); assert.equal(by(r, 'ui:local').status, 'red'); assert.equal(r.ok, false);
  assert.equal(s.told.length >= 1 && s.told.filter((t) => /ממשק: האתר \(מקומי\)/.test(t)).length, 1, 'critical alerts even in quiet hours');
  s.state.now += 15 * 60000; await s.h.run(); assert.equal(s.told.filter((t) => /ממשק: האתר \(מקומי\)/.test(t)).length, 1, 'no repeat');
  s.state.now += 6 * 3600000; await s.h.run(); assert.equal(s.told.filter((t) => /ממשק: האתר \(מקומי\)/.test(t) && /עדיין תקלה/.test(t)).length, 1, 'a reminder after 6 hours');
  s.state.smoke = { ok: true, facts: { rows: 3, chat_bubbles: 1 }, problems: [] }; s.state.quiet = false; await s.h.run();
  assert.equal(s.told.filter((t) => /חזר לפעול: ממשק: האתר \(מקומי\)/.test(t)).length, 1); await s.h.run(); assert.equal(s.told.filter((t) => /חזר לפעול: ממשק: האתר \(מקומי\)/.test(t)).length, 1, 'one recovery notice');
});

test('quiet hours hold back NON-critical issues until they end', async () => {
  const s = setup(); s.state.quiet = true; s.state.tg = false;
  await s.h.run(); assert.equal(s.told.filter((t) => /טלגרם/.test(t)).length, 0);
  s.state.quiet = false; s.state.now += 15 * 60000; await s.h.run(); assert.equal(s.told.filter((t) => /טלגרם/.test(t)).length, 1);
});

test('a dead service is restarted ONCE and reported; a failed timer service is a warning', async () => {
  const s = setup(); s.state.down.add('mesimot-tunnel');
  const r = await s.h.run(); assert.equal(by(r, 'svc:mesimot-tunnel').status, 'red'); assert.match(by(r, 'svc:mesimot-tunnel').message, /הופעל מחדש עכשיו/);
  assert.equal(s.calls.filter((c) => c === 'restart mesimot-tunnel').length, 1);
  s.state.now += 15 * 60000; const r2 = await s.h.run(); assert.equal(s.calls.filter((c) => c === 'restart mesimot-tunnel').length, 1, 'not restarted again within 30 minutes'); assert.match(by(r2, 'svc:mesimot-tunnel').message, /עדיין לא עובד/);
});

test('pipeline: error rate above 20% in the last hour, a stuck run, an import queue that stopped', async () => {
  const s = setup(); const t = (ms) => new Date(s.state.now - ms).toISOString();
  for (let i = 0; i < 10; i++) s.db.prepare("INSERT INTO claude_runs (started_at, finished_at, trigger, events_count, error) VALUES (?,?,?,?,?)").run(t(20 * 60000), t(19 * 60000), 'chat', 1, i < 4 ? 'spawn failed' : null);
  s.db.prepare("INSERT INTO claude_runs (started_at, trigger, events_count) VALUES (?,?,?)").run(t(40 * 60000), 'chat', 1);
  const imp = s.db.prepare("INSERT INTO imports (created_at, file_count, status, stats, file_ids, text) VALUES (?,?,?,?,?,?)").run(t(3 * 3600000), 1, 'processing', '{}', '[]', 'x').lastInsertRowid;
  s.db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, import_id, import_state, processed_at) VALUES ('p1','a@b','s',?, 'b', ?, 'relevant', ?)").run(t(3 * 3600000), imp, t(2 * 3600000));
  const r = await s.h.run(); assert.equal(by(r, 'pipe:errors').status, 'red'); assert.match(by(r, 'pipe:errors').message, /40%/); assert.equal(by(r, 'pipe:stuck').status, 'red'); assert.equal(by(r, 'pipe:import').status, 'red');
  s.db.prepare("INSERT INTO settings (key,value) VALUES ('rate_limit_until',?)").run(new Date(s.state.now + 3600000).toISOString());
  assert.equal(by(await s.h.run(), 'pipe:import').status, 'ok', 'a rate-limit pause is not a stalled queue');
});

test('mail, Telegram, outbox: IMAP down, getMe failing, an approved mail not claimed for 10 min, a claimed one without a result', async () => {
  const s = setup(); s.state.mail = false; s.state.tg = false;
  const mk = (st, col, ageMs) => s.db.prepare(`INSERT INTO outbox (kind, status, content_hash, ${col}, created_at, updated_at) VALUES ('new',?, 'h', ?, ?, ?)`).run(st, new Date(s.state.now - ageMs).toISOString(), new Date().toISOString(), new Date().toISOString());
  mk('approved', 'approved_at', 12 * 60000);
  let r = await s.h.run(); assert.equal(by(r, 'mail:login').status, 'red'); assert.equal(by(r, 'tg').status, 'red'); assert.equal(by(r, 'outbox').status, 'warn');
  mk('sending', 'claimed_at', 11 * 60000); r = await s.h.run(); assert.equal(by(r, 'outbox').status, 'red');
});

test('ingest: silence in work hours is red but NOT alerted by the health check (the watchdog owns that alert)', async () => {
  const s = setup(); s.db.prepare("INSERT INTO settings (key,value) VALUES ('ingest_last_contact',?)").run(new Date(s.state.now - 3 * 3600000).toISOString()); // Wednesday 10:00 Jerusalem
  const r = await s.h.run(); assert.equal(by(r, 'ingest').status, 'red'); assert.equal(s.told.filter((t) => /Outlook/.test(t)).length, 0);
});

test('data: an old backup, a failed integrity check and a jump of open attention items are reported', async () => {
  const s = setup(); const old = path.join(TMP, 'backups', 'mesimot-2026-11-30.db.gz'); fs.writeFileSync(old, 'x');
  for (const f of fs.readdirSync(path.join(TMP, 'backups'))) fs.utimesSync(path.join(TMP, 'backups', f), new Date(s.state.now - 40 * 3600000), new Date(s.state.now - 40 * 3600000));
  let r = await s.h.run(); assert.equal(by(r, 'data:backup').status, 'red'); assert.equal(by(r, 'data:integrity').status, 'ok');
  s.db.prepare("INSERT INTO settings (key,value) VALUES ('health_quickcheck_res','row 5 missing from index')  ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  assert.equal(by(await s.h.run(), 'data:integrity').status, 'red');
  s.state.now += 60 * 60000; for (let i = 0; i < 35; i++) s.db.prepare("INSERT INTO attention (kind, text, created_at) VALUES ('question',?,?)").run('שאלה ' + i, new Date().toISOString());
  r = await s.h.run(); assert.equal(by(r, 'anom:attention').status, 'warn'); assert.match(by(r, 'anom:attention').message, /קפצו ב-35/);
});

test('quick mode (the post-deploy gate): only UI and APIs; fails on a critical red, not on the mirror alone', async () => {
  const s = setup(); let n = 0; s.h = createHealth(s.db, s.store, { nowMs: () => s.state.now, localUrl: 'http://x', password: 'pw', apiToken: 't', chrome: 'x', fetch: async (u) => ({ ok: true, status: 200, json: async () => (/tasks/.test(u) ? [{ id: 1 }] : []) }), tell: async () => {},
    smoke: async ({ url }) => (++n && /workers|mirror/.test(url) ? { ok: false, problems: ['x'], facts: {} } : { ok: true, problems: [], facts: { rows: 2, chat_bubbles: 1 } }) });
  require('../lib/config').get().public_url = 'https://tasks.example'; require('../lib/config').get().mirror_url = 'https://mirror.workers.example';
  const r = await s.h.run({ quick: true }); assert.deepEqual(r.results.map((x) => x.id).filter((x) => x.startsWith('svc') || x.startsWith('pipe')), []); assert.equal(by(r, 'ui:mirror').status, 'red'); assert.equal(r.ok, true, 'a red mirror does not fail the gate');
  s.h = createHealth(s.db, s.store, { nowMs: () => s.state.now, localUrl: 'http://x', password: 'pw', apiToken: 't', chrome: 'x', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), tell: async () => {}, smoke: async () => ({ ok: false, problems: ['blank'], facts: {} }) });
  assert.equal((await s.h.run({ quick: true })).ok, false);
});

const chrome = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null;
test('the REAL smoke test: healthy app passes; the same app with a broken script (blank list) is caught', { skip: !chrome && 'no Chrome here', timeout: 120000 }, async () => {
  const { smoke } = require('../lib/uismoke');
  const db = open(':memory:'); auth.setPassword(db, 'correct horse battery'); auth.resetFailures(); const app = build({ db, token: 'tok', loginDelayMs: 0 }); await app.ready();
  const store = createStore(db); for (let i = 0; i < 7; i++) store.createTask(store.ownerId(), { title: `משימה ${i}`, requester: store.ownerId() });
  const proxy = (patch) => new Promise((resolve) => { const srv = http.createServer(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); const r = await app.inject({ method: req.method, url: req.url, headers: { ...req.headers, host: '127.0.0.1' }, payload: Buffer.concat(chunks) }); let body = r.rawPayload; if (patch && req.url.startsWith('/assets/app.js')) body = Buffer.from(String(r.payload).replace('async init() {', 'async init() { throw new Error("boom");')); const h = { ...r.headers }; delete h['content-length']; delete h['content-encoding']; res.writeHead(r.statusCode, h); res.end(body); }).listen(0, '127.0.0.1', () => resolve(srv)); });
  const good = await proxy(false); const okr = await smoke({ url: `http://127.0.0.1:${good.address().port}`, password: 'correct horse battery', chrome }); good.close();
  assert.equal(okr.ok, true, JSON.stringify(okr)); assert.equal(okr.facts.rows, 7);
  const bad = await proxy(true); const badr = await smoke({ url: `http://127.0.0.1:${bad.address().port}`, password: 'correct horse battery', chrome, rowsTimeoutMs: 4000 }); bad.close();
  assert.equal(badr.ok, false); assert.ok(badr.problems.some((p) => /ריקה|שגיאות JavaScript/.test(p)), JSON.stringify(badr.problems));
});
