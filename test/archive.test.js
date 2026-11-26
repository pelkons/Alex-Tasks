'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { build } = require('../lib/server');

function setup() {
  const db = open(':memory:'); const app = build({ db, token: 't', loginDelayMs: 0 }); const h = { authorization: 'Bearer t' };
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: h })).json();
  const post = async (url, payload, method = 'POST') => app.inject({ method, url, headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  return { db, app, get, post };
}
const mk = async (post, title, extra = {}) => (await post('/api/tasks', { title, due: '2026-12-01', ...extra })).json();

test('closed tasks are gone from the open list and live in the archive (newest first, with filters); reopening brings one back', async () => {
  const { get, post } = setup();
  const p1 = (await post('/api/projects', { name: 'מגדל הדוגמה' })).json(), p2 = (await post('/api/projects', { name: 'פארק הדוגמה' })).json();
  const a = await mk(post, 'משימה פתוחה אחת', { project: p1.id }); const b = await mk(post, 'משימה שהושלמה בטון', { project: p1.id }); const c = await mk(post, 'משימה שבוטלה פיגומים', { project: p2.id });
  await post(`/api/tasks/${b.id}`, { status: 'הושלם' }, 'PATCH'); await post(`/api/tasks/${c.id}`, { status: 'בוטל' }, 'PATCH');
  const open = await get('/api/tasks?open=1'); assert.deepEqual(open.map((t) => t.id), [a.id], 'the main list shows only open tasks');
  const arc = await get('/api/archive'); assert.equal(arc.total, 2); assert.deepEqual(new Set(arc.items.map((t) => t.id)), new Set([b.id, c.id]), 'done and cancelled are archived');
  assert.deepEqual((await get(`/api/archive?project=${p2.id}`)).items.map((t) => t.id), [c.id], 'filter by project');
  assert.deepEqual((await get('/api/archive?q=בטון')).items.map((t) => t.id), [b.id], 'its own search');
  assert.equal((await get('/api/archive?from=2999-01-01')).total, 0, 'date filter');
  assert.equal((await post(`/api/tasks/${b.id}`, { status: 'בטיפול' }, 'PATCH')).statusCode, 200);
  assert.deepEqual((await get('/api/tasks?open=1')).map((t) => t.id).sort(), [a.id, b.id].sort(), 'reopened');
  assert.equal((await get('/api/archive')).total, 1);
});

test('global search: current items by default, archived ones only with archive=1', async () => {
  const { get, post } = setup();
  const t = await mk(post, 'לאשר חשבון חלקי של הקבלן מיוחד'); await post(`/api/tasks/${t.id}`, { status: 'הושלם' }, 'PATCH');
  const q = encodeURIComponent('חשבון חלקי');
  assert.equal((await get(`/api/search?q=${q}&kind=task`)).results.length, 0, 'hidden by default');
  const r = await get(`/api/search?q=${q}&kind=task&archive=1`); assert.equal(r.results.length, 1); assert.equal(r.results[0].id, t.id);
});

test('the assistant\'s Q&A looks in the archive automatically when nothing current answers', async () => {
  const { db, get, post } = setup();
  const t = await mk(post, 'לבדוק את אטימות החלונות בקומה שבע'); await post(`/api/tasks/${t.id}`, { status: 'הושלם' }, 'PATCH');
  db.prepare("INSERT INTO notes (task_id, text, kind, author_id, created_at) VALUES (?,?,?,?,?)").run(t.id, 'נבדק, אטימות החלונות תקינה', 'text', 1, new Date().toISOString());
  const r = await get('/api/ask?q=' + encodeURIComponent('אטימות החלונות'));
  assert.equal(r.searched_archive, true); assert.ok(r.results.some((x) => x.kind === 'task' && x.id === t.id), JSON.stringify(r.results.map((x) => x.kind)));
});
