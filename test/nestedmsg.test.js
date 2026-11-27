'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-nested-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { parseMailFile, pickName, pickBody } = require('../lib/mailfile');
const { createFixNames } = require('../lib/fixnames');
const { buildMsg } = require('./helpers/msg-builder');

const HE = (s) => s; // fictional Hebrew text
const nested = (o = {}) => buildMsg({ from_name: 'דן לוי', from_addr: 'dan@v.example', to: [{ name: 'דנה', addr: 'dana@x.example' }], subject: HE('הדמיות לפרויקט הדוגמה'), body: HE('שלום, מצורפות ההדמיות העדכניות לפרויקט. נא לאשר עד סוף השבוע.'), date: Date.parse('2026-09-17T08:00:00Z'), ...o });

test('a nested message with 8-bit (cp1255) Hebrew is read as Hebrew, and the embedded attachment is named from the OUTER attachment (Hebrew), not from "?"', async () => {
  const inner = nested({ ansi1255: true });
  const direct = await parseMailFile(inner, 'x.msg'); assert.equal(direct.subject, 'הדמיות לפרויקט הדוגמה'); assert.match(direct.body, /ההדמיות העדכניות/);
  const outer = buildMsg({ from_name: 'רון', from_addr: 'ron@v.example', to: [{ name: 'דנה', addr: 'dana@x.example' }], subject: 'FW: הדמיות', body: 'מצורף', date: Date.parse('2026-11-26T08:00:00Z'), attachments: [{ name: 'FW הדמיות לפרויקט הדוגמה.msg', msg: { from_name: 'דן', from_addr: 'dan@v.example', subject: 'הדמיות לפרויקט הדוגמה', body: 'גוף', ansi1255: true } }] });
  const m = await parseMailFile(outer, 'o.msg'); assert.equal(m.attachments.length, 1); assert.ok(m.attachments[0].embedded); assert.match(m.attachments[0].name, /^FW הדמיות לפרויקט הדוגמה\.msg$/);
});

test('name and body choice: a copy with "?" for letters always loses to an intact copy', () => {
  assert.equal(pickName(['FW: ????? 5-7, ?"?- ??????.msg', 'FW: בורלא 5-7, ת"א- הדמיות']), 'FW: בורלא 5-7, ת"א- הדמיות'); assert.equal(pickName(['', 'undefinedשם', 'x.msg']), 'שם');
  assert.equal(pickBody(['???? ???? ??? ?????? ????? ??? ?????', 'שלום רב, מצורפים המסמכים לפרויקט כפי שסוכם בפגישה']), 'שלום רב, מצורפים המסמכים לפרויקט כפי שסוכם בפגישה');
});

test('a nested message whose plain-text body is "?" but whose RTF body keeps the Hebrew (cp1255 escapes) is read from the RTF', async () => {
  const rtf = "{\\rtf1\\ansi\\ansicpg1255\\deff0{\\fonttbl{\\f0 Arial;}}\\pard \\'f9\\'ec\\'e5\\'ed \\'e1\\'e5\\'e0\\'e5 \\'ec\\'e4\\'f6\\'e9\\'e2 \\'e0\\'fa \\'e4\\'e4\\'ec\\'e9\\'f4\\'e5\\'ee\\'e9\\'ed \\'e4\\'e0\\'e7\\'f8\\'e5\\'f0\\'e9\\'ed \\'ec\\'ee\\'e6\\'ee\\'e9\\'ef \\'e4\\'ee\\'e1\\'e9\\'ee\\'f8\\'ec\\'fa.\\par}";
  const buf = buildMsg({ from_name: '??', from_addr: 'a@v.example', to: [{ name: '??', addr: 'b@x.example' }], subject: '???? ????', body: '???? ???? ??? ?????? ????? ??? ????? ?????? ????', rtf, date: Date.parse('2026-09-17T08:00:00Z') });
  const m = await parseMailFile(buf, 'n.msg'); assert.match(m.body, /שלום בואו להציג את ההליפומים/);
});

test('repair: a damaged nested file is renamed from its own subject, or merged into the clean copy a re-push added (references move, the damaged row goes)', async () => {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const a = store.assistantId();
  const proj = store.createProject(a, { name: 'פרויקט' }); const eid = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, project_id) VALUES ('p1','x@y','אב',?,'גוף',?)").run(new Date().toISOString(), proj.id).lastInsertRowid;
  const addFile = (name, buf) => { const f = path.join(process.env.MESIMOT_FILES, name.replace(/[^\w.]/g, '_') + Math.random()); fs.writeFileSync(f, buf); return db.prepare("INSERT INTO files (original_name, path, mime, size, source, email_id, created_at) VALUES (?,?,?,?,?,?,?)").run(name, f, 'application/vnd.ms-outlook', buf.length, 'email', eid, new Date().toISOString()).lastInsertRowid; };
  const good = addFile('FW: בורלא 5-7, ת"א- הדמיות.msg', nested()); const bad = addFile('FW: ????? 5-7, ?"?- ??????.msg', nested({ subject: '????? ??????', body: '???? ??? ?????? ????? ??? ????? ????' }));
  db.prepare("INSERT INTO project_facts (project_id, key, value, as_of_date, source_type, source_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)").run(proj.id, 'מפתח', 'ערך', '2026-11-26', 'file', bad, a, new Date().toISOString());
  const own = addFile('???? ????.msg', nested({ ansi1255: true })); // no clean sibling, but its own subject is intact (8-bit Hebrew)
  const r = await createFixNames({ db, store, knowledge }).run();
  assert.equal(r.merged, 1); assert.equal(r.renamed, 1); assert.ok(!db.prepare('SELECT 1 FROM files WHERE id=?').get(bad), 'the damaged copy is gone');
  assert.equal(db.prepare("SELECT source_id FROM project_facts WHERE key='מפתח'").get().source_id, good, 'the fact now points at the clean copy');
  assert.equal(db.prepare('SELECT original_name FROM files WHERE id=?').get(own).original_name, 'הדמיות לפרויקט הדוגמה.msg');
  assert.equal((await createFixNames({ db, store, knowledge }).run()).scanned, 0, 'idempotent');
});
