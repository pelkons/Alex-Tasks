'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createApply } = require('../lib/apply');
const { createUndo } = require('../lib/undo');
const { createProtocols } = require('../lib/protocols');
const { createCalendar } = require('../lib/calendar');
const { createEntities } = require('../lib/entities');

function setup() {
  const db = open(':memory:');
  const store = createStore(db);
  const knowledge = createKnowledge(db, store);
  const chat = createChat(db, store, knowledge);
  const entities = createEntities(db, store);
  const apply = createApply(db, store, knowledge, chat, createProtocols(db, store, knowledge), createCalendar(db, store), entities).apply;
  const undo = createUndo(db, store, knowledge);
  return { db, store, knowledge, chat, entities, apply, undo, a: store.assistantId(), owner: store.ownerId() };
}

test('a partial person and a vague project collect mentions from tasks, chat and notes', () => {
  const { store, chat, entities, a, owner, db } = setup();
  const b = store.createPerson(a, { name: 'גלעד', status: 'partial', role_text: 'מנהל פרויקט דוגמית' });
  assert.deepEqual(b.missing.sort(), ['דוא״ל', 'חברה', 'שם משפחה'].sort());
  const lod = store.createProject(a, { name: 'דוגמית', aliases: ['מגרש 212'], partial: true });
  const t = store.createTask(a, { title: 'לבדוק את השיש', requester: b.id, project: lod.id });
  chat.sendChat(owner, { text: 'גלעד ביקש לבדוק את החוזה, מגרש 212' });
  store.addNote(a, { task: t.id, text: 'דיברתי עם לגלעד' });
  const m = entities.mentionList('person', b.id).map((x) => x.source_type).sort();
  assert.deepEqual(m, ['chat', 'note', 'task']);
  assert.ok(entities.mentionList('project', lod.id).length >= 2);
  assert.equal(entities.backfill().mentions >= 4, true);
});

test('completing a partial person in place re-links nothing away but notes the affected tasks; undo removes the notes', () => {
  const { store, entities, undo, a, owner, db } = setup();
  const b = store.createPerson(a, { name: 'גלעד', status: 'partial' });
  const t = store.createTask(a, { title: 'x', requester: b.id });
  const r = entities.resolvePerson(a, b.id, { name: 'גלעד מור', email: 'gal@xyz.example', company: 'XYZ', role_text: 'מנהל פרויקט דוגמית' });
  assert.equal(r.person.status, 'full'); assert.deepEqual(r.person.emails, ['gal@xyz.example']);
  assert.match(db.prepare('SELECT text FROM notes WHERE task_id=?').get(t.id).text, /עודכן: גלעד = גלעד מור, מנהל פרויקט דוגמית \(XYZ\)/);
  const ev = db.prepare("SELECT id FROM events WHERE action='resolve'").get();
  undo.undoEvent(owner, ev.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes WHERE task_id=?').get(t.id).c, 0);
});

test('merging a partial person into a full one re-points everything; undo restores the partial record exactly', () => {
  const { store, entities, undo, db, a, owner } = setup();
  const part = store.createPerson(a, { name: 'גלעד', status: 'partial', notes: 'מפרויקט דוגמית' });
  const full = store.createPerson(a, { name: 'גלעד מור', emails: 'gal@xyz.example', company: 'XYZ' });
  const t1 = store.createTask(a, { title: 'א', requester: part.id });
  const t2 = store.createTask(a, { title: 'ב', assignee: part.id });
  const before = { ...db.prepare('SELECT * FROM people WHERE id=?').get(part.id) };
  const r = entities.resolvePerson(a, part.id, { into: full.id });
  assert.equal(r.merged, true);
  assert.equal(store.getTask(t1.id).requester_id, full.id); assert.equal(store.getTask(t2.id).assignee_id, full.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM people WHERE id=?').get(part.id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mentions WHERE entity_type='person' AND entity_id=?").get(part.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes WHERE text LIKE ?').get('%עודכן: גלעד = גלעד מור%').c, 2);
  const ev = db.prepare("SELECT id FROM events WHERE action='resolve'").get();
  undo.undoEvent(owner, ev.id);
  assert.deepEqual({ ...db.prepare('SELECT * FROM people WHERE id=?').get(part.id) }, before);
  assert.equal(store.getTask(t1.id).requester_id, part.id); assert.equal(store.getTask(t2.id).assignee_id, part.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes WHERE text LIKE ?').get('%עודכן%').c, 0);
});

test('project resolve: tasks, facts, knowledge and aliases move; conflicting facts keep the newer; undo restores', () => {
  const { store, knowledge, entities, undo, db, a, owner } = setup();
  const lod = store.createProject(a, { name: 'דוגמית', partial: true });
  const full = store.createProject(a, { name: 'שכונת הפארק דוגמית', aliases: ['326.5011'] });
  const t = store.createTask(a, { title: 'שיש', project: lod.id });
  knowledge.setFact(a, { project: lod.id, key: 'מגרשים', value: '212, 311', as_of: '2026-11-01' });
  knowledge.setFact(a, { project: full.id, key: 'מגרשים', value: '212, 311, 400', as_of: '2026-10-01' });
  const r = entities.resolveProject(a, lod.id, { into: full.id });
  assert.equal(r.moved_tasks, 1);
  assert.equal(store.getTask(t.id).project_id, full.id);
  const cur = knowledge.currentFacts(full.id);
  assert.equal(cur.length, 1); assert.equal(cur[0].value, '212, 311', 'the newer value wins');
  assert.ok(store.getProject(full.id).aliases.includes('דוגמית'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM projects WHERE id=?').get(lod.id).c, 0);
  undo.undoEvent(owner, db.prepare("SELECT id FROM events WHERE action='resolve' AND entity='project'").get().id);
  assert.equal(store.getTask(t.id).project_id, lod.id);
  assert.equal(knowledge.currentFacts(lod.id).length, 1);
  assert.equal(knowledge.currentFacts(full.id)[0].value, '212, 311, 400');
  assert.deepEqual(store.getProject(full.id).aliases, ['326.5011']);
});

test('apply: required identity verdicts are enforced; not_same is remembered per identity', () => {
  const { store, apply, entities, db, a } = setup();
  const b = store.createPerson(a, { name: 'גלעד', status: 'partial' });
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger, required_entities) VALUES (?, 'batch', ?)").run(new Date().toISOString(), JSON.stringify([{ type: 'person', id: b.id, name: 'גלעד', identities: ['barak@other.example'] }])).lastInsertRowid;
  assert.throws(() => apply(a, { chat_message: 'x' }), /חסרה קביעה על זיהוי/);
  assert.throws(() => apply(a, { resolutions: [{ type: 'person', id: b.id, action: 'merge', reason: 'x' }] }), /into/);
  const r = apply(a, { resolutions: [{ type: 'person', id: b.id, action: 'not_same', reason: 'גלעד אחר, מחיפה' }] });
  assert.equal(r.resolutions[0].action, 'not_same');
  assert.equal(entities.isNotSame('person', b.id, 'barak@other.example'), true);
  assert.equal(store.listPeople().find((p) => p.id === b.id).status, 'partial', 'not merged');
  void run;
});

test('apply: complete a person and a project in one call, relinking happens before the task decisions', () => {
  const { store, apply, a, db } = setup();
  const b = store.createPerson(a, { name: 'גלעד', status: 'partial' });
  const lod = store.createProject(a, { name: 'דוגמית', partial: true });
  const t = store.createTask(a, { title: 'שיש', requester: b.id, project: lod.id });
  const r = apply(a, { resolutions: [
    { type: 'person', id: b.id, action: 'complete', name: 'גלעד מור', email: 'gal@xyz.example', company: 'XYZ', role_text: 'מנהל פרויקט דוגמית', reason: 'חתימה' },
    { type: 'project', id: lod.id, action: 'complete', aliases: ['מגרש 212'], reason: 'אותו פרויקט' }], decisions: [{ task: t.id, action: 'update', reason: 'המשך', email: undefined }] });
  assert.equal(r.resolutions.length, 2);
  assert.equal(store.getTask(t.id).requester, 'גלעד מור');
  assert.equal(store.getProject(lod.id).partial, 0);
  assert.ok(store.getProject(lod.id).aliases.includes('מגרש 212'));
  void db;
});
