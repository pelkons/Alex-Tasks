'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-files-'));
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');
const { ingestMessage, wanted } = require('../lib/email');
const { createStore } = require('../lib/store');
const docs = require('../lib/docs');

const TOKEN = 't-123';
function setup() {
  const db = open(':memory:');
  auth.setPassword(db, 'correct horse battery');
  auth.resetFailures();
  const app = build({ db, token: TOKEN, loginDelayMs: 0 }); require('./helpers/owner')(app, db, 'correct horse battery');
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const login = async () => {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct horse battery' } });
    return { cookie: `mesimot_session=${r.cookies[0].value}`, 'x-mesimot': '1' };
  };
  return { db, app, bearer, login };
}
const j = (r) => r.json();

test('search: "תקציב" finds "והתקציב" (trigram), across kinds, with filters', async () => {
  const { app, bearer, db } = setup();
  const p = j(await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל' } }));
  await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'לבדוק את והתקציב השנתי', project: p.id, requester: 'יעל רוזן' } });
  await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'משימה אחרת' } });
  db.prepare("INSERT INTO emails (subject, body_text, received_at, forwarded_from, forwarded_date) VALUES ('נושא','הוועדה אישרה והתקציב','2026-11-01T10:00:00Z','אבי כהן <a@b.co>','2026-11-01T10:00:00Z')").run();
  let r = j(await app.inject({ method: 'GET', url: '/api/search?q=' + encodeURIComponent('תקציב'), headers: bearer }));
  assert.deepEqual(r.results.map((x) => x.kind).sort(), ['email', 'task']);
  assert.match(r.results[0].snippet, /«תקציב»/);
  assert.match(r.results[0].html, /<mark>תקציב<\/mark>/);
  r = j(await app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent('תקציב')}&project=${p.id}`, headers: bearer }));
  assert.equal(r.count, 1);
  r = j(await app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent('תקציב')}&person=${encodeURIComponent('אבי')}`, headers: bearer }));
  assert.deepEqual(r.results.map((x) => x.kind), ['email']);
  r = j(await app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent('תקציב')}&from=02/11/2026`, headers: bearer }));
  assert.equal(r.results.filter((x) => x.kind === 'email').length, 0);
  r = await app.inject({ method: 'GET', url: '/api/search?q=אב', headers: bearer });
  assert.equal(r.statusCode, 400);
  // multi-word query falls back to OR
  r = j(await app.inject({ method: 'GET', url: '/api/search?q=' + encodeURIComponent('תקציב לא-קיים-בכלל'), headers: bearer }));
  assert.ok(r.count >= 1);
});

test('chat: owner message creates a pending event, assistant reply does not; status', async () => {
  const { app, bearer, login, db } = setup();
  const web = await login();
  const t = j(await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'x' } }));
  let r = await app.inject({ method: 'POST', url: '/api/chat', headers: web, payload: { text: 'שלום' } });
  assert.equal(r.statusCode, 201);
  assert.equal(j(r).author, 'owner');
  assert.equal(j(await app.inject({ method: 'GET', url: '/api/status', headers: bearer })).pending_chat, 1);
  r = await app.inject({ method: 'POST', url: '/api/chat', headers: bearer, payload: { text: 'הוספתי משימה', task: String(t.id) } });
  assert.equal(j(r).author, 'claude');
  assert.equal(j(r).tasks[0].id, t.id);
  assert.equal(j(await app.inject({ method: 'GET', url: '/api/status', headers: bearer })).pending_chat, 1);
  const list = j(await app.inject({ method: 'GET', url: '/api/chat', headers: web }));
  assert.deepEqual(list.map((m) => m.author), ['owner', 'claude']);
  // chat is searchable
  assert.equal(j(await app.inject({ method: 'GET', url: '/api/search?kind=chat&q=' + encodeURIComponent('משימה'), headers: bearer })).count, 1);
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'chat')").run(new Date().toISOString());
  assert.equal(j(await app.inject({ method: 'GET', url: '/api/status', headers: bearer })).working, true);
  r = await app.inject({ method: 'POST', url: '/api/run-summary', headers: bearer, payload: { text: 'סיכום' } });
  assert.equal(r.statusCode, 200);
});

test('knowledge: add, supersede keeps the old item but hides it from search', async () => {
  const { app, bearer } = setup();
  const p = j(await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל הנוף' } }));
  const k = j(await app.inject({ method: 'POST', url: '/api/knowledge', headers: bearer, payload: { project: p.id, kind: 'fact', title: 'קבלן החשמל', body: 'אור-נתיב', source: 'chat' } }));
  assert.equal(j(await app.inject({ method: 'GET', url: '/api/search?q=' + encodeURIComponent('אור-נתיב'), headers: bearer })).count, 1);
  const s = j(await app.inject({ method: 'POST', url: `/api/knowledge/${k.id}/supersede`, headers: bearer, payload: { body: 'חשמל-פלוס' } }));
  assert.equal(s.replaced.superseded_by, s.by.id);
  assert.equal(j(await app.inject({ method: 'GET', url: '/api/search?q=' + encodeURIComponent('אור-נתיב'), headers: bearer })).count, 0);
  assert.equal(j(await app.inject({ method: 'GET', url: '/api/search?q=' + encodeURIComponent('חשמל-פלוס'), headers: bearer })).count, 1);
  assert.equal(j(await app.inject({ method: 'GET', url: `/api/knowledge/${k.id}`, headers: bearer })).superseded_by, s.by.id);
  const show = j(await app.inject({ method: 'GET', url: `/api/projects/${p.id}/show`, headers: bearer }));
  assert.equal(show.knowledge.length, 1);
});

test('upload: text is extracted, chunked, searchable by project, never returned whole', async () => {
  const { app, bearer, db } = setup();
  const p = j(await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל הנוף' } }));
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`שורה ${i}: ${i === 250 ? 'קבלן החשמל הוא אור הדוגמה' : 'טקסט רגיל של המפרט'} עם עוד כמה מילים למילוי`);
  const boundary = '----x';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="project"\r\n\r\n${p.id}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="spec.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(lines.join('\n')), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await app.inject({ method: 'POST', url: '/api/files', headers: { ...bearer, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(r.statusCode, 201);
  const f = j(r)[0];
  assert.ok(f.chunk_count >= 3, 'several chunks');
  assert.equal(f.project_id, p.id);
  const sr = j(await app.inject({ method: 'GET', url: `/api/search?kind=chunk&project=${p.id}&q=${encodeURIComponent('אור הדוגמה')}`, headers: bearer }));
  assert.equal(sr.count, 1);
  assert.ok(sr.results[0].snippet.length < 400);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM events WHERE entity=? AND action=?').get('file', 'upload').c === 1);
  const show = j(await app.inject({ method: 'GET', url: `/api/files/${f.id}/show`, headers: bearer }));
  assert.ok(show.preview_chunks.length <= 2);
  const cls = j(await app.inject({ method: 'PATCH', url: `/api/files/${f.id}`, headers: bearer, payload: { summary: 'מפרט הפרויקט' } }));
  assert.equal(cls.summary, 'מפרט הפרויקט');
  const dl = await app.inject({ method: 'GET', url: `/api/files/${f.id}/download`, headers: bearer });
  assert.equal(dl.statusCode, 200);
  // chunk overlap
  const chunks = docs.chunkPages([lines.join('\n')]);
  assert.ok(chunks.length >= 3 && chunks.every((c) => c.text.split(/\s+/).length <= 460));
});

test('email intake: forwarded Hebrew Outlook mail is stored with the ORIGINAL sender and date', () => {
  const { db } = setup();
  const store = createStore(db);
  const msg = {
    message_id: '<m1@x>', from: 'Dana <dana@exconstruct.example>', to: ['assistant@agentmail.example'], subject: 'FW: חריגות בתקציב', timestamp: '2026-11-24T08:00:00Z',
    labels: ['received', 'unread'], attachments: [{ filename: 'budget.xlsx', content_type: 'x', size: 10 }],
    text: 'לטיפולך\n\nמאת: יעל רוזן <yael@exconstruct.example>\nנשלח: יום ראשון, 22 בנובמבר 2026 16:20\nאל: דנה\nנושא: חריגות בתקציב\n\nנא להחזיר תשובה עד חמישי',
  };
  const r = ingestMessage(db, store, msg);
  const e = db.prepare('SELECT * FROM emails WHERE id=?').get(r.id);
  assert.equal(e.forwarded_from, 'יעל רוזן <yael@exconstruct.example>');
  assert.equal(e.forwarded_date, '2026-11-22T14:20:00.000Z');
  assert.equal(JSON.parse(e.attachments)[0].filename, 'budget.xlsx');
  assert.equal(ingestMessage(db, store, msg).created, false);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE entity='email' AND processed_at IS NULL").get());
  assert.ok(db.prepare("SELECT 1 FROM search_index WHERE kind='email'").get());
});

test('email intake: participants are stored, unknown addresses become contacts, known ones are matched by address', () => {
  const { db } = setup();
  const store = createStore(db);
  db.prepare("UPDATE people SET emails='[\"michalg@exconstruct.example\"]' WHERE name_he='מיכל גלעד'").run();
  const r = ingestMessage(db, store, { message_id: '<p1@x>', from: 'Dana <dana@exconstruct.example>', to: ['assistant@agentmail.example'], subject: 'FW: חוזה', timestamp: '2026-11-24T08:00:00Z', labels: ['received'],
    text: 'FYI\n\nמאת: Noa Sharon <noa@lawfirm.example>\nנשלח: Monday, 23 November 2026 17:40\nאל: rachel@utility.example\nעותק: Dana Levi\u200f <dana@exconstruct.example>; Michal Gilad\u200f <michalg@exconstruct.example>\nנושא: חוזה\n\nראי המצורף' });
  const e = db.prepare('SELECT participants, thread FROM emails WHERE id=?').get(r.id);
  const parts = JSON.parse(e.participants);
  assert.equal(parts.length, 4);
  assert.equal(JSON.parse(e.thread)[0].date, '2026-11-23T15:40:00.000Z');
  const people = db.prepare('SELECT name_he, emails FROM people').all();
  assert.ok(people.some((p) => p.name_he === 'Noa Sharon' && p.emails.includes('noa@lawfirm.example')));
  assert.ok(people.some((p) => p.emails.includes('rachel@utility.example')));
  assert.equal(people.filter((p) => p.emails.includes('michalg@exconstruct.example')).length, 1, 'Michal is not duplicated');
  assert.equal(people.filter((p) => p.emails.includes('dana@exconstruct.example')).length, 1, 'the owner is not duplicated');
});

test('email filter: sender, forward subject, DMARC and labels', () => {
  const allow = ['dana@exconstruct.example', 'dana.levi@mail.example'];
  const ok = { labels: ['received'], from: 'K <dana@exconstruct.example>', subject: 'x', authentication_results: { dmarc: { result: 'pass' } } };
  assert.equal(wanted(ok, allow), true);
  assert.equal(wanted({ ...ok, authentication_results: { dmarc: { result: 'fail' } } }, allow), false);
  assert.equal(wanted({ ...ok, labels: ['received', 'mesimot'] }, allow), false);
  assert.equal(wanted({ ...ok, from: 'dana.levi@mail.example', subject: 'שלום' }, allow), false);
  assert.equal(wanted({ ...ok, from: 'dana.levi@mail.example', subject: 'Fwd: שלום' }, allow), true);
  assert.equal(wanted({ ...ok, from: 'evil@x.com', subject: 'FW: שלום' }, allow), false);
});

// ---- file formats
const { buildMsg } = require('./helpers/msg-builder');
const FIX = path.join(__dirname, 'fixtures');
async function upload(app, headers, name, buffer, mime, project) {
  const boundary = '----fx' + Math.random().toString(16).slice(2);
  const parts = [];
  if (project) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="project"\r\n\r\n${project}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`), buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
  const r = await app.inject({ method: 'POST', url: '/api/files', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) });
  assert.equal(r.statusCode, 201, r.body);
  return r.json()[0];
}

test('uploaded .msg becomes an email (real sender and date) and its attachments, even a nested .msg, become files', async () => {
  const { app, bearer: tokenHeaders, db, login } = setup();
  const web = await login();
  const bearer = web;
  const inner = { from_name: 'מיכל גלעד', from_addr: 'michal@example.com', subject: 'הודעה פנימית', body: 'הקבלן אור הדוגמה איחר', date: Date.UTC(2026, 10, 20, 9, 0), attachments: [{ name: 'פנימי.txt', data: Buffer.from('מסמך פנימי בתוך הודעה מקוננת') }] };
  const msg = buildMsg({ from_name: 'יעל רוזן', from_addr: 'yael@exconstruct.example', to: [{ name: 'דנה', addr: 'dana@exconstruct.example' }], subject: 'חריגות בתקציב', body: 'נא להחזיר תשובה עד חמישי', date: Date.UTC(2026, 10, 22, 14, 20),
    attachments: [{ name: 'נתונים.txt', data: Buffer.from('נתוני התקציב של החשמל') }, { name: 'fw.msg', msg: inner }] });
  const f = await upload(app, bearer, 'חריגות.msg', msg, 'application/vnd.ms-outlook');
  assert.ok(f.email_id);
  const e = db.prepare('SELECT * FROM emails WHERE id=?').get(f.email_id);
  assert.equal(e.forwarded_from, 'יעל רוזן <yael@exconstruct.example>');
  assert.equal(e.forwarded_date, '2026-11-22T14:20:00.000Z');
  assert.match(e.body_text, /עד חמישי/);
  // a mail file dropped in the chat waits (staged) until the chat message says whether it is a daily import or a normal upload
  assert.equal(e.import_state, 'staged');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE (entity='email' AND entity_id=?) OR (entity='file' AND entity_id=?)").get(f.email_id, f.id).c, 0);
  const sent = await app.inject({ method: 'POST', url: '/api/chat', headers: { ...bearer, 'content-type': 'application/json' }, payload: JSON.stringify({ text: 'בדוק', file_ids: [f.id] }) });
  assert.equal(sent.statusCode, 201, sent.body);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE entity='email' AND entity_id=? AND processed_at IS NULL").get(f.email_id), 'one file: released to the normal flow');
  assert.equal(db.prepare('SELECT import_state FROM emails WHERE id=?').get(f.email_id).import_state, null);
  const files = db.prepare('SELECT id, original_name, email_id, text_status FROM files ORDER BY id').all();
  assert.deepEqual(files.map((x) => x.original_name), ['חריגות.msg', 'נתונים.txt', 'fw.msg', 'פנימי.txt']);
  assert.ok(files.slice(1, 3).every((x) => x.email_id === f.email_id));
  // the nested message is an email of its own, with its own attachment
  const nested = db.prepare("SELECT * FROM emails WHERE subject='הודעה פנימית'").get();
  assert.equal(nested.forwarded_from, 'מיכל גלעד <michal@example.com>');
  assert.ok(db.prepare("SELECT 1 FROM files WHERE original_name='פנימי.txt'").get());
  // everything is searchable
  const sr = (await app.inject({ method: 'GET', url: '/api/search?q=' + encodeURIComponent('מקוננת'), headers: tokenHeaders })).json();
  assert.ok(sr.results.some((x) => x.kind === 'chunk'));
  // same file again does not create a second email
  const again = await upload(app, bearer, 'חריגות.msg', msg, 'application/vnd.ms-outlook');
  assert.equal(again.email_id, f.email_id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM emails').get().c, 2);
});

test('uploaded .eml that is a forward: the original sender is taken from the forwarded block', async () => {
  const { app, bearer, db } = setup();
  const eml = ['From: "דנה" <dana@exconstruct.example>', 'To: oracle@x.com', 'Subject: =?utf-8?B?' + Buffer.from('FW: הצעת מחיר').toString('base64') + '?=', 'Date: Tue, 24 Nov 2026 08:00:00 +0200',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('לטיפול\n\nמאת: מיכל גלעד <michal@exconstruct.example>\nנשלח: יום שני, 23 בנובמבר 2026 11:30\nאל: דנה\nנושא: הצעת מחיר\n\nנא לבדוק את ההצעה').toString('base64')].join('\r\n');
  const f = await upload(app, bearer, 'x.eml', Buffer.from(eml), 'message/rfc822');
  const e = db.prepare('SELECT * FROM emails WHERE id=?').get(f.email_id);
  assert.equal(e.forwarded_from, 'מיכל גלעד <michal@exconstruct.example>');
  assert.equal(e.forwarded_date, '2026-11-23T09:30:00.000Z');
});

test('office formats: pptx, xlsx are readable; legacy .doc is stored but flagged unreadable', async () => {
  const { app, bearer } = setup();
  const p = await upload(app, bearer, 'summary.pptx', fs.readFileSync(path.join(FIX, 'summary.pptx')));
  assert.equal(p.text_status, 'ok'); assert.equal(p.chunk_count, 2);
  let sr = (await app.inject({ method: 'GET', url: '/api/search?kind=chunk&q=' + encodeURIComponent('קפלן'), headers: bearer })).json();
  assert.equal(sr.count, 1);
  const x = await upload(app, bearer, 'budget.xlsx', fs.readFileSync(path.join(FIX, 'budget.xlsx')));
  assert.equal(x.text_status, 'ok');
  sr = (await app.inject({ method: 'GET', url: '/api/search?kind=chunk&q=' + encodeURIComponent('אינסטלציה'), headers: bearer })).json();
  assert.equal(sr.count, 1);
  const d = await upload(app, bearer, 'old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]));
  assert.equal(d.text_status, 'unsupported'); assert.equal(d.chunk_count, 0);
  assert.equal((await app.inject({ method: 'GET', url: `/api/files/${d.id}/download`, headers: bearer })).statusCode, 200);
});

test('OCR: Hebrew image and a scanned (image-only) PDF are read with tesseract heb+eng', { timeout: 120000 }, async () => {
  const { app, bearer } = setup();
  const img = await upload(app, bearer, 'scan.png', fs.readFileSync(path.join(FIX, 'hebrew-scan.png')), 'image/png');
  assert.equal(img.text_status, 'ocr'); assert.ok(img.chunk_count >= 1);
  let sr = (await app.inject({ method: 'GET', url: '/api/search?kind=chunk&q=' + encodeURIComponent('התקציב'), headers: bearer })).json();
  assert.equal(sr.count, 1);
  const pdf = await upload(app, bearer, 'scan.pdf', fs.readFileSync(path.join(FIX, 'hebrew-scan.pdf')), 'application/pdf');
  assert.equal(pdf.text_status, 'ocr');
  const webp = await upload(app, bearer, 'scan.webp', fs.readFileSync(path.join(FIX, 'hebrew-scan.webp')), 'image/webp');
  assert.equal(webp.text_status, 'ocr');
  const inline = await app.inject({ method: 'GET', url: `/api/files/${img.id}/download?inline=1`, headers: bearer });
  assert.match(inline.headers['content-disposition'], /^inline/);
});

test('project facts: newer supersedes, older is history only, same value confirms, undo restores', async () => {
  const { app, bearer, db } = setup();
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל הדוגמה' } })).json();
  const set = async (b) => (await app.inject({ method: 'POST', url: '/api/facts', headers: bearer, payload: { project: p.id, ...b } })).json();
  let r = await set({ key: 'סטטוס שלד', value: 'קומה 5', as_of: '20/11/2026', source: 'chat:1' });
  assert.equal(r.result, 'created');
  r = await set({ key: 'סטטוס שלד', value: 'קומה 7', as_of: '24/11/2026' });
  assert.equal(r.result, 'superseded');
  r = await set({ key: 'סטטוס שלד', value: 'קומה 3', as_of: '10/11/2026' });
  assert.equal(r.result, 'history_only', 'an older value never replaces a newer one');
  const cur = (await app.inject({ method: 'GET', url: `/api/facts?project=${p.id}`, headers: bearer })).json();
  assert.equal(cur.length, 1); assert.equal(cur[0].value, 'קומה 7'); assert.equal(cur[0].as_of_date, '2026-11-24');
  const hist = (await app.inject({ method: 'GET', url: `/api/facts?project=${p.id}&key=${encodeURIComponent('סטטוס שלד')}`, headers: bearer })).json();
  assert.deepEqual(hist.map((h) => [h.value, h.current]), [['קומה 7', true], ['קומה 5', false], ['קומה 3', false]]);
  // the same value from a newer source only moves the date
  r = await set({ key: 'סטטוס שלד', value: 'קומה 7', as_of: '25/11/2026' });
  assert.equal(r.result, 'confirmed');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM project_facts').get().c, 3);
  // only the current value is searchable
  const found = (await app.inject({ method: 'GET', url: '/api/search?kind=fact&q=' + encodeURIComponent('שלד'), headers: bearer })).json();
  assert.equal(found.count, 1); assert.match(found.results[0].title, /סטטוס שלד/);
  // project show lists the current facts
  const show = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/show`, headers: bearer })).json();
  assert.equal(show.facts[0].key, 'סטטוס שלד');
  // apply: facts in the structured answer
  const ap = (await app.inject({ method: 'POST', url: '/api/apply', headers: bearer, payload: { facts: [{ project: p.id, key: 'דירות', value: '128', as_of: '24/11/2026', source: 'email:0' }] } }));
  assert.equal(ap.statusCode, 400, 'an unknown source email is rejected');
  const ap2 = (await app.inject({ method: 'POST', url: '/api/apply', headers: bearer, payload: { facts: [{ project: p.id, key: 'דירות', value: '128', as_of: '24/11/2026' }] } })).json();
  assert.deepEqual(ap2.facts, ['created']);
});

test('protocols: items stay out of the main board until promoted; promote links a task back', async () => {
  const { app, bearer, db } = setup();
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל הדוגמה' } })).json();
  const r = await app.inject({ method: 'POST', url: '/api/protocols', headers: bearer, payload: {
    project: p.id, date: '24/11/2026 10:30', title: 'ישיבת תיאום שבועית', location: 'אתר מגדל הדוגמה', source: 'chat:1', summary: 'סיכום קצר',
    participants: 'דני לוי (בונה הדוגמה, מנהל עבודה); Moshe Katz <moshek@a.co> (יועץ בטיחות, יו"ר הישיבה)',
    items: [
      { kind: 'action', text: 'להגיש תוכנית פיגומים מעודכנת', owner: 'רון שחר', party: 'internal', due: '01/12/2026', recommended: true },
      { kind: 'action', text: 'הקבלן ישלים בדיקת עומסים', owner: 'דני לוי', party: 'external' },
      { kind: 'decision', text: 'הוחלט להקדים את יציקת קומה 7' },
      { kind: 'info', text: 'פגישה הבאה בעוד שבועיים' }] } });
  assert.equal(r.statusCode, 201, r.body);
  const pr = r.json();
  assert.equal(pr.items.length, 4); assert.equal(pr.recommended, 1); assert.equal(pr.open_actions, 2);
  assert.equal(pr.items[0].recommended, true, 'recommended items come first');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, 0, 'no main tasks were created');
  assert.ok(pr.participants.some((x) => x.email === 'moshek@a.co'));
  assert.ok(db.prepare("SELECT 1 FROM people WHERE emails LIKE '%moshek@a.co%'").get(), 'participants with an email become contacts');
  // searchable
  const found = (await app.inject({ method: 'GET', url: '/api/search?kind=protocol_item&q=' + encodeURIComponent('פיגומים'), headers: bearer })).json();
  assert.equal(found.count, 1); assert.equal(found.results[0].link, `/protocols/${pr.id}`);
  // promote
  const item = pr.items[0];
  const pm = (await app.inject({ method: 'POST', url: `/api/protocol-items/${item.id}/promote`, headers: bearer })).json();
  assert.equal(pm.task.assignee, 'רון שחר'); assert.equal(pm.task.due_date, '2026-12-01'); assert.equal(pm.task.source_date, '2026-11-24T08:30:00.000Z');
  const td = (await app.inject({ method: 'GET', url: `/api/tasks/${pm.task.id}`, headers: bearer })).json();
  assert.equal(td.protocol.protocol_id, pr.id);
  assert.equal((await app.inject({ method: 'POST', url: `/api/protocol-items/${item.id}/promote`, headers: bearer })).statusCode, 400);
  // done / dismiss / bulk
  const list = (await app.inject({ method: 'GET', url: `/api/protocols?project=${p.id}`, headers: bearer })).json();
  assert.equal(list[0].open_actions, 1);
  const many = (await app.inject({ method: 'POST', url: '/api/protocols/promote', headers: bearer, payload: { ids: [pr.items[1].id, item.id] } })).json();
  assert.equal(many.promoted.length, 1); assert.equal(many.skipped.length, 1);
});

test('incoming mail attachments: signature images are skipped, real files go through the pipeline', async () => {
  const { skipAttachment, downloadAttachments } = require('../lib/email');
  assert.equal(skipAttachment({ filename: 'image013.png', content_type: 'image/png', size: 14653 }), true);
  assert.equal(skipAttachment({ filename: 'logo.png', content_type: 'image/png', size: 5000, content_id: 'x' }), true);
  assert.equal(skipAttachment({ filename: 'scan.png', content_type: 'image/png', size: 80000 }), false);
  assert.equal(skipAttachment({ filename: 'spec.pdf', content_type: 'application/pdf', size: 1000 }), false);
  const { db } = setup();
  const store = createStore(db);
  const { createKnowledge } = require('../lib/knowledge');
  const knowledge = createKnowledge(db, store);
  const emailId = db.prepare("INSERT INTO emails (message_id, subject, received_at, body_text) VALUES ('<a@b>','x','2026-11-24T10:00:00Z','x')").run().lastInsertRowid;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (/\/attachments\//.test(url)) return { ok: true, json: async () => ({ download_url: 'https://cdn.example/file' }) };
    return { ok: true, arrayBuffer: async () => Buffer.from('הקבלן אור הדוגמה איחר באספקה') };
  };
  try {
    const saved = await downloadAttachments(db, store, knowledge, emailId, { message_id: '<a@b>', attachments: [
      { attachment_id: 'a1', filename: 'פרוטוקול.txt', content_type: 'text/plain', size: 30 },
      { attachment_id: 'a2', filename: 'image001.png', content_type: 'image/png', size: 9000 }] });
    assert.equal(saved.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM files WHERE email_id=?').get(emailId).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks').get().c, 1);
    const meta = JSON.parse(db.prepare('SELECT attachments FROM emails WHERE id=?').get(emailId).attachments);
    assert.equal(meta[1].skipped, 'inline'); assert.equal(meta[0].text_status, 'ok');
  } finally { global.fetch = realFetch; }
});

test('people: Hebrew display names, Latin alias for matching, merge keeps every link', async () => {
  const { app, bearer, db } = setup();
  const seeds = db.prepare('SELECT name_he, name_en FROM people WHERE name_en IS NOT NULL').all().map((p) => p.name_he + '=' + p.name_en);
  assert.ok(seeds.includes('אבי כהן=Avi Cohen') && seeds.includes('יעל רוזן=Yael Rosen'));
  // lookup by the Latin alias
  let r = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'x', requester: 'Avi Cohen' } });
  assert.equal(r.json().requester, 'אבי כהן');
  // a Latin-only contact, then transliteration keeps the Latin as the alias
  const c = (await app.inject({ method: 'POST', url: '/api/people', headers: bearer, payload: { name: 'Moshe Dayan', emails: 'moshe@a.co' } })).json();
  assert.equal(c.name_en, 'Moshe Dayan');
  const u = (await app.inject({ method: 'PATCH', url: `/api/people/${c.id}`, headers: bearer, payload: { name: 'משה דיין' } })).json();
  assert.equal(u.name_he, 'משה דיין'); assert.equal(u.name_en, 'Moshe Dayan');
  // duplicate Latin contact merges into the Hebrew one, tasks and addresses follow
  const dup = (await app.inject({ method: 'POST', url: '/api/people', headers: bearer, payload: { name: 'Avi Ben-David', emails: 'avib@a.co' } })).json();
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'y', requester: dup.id } })).json();
  const m = await app.inject({ method: 'POST', url: `/api/people/${dup.id}/merge`, headers: bearer, payload: { into: 'אבי כהן' } });
  assert.equal(m.statusCode, 200);
  assert.ok(m.json().emails.includes('avib@a.co'));
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).json().requester, 'אבי כהן');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM people WHERE name_he='Avi Ben-David'").get().c, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/people/1/merge', headers: bearer, payload: { into: 'רון שחר' } })).statusCode, 400);
  // a new address of a known person is added to him, not turned into a duplicate contact
  const { ensureContacts } = require('../lib/email');
  const store = createStore(db);
  ensureContacts(db, store, [{ name: 'Yael Rosen', email: 'arnonf@new.co' }]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM people WHERE name_en='Yael Rosen' OR name_he='Yael Rosen'").get().c, 1);
  assert.ok(JSON.parse(db.prepare("SELECT emails FROM people WHERE name_he='יעל רוזן'").get().emails).includes('arnonf@new.co'));
});

test('the same protocol from the same source is stored once; a retry fills in missing items', async () => {
  const { app, bearer, db } = setup();
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל' } })).json();
  const body = { project: p.id, date: '24/11/2026 09:00', title: 'ישיבה', source: 'chat:7' };
  const a = (await app.inject({ method: 'POST', url: '/api/protocols', headers: bearer, payload: body })).json();
  const b = (await app.inject({ method: 'POST', url: '/api/protocols', headers: bearer, payload: { ...body, title: 'ישיבה (שוב)', items: [{ kind: 'action', text: 'לבצע' }] } })).json();
  assert.equal(a.id, b.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM protocols').get().c, 1);
  assert.equal(b.items.length, 1);
  // through apply, in one call
  const ap = await app.inject({ method: 'POST', url: '/api/apply', headers: bearer, payload: { protocols: [{ project: p.id, date: '25/11/2026 10:00', title: 'ישיבה ב', source: 'chat:8', items: [{ kind: 'action', text: 'א' }, { kind: 'decision', text: 'ב' }] }] } });
  assert.equal(ap.statusCode, 200, ap.body);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM protocol_items').get().c, 3);
});

test('apply: Hebrew names for contacts in one call', async () => {
  const { app, bearer, db } = setup();
  const c = (await app.inject({ method: 'POST', url: '/api/people', headers: bearer, payload: { name: 'Moshe Dayan', emails: 'moshe@a.co' } })).json();
  const r = await app.inject({ method: 'POST', url: '/api/apply', headers: bearer, payload: { people: [{ id: c.id, name: 'משה דיין', name_en: 'Moshe Dayan' }] } });
  assert.equal(r.statusCode, 200, r.body);
  const p = db.prepare('SELECT name_he, name_en FROM people WHERE id=?').get(c.id);
  assert.deepEqual([p.name_he, p.name_en], ['משה דיין', 'Moshe Dayan']);
});
