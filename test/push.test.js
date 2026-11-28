'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open, now } = require('../lib/db');
const auth = require('../lib/auth');
const { createStore } = require('../lib/store');
const { createNotify } = require('../lib/notify');
const P = require('../lib/push');

// a fake push service: records what would leave the server; `fail` maps an endpoint to an HTTP status
function setup({ fail = {} } = {}) {
  const db = open(':memory:');
  const store = createStore(db);
  const notify = createNotify(db, store, { sendEmail: async () => {} });
  const sent = [];
  const sender = async (sub, body, opts) => {
    const code = typeof fail[sub.endpoint] === 'function' ? fail[sub.endpoint]() : fail[sub.endpoint];
    if (code) { const e = new Error('push service said ' + code); e.statusCode = code; e.body = 'x'; throw e; }
    sent.push({ endpoint: sub.endpoint, body: JSON.parse(body), raw: body, opts });
    return { statusCode: 201 };
  };
  const push = P.createPush(db, { notify, sender, keys: { publicKey: 'BPub', privateKey: 'priv' }, siteUrl: 'https://tasks.example' });
  return { db, store, notify, push, sent };
}
const SUB = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}-abcdefghijkl`, keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'a'.repeat(22) } });
const DAY = Date.parse('2026-11-25T10:00:00+02:00'); // Wednesday 10:00, not quiet
const NIGHT = Date.parse('2026-11-25T23:30:00+02:00');
const SHABBAT = Date.parse('2026-11-28T12:00:00+02:00');

test('subscriptions: add, update keys idempotently, status per device, remove; bad input is refused', () => {
  const { push, db } = setup();
  const s = push.subscribe(SUB(1), 'Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/131 Mobile');
  assert.equal(s.subscribed, true); assert.equal(s.devices, 1); assert.equal(s.device.label, 'Chrome · Android');
  push.subscribe({ ...SUB(1), keys: { p256dh: 'C' + 'y'.repeat(86), auth: 'b'.repeat(22) } }, 'x');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 1, 'same endpoint: one row');
  assert.equal(db.prepare('SELECT auth FROM push_subscriptions').get().auth, 'b'.repeat(22));
  push.subscribe(SUB(2), 'iPhone Safari/605');
  assert.equal(push.status().devices, 2);
  assert.equal(push.status(SUB(2).endpoint).subscribed, true);
  assert.equal(push.status('https://other.example/zzzzzzzzzzzz').subscribed, false);
  assert.deepEqual(push.unsubscribe(SUB(1).endpoint), { removed: 1 });
  assert.equal(push.status().devices, 1);
  assert.throws(() => push.subscribe({ endpoint: 'http://insecure.example/abcdefghijk', keys: SUB(3).keys }), /bad endpoint/);
  assert.throws(() => push.subscribe({ endpoint: SUB(3).endpoint, keys: { p256dh: 'short', auth: '' } }), /bad keys/);
  assert.equal(push.status().categories.length, 6);
});

test('payload: short Hebrew title, one line, a path on this site only; a long private text never leaves the server', async () => {
  const { push, sent } = setup();
  push.subscribe(SUB(1));
  const body = 'שורה ראשונה\nשורה שנייה עם פרטים פרטיים מאוד '.repeat(40);
  push.enqueue({ cat: 'mail', title: 'מייל חשוב מאוד מאוד מאוד '.repeat(5), body, url: 'https://evil.example/steal?x=1', tag: 'task:5' }, DAY);
  const r = await push.deliver(DAY);
  assert.equal(r.sent, 1);
  const p = sent[0].body;
  assert.deepEqual(Object.keys(p).sort(), ['b', 'c', 'g', 't', 'u']);
  assert.ok([...p.t].length <= P.TITLE_MAX); assert.ok([...p.b].length <= P.BODY_MAX);
  assert.ok(!/\n/.test(p.b), 'one line');
  assert.equal(p.u, '/steal?x=1', 'never another host');
  assert.ok(Buffer.byteLength(sent[0].raw) < 600, 'the whole payload is small');
  assert.equal(sent[0].opts.urgency, 'high');
  assert.ok(sent[0].opts.TTL > 0 && sent[0].opts.TTL <= 12 * 3600);
  assert.match(sent[0].opts.topic, /^[\w-]{1,32}$/);
  assert.equal(P.safeUrl('//evil.example/x'), '/');
  assert.equal(P.safeUrl('/task/12'), '/task/12');
  assert.equal(P.safeUrl('javascript:alert(1)'), '/');
});

test('categories: a switched-off category is neither queued nor sent; defaults: chat replies off, the rest on', async () => {
  const { push, sent, db } = setup();
  push.subscribe(SUB(1));
  assert.deepEqual(push.settings(), { reminders: true, attention: true, waiting: true, reply: false, system: true, mail: true });
  assert.equal(push.enqueue({ cat: 'reply', title: 'תשובה', url: '/chat' }, DAY), null);
  push.saveSettings({ mail: false });
  assert.equal(push.enqueue({ cat: 'mail', title: 'x' }, DAY), null);
  const id = push.enqueue({ cat: 'reminders', title: 'תזכורת', tag: 'daily' }, DAY);
  push.saveSettings({ reminders: false }); // switched off after it was queued: dropped at delivery
  await push.deliver(DAY);
  assert.equal(sent.length, 0);
  assert.equal(db.prepare('SELECT dropped FROM push_queue WHERE id=?').get(id).dropped, 'off');
  assert.throws(() => push.enqueue({ cat: 'nope', title: 'x' }), /unknown/);
});

test('quiet hours and Shabbat hold an item until they end; system alerts (the caller decided) and answers go out', async () => {
  const { push, sent } = setup();
  push.subscribe(SUB(1));
  push.enqueue({ cat: 'reminders', title: 'תזכורת', tag: 'daily' }, NIGHT);
  push.enqueue({ cat: 'system', title: 'תקלה', tag: 'system', bypassQuiet: true }, NIGHT);
  let r = await push.deliver(NIGHT);
  assert.equal(r.sent, 1); assert.equal(r.held, 1); assert.equal(sent[0].body.c, 'system');
  r = await push.deliver(Date.parse('2026-11-26T07:05:00+02:00')); // the next morning, within the TTL
  assert.equal(r.sent, 1); assert.equal(sent[1].body.c, 'reminders');
  push.enqueue({ cat: 'waiting', title: 'אלכס מחכה לתשובה', tag: 'waiting' }, SHABBAT);
  r = await push.deliver(SHABBAT);
  assert.equal(r.sent, 0); assert.equal(r.held, 1);
  // an item older than its TTL is dropped, not sent late
  r = await push.deliver(SHABBAT + 13 * 3600000);
  assert.equal(r.dropped, 1); assert.equal(sent.length, 2);
});

test('404/410 from the push service remove the device; transient errors retry with backoff; 4xx do not', async () => {
  let flaky = 2;
  const { push, sent, db } = setup({ fail: { [SUB(1).endpoint]: 410, [SUB(2).endpoint]: 404, [SUB(3).endpoint]: () => (flaky-- > 0 ? 503 : 0), [SUB(4).endpoint]: 400 } });
  for (const n of [1, 2, 3, 4, 5]) push.subscribe(SUB(n));
  const id = push.enqueue({ cat: 'system', title: 'תקלה', bypassQuiet: true }, DAY);
  let r = await push.deliver(DAY);
  assert.equal(r.removed, 2);
  assert.equal(push.status().devices, 3, 'the expired subscriptions are gone');
  assert.equal(sent.length, 1, 'device 5 got it');
  let row = db.prepare('SELECT * FROM push_queue WHERE id=?').get(id);
  assert.equal(row.sent_at, null); assert.equal(row.attempts, 1); assert.ok(Date.parse(row.next_try_at) >= DAY + 30000);
  assert.match(db.prepare('SELECT last_error FROM push_subscriptions WHERE endpoint=?').get(SUB(4).endpoint).last_error, /^400/);
  r = await push.deliver(DAY + 1000); assert.equal(r.sent, 0, 'waits for the backoff');
  r = await push.deliver(DAY + 31000); // second try: device 3 still 503
  row = db.prepare('SELECT * FROM push_queue WHERE id=?').get(id); assert.equal(row.attempts, 2); assert.ok(Date.parse(row.next_try_at) >= DAY + 31000 + 60000);
  r = await push.deliver(DAY + 200000); // third try: device 3 recovered; device 5 is not sent twice
  assert.equal(r.sent, 1);
  assert.deepEqual(sent.map((s) => s.endpoint), [SUB(5).endpoint, SUB(3).endpoint]);
});

test('dedupe and tag: the same event is pushed once; items of one kind share a tag so the phone shows one notification', async () => {
  const { push, sent } = setup();
  push.subscribe(SUB(1));
  assert.ok(push.enqueue({ cat: 'waiting', title: 'אלכס מחכה לתשובה', tag: 'waiting', dedupe: 'confirm:7' }, DAY));
  assert.equal(push.enqueue({ cat: 'waiting', title: 'אלכס מחכה לתשובה', tag: 'waiting', dedupe: 'confirm:7' }, DAY + 60000), null);
  assert.ok(push.enqueue({ cat: 'waiting', title: 'אלכס מחכה לתשובה', tag: 'waiting', dedupe: 'confirm:8' }, DAY + 60000));
  await push.deliver(DAY + 60000);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.g, 'waiting'); assert.equal(sent[1].body.g, 'waiting');
  assert.equal(sent[0].opts.topic, sent[1].opts.topic, 'the push service may replace an undelivered older one');
  assert.ok(push.enqueue({ cat: 'waiting', title: 'x', dedupe: 'confirm:7' }, DAY + 21 * 3600000), 'after 20 hours it may come again');
});

test('scan: confirmation and outgoing-mail cards, questions; an answered one is not pushed; the backlog before the first scan is ignored', async () => {
  const { db, store, push, sent } = setup();
  push.subscribe(SUB(1));
  const a = store.assistantId(), o = store.ownerId();
  const t = store.createTask(a, { title: 'משימה ישנה' });
  db.prepare("INSERT INTO attention (kind, text, task_id, created_at) VALUES ('question','ישנה',?,?)").run(t.id, now());
  assert.deepEqual(push.scan(DAY), { started: true });
  // a deletion confirmation (a chat message with confirm_id)
  const cid = db.prepare("INSERT INTO confirmations (kind, target_id, text, status, created_at) VALUES ('task_delete',?,?,'open',?)").run(t.id, 'למחוק?', now()).lastInsertRowid;
  db.prepare("INSERT INTO chat_messages (author, channel, text, created_at, confirm_id) VALUES ('claude','web','להעביר לסל את המשימה \"סוד\"?',?,?)").run(now(), cid);
  const aid = db.prepare("INSERT INTO attention (kind, text, task_id, created_at) VALUES ('question','מה התאריך?',?,?)").run(t.id, now()).lastInsertRowid;
  assert.equal(push.scan(DAY).queued, 2);
  assert.equal(push.scan(DAY).queued, 0, 'the cursor moved');
  db.prepare("UPDATE attention SET status='accepted' WHERE id=?").run(aid); // answered before it went out
  const r = await push.deliver(DAY);
  assert.equal(r.sent, 1); assert.equal(r.dropped, 1);
  assert.deepEqual(sent[0].body, { t: 'אלכס מחכה לתשובה', b: 'אישור לפני מחיקה', u: '/chat', g: 'waiting', c: 'waiting' });
  assert.ok(!sent[0].raw.includes('סוד'), 'the task title stays on the server');
  void o;
});

test('scan: the assistant\'s chat reply is pushed only when switched on, after its run ended, and only when no page of the site is open', async () => {
  const { db, store, push, sent } = setup();
  push.subscribe(SUB(1)); push.saveSettings({ reply: true });
  push.scan(DAY);
  const ownerMsg = () => db.prepare("INSERT INTO chat_messages (author, channel, text, created_at) VALUES ('owner','web','מה המצב?',?)").run(new Date(DAY).toISOString());
  ownerMsg();
  const run = db.prepare("INSERT INTO claude_runs (trigger, started_at) VALUES ('chat',?)").run(new Date(DAY).toISOString()).lastInsertRowid;
  const m = db.prepare("INSERT INTO chat_messages (author, channel, text, created_at, run_id) VALUES ('claude','web',?,?,?)").run('הכול בסדר. '.repeat(60), new Date(DAY + 1000).toISOString(), run).lastInsertRowid;
  assert.equal(push.scan(DAY + 2000).queued, 0, 'the run is still working');
  db.prepare('UPDATE claude_runs SET finished_at=? WHERE id=?').run(new Date(DAY + 3000).toISOString(), run);
  push.seen(DAY + 3000); // a page is open
  assert.equal(push.scan(DAY + 4000).queued, 0, 'he is looking at the site');
  ownerMsg();
  db.prepare("INSERT INTO chat_messages (author, channel, text, created_at, scope, task_id) VALUES ('claude','web','עדכנתי',?, 'task', NULL)").run(new Date(DAY + 200000).toISOString());
  const m2 = db.prepare("INSERT INTO chat_messages (author, channel, text, created_at) VALUES ('claude','web','תשובה שנייה',?)").run(new Date(DAY + 200000).toISOString()).lastInsertRowid;
  assert.equal(push.scan(DAY + 200000).queued, 2, 'the page was closed 90 s ago');
  await push.deliver(DAY + 200000);
  assert.equal(sent.length, 2); assert.equal(sent[1].body.t, 'תשובה מאלכס'); assert.equal(sent[1].body.u, '/chat'); assert.equal(sent[1].body.b, 'תשובה שנייה');
  void m; void m2;
});

test('hooks: daily reminders summary, the pulse, urgent mail, system alerts', async () => {
  const { db, store, notify, push, sent } = setup();
  push.subscribe(SUB(1));
  notify.hooks.daily = push.daily;
  const a = store.assistantId();
  store.createTask(a, { title: 'באיחור אחת', due_date: '2026-11-20' });
  const t2 = store.createTask(a, { title: 'היום', due_date: '2026-11-25' });
  notify.runDaily('2026-11-25');
  notify.runDaily('2026-11-25'); // twice the same day: one push
  push.attentionItems([{ key: 'boss_task:1', kind: 'boss', task: t2.id, text: 'בקשה של ממונה' }], '2026-11-25');
  push.urgentMail([{ task: t2, why: 'יעד היום' }]);
  push.system('⚠️ תקלה במערכת Alex Tasks: האתר\nלא עונה כבר 5 דקות\nעוד פרטים ארוכים');
  await push.deliver(DAY);
  assert.deepEqual(sent.map((s) => s.body.c), ['reminders', 'attention', 'mail', 'system']);
  assert.equal(sent[0].body.t, 'תזכורת: 1 באיחור, 1 ליעד היום'); assert.equal(sent[0].body.u, '/');
  assert.equal(sent[1].body.u, `/task/${t2.id}`);
  assert.equal(sent[2].body.b, 'יעד היום: היום');
  assert.equal(sent[3].body.t, 'תקלה במערכת'); assert.equal(sent[3].body.b, 'האתר לא עונה כבר 5 דקות');
});

test('test notification: goes to every device even in quiet hours; no device = nothing to send', async () => {
  const { push, sent } = setup();
  assert.deepEqual(await push.test(NIGHT), { sent: 0, devices: 0 });
  push.subscribe(SUB(1)); push.subscribe(SUB(2));
  push.saveSettings({ system: false });
  const r = await push.test(NIGHT);
  assert.equal(r.sent, 1); assert.equal(r.devices, 2); assert.equal(sent.length, 2);
  assert.equal(sent[0].body.t, 'התראת בדיקה'); assert.equal(sent[0].body.u, '/settings');
});

test('VAPID keys: created once outside the repository with mode 600, then reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vapid-'));
  const f = path.join(dir, 'sub', 'vapid.json');
  process.env.MESIMOT_VAPID_FILE = f;
  try {
    const db = open(':memory:');
    const k1 = P.createPush(db).publicKey();
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(P.createPush(db).publicKey(), k1);
    assert.match(k1, /^[\w-]{80,}$/);
  } finally { delete process.env.MESIMOT_VAPID_FILE; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API: owner session only; subscribe, status, settings, test (mocked push service), unsubscribe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vapid-'));
  process.env.MESIMOT_VAPID_FILE = path.join(dir, 'vapid.json');
  const out = [];
  try {
    const { build } = require('../lib/server');
    const db = open(':memory:');
    auth.setPassword(db, 'correct-horse-battery');
    const app = build({ db, token: 'TOK', loginDelayMs: 0, pushSender: async (sub, body) => { out.push(JSON.parse(body)); return { statusCode: 201 }; } });
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct-horse-battery' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const H = { cookie, 'x-mesimot': '1' };
    assert.equal((await app.inject({ method: 'GET', url: '/api/push/key' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/push/key', headers: { authorization: 'Bearer TOK' } })).statusCode, 403, 'not the assistant');
    const key = (await app.inject({ method: 'GET', url: '/api/push/key', headers: H })).json().key;
    assert.match(key, /^[\w-]{80,}$/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/test', headers: H, payload: {} })).statusCode, 400, 'no device yet');
    const s = await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { ...H, 'user-agent': 'Chrome/131 Android' }, payload: { subscription: SUB(1) } });
    assert.equal(s.statusCode, 200); assert.equal(s.json().subscribed, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: H, payload: { subscription: { endpoint: 'x' } } })).statusCode, 400);
    const st = await app.inject({ method: 'GET', url: '/api/push/status?endpoint=' + encodeURIComponent(SUB(1).endpoint), headers: H });
    assert.equal(st.json().subscribed, true); assert.equal(st.json().devices, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/settings', headers: H, payload: { reply: true } })).json().reply, true);
    const t = await app.inject({ method: 'POST', url: '/api/push/test', headers: H, payload: {} });
    assert.equal(t.json().sent, 1); assert.equal(out[0].t, 'התראת בדיקה');
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/seen', headers: H })).json().ok, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/unsubscribe', headers: H, payload: { endpoint: SUB(1).endpoint } })).json().removed, 1);
    // an expired session on a deep link returns there after the login
    const r = await app.inject({ method: 'GET', url: '/task/12' });
    assert.equal(r.statusCode, 302); assert.equal(r.headers.location, '/login?next=%2Ftask%2F12');
    const back = await app.inject({ method: 'GET', url: '/login?next=/task/12', headers: { cookie } });
    assert.equal(back.headers.location, '/task/12');
    const evil = await app.inject({ method: 'GET', url: '/login?next=//evil.example', headers: { cookie } });
    assert.equal(evil.headers.location, '/');
    await app.close();
  } finally { delete process.env.MESIMOT_VAPID_FILE; fs.rmSync(dir, { recursive: true, force: true }); }
});
