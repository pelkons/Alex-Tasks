'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createEntities } = require('../lib/entities');
const { createGate } = require('../lib/gate');
const { createSearch } = require('../lib/search');
const { createAsk } = require('../lib/ask');
const { createTrace } = require('../lib/trace');
const { createContext } = require('../lib/context');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store);
  const a = store.assistantId();
  const proj = store.createProject(store.ownerId(), { name: 'מגדל הדוגמה', aliases: [] });
  const em = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text) VALUES ('m1','x@y.co','FW: הוצאה לחתימות','2026-11-20T08:00:00Z','צירפתי את החוזה')").run().lastInsertRowid;
  const fid = db.prepare("INSERT INTO files (original_name, path, source, created_at, email_id, project_id, text_status) VALUES ('הוצאה לחתימות מגדל הדוגמה.pdf','/x','email',?,?,?, 'ok')").run(new Date().toISOString(), em, proj.id).lastInsertRowid;
  db.prepare('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)').run(fid, 0, 'סעיף 9.1 התמורה עבור החדר, קרקע ובנייה לשנאי אחד, תעמוד על 182,643.30 ש"ח בתוספת מע"מ.', 5);
  db.prepare('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)').run(fid, 1, 'המוכר ימסור את החדר עד סוף השנה ויישא בהוצאות הרישום.', 6);
  const searcher = createSearch(db); const trace = createTrace(db);
  const asker = createAsk({ db, store, knowledge, searcher, semantic: null, trace });
  return { db, store, knowledge, a, proj, em, fid, searcher, trace, asker };
}

test('ask expands the owner\'s words with domain synonyms (טרפו -> שנאי, ערך -> תמורה)', () => {
  const { asker } = setup();
  const ph = asker.expand('מה ערך החוזה של חדר טרפו במגדל הדוגמה?').map((x) => x.q).join(' | ');
  assert.match(ph, /שנאי/); assert.match(ph, /תמורה/);
});

test('ask finds the contract chunk that uses other words, with file name, page and the attachments of the email', async () => {
  const { asker } = setup();
  const r = await asker.ask({ q: 'מה ערך החוזה של חדר טרפו במגדל הדוגמה?' });
  assert.equal(r.project.name, 'מגדל הדוגמה');
  const c = r.results.find((x) => x.kind === 'chunk' && /182,643/.test(x.text));
  assert.ok(c, JSON.stringify(r.results.map((x) => x.kind)));
  assert.equal(c.page, 5); assert.match(c.file, /הוצאה לחתימות/);
  assert.ok(r.phrasings.length >= 3);
});

test('the context block lists the attachments of the related emails and projects', async () => {
  const { db, store, knowledge, searcher, em } = setup();
  const ctx = createContext({ db, store, knowledge, threads: { candidateTasks: () => [], relatedEmails: () => [], emailGist: () => '', taskCorrespondence: () => [] }, searcher, semantic: null });
  const out = await ctx.gather({ emails: [db.prepare('SELECT * FROM emails WHERE id=?').get(em)] });
  assert.match(out.block, /\[file \d+\] attached to email 1.*הוצאה לחתימות מגדל הדוגמה\.pdf.*2 chunks.*NO SUMMARY YET/);
});

test('"not found" is accepted only after the full search ladder, then only with a next step', async () => {
  const { db, store, knowledge, a, proj, fid, searcher, trace, asker } = setup();
  const gate = createGate({ db, store, knowledge, entities: createEntities(db, store) });
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'chat')").run(new Date(Date.now() - 1000).toISOString()).lastInsertRowid;
  const chat = require('../lib/chat').createChat(db, store, knowledge);
  const Q = { id: 1, text: 'מה ערך החוזה של חדר טרפו במגדל הדוגמה?', created_at: new Date().toISOString() };
  chat.sendChat(a, { text: 'לא מצאתי במידע שלי את הערך.' });
  let v = (await gate.check(run, { chats: [Q] })).filter((x) => x.code === 'notfound');
  assert.equal(v.length, 1);
  assert.match(v[0].question, /mesimot ask/); assert.match(v[0].question, /כרטיס הפרויקט/); assert.match(v[0].question, new RegExp(`קובץ ${fid}`)); assert.match(v[0].question, /היסטוריית הצ׳אט/);
  // do the ladder
  await asker.ask({ q: Q.text }); trace.log('chat_list', '{}'); trace.log('search', 'חדר שנאים תמורה'); trace.log('search', 'מגדל הדוגמה חוזה');
  db.prepare("UPDATE claude_runs SET finished_at=NULL WHERE id=?").run(run);
  v = (await gate.check(run, { chats: [Q] })).filter((x) => x.code === 'notfound');
  assert.equal(v.length, 1); assert.match(v[0].question, /הצעד הבא/); // ladder complete, but no next step offered
  chat.sendChat(a, { text: 'עדיין לא מצאתי. כדאי לשאול את אבי או להעלות את החוזה החתום.' });
  v = (await gate.check(run, { chats: [Q] })).filter((x) => x.code === 'notfound');
  assert.equal(v.length, 0);
  void proj; void searcher;
});

test('a reply that found the answer is never questioned', async () => {
  const { db, store, knowledge, a } = setup();
  const gate = createGate({ db, store, knowledge, entities: createEntities(db, store) });
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'chat')").run(new Date(Date.now() - 1000).toISOString()).lastInsertRowid;
  require('../lib/chat').createChat(db, store, knowledge).sendChat(a, { text: 'התמורה היא 182,643.30 ש"ח + מע"מ (קובץ 1, עמוד 5).' });
  assert.equal((await gate.check(run, { chats: [{ id: 1, text: 'מה הערך?', created_at: new Date().toISOString() }] })).filter((x) => x.code === 'notfound').length, 0);
});

test('thin or numeric OCR text marks a file as "text poor" so the assistant must look at the file itself', () => {
  const { db, knowledge, fid } = setup();
  assert.equal(knowledge.textPoor(fid), false);
  const img = db.prepare("INSERT INTO files (original_name, path, mime, source, created_at, text_status) VALUES ('image.png','/tmp/x.png','image/png','email',?, 'ocr')").run(new Date().toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)').run(img, 0, 'Si ruc iU הז', 1);
  assert.equal(knowledge.textPoor(img), true);
  const drawing = db.prepare("INSERT INTO files (original_name, path, mime, source, created_at, text_status) VALUES ('תרשים.pdf','/tmp/d.pdf','application/pdf','email',?, 'ok')").run(new Date().toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)').run(drawing, 0, '1234\n10\n9\nשמ\n1000.0000\n2000.0000\n= 17\n01/02/2026\n555\n640\n410', 1);
  assert.equal(knowledge.textPoor(drawing), true);
  assert.equal(knowledge.showFile(img).view_path, '/tmp/x.png');
  assert.equal(knowledge.showFile(fid).view_path, undefined);
});
