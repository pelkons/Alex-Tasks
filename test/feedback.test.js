'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createProposals } = require('../lib/proposals');
const { createFeedback } = require('../lib/feedback');
const { createFilters } = require('../lib/filters');
const { createImporter } = require('../lib/importer');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const proposals = createProposals({ db, store, chat }); const fb = createFeedback({ db, store, proposals });
  const a = store.assistantId(), owner = store.ownerId(); const proj = store.createProject(store.ownerId(), { name: 'מגדל הדוגמה' });
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger, model) VALUES (?, 'import', 'haiku')").run(new Date().toISOString()).lastInsertRowid;
  const mailTask = (from, subject, title) => {
    const e = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, forwarded_from) VALUES (?,?,?,?,?,?)").run('m' + Math.random(), from, subject, new Date().toISOString(), 'גוף', from).lastInsertRowid;
    const t = store.createTask(a, { title, project: proj.id, due: '2026-12-01', requester: owner, email: e }); db.prepare('UPDATE events SET run_id=? WHERE run_id IS NULL AND actor_id=?').run(run, a); return { e, t };
  };
  return { db, store, chat, proposals, fb, a, owner, proj, mailTask };
}

test('feedback is stored with the features of the source mail, the model and the prompt version', () => {
  const { db, fb, owner, mailTask } = setup();
  const { t } = mailTask('status@site.example', 'עדכון התקדמות שבועי קומה 9', 'לעדכן את התקדמות הקומה');
  const r = fb.record(owner, { item_type: 'task', item_id: t.id, verdict: 'down', reason: 'לא משימה', reason_text: 'רק עדכון' });
  const row = db.prepare('SELECT * FROM feedback WHERE id=?').get(r.id);
  assert.equal(row.sender, 'status@site.example'); assert.equal(row.domain, 'site.example'); assert.match(row.subject_kw, /התקדמות/); assert.equal(row.model, 'haiku'); assert.match(row.prompt_version, /^import-/); assert.equal(row.reason, 'לא משימה');
  assert.throws(() => fb.record(owner, { item_type: 'task', item_id: t.id, verdict: 'maybe' }), /up או down/);
});

test('three "not a task" verdicts from one sender propose a filter with one tap; approving creates the rule', () => {
  const { db, store, fb, proposals, owner, mailTask } = setup();
  let sugg = null;
  for (let i = 0; i < 3; i++) { const { t } = mailTask('status@site.example', `עדכון ${i}`, `משימה ${i}`); const r = fb.record(owner, { item_type: 'task', item_id: t.id, verdict: 'down', reason: 'לא משימה' }); sugg = r.suggestion || sugg; }
  assert.ok(sugg, 'a suggestion after the third verdict');
  const item = proposals.batch(sugg).items[0]; assert.equal(item.kind, 'filter_add'); assert.match(item.text, /status@site\.example/);
  proposals.decide(item.id, 'approve');
  assert.equal(createFilters({ db, store }).list()[0].pattern, 'status@site.example');
  const { t } = mailTask('status@site.example', 'עוד', 'עוד'); assert.equal(fb.record(owner, { item_type: 'task', item_id: t.id, verdict: 'down', reason: 'לא משימה' }).suggestion, null, 'no second suggestion for the same sender');
});

test('approving a downgrade proposal counts as a 👎; the immediate fix is applied through the store; questions record the answer', () => {
  const { db, store, fb, proposals, owner, mailTask } = setup();
  const { t, e } = mailTask('a@b.example', 'מבצע', 'משימה מיותרת');
  const bid = proposals.createBatch('tasks', 'x', [{ kind: 'task_info', target_id: t.id, text: 'לידיעה', reason: 'r' }]);
  proposals.approveBatch(bid);
  assert.equal(db.prepare("SELECT verdict, reason FROM feedback WHERE item_id=? AND item_type='task'").get(t.id).reason, 'לא משימה');
  const t2 = mailTask('c@d.example', 'x', 'פרויקט שגוי').t; const hidden = db.prepare('SELECT id FROM statuses WHERE hidden_default=1').get().id;
  assert.equal(fb.fix(owner, t2.id, 'info'), 'הועברה למידע בלבד'); assert.equal(db.prepare('SELECT status_id FROM tasks WHERE id=?').get(t2.id).status_id, hidden);
  const qb = proposals.createBatch('questions', 'שאלות', [{ kind: 'question', target_id: 0, other_id: e, text: 'נכון?' }, { kind: 'question', target_id: 0, other_id: e, text: 'ועוד?' }]);
  const qi = proposals.batch(qb).items; proposals.decide(qi[0].id, 'approve'); proposals.decide(qi[1].id, 'reject');
  const v = db.prepare("SELECT verdict, reason FROM feedback WHERE item_type='email' ORDER BY id").all(); assert.deepEqual(v.map((x) => x.verdict), ['up', 'down']); assert.equal(v[1].reason, 'היה צריך משימה');
  void store;
});

test('few-shot: the most similar earlier feedback becomes short examples for the prompt; stats show precision, weekly corrections and reasons', () => {
  const { db, fb, owner, mailTask } = setup();
  const a = mailTask('status@site.example', 'עדכון התקדמות שבועי', 'עדכון קומה 8').t; const b = mailTask('other@z.example', 'הצעת מחיר פיגומים', 'לאשר הצעה').t;
  fb.record(owner, { item_type: 'task', item_id: a.id, verdict: 'down', reason: 'לא משימה' }); fb.record(owner, { item_type: 'task', item_id: b.id, verdict: 'up' });
  const ex = fb.examples({ from_addr: 'status@site.example', subject: 'עדכון התקדמות שבועי קומה 9', project_id: null });
  assert.equal(ex.length, 1); assert.match(ex[0], /WRONG/); assert.match(ex[0], /לא משימה/); assert.match(ex[0], /status@site\.example/);
  assert.deepEqual(fb.examples({ from_addr: 'nobody@else.example', subject: 'משהו אחר לגמרי', project_id: null }), []);
  const st = fb.stats(30); assert.equal(st.up, 1); assert.equal(st.down, 1); assert.equal(st.task_precision, 0.5); assert.equal(st.reasons[0].reason, 'לא משימה'); assert.ok(st.corrections_per_week.length >= 1);
  void db;
});

test('digest questions: at most 3, on an FYI call with attachments or a long thread and on a task with a guessed due date', () => {
  const { db, store, a, owner, proj } = setup();
  const imp = createImporter({ db, store, knowledge: createKnowledge(db, store), chat: null });
  const id = db.prepare("INSERT INTO imports (created_at, status, stats) VALUES (?, 'digest', '{}')").run(new Date().toISOString()).lastInsertRowid;
  const e = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, forwarded_from, import_id, import_state, triage, thread_no) VALUES ('q1','x@y.example','סטטוס עם קובץ',?, 'x','x@y.example',?, 'done','fyi',1)").run(new Date().toISOString(), id).lastInsertRowid;
  db.prepare("INSERT INTO files (original_name, path, source, created_at, email_id) VALUES ('a.pdf','/x','email',?,?)").run(new Date().toISOString(), e);
  const t = store.createTask(a, { title: 'משימה עם יעד משוער', project: proj.id, due: '2026-12-02', due_source: 'estimated', requester: owner, email: e });
  const qs = imp.questions(id); assert.ok(qs.length >= 2 && qs.length <= 3); assert.ok(qs.every((x) => x.kind === 'question'));
  assert.ok(qs.some((x) => /לידיעה בלבד/.test(x.text))); assert.ok(qs.some((x) => x.target_id === t.id));
});
