'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');

const TOKEN = 'test-token-123';
const PW = 'correct horse battery';

function setup() {
  const db = open(':memory:');
  auth.setPassword(db, PW);
  auth.resetFailures();
  const app = build({ db, token: TOKEN, loginDelayMs: 0 }); require('./helpers/owner')(app, db, PW);
  const bearer = { authorization: `Bearer ${TOKEN}` };
  async function login() {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PW } });
    assert.equal(r.statusCode, 200);
    const c = r.cookies.find((x) => x.name === 'mesimot_session');
    assert.ok(c.httpOnly && c.secure);
    return { cookie: `mesimot_session=${c.value}`, 'x-mesimot': '1' };
  }
  return { db, app, bearer, login };
}

test('auth is required', async () => {
  const { app } = setup();
  let r = await app.inject({ method: 'GET', url: '/api/tasks' });
  assert.equal(r.statusCode, 401);
  r = await app.inject({ method: 'GET', url: '/settings' });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/login');
  r = await app.inject({ method: 'GET', url: '/' });
  assert.equal(r.statusCode, 200, 'the public landing page is served at /');
  r = await app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.statusCode, 401);
  r = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /dir="rtl"/);
});

test('login: wrong password, lockout after 5 failures', async () => {
  const { app } = setup();
  for (let i = 0; i < 4; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } });
    assert.equal(r.statusCode, 401);
  }
  let r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } });
  assert.equal(r.statusCode, 429);
  r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PW } });
  assert.equal(r.statusCode, 429, 'correct password is also refused while locked');
  auth.resetFailures();
});

test('cookie writes need the request header', async () => {
  const { app, login } = setup();
  const h = await login();
  const r = await app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie: h.cookie }, payload: { title: 'x' } });
  assert.equal(r.statusCode, 403);
});

test('task create/update/note write events with the right actor', async () => {
  const { app, bearer, login, db } = setup();
  const web = await login();
  let r = await app.inject({ method: 'POST', url: '/api/tasks', headers: web, payload: { title: 'לבדוק חוזה' } });
  assert.equal(r.statusCode, 201);
  const t = r.json();
  assert.equal(t.status, 'חדש');
  assert.equal(t.project, 'לא משויך');
  assert.equal(t.assignee, 'דנה');

  r = await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: web, payload: { status_id: 2, priority: 'דחוף', due_date: '05/12/2026' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'בטיפול');
  assert.equal(r.json().due_date, '2026-12-05');

  r = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/notes`, headers: bearer, payload: { text: 'הערה מהעוזר' } });
  assert.equal(r.statusCode, 201);
  r = await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: bearer, payload: { status: 'הושלם' } });
  assert.ok(r.json().done_at);

  const d = (await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).json();
  const ev = d.history;
  assert.ok(ev.length >= 5);
  assert.deepEqual(ev.filter((e) => e.field === 'status').map((e) => [e.actor, e.new_value]).reverse(), [['דנה', 'בטיפול'], ['אלכס', 'הושלם']]);
  assert.equal(ev.find((e) => e.action === 'create').actor, 'דנה');
  assert.equal(ev.find((e) => e.action === 'note').actor, 'אלכס');

  // web events wait for processing, the assistant's own events do not
  const p = (await app.inject({ method: 'GET', url: '/api/pending', headers: bearer })).json();
  assert.ok(p.events.length > 0 && p.events.every((e) => e.actor === 'דנה'));
  r = await app.inject({ method: 'POST', url: '/api/ack', headers: bearer, payload: { ids: p.events.map((e) => e.id) } });
  assert.equal(r.json().acked, p.events.length);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events WHERE processed_at IS NULL').get().c, 0);
});

test('validation errors are Hebrew', async () => {
  const { app, bearer } = setup();
  let r = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: '  ' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /[֐-׿]/);
  r = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'a', project: 'אין כזה' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'GET', url: '/api/tasks/9999', headers: bearer });
  assert.equal(r.statusCode, 404);
});

test('project merge moves tasks and keeps the old name as alias', async () => {
  const { app, bearer, db } = setup();
  const mk = async (name) => (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name } })).json();
  const a = await mk('פרויקט א'), b = await mk('פרויקט ב');
  for (const [title, project] of [['t1', a.id], ['t2', a.id], ['t3', b.id]]) {
    await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title, project } });
  }
  let r = await app.inject({ method: 'POST', url: `/api/projects/${a.id}/merge`, headers: bearer, payload: { into: b.id } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().moved_tasks, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_id=?').get(b.id).c, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM projects WHERE id=?').get(a.id).c, 0);
  const proj = (await app.inject({ method: 'GET', url: '/api/projects', headers: bearer })).json().find((p) => p.id === b.id);
  assert.ok(proj.aliases.includes('פרויקט א'));
  assert.equal(proj.open_count, 3);
  // lookup by alias works
  r = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 't4', project: 'פרויקט א' } });
  assert.equal(r.json().project_id, b.id);
  // merge events exist
  assert.ok(db.prepare("SELECT 1 FROM events WHERE action IN ('merge','resolve')").get());
  // the default project cannot be merged away
  const def = db.prepare('SELECT id FROM projects WHERE is_default=1').get().id;
  r = await app.inject({ method: 'POST', url: `/api/projects/${def}/merge`, headers: bearer, payload: { into: b.id } });
  assert.equal(r.statusCode, 400);
});

test('statuses/priorities are in tables; cancelled hidden by default', async () => {
  const { app, bearer } = setup();
  const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: bearer })).json();
  assert.deepEqual(boot.statuses.map((s) => s.name_he), ['חדש', 'בטיפול', 'ממתין', 'הושלם', 'בוטל']);
  assert.deepEqual(boot.priorities.map((s) => s.name_he), ['דחוף', 'רגיל', 'נמוך']);
  assert.equal(boot.people.length, 6);
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'x', status: 'בוטל' } })).json();
  let list = (await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer })).json();
  assert.ok(!list.find((x) => x.id === t.id));
  list = (await app.inject({ method: 'GET', url: '/api/tasks?include_hidden=1', headers: bearer })).json();
  assert.ok(list.find((x) => x.id === t.id));
});

test('requester, source date and due source', async () => {
  const { app, bearer, login } = setup();
  const web = await login();
  // web task: source_date defaults to now, manual due date
  let r = await app.inject({ method: 'POST', url: '/api/tasks', headers: web, payload: { title: 'מהאתר', due_date: '10/12/2026' } });
  const w = r.json();
  assert.ok(w.source_date && Math.abs(Date.now() - Date.parse(w.source_date)) < 60000);
  assert.equal(w.due_source, 'manual');
  assert.equal(w.requester_id, null);

  // assistant task with requester by name, original email date (Jerusalem time), estimated due date
  r = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'מאבי', requester: 'אבי כהן', source_date: '23/11/2026 09:30', due: '30/11/2026', due_source: 'estimated' } });
  assert.equal(r.statusCode, 201);
  const t = r.json();
  assert.equal(t.requester, 'אבי כהן');
  assert.equal(t.due_source, 'estimated');
  assert.equal(t.source_date, '2026-11-23T07:30:00.000Z'); // UTC+2 in November
  assert.equal(t.created_by, 4);

  // a manual edit from the web flips the source to manual
  r = await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: web, payload: { due_date: '01/12/2026' } });
  assert.equal(r.json().due_source, 'manual');
  // requester change is logged
  r = await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: web, payload: { requester_id: null } });
  assert.equal(r.json().requester, null);
  const hist = (await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).json().history;
  assert.ok(hist.find((e) => e.field === 'requester' && e.old_value === 'אבי כהן' && e.actor === 'דנה'));
  assert.ok(hist.find((e) => e.field === 'due_source' && e.new_value === 'manual'));

  r = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'x', due_source: 'bogus' } });
  assert.equal(r.statusCode, 400);
  // filter by requester
  const list = (await app.inject({ method: 'GET', url: '/api/tasks?requester=none', headers: bearer })).json();
  assert.ok(list.every((x) => x.requester_id === null));
});

test('default order: overdue and nearest due first, no due date last', async () => {
  const { app, bearer } = setup();
  for (const [title, due] of [['ללא', null], ['רחוק', '2030-01-01'], ['עבר', '2020-01-01'], ['קרוב', '2029-01-01']]) {
    await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title, due } });
  }
  const list = (await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer })).json();
  assert.deepEqual(list.map((x) => x.title), ['עבר', 'קרוב', 'רחוק', 'ללא']);
});

test('projects get a stable saved color that can be changed', async () => {
  const { app, bearer } = setup();
  const a = (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'א' } })).json();
  assert.match(a.color, /^#[0-9a-f]{6}$/);
  const again = (await app.inject({ method: 'GET', url: '/api/projects', headers: bearer })).json().find((p) => p.id === a.id);
  assert.equal(again.color, a.color);
  let r = await app.inject({ method: 'PATCH', url: `/api/projects/${a.id}`, headers: bearer, payload: { color: '#123456' } });
  assert.equal(r.json().color, '#123456');
  r = await app.inject({ method: 'PATCH', url: `/api/projects/${a.id}`, headers: bearer, payload: { color: 'red' } });
  assert.equal(r.statusCode, 400);
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'x', project: a.id } })).json();
  assert.equal(t.project_color, '#123456');
  const def = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'y' } })).json();
  assert.equal(def.project_default, 1);
});

test('undo: reverts through the events log, logs the undo as an owner event, refuses stale values', async () => {
  const { app, bearer, login, db } = setup();
  const web = await login();
  // a run in progress so the assistant's actions are attributed to it
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'chat')").run(new Date().toISOString()).lastInsertRowid;
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'משימה של Claude', priority: 'רגיל', due: '30/11/2026', due_source: 'estimated' } })).json();
  await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: bearer, payload: { assignee: 'רון שחר', priority: 'דחוף' } });
  await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/notes`, headers: bearer, payload: { text: 'הערה' } });
  db.prepare('UPDATE claude_runs SET finished_at=? WHERE id=?').run(new Date().toISOString(), run);

  let act = (await app.inject({ method: 'GET', url: '/api/activity', headers: web })).json();
  assert.equal(act.runs[0].id, Number(run));
  assert.equal(act.today_runs, 1);
  const acts = act.runs[0].actions;
  assert.ok(acts.length >= 4 && acts.every((a) => a.undoable));
  // token callers cannot undo
  assert.equal((await app.inject({ method: 'POST', url: `/api/events/${acts[0].id}/undo`, headers: bearer })).statusCode, 403);
  // undo the assignee change
  const asg = acts.find((a) => a.field === 'assignee');
  let r = await app.inject({ method: 'POST', url: `/api/events/${asg.id}/undo`, headers: web });
  assert.equal(r.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).json().assignee, 'דנה');
  // the undo is an owner event waiting for the assistant to learn from it
  const pend = (await app.inject({ method: 'GET', url: '/api/pending', headers: bearer })).json().events;
  assert.ok(pend.some((e) => e.entity === 'undo' && e.actor === 'דנה'));
  // a second undo of the same action is refused
  assert.equal((await app.inject({ method: 'POST', url: `/api/events/${asg.id}/undo`, headers: web })).statusCode, 400);
  // the owner changes the priority himself; undoing the assistant's older priority change is now refused
  await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: web, payload: { priority: 'נמוך' } });
  const pri = acts.find((a) => a.field === 'priority' && a.action === 'update');
  r = await app.inject({ method: 'POST', url: `/api/events/${pri.id}/undo`, headers: web });
  assert.equal(r.statusCode, 400);
  // undo the whole run: note removed, task cancelled (hidden), the skipped one reported
  r = await app.inject({ method: 'POST', url: `/api/runs/${run}/undo`, headers: web });
  const res = r.json();
  assert.ok(res.undone >= 2 && res.skipped.length >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes WHERE task_id=?').get(t.id).c, 0);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: bearer })).json().status, 'בוטל');
});

test('renaming a project keeps the old name as an alias', async () => {
  const { app, bearer } = setup();
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'שם ישן', aliases: 'כינוי' } })).json();
  const r = (await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: bearer, payload: { name: 'שם חדש' } })).json();
  assert.deepEqual(r.aliases.sort(), ['כינוי', 'שם ישן'].sort());
  const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer, payload: { title: 'x', project: 'שם ישן' } })).json();
  assert.equal(t.project, 'שם חדש');
});

test('the public landing page: bilingual, no personal data, static; robots.txt allows only "/"; the app at "/" for a signed-in owner; /login unchanged', async () => {
  const { app, bearer } = setup();
  const r = await app.inject({ method: 'GET', url: '/' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.body, /<title>Mesimot — task and project management for construction engineering teams<\/title>/);
  assert.match(r.body, /<meta name="description"/);
  assert.match(r.body, /Alex Tasks — ניהול משימות ופרויקטים לצוותי הנדסה ובנייה/);
  assert.match(r.body, /href="\/login"[^>]*>Sign in \/ כניסה/);
  assert.match(r.body, /Private business tool\. Access by invitation only\./);
  assert.ok(r.body.indexOf('Email to task') < r.body.indexOf('ממייל למשימה'), 'English first, then Hebrew');
  assert.ok(!/<script|https?:\/\/(?!www\.w3)/i.test(r.body), 'no scripts and no external requests');
  for (const word of ['example', 'exconstruct', 'kosta', 'דנה', 'אשתרום', '@']) assert.ok(!r.body.toLowerCase().includes(word.toLowerCase()), 'no personal data: ' + word);
  const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
  assert.equal(robots.statusCode, 200);
  assert.match(robots.body, /Allow: \/\$\nDisallow: \/\n/);
  for (const d of ['/api', '/cal', '/login', '/files']) assert.ok(robots.body.includes('Disallow: ' + d + '\n'), d);
  assert.equal((await app.inject({ method: 'GET', url: '/login' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/settings' })).statusCode, 302, 'other pages still redirect to the login');
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks' })).statusCode, 401);
  const app2 = await app.inject({ method: 'GET', url: '/', headers: bearer });
  assert.match(app2.body, /x-data|Alpine|app\.js/, 'an authenticated request gets the app');
});
