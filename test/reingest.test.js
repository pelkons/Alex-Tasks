'use strict';
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_LIVE_QUIET_S = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-reingest-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createCalendar } = require('../lib/calendar');
const { createImporter } = require('../lib/importer');
const { createIngest } = require('../lib/ingest');
const { createHealth } = require('../lib/health');
const { garbledRatio } = require('../lib/textclean');
const { buildMsg } = require('./helpers/msg-builder');

function lib() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const ingest = createIngest({ db, store, knowledge, importer: createImporter({ db, store, knowledge, chat }), calendar: createCalendar(db, store), version: 't' });
  return { db, store, knowledge, ingest };
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF notes about traffic');
const msg = (o) => buildMsg({ from_name: o.from_name, from_addr: 'avi@client.example', to: [{ name: 'דנה', addr: 'dana@exconstruct.example' }], subject: o.subject, body: o.body, date: Date.parse('2026-11-26T09:00:00Z'), attachments: [{ name: o.att, data: PDF, mime: 'application/pdf' }] });
const garbled = () => msg({ from_name: '??? ???', subject: '???? ????? - ???? 15-47', body: '???? ????, ???? ???? ??? ?????? ????? ??? ?????. ??? ?????', att: '???? ????.pdf' });
const good = () => msg({ from_name: 'אבי כהן', subject: 'נספח תנועה - ארבר 15-47', body: 'שלום דנה, מצורף נספח התנועה העדכני לתכנית ארבר. תודה', att: 'נספח תנועה.pdf' });
const meta = { entry_id: 'EN1', folder: 'inbox', received_or_sent_at: '2026-11-26T09:00:00Z', internet_message_id: '<tr1@client.example>' };

test('garbled ratio: "?" for letters is garbled, real questions are not', () => {
  assert.ok(garbledRatio('???? ???? ??? ?????? ????? ??? ?????') > 0.5); assert.ok(garbledRatio('שלום, מתי נוכל להיפגש? אשמח לדעת האם הנספח מוכן ומה הסטטוס?') < 0.05); assert.equal(garbledRatio('???'), 0);
});

test('re-ingest replaces the stored file, headers, body and attachment names IN PLACE; the email id and every link stay; garbled mail is queued for facts/extraction', async () => {
  const L = lib(); const owner = L.store.ownerId(); const a = L.store.assistantId();
  const r1 = await L.ingest.mail(meta, garbled(), 'm.msg'); assert.equal(r1.status, 'stored');
  const emailId = r1.email_id; const em0 = L.db.prepare('SELECT * FROM emails WHERE id=?').get(emailId); const kids0 = L.db.prepare('SELECT * FROM files WHERE email_id=? AND id<>?').all(emailId, em0.file_id);
  assert.equal(kids0.length, 1); assert.match(kids0[0].original_name, /^\?+ \?+\.pdf$/);
  // things that point at the email and at the attachment
  const proj = L.store.createProject(a, { name: 'ארבר' }); const t = L.store.createTask(owner, { title: 'משימה מהמייל', project: proj.id, requester: owner, source_email: emailId });
  L.store.linkTaskEmail(a, t.id, emailId, 'created'); L.db.prepare("INSERT INTO project_facts (project_id, key, value, as_of_date, source_type, source_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)").run(proj.id, 'שטח', '18 דונם', '2026-11-26', 'file', kids0[0].id, a, new Date().toISOString());
  L.db.prepare("INSERT INTO people (name_he, role, emails, notes, created_at) VALUES ('??? ???','contact','[\"avi@client.example\"]','',?)").run(new Date().toISOString());
  const r2 = await L.ingest.mail({ ...meta, reingest: true }, good(), 'm.msg');
  assert.equal(r2.status, 'reingested'); assert.equal(r2.email_id, emailId); assert.equal(r2.garbled_before, true); assert.equal(r2.files_renamed, 1); assert.equal(r2.files_added, 0); assert.equal(r2.people_fixed, 1);
  const em = L.db.prepare('SELECT * FROM emails WHERE id=?').get(emailId);
  assert.match(em.subject, /נספח תנועה/); assert.match(em.body_text, /נספח התנועה העדכני/); assert.equal(em.id, emailId); assert.equal(em.file_id, em0.file_id); assert.equal(em.import_state, em0.import_state, 'the pipeline state is untouched');
  const kid = L.db.prepare('SELECT * FROM files WHERE id=?').get(kids0[0].id); assert.equal(kid.original_name, 'נספח תנועה.pdf'); assert.ok(fs.existsSync(kid.path) && kid.path.includes('נספח תנועה.pdf'), 'renamed on disk too');
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM files WHERE email_id=?').get(emailId).c, 2, 'no duplicate attachment rows');
  assert.ok(L.db.prepare('SELECT 1 FROM task_emails WHERE task_id=? AND email_id=?').get(t.id, emailId), 'task link kept'); assert.equal(L.db.prepare("SELECT source_id FROM project_facts WHERE key='שטח'").get().source_id, kids0[0].id, 'the fact still points at the same file id');
  assert.equal(L.db.prepare("SELECT name_he FROM people WHERE emails LIKE '%avi@client%'").get().name_he, 'אבי כהן');
  assert.ok(L.db.prepare("SELECT 1 FROM search_index WHERE kind='email' AND ref_id=? AND body MATCH 'התנועה'").get(emailId), 'the Hebrew body is searchable'); assert.equal(L.db.prepare("SELECT sha256 FROM files WHERE id=?").get(em0.file_id).sha256.length, 64);
  assert.ok(L.db.prepare('SELECT 1 FROM reingest_queue WHERE email_id=? AND done_at IS NULL').get(emailId), 'garbled mail is queued for facts/extraction'); assert.equal(L.db.prepare('SELECT facts_checked FROM files WHERE id=?').get(kids0[0].id).facts_checked, 0);
  // idempotent: the same bytes again change nothing
  const r3 = await L.ingest.mail({ ...meta, reingest: true }, good(), 'm.msg'); assert.equal(r3.unchanged, true);
  // another entry id for the same internet message id still finds the mail
  const r4 = await L.ingest.mail({ ...meta, entry_id: 'EN1-moved', reingest: true }, msg({ from_name: 'אבי כהן', subject: 'נספח תנועה - ארבר 15-47', body: 'גרסה שנייה של הגוף. שלום דנה, מצורף הנספח', att: 'נספח תנועה.pdf' }), 'm.msg'); assert.equal(r4.email_id, emailId);
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM emails').get().c, 1);
});

test('re-ingest of a mail that was fine is NOT queued for the assistant; a mail never seen before is stored normally', async () => {
  const L = lib(); const ok = await L.ingest.mail({ ...meta, entry_id: 'G1', internet_message_id: '<g1@x>' }, good(), 'm.msg');
  const r = await L.ingest.mail({ ...meta, entry_id: 'G1', internet_message_id: '<g1@x>', reingest: true }, msg({ from_name: 'אבי כהן', subject: 'נספח תנועה - ארבר 15-47', body: 'שלום דנה, מצורף נספח התנועה העדכני לתכנית ארבר. תוספת קטנה', att: 'נספח תנועה.pdf' }), 'm.msg');
  assert.equal(r.status, 'reingested'); assert.equal(r.garbled_before, false); assert.equal(L.db.prepare('SELECT COUNT(*) c FROM reingest_queue').get().c, 0);
  const fresh = await L.ingest.mail({ ...meta, entry_id: 'NEW9', internet_message_id: '<new9@x>', reingest: true }, msg({ from_name: 'דנה לוי', subject: 'נושא אחר לגמרי', body: 'גוף אחר לגמרי של מייל חדש שלא נראה קודם', att: 'אחר.pdf' }), 'm.msg'); assert.equal(fresh.status, 'stored'); assert.ok(ok.email_id);
});

test('health: the share of garbled ingested mail in the last 24 h is yellow above 5%', async () => {
  const L = lib(); await L.ingest.mail({ ...meta, entry_id: 'H1', internet_message_id: '<h1@x>' }, garbled(), 'm.msg'); await L.ingest.mail({ ...meta, entry_id: 'H2', internet_message_id: '<h2@x>' }, good(), 'm.msg');
  const h = createHealth(L.db, L.store, { localUrl: 'http://x', password: '', mailPing: async () => {}, tgToken: '' });
  let r = (await h.mail()).find((x) => x.id === 'ingest:garbled'); assert.equal(r.status, 'warn'); assert.match(r.message, /1 מתוך 2/);
  await L.ingest.mail({ ...meta, entry_id: 'H1', internet_message_id: '<h1@x>', reingest: true }, good(), 'm.msg');
  r = (await h.mail()).find((x) => x.id === 'ingest:garbled'); assert.equal(r.status, 'ok', 'after the re-push the share drops');
});
