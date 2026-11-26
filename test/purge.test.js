'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createTaskDelete } = require('../lib/taskdel');
const { createPurge } = require('../lib/purge');
const { createConfirm } = require('../lib/confirm');

function lib() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const taskdel = createTaskDelete({ db, store }); const purge = createPurge({ db, store, taskdel }); const confirm = createConfirm({ db, store, chat, taskdel, purge });
  const a = store.assistantId(), owner = store.ownerId();
  const p1 = store.createProject(a, { name: 'פרויקט ישן' }), p2 = store.createProject(a, { name: 'פרויקט יעד' });
  const t1 = store.createTask(owner, { title: 'משימה א', project: p1.id, requester: owner }), t2 = store.createTask(owner, { title: 'משימה ב', project: p1.id, requester: owner });
  return { db, store, chat, purge, confirm, a, owner, p1, p2, t1, t2 };
}
const c = (db, sql, ...a) => db.prepare(sql).get(...a).c;

test('project delete: tasks move to the target project, the project is gone and the deletion is logged', () => {
  const { db, purge, owner, p1, p2, t1, t2 } = lib();
  const r = purge.project(owner, p1.id, { tasks: `move:${p2.id}` });
  assert.equal(r.tasks, 2);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM projects WHERE id=?', p1.id), 0);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM tasks WHERE project_id=?', p2.id), 2);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE entity='project' AND action='purge'").get());
  assert.ok(t1 && t2);
});

test('project delete: unassign (default) and delete modes; the default project cannot be deleted', () => {
  const x = lib(); x.purge.project(x.owner, x.p1.id, {});
  const def = x.db.prepare('SELECT id FROM projects WHERE is_default=1').get().id;
  assert.equal(c(x.db, 'SELECT COUNT(*) c FROM tasks WHERE project_id=?', def), 2);
  assert.throws(() => x.purge.project(x.owner, def, {}));
  const y = lib(); y.purge.project(y.owner, y.p1.id, { tasks: 'delete' });
  assert.equal(c(y.db, 'SELECT COUNT(*) c FROM tasks'), 0);
});

test('project delete through a confirmation: only the owner answer executes it', () => {
  const { db, confirm, a, owner, p1, p2 } = lib();
  const cf = confirm.ask(a, 'project_delete', p1.id, { payload: { tasks: `move:${p2.id}` } });
  assert.match(cf.text || cf.message?.text || JSON.stringify(cf), /פרויקט ישן/);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM projects WHERE id=?', p1.id), 1, 'nothing happens before the answer');
  confirm.answer(owner, cf.id, true);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM projects WHERE id=?', p1.id), 0);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM tasks WHERE project_id=?', p2.id), 2);
});

test('person delete keeps the tasks without the person; the owner cannot be deleted', () => {
  const { db, store, purge, owner, a, p1 } = lib();
  const per = store.createPerson(a, { name: 'דנה בדיקה' });
  const t = store.createTask(owner, { title: 'משימה של דנה', project: p1.id, assignee: per.id, requester: owner });
  purge.person(owner, per.id);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM people WHERE id=?', per.id), 0);
  assert.equal(db.prepare('SELECT assignee_id a FROM tasks WHERE id=?').get(t.id).a, null);
  assert.throws(() => purge.person(owner, owner));
});

test('entity-scoped chat: stored with its ref, listed per scope, kept out of other scopes; bad refs are refused', () => {
  const { chat, owner, a, p1, db } = lib();
  const m = chat.sendChat(owner, { text: 'תשנה את שם הפרויקט', entity_scope: `project:${p1.id}` });
  assert.equal(m.scope, 'entity'); assert.equal(m.scope_ref, `project:${p1.id}`);
  assert.equal(chat.scopeThread(`project:${p1.id}`).length, 1);
  assert.equal(chat.scopeThread('day:2026-12-01').length, 0);
  assert.throws(() => chat.sendChat(owner, { text: 'x', entity_scope: 'project:9999' }));
  assert.throws(() => chat.sendChat(owner, { text: 'x', entity_scope: 'zzz:1' }));
  // the assistant's reply inside a run pinned to the project stays in the scope
  const run = chat.startRun('chat', 1); db.prepare('UPDATE claude_runs SET pinned_ref=? WHERE id=?').run(`project:${p1.id}`, run);
  const r = chat.sendChat(a, { text: 'שיניתי את השם' });
  assert.equal(r.scope_ref, `project:${p1.id}`);
  assert.equal(chat.scopeThread(`project:${p1.id}`).length, 2);
});
