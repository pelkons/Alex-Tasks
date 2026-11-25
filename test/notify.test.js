'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { createStore } = require('../lib/store');
const { createNotify } = require('../lib/notify');
const { sendOwnerEmail } = require('../lib/email');
const { build } = require('../lib/server');

const iso = (s) => new Date(s);
function setup() {
  const db = open(':memory:');
  const store = createStore(db);
  const sent = [];
  const notify = createNotify(db, store, { sendEmail: async (m) => { sent.push(m); } });
  store.hooks.attention = notify.onAttention;
  return { db, store, notify, sent };
}

test('quiet hours (22:00-07:00) and Shabbat (Fri 16:00 - Sat 20:00), Jerusalem time', () => {
  const { notify } = setup();
  // 2026-11-25 is a Wednesday; Jerusalem is UTC+2 in November
  assert.equal(notify.isQuiet(iso('2026-11-25T09:00:00+02:00')), false);
  assert.equal(notify.isQuiet(iso('2026-11-25T22:30:00+02:00')), true);
  assert.equal(notify.isQuiet(iso('2026-11-25T06:59:00+02:00')), true);
  assert.equal(notify.isQuiet(iso('2026-11-25T07:00:00+02:00')), false);
  assert.equal(notify.isQuiet(iso('2026-11-27T15:59:00+02:00')), false, 'Friday before 16:00');
  assert.equal(notify.isQuiet(iso('2026-11-27T16:00:00+02:00')), true, 'Friday 16:00');
  assert.equal(notify.isQuiet(iso('2026-11-28T12:00:00+02:00')), true, 'Saturday noon');
  assert.equal(notify.isQuiet(iso('2026-11-28T19:59:00+02:00')), true);
  assert.equal(notify.isQuiet(iso('2026-11-28T20:00:00+02:00')), false, 'Saturday 20:00');
  notify.saveSettings({ shabbat: false });
  assert.equal(notify.isQuiet(iso('2026-11-28T12:00:00+02:00')), false);
});

test('daily reminders: overdue, stale in-progress, due soon; digest queued once; closed tasks drop their reminders', async () => {
  const { db, store, notify, sent } = setup();
  const a = store.assistantId();
  const old = store.createTask(a, { title: 'באיחור', due: '2026-11-20' });
  const soon = store.createTask(a, { title: 'מחר', due: '2026-11-26' });
  const stuck = store.createTask(a, { title: 'תקועה', status: 'בטיפול' });
  db.prepare("UPDATE tasks SET updated_at='2026-11-20T10:00:00Z' WHERE id=?").run(stuck.id);
  store.createTask(a, { title: 'רגילה', due: '2026-12-30' });
  const r = notify.runDaily('2026-11-25');
  assert.deepEqual(r, { overdue: 1, stale: 1, soon: 1 });
  const att = db.prepare("SELECT text FROM attention WHERE kind='reminder'").all().map((x) => x.text);
  assert.equal(att.length, 3);
  assert.ok(att.some((t) => /^באיחור: באיחור/.test(t)) && att.some((t) => /^מחר יעד/.test(t)) && att.some((t) => /ללא התקדמות 3 ימים/.test(t)));
  notify.runDaily('2026-11-25'); // a second run does not duplicate
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attention WHERE kind='reminder'").get().c, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications').get().c, 1, 'one digest per day');
  // quiet time: nothing is sent; morning: one short Hebrew digest
  assert.equal(await notify.flush(iso('2026-11-25T23:00:00+02:00')), 0);
  assert.equal(sent.length, 0);
  assert.equal(await notify.flush(iso('2026-11-26T08:00:00+02:00')), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'dana.levi@mail.example');
  assert.match(sent[0].text, /באיחור \(1\)/); assert.match(sent[0].text, /בטיפול בלי התקדמות/);
  assert.equal(await notify.flush(iso('2026-11-26T09:00:00+02:00')), 0, 'sent once');
  store.updateTask(a, old.id, { status: 'הושלם' });
  notify.runDaily('2026-11-26');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attention WHERE status='open' AND task_id=?").get(old.id).c, 0);
  void soon;
});

test('a question about a boss request is emailed at once, but only outside quiet hours', async () => {
  const { db, store, notify, sent } = setup();
  const a = store.assistantId();
  const t = store.createTask(a, { title: 'בקשה של הממונה', requester: 'אבי כהן' });
  const other = store.createTask(a, { title: 'בקשה אחרת', requester: 'יעל רוזן' });
  store.addAttention(a, { kind: 'question', text: 'מתי צריך לסיים?', task: t.id });
  store.addAttention(a, { kind: 'suggestion', text: 'הצעה', task: other.id });
  db.prepare("UPDATE people SET name_he='נועה', notes='', name_en=NULL WHERE name_he='יעל רוזן'").run();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE urgency='urgent'").get().c, 1, 'only the question about a boss is urgent');
  assert.equal(await notify.flush(iso('2026-11-25T23:30:00+02:00')), 0, 'held during quiet hours');
  assert.equal(await notify.flush(iso('2026-11-26T07:05:00+02:00')), 1);
  assert.match(sent[0].subject, /שאלה של אלכס/);
  notify.saveSettings({ notify_email: false });
  store.addAttention(a, { kind: 'question', text: 'עוד שאלה', task: t.id });
  assert.equal(await notify.flush(iso('2026-11-26T12:00:00+02:00')), 0, 'email channel switched off');
});

test('the only mail the system sends goes to the owner', async () => {
  const { db } = setup();
  await assert.rejects(() => sendOwnerEmail(db, { to: 'someone@else.com', subject: 'x', text: 'y' }), /not the owner/);
});

test('settings API, status and priority renaming, drafts, and password change', async () => {
  const db = open(':memory:');
  auth.setPassword(db, 'correct horse battery');
  auth.resetFailures();
  const app = build({ db, token: 't', loginDelayMs: 0 });
  const login = async (pw) => { const r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: pw } }); return r; };
  const r0 = await login('correct horse battery');
  const web = { cookie: `mesimot_session=${r0.cookies[0].value}`, 'x-mesimot': '1' };
  let r = (await app.inject({ method: 'GET', url: '/api/settings', headers: web })).json();
  assert.equal(r.quiet_start, '22:00'); assert.deepEqual(r.email_allowlist, ['dana@exconstruct.example', 'dana.levi@mail.example']);
  assert.match(r.calendar_url, /\/cal\//);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: web, payload: { quiet_start: '23:00', notify_telegram: false, email_allowlist: 'a@b.co, c@d.co' } })).statusCode, 200);
  r = (await app.inject({ method: 'GET', url: '/api/settings', headers: web })).json();
  assert.equal(r.quiet_start, '23:00'); assert.equal(r.notify_telegram, false); assert.deepEqual(r.email_allowlist, ['a@b.co', 'c@d.co']);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: web, payload: { email_allowlist: 'not-an-address' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: web, payload: { quiet_end: '7am' } })).statusCode, 400);
  // renaming a status keeps every task attached
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: web, payload: { title: 'x' } })).json();
  const st = r.statuses.find((s) => s.name_he === 'חדש');
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/statuses/${st.id}`, headers: web, payload: { name_he: 'התקבל' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: web })).json().status, 'התקבל');
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/statuses/${st.id}`, headers: web, payload: { name_he: 'בטיפול' } })).statusCode, 400, 'names stay unique');
  // drafts
  const d = (await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/drafts`, headers: web, payload: { text: 'שלום נועה, אישרתי.' } })).json();
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/drafts/${d.id}`, headers: web, payload: { status: 'הועתק' } })).json().status, 'הועתק');
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: web })).json().drafts[0].status, 'הועתק');
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/drafts/${d.id}`, headers: web, payload: { status: 'x' } })).statusCode, 400);
  // password: old one required, new one at least 12 characters; the old password stops working
  assert.equal((await app.inject({ method: 'POST', url: '/api/password', headers: web, payload: { old_password: 'wrong', new_password: 'another long password' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/password', headers: web, payload: { old_password: 'correct horse battery', new_password: 'short' } })).statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/api/password', headers: web, payload: { old_password: 'correct horse battery', new_password: 'another long password' } });
  assert.equal(ok.statusCode, 200);
  auth.resetFailures();
  assert.equal((await login('correct horse battery')).statusCode, 401);
  assert.equal((await login('another long password')).statusCode, 200);
  // the old session cookie is invalid, the one returned by the change works
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks', headers: web })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie: `mesimot_session=${ok.cookies[0].value}` } })).statusCode, 200);
});
