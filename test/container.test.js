'use strict';
// Regression: a classic-Outlook "forward as attachment" saved as ONE .msg holds dozens of EMBEDDED messages (attachMethod 5). They used to be stored as
// extension-less, unreadable files and nothing was imported. Now the container is only acknowledged and each embedded message feeds the import.
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_NO_BG = '1';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-cont-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createImporter } = require('../lib/importer');
const { parseMailFile } = require('../lib/mailfile');
const { buildMsg } = require('./helpers/msg-builder');

const inner = (i, from, addr, extra = {}) => ({ from_name: from, from_addr: addr, to: [{ name: 'דנה', addr: 'dana@exconstruct.example' }], subject: `נושא ${i}`, body: `גוף ההודעה ${i}`, date: Date.UTC(2026, 10, 10 + (i % 12), 9, i), ...extra });
// the structure of the real files: embedded messages whose display name is the subject WITHOUT an extension, plus a tiny signature picture
const container = (n = 6) => buildMsg({ subject: '', body: '', attachments: [
  ...Array.from({ length: n }, (_, i) => ({ name: `Re: פגישת תאום ${i} - חניון`, msg: inner(i, i % 3 === 0 ? 'דנה לוי' : `ספק ${i}`, i % 3 === 0 ? 'dana@exconstruct.example' : `s${i}@supplier.example`) })),
  { name: 'image001.png', data: Buffer.alloc(2000, 1), mime: 'image/png' } ] });

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const imp = createImporter({ db, store, knowledge, chat }); store.hooks.importIntake = imp.intake; store.hooks.importProgress = imp.progress;
  return { db, store, knowledge, chat, imp, owner: store.ownerId() };
}

test('embedded messages are recognised and named .msg (they used to have no extension)', async () => {
  const m = await parseMailFile(container(), 'x.msg');
  const emb = m.attachments.filter((a) => a.embedded);
  assert.equal(emb.length, 6);
  assert.ok(emb.every((a) => /\.msg$/.test(a.name) && a.mime === 'application/vnd.ms-outlook'), emb.map((a) => a.name).join(' | '));
  assert.equal(m.attachments.length, 7); // the picture is an ordinary attachment
});

test('a container .msg: only acknowledged; its embedded messages become staged emails (real sender, no extension-less files); the picture is skipped; one import', async () => {
  const { db, knowledge, chat, imp, owner } = setup();
  const c0 = db.prepare("SELECT COUNT(*) c FROM people WHERE role='contact'").get().c;
  const f = await knowledge.saveUpload(owner, { name: '261122.msg', mime: 'application/vnd.ms-outlook', buffer: container(), source: 'web' });
  const outer = db.prepare('SELECT * FROM emails WHERE id=?').get(f.email_id);
  assert.equal(outer.import_state, 'container'); assert.ok(outer.processed_at, 'the container is never processed');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM emails WHERE import_state='staged' AND container_id=?").get(outer.id).c, 6);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM files WHERE original_name NOT LIKE '%.%'").get().c, 0, 'no extension-less file rows');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM files WHERE original_name LIKE 'image001%'").get().c, 0, 'signature picture skipped');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events WHERE entity IN (\'email\',\'file\')').get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM people WHERE role='contact'").get().c, c0, 'no contacts for staged mail');
  // dropping the container into the chat is an import even though it is ONE file
  const card = chat.sendChat(owner, { text: '', file_ids: [f.id] });
  assert.ok(card.import, 'one container file = a daily import');
  await imp.stage(card.import_id);
  const p = imp.progress(card.import_id);
  assert.equal(p.total, 6, 'the container itself is not counted');
  const rows = db.prepare("SELECT from_addr, direction FROM emails WHERE import_id=? AND import_state='parsed' ORDER BY id").all(card.import_id);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => /@/.test(r.from_addr)), 'real From of each embedded message');
  assert.equal(rows.filter((r) => r.direction === 'sent').length, 2, 'the owner\'s own messages are SENT');
  imp.dedupe(card.import_id); imp.applyNoise(card.import_id); imp.buildThreads(card.import_id);
  imp.applyTriage(card.import_id, {});
  assert.ok(db.prepare("SELECT COUNT(*) c FROM people WHERE role='contact'").get().c > c0, 'contacts appear after triage, for relevant mail only');
});

test('several containers uploaded together form ONE import; the next work comes in chronological order', async () => {
  const { db, knowledge, chat, imp, owner } = setup();
  const ids = [];
  for (const n of ['261110-11.msg', '261112-15.msg']) ids.push((await knowledge.saveUpload(owner, { name: n, mime: 'application/vnd.ms-outlook', buffer: container(5), source: 'web' })).id);
  const card = chat.sendChat(owner, { text: 'ייבוא יומי', file_ids: ids });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM imports').get().c, 1);
  await imp.stage(card.import_id); imp.dedupe(card.import_id); // the second container repeats the same messages: duplicates are linked, not processed again
  const p = imp.progress(card.import_id);
  assert.equal(p.total, 5 + 0 * 5, 'identical messages in two containers are stored once');
  imp.applyNoise(card.import_id); imp.buildThreads(card.import_id); imp.applyTriage(card.import_id, {});
  const w = imp.nextWork(card.import_id);
  const dates = w.emails.map((e) => e.mail_date); assert.deepEqual(dates, [...dates].sort());
});
