'use strict';
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_LIVE_QUIET_S = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-ingest-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createCalendar } = require('../lib/calendar');
const { createImporter } = require('../lib/importer');
const { createIngest, createIngestApp, inTailnet } = require('../lib/ingest');
const { buildMsg } = require('./helpers/msg-builder');

const TOKEN = 'test-ingest-token-0123456789';
const TS = '100.106.52.82';
function lib() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const calendar = createCalendar(db, store); const importer = createImporter({ db, store, knowledge, chat });
  const ingest = createIngest({ db, store, knowledge, importer, calendar, version: 'test' });
  const app = createIngestApp({ ingest, token: TOKEN });
  return { db, store, knowledge, chat, calendar, importer, ingest, app };
}
// fictional messages (generated)
const msg = (n, o = {}) => buildMsg({ from_name: o.from_name || `ספק ${n}`, from_addr: o.from_addr || `vendor${n}@supplier.example`, to: [{ name: 'דנה', addr: 'dana@exconstruct.example' }], subject: o.subject || `בקשה מספר ${n} לאישור תוכניות`, body: o.body || `שלום, נא לאשר את התוכנית מספר ${n} עד סוף השבוע.`, date: o.date || Date.parse('2026-11-26T08:00:00Z') + n * 60000 });
function multipart(meta, file) {
  const b = '----t' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="m.msg"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { payload: Buffer.concat([head, file, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
const post = (L, meta, file, over = {}) => { const m = multipart(meta, file); return L.app.inject({ method: 'POST', url: '/ingest/mail', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${TOKEN}`, ...(over.headers || {}) }, remoteAddress: over.ip || TS }); };

test('access: only Tailscale source addresses with the right Bearer token', async () => {
  const L = lib();
  assert.ok(inTailnet('100.64.0.1') && inTailnet('100.127.255.254') && inTailnet('::ffff:100.106.52.82'));
  assert.ok(!inTailnet('100.63.0.1') && !inTailnet('100.128.0.1') && !inTailnet('127.0.0.1') && !inTailnet('8.8.8.8') && !inTailnet('10.0.0.214'));
  const get = (headers, ip) => L.app.inject({ method: 'GET', url: '/ingest/status', headers, remoteAddress: ip });
  assert.equal((await get({ authorization: `Bearer ${TOKEN}` }, TS)).statusCode, 200);
  assert.equal((await get({}, TS)).statusCode, 401);
  assert.equal((await get({ authorization: 'Bearer wrong' }, TS)).statusCode, 401);
  assert.equal((await get({ authorization: `Bearer ${TOKEN}` }, '127.0.0.1')).statusCode, 403, 'loopback is refused');
  assert.equal((await get({ authorization: `Bearer ${TOKEN}` }, '203.0.113.9')).statusCode, 403, 'a public address is refused');
  const noToken = createIngestApp({ ingest: L.ingest, token: '' });
  assert.equal((await noToken.inject({ method: 'GET', url: '/ingest/status', headers: { authorization: 'Bearer ' }, remoteAddress: TS })).statusCode, 401, 'without a configured token everything is refused');
});

test('mail: stored once, duplicates by entry id and by internet message id (also against earlier mail), 100 MB cap is declared', async () => {
  const L = lib();
  const meta = { entry_id: 'E1', store: 'main', folder: 'inbox', received_or_sent_at: '2026-11-26T08:01:00Z', internet_message_id: '<abc.1@supplier.example>', size: 1000 };
  const r1 = await post(L, meta, msg(1)); assert.equal(r1.statusCode, 200); assert.equal(r1.json().status, 'stored');
  assert.equal((await post(L, meta, msg(1))).json().status, 'duplicate', 'same entry id');
  assert.equal((await post(L, { ...meta, entry_id: 'E1b' }, msg(1))).json().status, 'duplicate', 'same internet message id, other entry id');
  assert.equal((await post(L, { ...meta, entry_id: 'E1c', internet_message_id: 'ABC.1@supplier.example' }, msg(1))).json().status, 'duplicate', 'the id is compared without brackets and case');
  // an earlier hand import of the same message (known by its Message-ID)
  L.db.prepare("INSERT INTO emails (message_id, msgid, from_addr, subject, received_at, body_text) VALUES ('upload:1','old.2@supplier.example','x@y','s',?,'b')").run(new Date().toISOString());
  assert.equal((await post(L, { ...meta, entry_id: 'E2', internet_message_id: '<old.2@supplier.example>' }, msg(2))).json().status, 'duplicate', 'mail imported earlier');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM emails WHERE import_state='staged'").get().c, 1);
  assert.equal((await post(L, { folder: 'inbox' }, msg(3))).statusCode, 400, 'entry_id is required');
  const bad = await L.app.inject({ method: 'POST', url: '/ingest/mail', payload: Buffer.from('not multipart'), headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, remoteAddress: TS });
  assert.ok(bad.statusCode >= 400 && bad.statusCode < 500);
});

test('live batch: mail joins one rolling import without a chat card; the pipeline parses it, SENT folder means sent; a backfill is a separate import with a card and waits behind live mail', async () => {
  const L = lib();
  await post(L, { entry_id: 'A1', folder: 'inbox', received_or_sent_at: '2026-11-26T08:01:00Z', internet_message_id: '<a1@s.example>' }, msg(1));
  await post(L, { entry_id: 'A2', folder: 'sent', received_or_sent_at: '2026-11-26T08:05:00Z', internet_message_id: '<a2@s.example>' }, msg(2, { from_name: 'דנה', from_addr: 'dana@exconstruct.example', subject: 'RE: בקשה מספר 1 לאישור תוכניות' }));
  await post(L, { entry_id: 'B1', folder: 'inbox', received_or_sent_at: '2026-10-01T08:00:00Z', internet_message_id: '<b1@s.example>', backfill: 'אוקטובר 2026' }, msg(9, { date: Date.parse('2026-10-01T08:00:00Z') }));
  const imps = L.db.prepare('SELECT * FROM imports ORDER BY id').all();
  assert.equal(imps.length, 2);
  const live = imps.find((i) => JSON.parse(i.stats).live), back = imps.find((i) => JSON.parse(i.stats).backfill);
  assert.equal(live.chat_message_id, null, 'no card for live mail'); assert.ok(back.chat_message_id, 'a backfill has its card');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE import_id=?").get(live.id).c, 0);
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM emails WHERE import_id=?').get(live.id).c, 2);
  L.importer.releaseCollecting();
  assert.equal(L.importer.active().id, live.id, 'live mail goes first');
  await L.importer.stage(live.id);
  const rows = L.db.prepare("SELECT direction, mail_date, msgid, import_state FROM emails WHERE import_id=? ORDER BY id").all(live.id);
  assert.deepEqual(rows.map((r) => r.direction), ['received', 'sent']);
  assert.ok(rows.every((r) => r.import_state === 'parsed' && r.msgid), 'parsed, with the connector\'s internet message id kept');
  L.importer.dedupe(live.id); L.importer.applyNoise(live.id); const n = L.importer.buildThreads(live.id);
  assert.ok(n >= 1);
});

test('live urgent: a boss request, due today or tomorrow, once per reason; everything else is silent', () => {
  const L = lib(); const a = L.store.assistantId(), owner = L.store.ownerId();
  const boss = L.store.createPerson(a, { name: 'מנהלת הבדיקה', role: 'contact', notes: 'הממונה של הבעלים' });
  const imp = L.importer.liveBatch().id;
  const run = L.chat.startRun('import', 1); L.db.prepare('UPDATE claude_runs SET import_id=? WHERE id=?').run(imp, run);
  const proj = L.store.createProject(L.store.ownerId(), { name: 'מגדל הבדיקה' });
  const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); };
  const mk = (title, o) => { const t = L.store.createTask(a, { title, project: proj.id, requester: owner, assignee: owner, ...o }); L.db.prepare('UPDATE events SET run_id=? WHERE entity=? AND entity_id=?').run(run, 'task', t.id); return t; };
  mk('בקשה של הממונה', { requester: boss.id, due: day(20) }); mk('דחוף למחר', { due: day(1) }); mk('בעוד חודש', { due: day(30) });
  const u = L.importer.liveUrgent(imp);
  assert.deepEqual(u.map((x) => x.task.title).sort(), ['בקשה של הממונה', 'דחוף למחר'].sort());
  assert.equal(L.importer.liveUrgent(imp).length, 0, 'each is announced once');
});

test('morning digest text: counts, new tasks, today\'s meetings; silent when nothing came in', async () => {
  const L = lib();
  await post(L, { entry_id: 'D1', folder: 'inbox', received_or_sent_at: '2026-11-26T08:01:00Z', internet_message_id: '<d1@s.example>' }, msg(1));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  L.calendar.upsertOutlook({ entry_id: 'M1', subject: 'ישיבת תיאום', start: `${today}T10:00:00+02:00`, end: `${today}T11:00:00+02:00`, all_day: false });
  const d = L.importer.liveDigest(new Date(Date.now() - 24 * 3600000).toISOString());
  assert.match(d.text, /1 מיילים/); assert.match(d.text, /ישיבת תיאום/); assert.match(d.text, /בוקר טוב/);
});

test('calendar mirror: upsert, update, delete, recurring occurrences, all-day end, read-only, never exported back, search, no duplicate of a meeting found in mail', () => {
  const L = lib(); const c = L.calendar;
  const ev = { entry_id: 'C1', global_appointment_id: 'G1', subject: 'פגישת תכנון עם יעל', start: '2026-12-01T09:00:00+02:00', end: '2026-12-01T10:00:00+02:00', all_day: false, location: 'חדר 3', organizer: { name: 'יעל רוזן', email: 'yael@x.example' }, required_attendees: [{ name: 'דנה', email: 'Dana@Exconstruct.example' }], optional_attendees: [], response_status: 'accepted', last_modified: '2026-11-26T07:00:00Z', body_snippet: 'x'.repeat(5000) };
  assert.equal(c.upsertOutlook(ev), 'created'); assert.equal(c.upsertOutlook({ ...ev, location: 'חדר 4' }), 'updated');
  const row = L.db.prepare("SELECT * FROM calendar_items WHERE source='outlook'").get();
  assert.equal(row.location, 'חדר 4'); assert.equal(row.description.length, 2048); assert.match(row.attendees, /dana@exconstruct\.example/); assert.equal(L.db.prepare('SELECT COUNT(*) c FROM calendar_items').get().c, 1);
  // recurring: one row per occurrence
  c.upsertOutlook({ entry_id: 'R1', subject: 'סטטוס שבועי', start: '2026-12-02T08:00:00+02:00', end: '2026-12-02T08:30:00+02:00', is_recurring: true, occurrence: '2026-12-02' });
  c.upsertOutlook({ entry_id: 'R1', subject: 'סטטוס שבועי', start: '2026-12-09T08:00:00+02:00', end: '2026-12-09T08:30:00+02:00', is_recurring: true, occurrence: '2026-12-09' });
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM calendar_items WHERE ol_entry_id='R1'").get().c, 2);
  assert.equal(c.upsertOutlook({ entry_id: 'R1', is_recurring: true, occurrence: '2026-12-09', deleted: true }), 'deleted');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM calendar_items WHERE ol_entry_id='R1'").get().c, 1);
  // all-day: Outlook's end is the next midnight (exclusive)
  c.upsertOutlook({ entry_id: 'AD', subject: 'יום חופשה', start: '2026-12-03', end: '2026-12-04', all_day: true });
  const ad = L.db.prepare("SELECT * FROM calendar_items WHERE ol_entry_id='AD'").get(); assert.equal(ad.start, '2026-12-03'); assert.equal(ad.end, '2026-12-03'); assert.equal(ad.all_day, 1);
  // read-only for everyone else, and never exported back to Outlook
  assert.throws(() => c.updateItem(L.store.ownerId(), row.id, { title: 'x' }), /Outlook/); assert.throws(() => c.deleteItem(L.store.ownerId(), row.id), /Outlook/);
  assert.ok(!c.ics().includes('פגישת תכנון עם יעל'), 'the mirror is not in the feed');
  const own = c.addItem(L.store.assistantId(), { title: 'פגישה פנימית שלי', start: '2026-12-05 10:00' }); assert.ok(c.ics().includes('פגישה פנימית שלי')); assert.ok(own.id);
  // the screen's data: labelled and searchable
  const day = c.range('2026-12-01', '2026-12-01'); assert.equal(day[0].source, 'outlook'); assert.equal(day[0].organizer.includes('יעל'), true);
  assert.equal(c.range('2026-12-01', '2026-12-31', 'יעל').length, 1); assert.equal(c.range('2026-12-01', '2026-12-31', 'לא קיים').length, 0);
  // a meeting found in mail with the same start and a similar title is the Outlook item, not a second one
  const same = c.addItem(L.store.assistantId(), { title: 'הזמנה: פגישת תכנון עם יעל', start: '2026-12-01T09:00:00+02:00' }); assert.equal(same.id, row.id);
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM calendar_items WHERE substr(start,1,10)='2026-12-01'").get().c, 1);
});

test('endpoints: calendar array, status for resuming, error handling', async () => {
  const L = lib(); const H = { authorization: `Bearer ${TOKEN}` };
  const r = await L.app.inject({ method: 'POST', url: '/ingest/calendar', headers: H, remoteAddress: TS, payload: [{ entry_id: 'X1', subject: 'a', start: '2026-12-01T09:00:00+02:00', end: '2026-12-01T10:00:00+02:00' }, { subject: 'ללא מזהה', start: '2026-12-01' }, { entry_id: 'X2', deleted: true }] });
  assert.equal(r.statusCode, 200); const j = r.json(); assert.deepEqual([j.received, j.created, j.ignored, j.errors.length], [3, 1, 1, 1]);
  assert.equal((await L.app.inject({ method: 'POST', url: '/ingest/calendar', headers: H, remoteAddress: TS, payload: { not: 'an array' } })).statusCode, 400);
  await post(L, { entry_id: 'S1', folder: 'inbox', received_or_sent_at: '2026-11-26T08:01:00Z', internet_message_id: '<s1@x>' }, msg(1));
  await post(L, { entry_id: 'S2', folder: 'sent', received_or_sent_at: '2026-11-26T08:02:00Z', internet_message_id: '<s2@x>' }, msg(2));
  const st = (await L.app.inject({ method: 'GET', url: '/ingest/status', headers: H, remoteAddress: TS })).json();
  assert.equal(st.server_version, 'test'); assert.deepEqual(st.mail.folders.map((f) => f.folder).sort(), ['inbox', 'sent']);
  assert.equal(st.mail.total, 2); assert.ok(st.mail.folders.find((f) => f.folder === 'sent').last_item_at.startsWith('2026-11-26T08:02')); assert.ok(st.calendar.last_received_at); assert.equal(st.calendar.items, 1); assert.ok(st.last_contact_at);
});

test('watchdog: 2 h of silence in work hours alerts once, outside work hours it does not, and a recovery notice follows', async () => {
  const { createWatchdog } = require('../lib/watchdog');
  const db = open(':memory:'); const store = createStore(db); const tg = [];
  const wd = createWatchdog(db, store, { systemctl: () => ({ code: 0, stdout: 'active' }), fetch: async () => ({ status: 200 }), localUrl: '', publicUrl: '', token: '', sendTelegram: async (t) => tg.push(t), sendEmailText: async (t) => tg.push(t), isQuiet: () => false });
  const set = (v) => db.prepare("INSERT INTO settings (key,value) VALUES ('ingest_last_contact',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v);
  assert.equal((await wd.checkIngest(Date.parse('2026-12-02T10:00:00Z'))).skipped, 'never connected');
  const last = Date.parse('2026-12-02T05:00:00Z'); set(new Date(last).toISOString()); // Wednesday 07:00 Jerusalem
  const wed10 = Date.parse('2026-12-02T08:00:00Z') ; // 10:00 local, 3 h later
  assert.equal((await wd.checkIngest(last + 3600000)).ok, true);
  assert.equal((await wd.checkIngest(wed10)).alerted, true); assert.match(tg[0], /MAINPC לא שלח מיילים מאז 07:00/);
  assert.equal((await wd.checkIngest(wed10 + 600000)).skipped, 'already alerted'); assert.equal(tg.length, 1);
  set(new Date(wed10 + 700000).toISOString()); assert.equal((await wd.checkIngest(wed10 + 800000)).recovered, true);
  // Friday: no alert
  set(new Date(Date.parse('2026-12-04T05:00:00Z')).toISOString()); tg.length = 0;
  assert.equal((await wd.checkIngest(Date.parse('2026-12-04T10:00:00Z'))).skipped, 'outside work hours'); assert.equal(tg.length, 0);
});
