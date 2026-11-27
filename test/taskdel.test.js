'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createTaskDelete } = require('../lib/taskdel');
const { createConfirm } = require('../lib/confirm');

function lib(ttl) {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const taskdel = createTaskDelete({ db, store, ttl }); const confirm = createConfirm({ db, store, chat, taskdel }); store.hooks.confirmView = confirm.get;
  const a = store.assistantId(), owner = store.ownerId(); const proj = store.createProject(store.ownerId(), { name: 'מגדל הדוגמה' });
  const t = store.createTask(owner, { title: 'משימה למחיקה סודית', project: proj.id, due: '2026-12-01', requester: owner });
  store.addNote(owner, { task: t.id, text: 'הערה סודית שצריכה להימחק' }); store.addDraft(a, t.id, 'טיוטה סודית');
  db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text) VALUES ('m','x@y','s',?,'b')").run(new Date().toISOString());
  store.linkTaskEmail(a, t.id, 1, 'created'); store.updateTask(owner, t.id, { due: '2026-12-09' });
  chat.sendChat(owner, { text: 'הודעה בשיחה על המשימה', task_scope: t.id });
  db.prepare("INSERT INTO attention (kind, text, task_id, status, created_at) VALUES ('question','שאלה על המשימה',?, 'open', ?)").run(t.id, new Date().toISOString());
  return { db, store, chat, taskdel, confirm, a, owner, proj, t };
}
const count = (db, sql, ...a) => db.prepare(sql).get(...a).c;

test('permanent deletion: the task and everything of it are gone (index entries too); events are anonymised; the deletion is logged without content', () => {
  const { db, taskdel, owner, t } = lib();
  const r = taskdel.purge(owner, t.id);
  assert.equal(r.title, 'משימה למחיקה סודית'); assert.ok(r.token);
  for (const [tbl, col] of [['tasks', 'id'], ['notes', 'task_id'], ['drafts', 'task_id'], ['task_emails', 'task_id'], ['chat_messages', 'task_id'], ['attention', 'task_id']]) assert.equal(count(db, `SELECT COUNT(*) c FROM ${tbl} WHERE ${col}=?`, t.id), 0, tbl);
  assert.equal(count(db, "SELECT COUNT(*) c FROM search_index WHERE kind IN ('task','note') AND (title LIKE '%סודית%' OR body LIKE '%סודית%')"), 0, 'search index entries are removed');
  assert.equal(count(db, "SELECT COUNT(*) c FROM events WHERE entity='task' AND entity_id=? AND (old_value IS NOT NULL OR new_value IS NOT NULL) AND action<>'purge'", t.id), 0, 'events anonymised');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE entity='task' AND entity_id=? AND action='purge'").get(t.id), 'the deletion is logged');
  assert.equal(count(db, "SELECT COUNT(*) c FROM emails"), 1, 'the email itself stays');
});

test('undo within the window restores the task and its notes, drafts, links and thread; after the window it is gone for good', async () => {
  const { db, taskdel, owner, t } = lib(120);
  const r = taskdel.purge(owner, t.id);
  const back = taskdel.restore(owner, r.token); assert.equal(back.id, t.id);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM notes WHERE task_id=?', t.id), 1); assert.equal(count(db, 'SELECT COUNT(*) c FROM drafts WHERE task_id=?', t.id), 1);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM task_emails WHERE task_id=?', t.id), 1); assert.equal(count(db, "SELECT COUNT(*) c FROM chat_messages WHERE task_id=? AND scope='task'", t.id), 1);
  assert.equal(count(db, "SELECT COUNT(*) c FROM events WHERE entity='task' AND entity_id=? AND new_value IS NOT NULL", t.id) > 0, true, 'event content restored');
  assert.throws(() => taskdel.restore(owner, r.token), /30 שניות/, 'a token works once');
  const r2 = taskdel.purge(owner, t.id); await new Promise((res) => setTimeout(res, 200));
  assert.throws(() => taskdel.restore(owner, r2.token), /30 שניות/, 'after the window the snapshot is gone');
});

test('confirmation: the assistant asks with two buttons; "לא" deletes nothing; only the owner\'s "כן" deletes; the result carries the undo token', () => {
  const { db, confirm, a, owner, t } = lib();
  const asked = confirm.ask(a, 'task_delete', t.id);
  const msg = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(asked.message_id); assert.equal(msg.confirm_id, asked.id); assert.match(msg.text, /למחוק לצמיתות/);
  assert.equal(confirm.answer(owner, asked.id, false).status, 'no'); assert.equal(count(db, 'SELECT COUNT(*) c FROM tasks WHERE id=?', t.id), 1);
  const again = confirm.answer(owner, asked.id, true); assert.equal(again.status, 'no', 'an answered request cannot be reused');
  const a2 = confirm.ask(a, 'task_delete', t.id); const r = confirm.answer(owner, a2.id, true);
  assert.equal(r.status, 'yes'); assert.ok(r.result.token); assert.equal(count(db, 'SELECT COUNT(*) c FROM tasks WHERE id=?', t.id), 0);
});

test('the API: a token (the assistant) cannot delete directly; the owner can; the confirmation endpoint answers only for the owner', async () => {
  const db = open(':memory:'); auth.setPassword(db, 'pw-1234567890ab'); auth.resetFailures();
  const app = build({ db, token: 'T', loginDelayMs: 0 }); const bearer = { authorization: 'Bearer T' };
  const lr = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw-1234567890ab' } }); const c = lr.cookies.find((x) => x.name === 'mesimot_session'); const web = { cookie: `mesimot_session=${c.value}`, 'x-mesimot': '1' };
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'משימה', due: '2026-12-01' } })).json();
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/tasks/${t.id}`, headers: bearer })).statusCode, 403, 'the assistant must ask for a confirmation');
  const asked = (await app.inject({ method: 'POST', url: '/api/confirm', headers: bearer, payload: { kind: 'task_delete', id: t.id } })).json();
  assert.equal((await app.inject({ method: 'POST', url: `/api/confirm/${asked.id}/answer`, headers: bearer, payload: { yes: true } })).statusCode, 403, 'the assistant cannot answer for the owner');
  const ans = await app.inject({ method: 'POST', url: `/api/confirm/${asked.id}/answer`, headers: web, payload: { yes: true } }); assert.equal(ans.statusCode, 200); assert.equal(ans.json().status, 'yes');
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).statusCode, 404);
  const undo = await app.inject({ method: 'POST', url: '/api/purge/undo', headers: web, payload: { token: ans.json().result.token } }); assert.equal(undo.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).statusCode, 200, 'restored');
  const del = await app.inject({ method: 'DELETE', url: `/api/tasks/${t.id}`, headers: web }); assert.equal(del.statusCode, 200, 'the owner\'s own button works');
});
