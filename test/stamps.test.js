'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { build } = require('../lib/server');
const { createStore } = require('../lib/store');

test('project, person and protocol pages carry created / last updated stamps (the event log itself stays out of the pages)', async () => {
  const db = open(':memory:'); const app = build({ db, token: 'tok', loginDelayMs: 0 }); const H = { authorization: 'Bearer tok' }; const store = createStore(db); const a = store.assistantId();
  const proj = store.createProject(store.ownerId(), { name: 'פרויקט הדוגמה' }); const person = store.createPerson(a, { name: 'דנה בדיקה', role: 'contact' }); store.updateProject(a, proj.id, { summary: 'תקציר חדש' });
  const pg = (await app.inject({ method: 'GET', url: `/api/projects/${proj.id}/page`, headers: H })).json(); assert.ok(pg.stamps.created_at && pg.stamps.updated_at >= pg.stamps.created_at);
  const pc = (await app.inject({ method: 'GET', url: `/api/people/${person.id}`, headers: H })).json(); assert.ok(pc.stamps.created_at && pc.stamps.updated_at);
  const pr = db.prepare("INSERT INTO protocols (project_id, meeting_at, title, participants, created_by, created_at) VALUES (?,?,?,?,?,?)").run(proj.id, '2026-11-20T10:00:00Z', 'פרוטוקול', '[]', a, new Date().toISOString()).lastInsertRowid;
  const prot = (await app.inject({ method: 'GET', url: `/api/protocols/${pr}`, headers: H })).json(); assert.ok(prot.stamps.created_at && prot.stamps.updated_at === prot.stamps.created_at);
  const t = store.createTask(a, { title: 'משימה', requester: store.ownerId() }); const d = (await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: H })).json(); assert.ok(d.created_at && d.updated_at);
});
