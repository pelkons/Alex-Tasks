'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createEntities } = require('../lib/entities');
const { createGate } = require('../lib/gate');

function setup() {
  const db = open(':memory:');
  const store = createStore(db);
  const knowledge = createKnowledge(db, store);
  const entities = createEntities(db, store);
  const gate = createGate({ db, store, knowledge, entities });
  const a = store.assistantId();
  const run = () => db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'batch')").run(new Date(Date.now() - 1000).toISOString()).lastInsertRowid;
  // tasks created "by the assistant inside a run": the events carry the run id
  const inRun = (runId, fn) => { const out = fn(); db.prepare('UPDATE events SET run_id=? WHERE run_id IS NULL AND actor_id=?').run(runId, a); return out; };
  return { db, store, knowledge, entities, gate, a, run, inRun };
}
const codes = (v) => v.map((x) => x.code);
const CHAT = { id: 1, text: 'גלעד מפרויקט דוגמית, מגרשים 212 ו-311, ביקש לבדוק מה הובטח בחוזה מכר בנושא של השיש', created_at: new Date().toISOString() };

test('1. project: a task in "לא משויך" is questioned, quoting the source and listing project candidates', async () => {
  const { store, gate, a, run, inRun } = setup();
  store.createProject(a, { name: 'מגדל הדוגמה', aliases: ['100.2000'] });
  const r = run();
  const t = inRun(r, () => store.createTask(a, { title: 'לבדוק את השיש', requester: store.ownerId(), due: '2026-12-01' }));
  const v = await gate.check(r, { chats: [CHAT] });
  const pv = v.find((x) => x.code === 'project');
  assert.ok(pv, JSON.stringify(codes(v)));
  assert.match(pv.question, /נוצרה בלי פרויקט/);
  assert.match(pv.question, /גלעד מפרויקט דוגמית, מגרשים 212 ו-311/, 'quotes the source');
  assert.match(pv.question, /"דוגמית" \(במקור/, 'a project named in the source but missing is proposed for creation');
  void t;
});

test('1. project: known aliases, plot and project numbers are offered as candidates; an explicit reason plus a question for the owner is accepted', async () => {
  const { store, gate, a, run, inRun, db } = setup();
  const alt = store.createProject(a, { name: 'מגדל הדוגמה 2-4', aliases: ['מגדל הדוגמה', '100.2000'] });
  const lod = store.createProject(a, { name: 'דוגמית', aliases: ['מגרש 212'], partial: true });
  const r = run();
  const t = inRun(r, () => store.createTask(a, { title: 'דבר', due: '2026-12-01', requester: store.ownerId(), unassigned_reason: 'לא ברור' }));
  const src = { chats: [{ id: 2, text: 'לבדוק את חוזה 100.2000 ובנוסף מגרש 212', created_at: new Date().toISOString() }] };
  let v = await gate.check(r, src);
  const q1 = v.find((x) => x.code === 'project').question;
  assert.ok(q1.includes(`${alt.id} "מגדל הדוגמה 2-4"`) && q1.includes(`${lod.id} "דוגמית"`), q1);
  store.addAttention(a, { kind: 'question', task: t.id, text: 'לאיזה פרויקט?' });
  v = await gate.check(r, src);
  assert.ok(!codes(v).includes('project'), 'reason + question for the owner satisfies the gate');
  void db;
});

test('2. requester: missing; wrong for an email; wrong or unknown for a chat', async () => {
  const { store, gate, a, run, inRun, db } = setup();
  const p = store.createProject(a, { name: 'דוגמית' });
  const noa = store.createPerson(a, { name: 'נועה שרון', emails: 'noa@lawfirm.example' });
  const r = run();
  const miss = inRun(r, () => store.createTask(a, { title: 'א', project: p.id, due: '2026-12-01' }));
  let v = await gate.check(r, { chats: [CHAT] });
  assert.ok(v.some((x) => x.code === 'requester' && x.task_id === miss.id));
  // email: the original sender is noa, the requester is the owner
  const e = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, forwarded_from, processed_at) VALUES ('m1','dana@exconstruct.example','שלום','2026-11-25T08:00:00Z','x','Noa Sharon <noa@lawfirm.example>', ?)").run(new Date().toISOString()).lastInsertRowid;
  const r2 = run();
  const t2 = inRun(r2, () => store.createTask(a, { title: 'ב', project: p.id, due: '2026-12-01', requester: store.ownerId(), email: e }));
  v = await gate.check(r2, { emails: [db.prepare('SELECT * FROM emails WHERE id=?').get(e)] });
  assert.ok(v.some((x) => x.code === 'requester' && /נועה שרון/.test(x.question)), JSON.stringify(v));
  store.updateTask(a, t2.id, { requester: noa.id });
  v = await gate.check(r2, { emails: [db.prepare('SELECT * FROM emails WHERE id=?').get(e)] });
  assert.ok(!v.some((x) => x.code === 'requester'));
  // chat: "גלעד ... ביקש" and the requester is the owner while גלעד does not exist
  const r3 = run();
  inRun(r3, () => store.createTask(a, { title: 'ג', project: p.id, due: '2026-12-01', requester: store.ownerId() }));
  v = await gate.check(r3, { chats: [CHAT] });
  assert.ok(v.some((x) => x.code === 'requester' && /גלעד/.test(x.question) && /person add/.test(x.question)), JSON.stringify(v.map((x) => x.question)));
});

test('3. dates: source_date and due_source are filled by code (logged), a missing due date is questioned', async () => {
  const { store, gate, a, run, inRun, db } = setup();
  const p = store.createProject(a, { name: 'דוגמית' });
  const r = run();
  const t = inRun(r, () => store.createTask(a, { title: 'ד', project: p.id, requester: store.ownerId() }));
  const v = await gate.check(r, { chats: [CHAT] });
  assert.ok(v.some((x) => x.code === 'dates' && /אין תאריך יעד/.test(x.question)));
  assert.equal(store.getTask(t.id).source_date, CHAT.created_at, 'source_date taken from the chat message');
  assert.ok(db.prepare("SELECT 1 FROM gate_log WHERE code='dates' AND outcome='autofixed'").get());
  store.updateTask(a, t.id, { due: '2026-12-02' });
  db.prepare("UPDATE tasks SET due_source=NULL WHERE id=?").run(t.id);
  const v2 = await gate.check(r, { chats: [CHAT] });
  assert.ok(!v2.some((x) => x.code === 'dates'));
  assert.equal(store.getTask(t.id).due_source, 'estimated');
});

test('4. people: a named known person must be linked or dismissed; unknown "<name> מפרויקט ..." must be created as a partial person', async () => {
  const { store, gate, a, run, inRun, db } = setup();
  const p = store.createProject(a, { name: 'דוגמית' });
  const dani = store.createPerson(a, { name: 'דני רוזן' });
  const r = run();
  const src = { chats: [{ id: 5, text: 'דני צריך לראות את זה. גלעד מפרויקט דוגמית ביקש לבדוק את השיש', created_at: new Date().toISOString() }] };
  inRun(r, () => store.createTask(a, { title: 'לבדוק שיש', project: p.id, due: '2026-12-01', requester: store.ownerId() }));
  let v = await gate.check(r, src);
  const pv = v.filter((x) => x.code === 'people');
  assert.ok(pv.some((x) => /דני רוזן/.test(x.question)) && pv.some((x) => /"גלעד" לא קיים/.test(x.question)), JSON.stringify(pv.map((x) => x.question)));
  // dismiss one, create the other as partial
  db.prepare("INSERT INTO entity_decisions (entity_type, entity_id, identity, verdict, created_at) VALUES ('name', ?, ?, 'dismissed', ?)").run(r, 'דני רוזן', new Date().toISOString());
  store.createPerson(a, { name: 'גלעד', status: 'partial' });
  v = await gate.check(r, src);
  const pv2 = v.filter((x) => x.code === 'people');
  assert.ok(pv2.length === 1 && /גלעד/.test(pv2[0].question) && /לא קושר/.test(pv2[0].question), JSON.stringify(pv2.map((x) => x.question)));
  assert.ok(v.some((x) => x.code === 'requester' && /גלעד/.test(x.question)), 'the partial person exists now, but is still not the requester');
  void dani;
});

test('5. language: Cyrillic or a non-Hebrew title is questioned (also for updates)', async () => {
  const { store, gate, a, run, inRun } = setup();
  const p = store.createProject(a, { name: 'דוגמית' });
  const r = run();
  inRun(r, () => store.createTask(a, { title: 'Позвонить Гаю', project: p.id, due: '2026-12-01', requester: store.ownerId() }));
  inRun(r, () => store.createTask(a, { title: 'Check the marble series', project: p.id, due: '2026-12-01', requester: store.ownerId() }));
  const v = (await gate.check(r, { chats: [CHAT] })).filter((x) => x.code === 'language');
  assert.equal(v.length, 2);
  assert.match(v[0].question, /קירילי/);
});

test('6. duplicates: a new task similar to an open one needs an explicit decision', async () => {
  const { store, gate, a, run, inRun, db } = setup();
  const p = store.createProject(a, { name: 'דוגמית' });
  const old = inRun(run(), () => store.createTask(a, { title: 'לבדוק את חוזה המכר בנושא השיש', project: p.id, due: '2026-12-01', requester: store.ownerId() }));
  const r = run();
  const nt = inRun(r, () => store.createTask(a, { title: 'לבדוק חוזה המכר בנושא השיש', project: p.id, due: '2026-12-01', requester: store.ownerId() }));
  let v = await gate.check(r, { chats: [CHAT] });
  assert.ok(v.some((x) => x.code === 'duplicate' && x.question.includes(`${old.id}`)));
  db.prepare("INSERT INTO entity_decisions (entity_type, entity_id, identity, verdict, created_at) VALUES ('dup', ?, ?, 'different', ?)").run(nt.id, `of:${old.id}`, new Date().toISOString());
  v = await gate.check(r, { chats: [CHAT] });
  assert.ok(!v.some((x) => x.code === 'duplicate'));
});

test('7. email source: chat report, attachments looked at, facts attempted', async () => {
  const { store, gate, a, run, db } = setup();
  const e = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, processed_at) VALUES ('m9','x@y.co','נושא','2026-11-25T08:00:00Z','גוף', ?)").run(new Date().toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO files (original_name, path, source, created_at, email_id) VALUES ('חוזה.pdf','/x','email',?,?)").run(new Date().toISOString(), e);
  const r = run();
  const src = { emails: [db.prepare('SELECT * FROM emails WHERE id=?').get(e)] };
  let v = await gate.check(r, src);
  assert.deepEqual(codes(v).sort(), ['attachments', 'email_report', 'facts']);
  db.prepare("UPDATE files SET summary='חוזה מכר' WHERE email_id=?").run(e);
  v = await gate.check(r, src);
  assert.match(v.find((x) => x.code === 'attachments').question, /שיוך לפרויקט.*בדיקת נתונים/); // summary alone is not enough: project link and facts check are required too
  const pj = store.createProject(a, { name: 'דוגמית' });
  db.prepare('UPDATE files SET project_id=?, facts_checked=1 WHERE email_id=?').run(pj.id, e);
  db.prepare('UPDATE claude_runs SET facts_checked=1 WHERE id=?').run(r);
  store.createPerson(a, { name: 'x' }); // noise
  require('../lib/chat').createChat(db, store, createKnowledge(db, store)).sendChat(a, { text: 'סיימתי' });
  v = await gate.check(r, src);
  assert.deepEqual(codes(v), []);
});

test('8. protocol: action items need an owner or an explicit "לא ידוע"', async () => {
  const { store, gate, a, run, db } = setup();
  const r = run();
  const p = store.createProject(a, { name: 'דוגמית' });
  const proto = db.prepare("INSERT INTO protocols (project_id, meeting_at, title, created_by, created_at) VALUES (?,?,?,?,?)").run(p.id, '2026-11-25T10:00:00Z', 'ישיבה', a, new Date().toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO protocol_items (protocol_id, idx, kind, text, created_at) VALUES (?,1,'action','להגיש תוכניות',?)").run(proto, new Date().toISOString());
  store.logEvent(a, 'protocol', proto, 'create', 'title', null, 'ישיבה');
  db.prepare('UPDATE events SET run_id=? WHERE entity=\'protocol\'').run(r);
  assert.ok((await gate.check(r, {})).some((x) => x.code === 'protocol'));
  db.prepare("UPDATE protocol_items SET owner_name='לא ידוע'").run();
  assert.ok(!(await gate.check(r, {})).some((x) => x.code === 'protocol'));
});

test('after the last round: accepted violations become an attention item and a review badge, and are counted', async () => {
  const { store, gate, a, run, inRun, db } = setup();
  const r = run();
  const t = inRun(r, () => store.createTask(a, { title: 'לבדוק את השיש', due: '2026-12-01', requester: store.ownerId() }));
  const v = await gate.check(r, { chats: [CHAT] });
  gate.logRaised(r, v, 0);
  gate.accept(r, v.filter((x) => x.code === 'project'), 2);
  assert.equal(store.getTask(t.id).needs_review, 1);
  assert.ok(db.prepare("SELECT 1 FROM attention WHERE kind='question' AND text LIKE 'דורש בדיקה (שיוך לפרויקט)%'").get());
  const st = gate.stats().find((x) => x.code === 'project');
  assert.equal(st.accepted, 1); assert.ok(st.raised >= 1);
  gate.logResolved(r, v, [], 1);
  assert.ok(gate.stats().find((x) => x.code === 'project').resolved >= 1);
});

test('pulse messages and curator output are checked too', () => {
  const { gate, a, run, store, db } = setup();
  assert.equal(gate.checkMessage('היום יעד https://tasks.example.org/task/3 להתחיל?', [{}]).length, 0);
  assert.ok(gate.checkMessage('Позвонить завтра', []).some((x) => x.key === 'cyr'));
  assert.ok(gate.checkMessage('שורה\nשורה\nשורה\nשורה\nשורה\nשורה', []).some((x) => x.key === 'long'));
  assert.ok(gate.checkMessage('יש משימה באיחור', [{}]).some((x) => x.key === 'links'));
  const p = store.createProject(a, { name: 'מגדל הדוגמה' });
  const r = run();
  const v = gate.checkCurator(r, { wordsAfter: 3000, limit: 1500 });
  assert.deepEqual(v.map((x) => x.code).sort(), ['memory', 'summary']);
  void p; void db;
});

test('4. a person created in the run with only a first name and no email becomes partial by code', async () => {
  const { store, gate, a, run, inRun, db } = setup();
  const r = run();
  const p = inRun(r, () => store.createPerson(a, { name: 'גלעד' }));
  const full = inRun(r, () => store.createPerson(a, { name: 'גלעד מור' }));
  await gate.check(r, {});
  assert.equal(db.prepare('SELECT status FROM people WHERE id=?').get(p.id).status, 'partial');
  assert.equal(db.prepare('SELECT status FROM people WHERE id=?').get(full.id).status, 'full');
  assert.ok(db.prepare("SELECT 1 FROM gate_log WHERE code='people' AND outcome='autofixed'").get());
});
