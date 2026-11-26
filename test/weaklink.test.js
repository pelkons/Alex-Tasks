'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createApply } = require('../lib/apply');
const { createProtocols } = require('../lib/protocols');
const { createCalendar } = require('../lib/calendar');
const { createSearch } = require('../lib/search');
const { createContext } = require('../lib/context');
const { createThreads } = require('../lib/threads');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const apply = createApply(db, store, knowledge, chat, createProtocols(db, store, knowledge), createCalendar(db, store)).apply;
  const a = store.assistantId(), owner = store.ownerId();
  const p = store.createProject(a, { name: 'מגדל הדוגמה' });
  const strong = store.createTask(owner, { title: 'משימה קשורה באמת 100.2000', project: p.id, due: '2026-12-01', requester: owner });
  const weak = store.createTask(owner, { title: 'משימה אחרת באותו פרויקט', project: p.id, due: '2026-12-02', requester: owner });
  return { db, store, knowledge, apply, a, owner, p, strong, weak };
}
const openRun = (db, required) => db.prepare("INSERT INTO claude_runs (started_at, trigger, required_tasks) VALUES (?, 'import', ?)").run(new Date().toISOString(), JSON.stringify(required)).lastInsertRowid;

test('apply: a WEAKLY related task without a decision is recorded as no_change automatically; a STRONG one still must be decided', () => {
  const { db, apply, a, strong, weak } = setup();
  const run = openRun(db, [{ id: strong.id, title: 'x', rank: 1 }, { id: weak.id, title: 'y', rank: 6 }]);
  // only the weak one is missing: fine
  const ok = apply(a, { decisions: [{ task: strong.id, action: 'no_change', reason: 'אין שינוי' }] });
  assert.ok(ok);
  const rows = db.prepare('SELECT task_id, action, reason FROM decisions WHERE run_id=? ORDER BY task_id').all(run);
  assert.deepEqual(rows.map((r) => [r.task_id, r.action]), [[strong.id, 'no_change'], [weak.id, 'no_change']]);
  assert.match(rows.find((r) => r.task_id === weak.id).reason, /אוטומטית/);
  // the strong one missing: rejected as a whole
  db.prepare('UPDATE claude_runs SET finished_at=? WHERE id=?').run(new Date().toISOString(), run);
  openRun(db, [{ id: strong.id, title: 'x', rank: 1 }, { id: weak.id, title: 'y', rank: 6 }]);
  assert.throws(() => apply(a, { decisions: [{ task: weak.id, action: 'no_change', reason: 'x' }] }), /חסרות החלטות/);
});

test('context for import threads (strict): same-project and search matches are context only; the owner as a participant is never a link', async () => {
  const { db, store, knowledge, a, owner, p, strong, weak } = setup();
  const searcher = createSearch(db); const threads = createThreads(db, store, knowledge);
  const ctx = createContext({ db, store, knowledge, threads, searcher, semantic: null });
  const ownerMail = store.listPeople().find((x) => x.role === 'owner').emails[0] || 'owner@example.com';
  const e = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, forwarded_from, participants) VALUES ('s1','x@y.example','נושא כללי בפרויקט מגדל הדוגמה',?, 'גוף המייל', 'Sup <sup@y.example>', ?)").run(new Date().toISOString(), JSON.stringify([{ role: 'from', email: 'sup@y.example', msg_index: 0 }, { role: 'to', email: ownerMail, msg_index: 0 }])).lastInsertRowid;
  // the owner is a participant of the task's emails and of this mail: still no link
  const te = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, participants) VALUES ('s0','z@y.example','ישן',?, 'x', ?)").run(new Date().toISOString(), JSON.stringify([{ role: 'to', email: ownerMail, msg_index: 0 }, { role: 'from', email: 'z@y.example', msg_index: 0 }])).lastInsertRowid;
  require('../lib/threads').setKeys(db, e); require('../lib/threads').setKeys(db, te);
  store.linkTaskEmail(a, weak.id, te, 'created');
  const mail = db.prepare('SELECT * FROM emails WHERE id=?').get(e);
  const loose = await ctx.gather({ emails: [mail] });
  assert.ok(loose.required.some((t) => t.id === weak.id), 'normal runs still list project-level matches (they are decided automatically as no_change when missing)');
  const strict = await ctx.gather({ emails: [mail] }, { strict: true });
  assert.equal(strict.required.length, 0, JSON.stringify(strict.required));
  assert.match(strict.block, /משימה אחרת באותו פרויקט/, 'still shown as context');
  void owner; void p; void strong;
});

test('an email with an empty subject is never "the same thread" as another empty-subject email', () => {
  const { db, store, knowledge, a, weak } = setup();
  const threads = createThreads(db, store, knowledge);
  const mk = (id) => db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, thread_key) VALUES (?, 'x@y.example', '', ?, 'x', '')").run(id, new Date().toISOString()).lastInsertRowid;
  const e1 = mk('e1'), e2 = mk('e2'); store.linkTaskEmail(a, weak.id, e2, 'created');
  assert.equal(threads.relatedEmails(e1).length, 0); assert.equal(threads.candidateTasks(e1).length, 0);
});
