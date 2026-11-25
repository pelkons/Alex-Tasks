'use strict';
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_NO_BG = '1';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-impm-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createImporter } = require('../lib/importer');
const mailLayer = require('../lib/mail');
const email = require('../lib/email');

const OWNER = 'dana@exconstruct.example';
const eml = (o) => Buffer.from([`From: ${o.from}`, `To: ${o.to || OWNER}`, `Subject: ${o.subject}`, `Date: ${o.date}`, `Message-ID: <${o.id}>`, o.reply ? `In-Reply-To: <${o.reply}>` : '', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', o.body || 'שלום'].filter((x) => x !== '').join('\r\n'), 'utf8');
function outer(id, subject, parts) {
  return { message_id: id, from: `Dana <${OWNER}>`, to: ['assistant@proton.example'], subject, text: 'מצורפים מיילי אתמול', timestamp: new Date().toISOString(), labels: ['received'], authentication_results: { dmarc: 'pass' },
    attachments: parts.map((p, i) => ({ filename: p.filename, content_type: p.type, size: p.buf.length, attachment_id: String(i) })), _parts: parts };
}
function fake(msgs) {
  const calls = [];
  return { name: 'imap', address: 'assistant@proton.example', calls, async listNew() { return msgs; }, async fetch(id) { return msgs.find((m) => m.message_id === id); },
    async attachment(id, attId) { return msgs.find((m) => m.message_id === id)._parts[+attId].buf; }, async addLabel(id, l) { calls.push(['label', id, l]); }, async markDone() {}, async list() { return []; } };
}
const install = (p) => { const o = { get: mailLayer.get, all: mailLayer.all, byName: mailLayer.byName }; mailLayer.get = () => p; mailLayer.all = () => [p]; mailLayer.byName = () => p; return () => Object.assign(mailLayer, o); };

test('one email from the owner with 22 attached messages (rfc822 parts and .msg names) is a daily import; siblings merge; the outer mail is not a task', async () => {
  process.env.MESIMOT_IMPORT_QUIET_S = '0';
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store);
  const A = [], B = [];
  for (let i = 0; i < 16; i++) A.push({ filename: i % 4 === 0 ? `msg${i}.eml` : undefined, type: 'message/rfc822', buf: eml({ from: `Contractor ${i} <c${i}@contractor.example>`, subject: `נושא ${i}`, id: `m${i}@c.example`, date: 'Tue, 24 Nov 2026 10:00:00 +0200', body: `גוף ${i}` }) });
  A.push({ filename: 'reply.eml', type: 'message/rfc822', buf: eml({ from: `Dana <${OWNER}>`, to: 'c0@contractor.example', subject: 'RE: נושא 0', id: 'r0@exconstruct.example', reply: 'm0@c.example', date: 'Tue, 24 Nov 2026 15:00:00 +0200', body: 'שלחתי' }) });
  A.push({ filename: 'logo.png', type: 'image/png', buf: Buffer.from('x') }); // not a mail part
  for (let i = 0; i < 4; i++) B.push({ filename: `late${i}.eml`, type: 'message/rfc822', buf: eml({ from: `Other ${i} <o${i}@other.example>`, subject: `מאוחר ${i}`, id: `late${i}@o.example`, date: 'Tue, 24 Nov 2026 17:00:00 +0200' }) });
  B.push({ filename: 'dup.eml', type: 'message/rfc822', buf: eml({ from: 'Contractor 1 <c1@contractor.example>', subject: 'נושא 1', id: 'm1@c.example', date: 'Tue, 24 Nov 2026 10:00:00 +0200', body: 'גוף 1' }) }); // the same message in both parts
  const m1 = outer('<out1@x>', 'ייבוא 1/2', A), m2 = outer('<out2@x>', 'ייבוא 2/2', B);
  const prov = fake([m1, m2]); const undo = install(prov);
  try {
    const taken = await email.pollOnce(db, store, () => {}, knowledge);
    assert.equal(taken.length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM imports').get().c, 1, 'two outer mails within the window: ONE import');
    const imp = db.prepare('SELECT * FROM imports').get(); assert.equal(imp.status, 'collecting');
    const st = JSON.parse(imp.stats); assert.equal(st.outer, 2); assert.equal(st.parts, 22, 'parts counted per attached message (the picture is not one)');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE import_state='outer' AND processed_at IS NOT NULL").get().c, 2, 'outer mails: acknowledged, never processed');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE import_state='staged' AND import_id=?").get(imp.id).c, 21, '22 parts, one message twice = 21');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='email' AND processed_at IS NULL").get().c, 0, 'no event wakes a normal run');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE processed_at IS NULL AND import_state IS NULL").get().c, 0);
    assert.deepEqual(prov.calls.filter((c) => c[0] === 'label').map((c) => c[1]), ['<out1@x>', '<out2@x>']);
    // the card
    const importer = createImporter({ db, store, knowledge, chat: null });
    assert.equal(importer.progress(imp.id).outer, 2); assert.equal(importer.progress(imp.id).parts, 22);
    // no new part for the quiet period: the pipeline starts
    importer.releaseCollecting(); assert.equal(db.prepare('SELECT status FROM imports').get().status, 'staging');
    await importer.stage(imp.id); importer.dedupe(imp.id); importer.applyNoise(imp.id); importer.buildThreads(imp.id);
    const p = importer.progress(imp.id); assert.equal(p.total, 21);
    assert.equal(db.prepare("SELECT direction FROM emails WHERE msgid='r0@exconstruct.example'").get().direction, 'sent', 'the owner\'s message inside the batch is SENT');
    assert.equal(db.prepare("SELECT direction FROM emails WHERE msgid='m0@c.example'").get().direction, 'received');
    assert.equal(db.prepare("SELECT thread_no FROM emails WHERE msgid='m0@c.example'").get().thread_no, db.prepare("SELECT thread_no FROM emails WHERE msgid='r0@exconstruct.example'").get().thread_no, 'the reply joins its thread');
  } finally { undo(); delete process.env.MESIMOT_IMPORT_QUIET_S; }
});

test('1 to 3 attached messages stay a normal forward; the quiet period holds the batch back', async () => {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store);
  const parts = [0, 1].map((i) => ({ filename: `a${i}.eml`, type: 'message/rfc822', buf: eml({ from: 'x@y.example', subject: `ס ${i}`, id: `s${i}@y.example`, date: 'Tue, 24 Nov 2026 10:00:00 +0200' }) }));
  const undo = install(fake([outer('<few@x>', 'FW: שני מיילים', parts)]));
  try {
    await email.pollOnce(db, store, () => {}, knowledge);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM imports').get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE import_state IS NULL").get().c >= 1, true);
  } finally { undo(); }
  // a batch inside the 10-minute quiet period is not released
  const imp = createImporter({ db, store, knowledge, chat: null });
  const id = db.prepare("INSERT INTO imports (created_at, status, stats) VALUES (?, 'collecting', ?)").run(new Date().toISOString(), JSON.stringify({ source: 'mail', last_part_at: new Date().toISOString() })).lastInsertRowid;
  imp.releaseCollecting(); assert.equal(db.prepare('SELECT status FROM imports WHERE id=?').get(id).status, 'collecting');
  assert.equal(imp.active(), undefined, 'a collecting batch is not picked up by the driver');
});
