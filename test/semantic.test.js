'use strict';
// Uses the real multilingual-e5-small model (cached in ./models after the first run).
process.env.MESIMOT_SEMANTIC = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');

const TOKEN = 't-sem';
test('semantic and hybrid search: "עלויות" finds a chunk about "תקציב"', { timeout: 180000 }, async () => {
  const db = open(':memory:');
  auth.setPassword(db, 'correct horse battery');
  const app = build({ db, token: TOKEN, loginDelayMs: 0 });
  const h = { authorization: `Bearer ${TOKEN}` };
  db.prepare("INSERT INTO files (original_name, path, size, source, created_at) VALUES ('spec.pdf','/x',1,'web','2026-11-20T10:00:00Z')").run();
  const ins = db.prepare('INSERT INTO chunks (file_id, idx, text, page) VALUES (1,?,?,1)');
  ins.run(0, 'התקציב הכולל של הפרויקט הוא 412 מיליון שקל. עבודות שלד ובטון 148 מיליון, חשמל ותקשורת 36 מיליון, חזיתות 41 מיליון.');
  ins.run(1, 'קבלן החשמל הוא חברת אור הדוגמה. מנהל העבודה מטעמו הוא משה דיין והוא נמצא באתר מדי יום.');
  ins.run(2, 'סיור בטיחות שבועי נערך בכל יום שלישי בשעה שמונה בבוקר, וכל עובד חייב באישור בטיחות בתוקף.');
  ins.run(3, 'ישיבת הנהלה רבעונית מתקיימת ביום חמישי הראשון של החודש בשעה עשר במשרדי המזמין.');
  // keyword search cannot find it: the word "עלויות" is nowhere in the text
  const kw = (await app.inject({ method: 'GET', url: '/api/search?mode=keyword&q=' + encodeURIComponent('עלויות'), headers: h })).json();
  assert.equal(kw.count, 0);
  // index in the background (here: run the batches directly)
  let n = 0; while (await app.semantic.indexBatch(8)) n++;
  assert.ok(n >= 1);
  const st = (await app.inject({ method: 'GET', url: '/api/semantic/status', headers: h })).json();
  assert.equal(st.pending, 0); assert.ok(st.indexed_items >= 4);
  const r = (await app.inject({ method: 'GET', url: '/api/search?kind=chunk&q=' + encodeURIComponent('עלויות'), headers: h })).json();
  assert.equal(r.mode, 'hybrid');
  assert.match(r.results[0].snippet, /התקציב הכולל/, 'the budget chunk ranks first');
  assert.equal(r.results[0].via, 'semantic');
  const r2 = (await app.inject({ method: 'GET', url: '/api/search?kind=chunk&q=' + encodeURIComponent('מתי נפגשת ההנהלה'), headers: h })).json();
  assert.match(r2.results[0].snippet, /ישיבת הנהלה/);
  // a keyword hit is found by both layers and ranks first
  const r3 = (await app.inject({ method: 'GET', url: '/api/search?kind=chunk&q=' + encodeURIComponent('אור הדוגמה'), headers: h })).json();
  assert.match(r3.results[0].snippet, /קבלן החשמל/);
  assert.equal(r3.results[0].via, 'keyword+semantic');
  // filters apply to the semantic layer too
  const r4 = (await app.inject({ method: 'GET', url: '/api/search?kind=task&q=' + encodeURIComponent('עלויות'), headers: h })).json();
  assert.equal(r4.count, 0);
  // an edited source is re-embedded
  db.prepare("UPDATE chunks SET text='תכנית פינוי בינוי חדשה בשכונה' WHERE idx=0").run(); // chunk rows are not updated by trigger: delete+insert
  db.prepare('DELETE FROM chunks WHERE idx=0').run();
  db.prepare("INSERT INTO chunks (file_id, idx, text, page) VALUES (1,0,'תכנית פינוי בינוי חדשה בשכונה',1)").run();
  assert.ok(app.semantic.status().pending >= 1);
  while (await app.semantic.indexBatch(8));
  assert.equal(app.semantic.status().pending, 0);
});
