'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFile } = require('child_process');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createTrash } = require('../lib/trash');
const { createTaskDelete } = require('../lib/taskdel');
const { createPurge } = require('../lib/purge');
const { createConfirm } = require('../lib/confirm');
const { createCalendar } = require('../lib/calendar');
const { createFilters } = require('../lib/filters');
const { createChatEdit } = require('../lib/chatedit');
const { createUndo } = require('../lib/undo');

function lib() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const trash = createTrash({ db, store }); const taskdel = createTaskDelete({ db, store, trash }); const purge = createPurge({ db, store, trash });
  const confirm = createConfirm({ db, store, chat, taskdel, trash, purge }); store.hooks.confirmView = confirm.get;
  const owner = store.ownerId(), a = store.assistantId();
  const p1 = store.createProject(owner, { name: 'מגדל הבדיקה' }), p2 = store.createProject(owner, { name: 'פרויקט יעד' });
  const t1 = store.createTask(owner, { title: 'משימה ראשונה בפרויקט', project: p1.id, requester: owner }), t2 = store.createTask(owner, { title: 'משימה שנייה בפרויקט', project: p1.id, requester: owner });
  store.addNote(owner, { task: t1.id, text: 'הערה על המשימה הראשונה' });
  return { db, store, chat, knowledge, trash, taskdel, purge, confirm, owner, a, p1, p2, t1, t2 };
}
const c = (db, sql, ...a) => db.prepare(sql).get(...a).c;
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

test('project delete with its tasks: everything goes to ONE bin item, nothing is left live; restore brings back the project, the tasks, the notes and the facts', () => {
  const { db, store, trash, purge, owner, p1, t1, t2 } = lib();
  db.prepare("INSERT INTO project_facts (project_id, key, value, as_of_date, created_at) VALUES (?, 'קומות', '12', '2026-11-01', ?)").run(p1.id, new Date().toISOString());
  const r = purge.project(owner, p1.id, { tasks: 'delete' });
  assert.ok(r.trash_id); assert.equal(r.tasks, 2);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM projects WHERE id=?', p1.id), 0);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM tasks WHERE id IN (?,?)', t1.id, t2.id), 0);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM project_facts WHERE project_id=?', p1.id), 0);
  assert.equal(c(db, "SELECT COUNT(*) c FROM search_index WHERE body LIKE '%הערה על המשימה%' OR title LIKE '%בפרויקט%'"), 0, 'nothing searchable');
  const l = trash.list(); assert.equal(l.total, 1); assert.equal(l.items[0].kind, 'project'); assert.equal(l.items[0].days_left, 60);
  const back = trash.restore(owner, r.trash_id);
  assert.equal(back.id, p1.id); assert.equal(store.getProject(p1.id).name_he, 'מגדל הבדיקה');
  assert.equal(c(db, 'SELECT COUNT(*) c FROM tasks WHERE project_id=?', p1.id), 2);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM notes WHERE task_id=?', t1.id), 1);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM project_facts WHERE project_id=?', p1.id), 1);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM trash'), 0);
});

test('project delete that moved the tasks: restore moves back only what is still where the deletion put it; a name taken meanwhile gets "(משוחזר)"', () => {
  const { db, store, trash, purge, owner, p1, p2, t1, t2 } = lib();
  const r = purge.project(owner, p1.id, { tasks: `move:${p2.id}` });
  store.updateTask(owner, t2.id, { project: store.defaultProjectId() }); // the owner moved one of them since
  store.createProject(owner, { name: 'מגדל הבדיקה' });
  const back = trash.restore(owner, r.trash_id);
  assert.equal(back.renamed, true); assert.match(store.getProject(back.id).name_he, /\(משוחזר\)/);
  assert.equal(db.prepare('SELECT project_id p FROM tasks WHERE id=?').get(t1.id).p, back.id);
  assert.equal(db.prepare('SELECT project_id p FROM tasks WHERE id=?').get(t2.id).p, store.defaultProjectId());
});

test('a task whose project was deleted meanwhile comes back in "לא משויך"; a taken id gets a fresh one', () => {
  const { db, store, taskdel, purge, trash, owner, p1, p2, t1 } = lib();
  const r = taskdel.purge(owner, t1.id);
  purge.project(owner, p1.id, { tasks: `move:${p2.id}` });
  const back = trash.restore(owner, r.trash_id);
  assert.equal(db.prepare('SELECT project_id p FROM tasks WHERE id=?').get(back.id).p, store.defaultProjectId());
  // id clash: delete the newest task, create another one (SQLite reuses the id), restore
  const t9 = store.createTask(owner, { title: 'משימה אחרונה', project: p2.id }); const r9 = taskdel.purge(owner, t9.id);
  const t10 = store.createTask(owner, { title: 'משימה חדשה', project: p2.id }); assert.equal(t10.id, t9.id);
  const b9 = trash.restore(owner, r9.trash_id); assert.notEqual(b9.id, t9.id);
  assert.equal(db.prepare('SELECT title FROM tasks WHERE id=?').get(b9.id).title, 'משימה אחרונה');
  assert.equal(db.prepare('SELECT title FROM tasks WHERE id=?').get(t10.id).title, 'משימה חדשה');
});

test('person, protocol, calendar item, mail filter and chat message: delete -> bin -> restore', () => {
  const { db, store, chat, knowledge, trash, purge, owner, a, p1, t1 } = lib();
  const per = store.createPerson(a, { name: 'דנה לבדיקה' }); store.updateTask(owner, t1.id, { assignee: per.id });
  const rp = purge.person(owner, per.id); assert.equal(db.prepare('SELECT assignee_id x FROM tasks WHERE id=?').get(t1.id).x, null);
  trash.restore(owner, rp.trash_id); assert.equal(db.prepare('SELECT assignee_id x FROM tasks WHERE id=?').get(t1.id).x, per.id, 'the person is linked again');

  const prid = db.prepare("INSERT INTO protocols (project_id, meeting_at, title, created_at) VALUES (?, '2026-11-20', 'ישיבת תיאום', ?)").run(p1.id, new Date().toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO protocol_items (protocol_id, text, created_at) VALUES (?, 'סעיף ראשון', ?)").run(prid, new Date().toISOString());
  const rr = purge.protocol(owner, prid); assert.equal(c(db, 'SELECT COUNT(*) c FROM protocol_items WHERE protocol_id=?', prid), 0);
  trash.restore(owner, rr.trash_id); assert.equal(c(db, 'SELECT COUNT(*) c FROM protocol_items WHERE protocol_id=?', prid), 1);

  const cal = createCalendar(db, store); const it = cal.addItem(owner, { title: 'פגישה באתר', start: '2026-12-02 10:00' });
  const rc = cal.deleteItem(owner, it.id); assert.ok(rc.trash_id); assert.equal(c(db, 'SELECT COUNT(*) c FROM calendar_items WHERE id=?', it.id), 0);
  trash.restore(owner, rc.trash_id); assert.equal(c(db, 'SELECT COUNT(*) c FROM calendar_items WHERE id=?', it.id), 1);

  const fl = createFilters({ db, store }); const rule = fl.add(owner, { kind: 'domain', pattern: 'spam.example', action: 'skip' });
  const rf = fl.remove(owner, rule.id); assert.equal(c(db, 'SELECT COUNT(*) c FROM mail_filters'), 0);
  trash.restore(owner, rf.trash_id); assert.equal(c(db, 'SELECT COUNT(*) c FROM mail_filters'), 1);

  const ce = createChatEdit({ db, store, chat, undo: createUndo(db, store, knowledge), trash });
  const m = chat.sendChat(owner, { text: 'הודעה סודית למחיקה' });
  const rm = ce.remove(owner, m.id); assert.ok(rm.trash_id);
  assert.equal(c(db, "SELECT COUNT(*) c FROM search_index WHERE kind='chat' AND ref_id=?", m.id), 0, 'out of the search');
  assert.ok(!chat.listChat({}).some((x) => x.id === m.id));
  trash.restore(owner, rm.trash_id);
  assert.ok(chat.listChat({}).some((x) => x.id === m.id), 'shown again'); assert.equal(c(db, "SELECT COUNT(*) c FROM search_index WHERE kind='chat' AND ref_id=?", m.id), 1);
  const rm2 = ce.remove(owner, m.id); trash.destroy(owner, rm2.trash_id);
  assert.equal(db.prepare('SELECT text FROM chat_messages WHERE id=?').get(m.id).text, '', 'a finally deleted message is blanked');
  assert.equal(c(db, "SELECT COUNT(*) c FROM events WHERE entity='chat' AND entity_id=? AND old_value LIKE '%סודית%'", m.id), 0);
});

test('retention: the nightly expiry removes only items older than trash_days, logs ONE event; changing the setting applies to items already in the bin; 0 = never', () => {
  const { db, trash, taskdel, owner, t1, t2 } = lib();
  const r1 = taskdel.purge(owner, t1.id), r2 = taskdel.purge(owner, t2.id);
  db.prepare('UPDATE trash SET deleted_at=? WHERE id=?').run(ago(61), r1.trash_id); db.prepare('UPDATE trash SET deleted_at=? WHERE id=?').run(ago(20), r2.trash_id);
  assert.equal(trash.get(r2.trash_id).days_left, 40);
  const ev0 = c(db, "SELECT COUNT(*) c FROM events WHERE entity='trash'");
  const x = trash.expire(); assert.equal(x.purged, 1);
  assert.equal(c(db, "SELECT COUNT(*) c FROM events WHERE entity='trash' AND action='expire'") - 0, 1); assert.ok(c(db, "SELECT COUNT(*) c FROM events WHERE entity='trash'") === ev0 + 1);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM trash WHERE id=?', r2.trash_id), 1);
  trash.setDays(30); assert.equal(trash.get(r2.trash_id).days_left, 10, 'recomputed from the deletion date');
  trash.setDays(10); assert.equal(trash.expire().purged, 1);
  assert.throws(() => trash.setDays(4000)); assert.throws(() => trash.setDays(-1)); assert.throws(() => trash.setDays('abc'));
  const r3 = taskdel.purge(owner, store3(db, owner)); db.prepare('UPDATE trash SET deleted_at=? WHERE id=?').run(ago(9999), r3.trash_id);
  trash.setDays(0); assert.equal(trash.expire().purged, 0); assert.equal(trash.get(r3.trash_id).days_left, null);
});
function store3(db, owner) { return createStore(db).createTask(owner, { title: 'משימה שלישית' }).id; }

test('the nightly housekeeping includes the bin expiry', async () => {
  const { db, store, taskdel, owner, t1 } = lib();
  const r = taskdel.purge(owner, t1.id); db.prepare('UPDATE trash SET deleted_at=? WHERE id=?').run(ago(70), r.trash_id);
  const hk = require('../lib/housekeeping').createHousekeeping(db, store, { mail: { name: 'imap', list: async () => [], remove: async () => ({}) }, dirs: { data: '/nonexistent-x', files: '/nonexistent-x', backups: '/nonexistent-x', runs: '/nonexistent-x', agentTmp: '/nonexistent-x', uploads: '/nonexistent-x', botapi: '/nonexistent-x', voice: '/nonexistent-x' } });
  const res = await hk.run({ dryRun: true }); assert.equal(res.trash.due, 1, 'the nightly run looks at the bin (dry run: nothing deleted)'); assert.equal(c(db, 'SELECT COUNT(*) c FROM trash'), 1);
});

test('permanent deletion from the bin by the assistant needs the owner\'s confirmation (single item and empty)', () => {
  const { db, trash, taskdel, confirm, owner, a, t1, t2 } = lib();
  const r1 = taskdel.purge(owner, t1.id); taskdel.purge(owner, t2.id);
  const q1 = confirm.ask(a, 'trash_delete', r1.trash_id); assert.match(q1.text, /סופית/);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM trash'), 2, 'nothing before the answer');
  assert.equal(confirm.answer(owner, q1.id, true).status, 'yes'); assert.equal(c(db, 'SELECT COUNT(*) c FROM trash'), 1);
  const q2 = confirm.ask(a, 'trash_empty', 0); assert.match(q2.text, /לרוקן/);
  confirm.answer(owner, q2.id, true); assert.equal(trash.count(), 0);
  assert.throws(() => confirm.ask(a, 'trash_empty', 0), /ריק/);
});

async function server() {
  const db = open(':memory:'); auth.setPassword(db, 'pw-1234567890ab'); auth.resetFailures();
  const app = build({ db, token: 'T', loginDelayMs: 0 }); const bearer = { authorization: 'Bearer T' };
  const lr = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw-1234567890ab' } }); const ck = lr.cookies.find((x) => x.name === 'mesimot_session');
  return { db, app, bearer, web: { cookie: `mesimot_session=${ck.value}`, 'x-mesimot': '1' } };
}

test('API: list and restore for both; permanent delete and empty only for the owner\'s session; settings carry trash_days', async () => {
  const { db, app, bearer, web } = await server();
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'משימה לסל' } })).json();
  const del = (await app.inject({ method: 'DELETE', url: `/api/tasks/${t.id}`, headers: web })).json(); assert.ok(del.trash_id);
  const l = (await app.inject({ method: 'GET', url: '/api/trash', headers: bearer })).json(); assert.equal(l.items.length, 1); assert.equal(l.days, 60);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${del.trash_id}`, headers: bearer })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/trash/empty', headers: bearer, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/trash/${del.trash_id}/restore`, headers: bearer, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).statusCode, 200);
  const del2 = (await app.inject({ method: 'DELETE', url: `/api/tasks/${t.id}`, headers: web })).json();
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${del2.trash_id}`, headers: web })).statusCode, 200);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM trash'), 0);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: web, payload: { trash_days: 5000 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: web, payload: { trash_days: 90 } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/settings', headers: web })).json().trash_days, 90);
  assert.equal((await app.inject({ method: 'GET', url: '/api/bootstrap', headers: web })).json().trash_total, 0);
});

test('CLI: mesimot trash list | restore are direct, delete | empty ask the owner', async () => {
  const { db, app, bearer } = await server();
  await app.listen({ port: 0, host: '127.0.0.1' }); const port = app.server.address().port;
  try {
    const cli = (...args) => new Promise((res, rej) => execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'mesimot'), ...args], { env: { ...process.env, MESIMOT_URL: `http://127.0.0.1:${port}`, MESIMOT_TOKEN: 'T' } }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(JSON.parse(so)))));
    const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'משימה מה-CLI' } })).json();
    const cf = (await cli('confirm', 'task-delete', String(t.id))); assert.match(cf.text, /להעביר לסל/);
    const store = createStore(db); const ans = createConfirm({ db, store, chat: createChat(db, store, createKnowledge(db, store)), taskdel: createTaskDelete({ db, store }) }).answer(store.ownerId(), cf.id, true);
    const list = await cli('trash', 'list'); assert.equal(list.items[0].id, ans.result.trash_id);
    const kind = await cli('trash', 'list', '--kind', 'project'); assert.equal(kind.items.length, 0);
    const back = await cli('trash', 'restore', String(ans.result.trash_id)); assert.equal(back.restored, true);
    assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).statusCode, 200);
    await app.inject({ method: 'DELETE', url: `/api/tasks/${t.id}`, headers: { ...bearer } }); // refused for the token (403): nothing changes
    const cf2 = await cli('confirm', 'task-delete', String(t.id)); createConfirm({ db, store, chat: createChat(db, store, createKnowledge(db, store)), taskdel: createTaskDelete({ db, store }) }).answer(store.ownerId(), cf2.id, true);
    const tid = (await cli('trash', 'list')).items[0].id;
    const d = await cli('trash', 'delete', String(tid)); assert.match(d.text, /סופית/); assert.equal(c(db, 'SELECT COUNT(*) c FROM trash'), 1, 'only asked');
    const e = await cli('trash', 'empty'); assert.match(e.text, /לרוקן/); assert.equal(c(db, 'SELECT COUNT(*) c FROM trash'), 1);
  } finally { await app.close(); }
});
