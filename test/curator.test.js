'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-pulse-'));
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_LOCK = path.join(tmp, 'runner.lock');
process.env.MESIMOT_RUN_LOG = path.join(tmp, 'runs');
process.env.MESIMOT_CLAUDE_BIN = path.join(__dirname, 'fixtures', 'fake-claude.sh');
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
const { createRunner } = require('../lib/runner');

function setup() {
  const db = open(':memory:');
  const store = createStore(db);
  const knowledge = createKnowledge(db, store);
  const chat = createChat(db, store, knowledge);
  const apply = createApply(db, store, knowledge, chat, createProtocols(db, store, knowledge), createCalendar(db, store)).apply;
  const undo = createUndo(db, store, knowledge);
  const a = store.assistantId();
  const p = store.createProject(store.ownerId(), { name: 'מגדל הדוגמה' });
  return { db, store, knowledge, apply, undo, a, p };
}

test('apply: duplicate fact keys merge (newer value wins, history kept), and the whole run can be undone', () => {
  const { db, store, knowledge, apply, undo, a, p } = setup();
  knowledge.setFact(a, { project: p.id, key: 'קבלן שלד', value: 'בונה הדוגמה', as_of: '2026-10-01' });
  knowledge.setFact(a, { project: p.id, key: 'קבלן הביצוע של השלד', value: 'בנייה הדוגמה', as_of: '2026-11-10' });
  knowledge.setFact(a, { project: p.id, key: 'קומות', value: '12', as_of: '2026-11-01' });
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'curator')").run(new Date().toISOString()).lastInsertRowid;
  const r = apply(a, { fact_merges: [{ project: p.id, from_key: 'קבלן שלד', into_key: 'קבלן הביצוע של השלד' }] });
  assert.equal(r.ok, true);
  const cur = knowledge.currentFacts(p.id);
  assert.deepEqual(cur.map((f) => f.key).sort(), ['קבלן הביצוע של השלד', 'קומות'].sort());
  assert.equal(cur.find((f) => f.key === 'קבלן הביצוע של השלד').value, 'בנייה הדוגמה', 'the newer value stays current');
  const hist = knowledge.factHistory(p.id, 'קבלן הביצוע של השלד');
  assert.equal(hist.length, 2, 'the old value is kept as history under the kept key');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM project_facts WHERE key='קבלן שלד'").get().c, 0);
  // undo the run
  const out = undo.undoRun(store.ownerId(), run);
  assert.equal(out.undone, 2, JSON.stringify(out));
  assert.deepEqual(knowledge.currentFacts(p.id).map((f) => f.key).sort(), ['קבלן הביצוע של השלד', 'קבלן שלד', 'קומות'].sort());
});

test('apply: when only the old label has a value it is simply renamed; a bad merge changes nothing', () => {
  const { db, store, knowledge, apply, a, p } = setup();
  knowledge.setFact(a, { project: p.id, key: 'דירות', value: '48', as_of: '2026-11-01' });
  apply(a, { fact_merges: [{ project: p.id, from_key: 'דירות', into_key: 'מספר דירות' }] });
  assert.deepEqual(knowledge.currentFacts(p.id).map((f) => f.key), ['מספר דירות']);
  assert.throws(() => apply(a, { projects: [{ project: p.id, summary: 'x' }], fact_merges: [{ project: p.id, from_key: 'לא קיים', into_key: 'y' }] }), /אין נתונים/);
  assert.equal(store.getProject(p.id).summary_he, '', 'the whole call was rolled back');
  void db;
});

test('apply: project summaries are refreshed and people duplicates merge', () => {
  const { store, apply, a, p } = setup();
  const x = store.createPerson(a, { name: 'דני כהן', role: 'contact', emails: ['dani@x.com'] });
  const y = store.createPerson(a, { name: 'Danny Cohen', role: 'contact', emails: ['dani@x.com'] });
  const r = apply(a, { projects: [{ project: p.id, summary: 'פרויקט מגורים בתל אביב. השלד בקומה 7.' }], merge_people: [{ from: y.id, into: x.id }], attention: [{ kind: 'question', text: 'סטטוס השלד סותר: קומה 7 או 9?' }] });
  assert.equal(r.ok, true);
  assert.equal(store.getProject(p.id).summary_he, 'פרויקט מגורים בתל אביב. השלד בקומה 7.');
  const people = store.listPeople().filter((q) => /דני|Danny/.test(q.name_he));
  assert.equal(people.length, 1);
  assert.equal(people[0].name_en, 'Danny Cohen');
});

// ---- the pulse run (step B) with a stand-in for `claude -p`
function runnerWith(db) { return createRunner(db); }
const AT = new Date('2026-11-25T11:00:00+02:00');

test('pulse: nothing found -> logged, the assistant is not even started', async () => {
  const { db } = setup();
  const runner = runnerWith(db);
  process.env.FAKE_CLAUDE_REPLY = 'should not be used';
  const r = await runner.pulseOnce({ at: AT });
  assert.equal(r.found, 0);
  const run = db.prepare("SELECT * FROM claude_runs WHERE trigger='pulse'").get();
  assert.match(run.summary_he, /לא נמצא דבר/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE author='claude'").get().c, 0);
});

test('pulse: something found and the assistant writes a message -> one chat message with the task attached; the items are not reported twice', async () => {
  const { db, store, a } = setup();
  const t = store.createTask(a, { title: 'להכין דוח', due: '2026-11-25' });
  process.env.FAKE_CLAUDE_REPLY = `היום יעד: להכין דוח https://tasks.example.org/task/${t.id}. להתחיל עכשיו?`;
  const runner = runnerWith(db);
  const r = await runner.pulseOnce({ at: AT });
  assert.equal(r.found, 1); assert.equal(r.sent, true, JSON.stringify({ ...r, items: undefined }));
  const msgs = db.prepare("SELECT * FROM chat_messages WHERE author='claude'").all();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /להכין דוח/);
  assert.deepEqual(JSON.parse(msgs[0].task_ids), [t.id]);
  assert.match(db.prepare("SELECT summary_he FROM claude_runs WHERE trigger='pulse' ORDER BY id DESC").get().summary_he, /נמצאו 1, נשלחה הודעה/);
  const again = await runner.pulseOnce({ at: AT });
  assert.equal(again.found, 0, 'reported at most once a day');
});

test('pulse: [SILENT] sends nothing but is logged, and the items still count as reported today', async () => {
  const { db, store, a } = setup();
  store.createTask(a, { title: 'משהו קטן', due: '2026-11-25' });
  process.env.FAKE_CLAUDE_REPLY = '[SILENT]';
  const runner = runnerWith(db);
  const r = await runner.pulseOnce({ at: AT });
  assert.equal(r.found, 1); assert.equal(r.sent, false); assert.equal(r.silent, true);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE author='claude'").get().c, 0);
  assert.match(db.prepare("SELECT summary_he FROM claude_runs WHERE trigger='pulse'").get().summary_he, /שקט/);
  assert.equal((await runner.pulseOnce({ at: AT })).found, 0);
});

test('pulse: skipped at night and on Shabbat', async () => {
  const { db, store, a } = setup();
  store.createTask(a, { title: 'x', due: '2026-11-25' });
  const runner = runnerWith(db);
  assert.equal((await runner.pulseOnce({ at: new Date('2026-11-25T23:00:00+02:00') })).skipped, 'quiet');
  assert.equal((await runner.pulseOnce({ at: new Date('2026-11-28T11:00:00+02:00') })).skipped, 'quiet');
});

test('curator prompt lists projects with their facts, duplicate-key candidates and memory sizes', () => {
  const { db, store, knowledge, a, p } = setup();
  knowledge.setFact(a, { project: p.id, key: 'קבלן שלד', value: 'א', as_of: '2026-10-01' });
  knowledge.setFact(a, { project: p.id, key: 'קבלן שלד ראשי', value: 'ב', as_of: '2026-10-02' });
  const prompt = runnerWith(db).buildCuratorPrompt();
  assert.match(prompt, /\[project \d+\] מגדל הדוגמה/);
  assert.match(prompt, /possible duplicate keys: קבלן שלד ~ קבלן שלד ראשי/);
  assert.match(prompt, /fact_merges/);
  void store;
});

test('every run records the model and effort of its job (routing per job)', async () => {
  const { db, store, a } = setup();
  store.createTask(a, { title: 'משהו להיום', due: '2026-11-25' });
  process.env.FAKE_CLAUDE_REPLY = '[SILENT]';
  process.env.MESIMOT_JOB_MODELS = 'pulse=haiku:low:sonnet';
  try { await runnerWith(db).pulseOnce({ at: AT }); } finally { delete process.env.MESIMOT_JOB_MODELS; }
  const run = db.prepare("SELECT model, effort FROM claude_runs WHERE trigger='pulse'").get();
  assert.deepEqual({ ...run }, { model: 'haiku', effort: 'low' });
});
