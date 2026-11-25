'use strict';
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_NO_BG = '1';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-imp-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createImporter, noiseReason } = require('../lib/importer');

const OWNER = 'dana@exconstruct.example';
function eml({ from, to = OWNER, subject, id, reply, refs, date, body = 'שלום, גוף המייל', extra = '' }) {
  return Buffer.from([`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${date}`, `Message-ID: <${id}>`, reply ? `In-Reply-To: <${reply}>` : '', refs ? `References: ${refs.map((r) => `<${r}>`).join(' ')}` : '', extra, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].filter((x) => x !== '').join('\r\n').replace('\r\n\r\n', '\r\n\r\n'), 'utf8');
}
function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const imp = createImporter({ db, store, knowledge, chat }); store.hooks.importIntake = imp.intake; store.hooks.importProgress = imp.progress;
  const owner = store.ownerId();
  const drop = async (name, buf) => (await knowledge.saveUpload(owner, { name, mime: 'message/rfc822', buffer: buf, source: 'web' })).id;
  return { db, store, knowledge, chat, imp, owner, drop };
}

test('noise is decided by code: newsletters, auto-replies, out of office, calendar responses, receipts, no-reply', () => {
  assert.match(noiseReason({ subject: 'x', headers: { 'list-unsubscribe': '<mailto:u@x>' } }), /ידיעון/);
  assert.match(noiseReason({ subject: 'Re: x', headers: { 'auto-submitted': 'auto-replied' } }), /אוטומטי/);
  assert.match(noiseReason({ subject: 'מחוץ למשרד: חזרה ב-30', headers: {} }), /מחוץ למשרד/);
  assert.match(noiseReason({ subject: 'Accepted: ישיבת תיאום', headers: {} }), /יומן/);
  assert.match(noiseReason({ subject: 'התקבל: ישיבה', headers: {} }), /יומן/);
  assert.match(noiseReason({ subject: 'Undeliverable: x', headers: {} }), /מסירה/);
  assert.match(noiseReason({ subject: 'חשבונית', from: 'no-reply@vendor.com', headers: {} }), /no-reply/);
  assert.equal(noiseReason({ subject: 'בקשה להצעת מחיר', from: 'sara@firm.example', headers: {} }), null);
});

test('more than 3 mail files, a zip of them, or "ייבוא יומי" make one import card instead of a message per file; 1-3 files stay normal', async () => {
  const { db, imp, chat, owner, drop, store } = setup();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await drop(`m${i}.eml`, eml({ from: 'a@x.co', subject: `נושא ${i}`, id: `m${i}@x.co`, date: 'Tue, 24 Nov 2026 10:0' + i + ':00 +0200' })));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE import_state='staged'").get().c, 4);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity IN ('email','file')").get().c, 0, 'staged mail makes no events');
  const msg = chat.sendChat(owner, { text: '', file_ids: ids });
  assert.ok(msg.import && msg.import.total === 4, JSON.stringify(msg.import));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE author='owner'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='chat'").get().c, 0, 'the card does not wake a chat run');
  // 2 files: the normal flow
  const two = [await drop('n1.eml', eml({ from: 'b@x.co', subject: 'רגיל 1', id: 'n1@x.co', date: 'Tue, 24 Nov 2026 11:00:00 +0200' })), await drop('n2.eml', eml({ from: 'b@x.co', subject: 'רגיל 2', id: 'n2@x.co', date: 'Tue, 24 Nov 2026 11:05:00 +0200' }))];
  const m2 = chat.sendChat(owner, { text: 'תבדוק', file_ids: two });
  assert.equal(m2.import, null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE import_state IS NULL AND id IN (SELECT email_id FROM files WHERE id IN (?,?))").get(...two).c, 2, 'released to the normal flow');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='email'").get().c >= 2);
  // the words "ייבוא יומי" with one file
  const one = [await drop('z.eml', eml({ from: 'c@x.co', subject: 'אחד', id: 'z@x.co', date: 'Tue, 24 Nov 2026 12:00:00 +0200' }))];
  assert.ok(chat.sendChat(owner, { text: 'ייבוא יומי', file_ids: one }).import);
  void store;
});

test('pipeline: real headers and direction, dedupe against forwarded copies and inside the batch, noise, threads, triage, order of work', async () => {
  const { db, imp, chat, owner, drop, store } = setup();
  // an earlier forwarded copy of a mail (different Message-ID, original sender + date + subject in the body)
  db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, forwarded_from, forwarded_date, original_subject) VALUES ('<fwd1@proton>','dana@exconstruct.example','FW: הצעת מחיר פיגומים','2026-11-24T09:00:00Z','x','Sara Cohen <sara@firm.example>','2026-11-24T08:00:00.000Z','הצעת מחיר פיגומים')").run();
  const files = [
    ['a1.eml', eml({ from: 'Sara Cohen <sara@firm.example>', subject: 'הצעת מחיר פיגומים', id: 'a1@firm.example', date: 'Tue, 24 Nov 2026 10:00:00 +0200' })], // = the forwarded copy
    ['t1.eml', eml({ from: 'Moshe <moshe@contractor.example>', subject: 'תוכנית יציקות', id: 't1@c.example', date: 'Tue, 24 Nov 2026 09:00:00 +0200', body: 'נא לשלוח תוכנית יציקות עד חמישי' })],
    ['t2.eml', eml({ from: `Dana <${OWNER}>`, to: 'moshe@contractor.example', subject: 'RE: תוכנית יציקות', id: 't2@exconstruct.example', reply: 't1@c.example', refs: ['t1@c.example'], date: 'Tue, 24 Nov 2026 14:00:00 +0200', body: 'שלחתי לך את התוכנית בצרופה' })],
    ['t2dup.eml', eml({ from: `Dana <${OWNER}>`, to: 'moshe@contractor.example', subject: 'RE: תוכנית יציקות', id: 't2@exconstruct.example', reply: 't1@c.example', date: 'Tue, 24 Nov 2026 14:00:00 +0200' })], // same Message-ID inside the batch
    ['n1.eml', eml({ from: 'News <news@vendor.com>', subject: 'מבצע חורף', id: 'n1@v.com', date: 'Tue, 24 Nov 2026 07:00:00 +0200', extra: 'List-Unsubscribe: <mailto:u@vendor.com>' })],
    ['o1.eml', eml({ from: 'Rina <rina@firm.example>', subject: 'Automatic reply: פגישה', id: 'o1@f.example', date: 'Tue, 24 Nov 2026 07:30:00 +0200', extra: 'Auto-Submitted: auto-replied' })],
    ['c1.eml', eml({ from: 'Rina <rina@firm.example>', subject: 'Accepted: ישיבת תיאום', id: 'c1@f.example', date: 'Tue, 24 Nov 2026 08:30:00 +0200' })],
    ['u1.eml', eml({ from: 'Yossi <yossi@y.example>', subject: 'שאלה על אישור', id: 'u1@y.example', date: 'Tue, 24 Nov 2026 13:00:00 +0200' })],
  ];
  const ids = []; for (const [n, b] of files) ids.push(await drop(n, b));
  const card = chat.sendChat(owner, { text: 'ייבוא יומי', file_ids: ids });
  const importId = card.import_id;
  await imp.stage(importId);
  const e = (id) => db.prepare('SELECT * FROM emails WHERE id=(SELECT email_id FROM files WHERE id=?)').get(id);
  assert.equal(e(ids[2]).direction, 'sent'); assert.equal(e(ids[1]).direction, 'received');
  assert.equal(e(ids[1]).msgid, 't1@c.example'); assert.deepEqual(JSON.parse(e(ids[2]).refs), ['t1@c.example']); assert.equal(e(ids[2]).in_reply_to, 't1@c.example');
  imp.dedupe(importId); imp.applyNoise(importId);
  assert.equal(e(ids[0]).import_state, 'dup', 'forwarded copy matched by sender + minute + subject');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE msgid='t2@exconstruct.example'").get().c, 1, 'the same Message-ID dropped twice is one mail');
  assert.equal(e(ids[0]).dup_of, 1);
  for (const i of [4, 5, 6]) assert.equal(e(ids[i]).import_state, 'noise', files[i][0]);
  const threads = imp.buildThreads(importId);
  assert.equal(threads, 2, 'the reply joins its thread by In-Reply-To; the other mail is alone');
  assert.equal(e(ids[1]).thread_no, e(ids[2]).thread_no);
  const items = imp.triageItems(importId); assert.equal(items.length, 2); assert.ok(items.find((t) => t.sent_by_owner));
  imp.applyTriage(importId, { [e(ids[7]).thread_no]: 'fyi', [e(ids[1]).thread_no]: 'noise' }); // noise for a thread with the owner's mail is overruled
  assert.equal(e(ids[1]).import_state, 'fyi');
  const w1 = imp.nextWork(importId); assert.equal(w1.kind, 'fyi'); assert.deepEqual(w1.emails.map((x) => x.msgid), ['t1@c.example', 't2@exconstruct.example', 'u1@y.example'].filter((x) => w1.emails.some((y) => y.msgid === x)));
  const p = imp.progress(importId); assert.equal(p.total, 7); assert.equal(p.dup, 1); assert.equal(p.noise, 3); assert.equal(p.processed, 4);
  imp.markDone(w1.emails.map((x) => x.id)); assert.equal(imp.progress(importId).processed, 7); assert.equal(imp.nextWork(importId), null);
  void store;
});

test('a zip of mail files is opened and its mails join the import', async () => {
  const { db, imp, chat, owner, knowledge } = setup();
  const JSZip = require('jszip'); const z = new JSZip();
  for (let i = 0; i < 3; i++) z.file(`day/m${i}.eml`, eml({ from: 'a@x.co', subject: `זיפ ${i}`, id: `z${i}@x.co`, date: 'Tue, 24 Nov 2026 10:0' + i + ':00 +0200' }));
  const buf = await z.generateAsync({ type: 'nodebuffer' });
  const f = await knowledge.saveUpload(owner, { name: 'אתמול.zip', mime: 'application/zip', buffer: buf, source: 'web' });
  const card = chat.sendChat(owner, { text: '', file_ids: [f.id] });
  assert.ok(card.import, 'a zip with mail inside is an import');
  await imp.stage(card.import_id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE import_id=? AND import_state='parsed'").get(card.import_id).c, 3);
});
