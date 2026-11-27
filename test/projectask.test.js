'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-pa-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createProposals } = require('../lib/proposals');
const { createTelegram } = require('../lib/telegram');
const { createGate } = require('../lib/gate');
const { norm, variants } = require('../lib/projectask');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const proposals = createProposals({ db, store, chat }); const pa = proposals.projectAsk(); store.hooks.pendingProject = pa.pendingByName;
  const a = store.assistantId(), owner = store.ownerId();
  const tower = store.createProject(owner, { name: 'מגדל הדוגמה', aliases: ['מגדל הדגם'] }); const park = store.createProject(owner, { name: 'פארק הדוגמה' });
  const eid = db.prepare("INSERT INTO emails (message_id, from_addr, to_addr, subject, original_subject, received_at, body_text) VALUES ('m1','Ron <ron@vendor.example>','d@x.example','FW: תכנון שכונת הזית','תכנון שכונת הזית','2026-11-24T08:00:00Z','שלום')").run().lastInsertRowid;
  return { db, store, chat, proposals, pa, a, owner, tower, park, eid };
}
const rowOf = (S, name) => S.db.prepare('SELECT * FROM project_proposals WHERE name=?').get(name);

test('the assistant cannot create a project: the store refuses, the API turns the request into a pending proposal; the owner still creates directly', async () => {
  const S = setup();
  assert.throws(() => S.store.createProject(S.a, { name: 'שכונת הזית' }), /project propose/);
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM projects WHERE name_he='שכונת הזית'").get().c, 0);
  const d = S.store.createProject(S.owner, { name: 'ישיר' }); assert.equal(d.name_he, 'ישיר');
  const { build } = require('../lib/server'); const auth = require('../lib/auth'); auth.setPassword(S.db, 'pw pw pw pw pw pw'); const app = build({ db: S.db, token: 'tok', loginDelayMs: 0 });
  const r = await app.inject({ method: 'POST', url: '/api/projects', headers: { authorization: 'Bearer tok' }, payload: { name: 'שכונת הזית', aliases: 'הזית', from: `email:${S.eid}` } });
  assert.equal(r.statusCode, 202); const j = r.json(); assert.equal(j.status, 'pending_approval'); assert.equal(S.db.prepare("SELECT COUNT(*) c FROM projects WHERE name_he='שכונת הזית'").get().c, 0);
  const l = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw pw pw pw pw pw' } }); const ow = { cookie: `mesimot_session=${l.cookies[0].value}`, 'x-mesimot': '1' };
  const r2 = await app.inject({ method: 'POST', url: '/api/projects', headers: ow, payload: { name: 'מהאתר' } }); assert.equal(r2.statusCode, 201); assert.equal(r2.json().name_he, 'מהאתר');
  const bad = await app.inject({ method: 'POST', url: `/api/proposals/item/${S.db.prepare("SELECT id FROM proposals WHERE kind='project_new'").get().id}`, headers: { authorization: 'Bearer tok' }, payload: { action: 'approve' } });
  assert.notEqual(bad.statusCode, 200, 'only the owner answers'); assert.equal(S.db.prepare("SELECT COUNT(*) c FROM projects WHERE name_he='שכונת הזית'").get().c, 0);
});

test('one question per normalized name; aliases, prefixes, quotes and existing aliases do not create another', () => {
  const S = setup();
  assert.equal(norm('«בשכונת "הזית"»'), 'בשכונת הזית'); assert.ok(variants('בדוגמית').includes('דוגמית'));
  const r1 = S.pa.propose(S.a, { name: 'דוגמית', aliases: ['מגרש 212'], from: `email:${S.eid}` }); assert.equal(r1.status, 'pending_approval');
  assert.equal(r1.proposal.context.startsWith('מתוך: תכנון שכונת הזית'), true, r1.proposal.context);
  const r2 = S.pa.propose(S.a, { name: 'בדוגמית' }); assert.equal(r2.deduped, true); const r3 = S.pa.propose(S.a, { name: 'מגרש 212' }); assert.equal(r3.deduped, true);
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM project_proposals").get().c, 1); assert.equal(S.db.prepare("SELECT COUNT(*) c FROM proposals WHERE kind='project_new'").get().c, 1);
  assert.equal(S.pa.propose(S.a, { name: 'מגדל הדגם' }).status, 'exists', 'an alias of an existing project'); assert.equal(S.pa.propose(S.a, { name: 'מגדל הדוגמה' }).status, 'exists');
  const it = S.proposals.batch(r1.batch).items[0]; assert.equal(it.ask, 'פרויקט חדש? «דוגמית»'); assert.equal(it.approve_label, '✅ כן, להוסיף'); assert.equal(it.reject_label, '❌ לא');
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM attention WHERE status='open' AND text LIKE 'פרויקט חדש?%'").get().c, 1);
});

test('YES: the project is created with the proposed name and aliases; the source email, its tasks and everything waiting are linked', () => {
  const S = setup();
  const r = S.pa.propose(S.a, { name: 'שכונת הזית', aliases: ['הזית'], from: `email:${S.eid}` });
  const t1 = S.store.createTask(S.a, { title: 'לבדוק תכנון', source_email_id: S.eid, project: 'הזית' }); // the pending name resolves to unassigned
  const t2 = S.store.createTask(S.a, { title: 'משימה על הזית', project: 'הזית' }); const t3 = S.store.createTask(S.a, { title: 'לא קשור' });
  assert.equal(S.store.getTask(t2.id).pending_project, 'שכונת הזית'); assert.equal(S.store.getTask(t2.id).project_default, 1); assert.equal(S.store.getTask(t3.id).pending_project, null);
  const pq = S.db.prepare("SELECT id FROM proposals WHERE kind='project_new'").get().id;
  const res = S.proposals.decide(pq, 'approve'); assert.equal(res.status, 'applied'); assert.match(res.result, /נוצר הפרויקט "שכונת הזית"/);
  const p = S.store.listProjects().find((x) => x.name_he === 'שכונת הזית'); assert.ok(p); assert.deepEqual(p.aliases, ['הזית']);
  for (const id of [t1.id, t2.id]) assert.equal(S.store.getTask(id).project_id, p.id); assert.notEqual(S.store.getTask(t3.id).project_id, p.id);
  assert.equal(S.db.prepare('SELECT project_id FROM emails WHERE id=?').get(S.eid).project_id, p.id); assert.equal(S.db.prepare('SELECT COUNT(*) c FROM pending_project_items').get().c, 0);
  assert.equal(S.db.prepare("SELECT status FROM attention WHERE text LIKE 'פרויקט חדש?%'").get().status, 'accepted'); assert.equal(rowOf(S, 'שכונת הזית').status, 'created');
  assert.equal(S.pa.propose(S.a, { name: 'הזית' }).status, 'exists', 'later mail resolves to the new project');
});

test('NO + belongs to project Y: the name becomes an alias of Y and the waiting items move to Y; second step offers up to 4 projects', () => {
  const S = setup();
  const t = S.store.createTask(S.a, { title: 'סיור באתר פארק', source_email_id: S.eid });
  const r = S.pa.propose(S.a, { name: 'פארק צפון', aliases: ['PN'], from: `email:${S.eid}`, attach: `task:${t.id}` });
  const pq = S.db.prepare("SELECT id FROM proposals WHERE kind='project_new'").get().id;
  const no = S.proposals.decide(pq, 'reject'); assert.equal(no.status, 'rejected');
  const pick = S.db.prepare("SELECT * FROM proposals WHERE kind='project_pick'").get(); assert.ok(pick); const view = S.proposals.withContext(pick);
  assert.ok(view.options.length >= 2 && view.options.length <= 4); assert.ok(view.options.some((o) => o.id === S.park.id)); assert.equal(view.none_label, '🚫 לא פרויקט'); assert.equal(rowOf(S, 'פארק צפון').status, 'open', 'still waiting');
  const done = S.proposals.decide(pick.id, 'approve', { project: S.park.id }); assert.equal(done.status, 'applied');
  const park = S.store.getProject(S.park.id); assert.ok(park.aliases.includes('פארק צפון') && park.aliases.includes('PN'));
  assert.equal(S.store.getTask(t.id).project_id, S.park.id); assert.equal(S.pa.propose(S.a, { name: 'PN' }).status, 'exists'); assert.equal(rowOf(S, 'פארק צפון').status, 'alias');
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM projects WHERE name_he='פארק צפון'").get().c, 0);
});

test('NO + not a project: stored as rejected with variants, never proposed again, items stay unassigned, no gate question', () => {
  const S = setup();
  const t = S.store.createTask(S.a, { title: 'ישיבה עם דוגמית', source_email_id: S.eid });
  S.pa.propose(S.a, { name: 'דוגמית', from: `email:${S.eid}` }); const pq = S.db.prepare("SELECT id FROM proposals WHERE kind='project_new'").get().id;
  S.proposals.decide(pq, 'reject'); const pick = S.db.prepare("SELECT id FROM proposals WHERE kind='project_pick'").get(); const res = S.proposals.decide(pick.id, 'reject'); assert.equal(res.status, 'rejected');
  assert.equal(S.store.getTask(t.id).project_default, 1); assert.equal(S.store.getTask(t.id).pending_project, null);
  for (const n of ['דוגמית', 'בדוגמית', '"דוגמית"', 'פרויקט דוגמית']) { const r = S.pa.propose(S.a, { name: n }); assert.equal(r.status, 'rejected', n); }
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM project_proposals").get().c, 1); assert.equal(S.db.prepare("SELECT COUNT(*) c FROM proposals WHERE kind='project_new'").get().c, 1);
  assert.equal(S.db.prepare("SELECT status FROM attention WHERE text LIKE 'פרויקט חדש?%'").get().status, 'dismissed');
});

test('the owner\'s own chat words ("פתח פרויקט X") create it directly; otherwise a chat source still asks', () => {
  const S = setup();
  const m = S.chat.sendChat(S.owner, { text: 'תפתח פרויקט חדש בשם שכונת הברושים' });
  assert.equal(S.pa.propose(S.a, { name: 'שכונת הברושים', from: `chat:${m.id}` }).status, 'created');
  const m2 = S.chat.sendChat(S.owner, { text: 'דיברתי היום עם אורן על שכונת האלונים' });
  assert.equal(S.pa.propose(S.a, { name: 'שכונת האלונים', from: `chat:${m2.id}` }).status, 'pending_approval');
});

test('a run that wrote a project around the API is reverted by the gate into a proposal and re-prompted', async () => {
  const S = setup(); const gate = createGate({ db: S.db, store: S.store, knowledge: createKnowledge(S.db, S.store), projectAsk: S.pa });
  const runId = S.db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'email')").run(new Date(Date.now() - 1000).toISOString()).lastInsertRowid;
  const id = S.db.prepare("INSERT INTO projects (name_he, aliases, created_by, created_at, color) VALUES ('שכונת הכרמל','[]',?,?,'#112233')").run(S.a, new Date().toISOString()).lastInsertRowid;
  const t = S.db.prepare("UPDATE tasks SET project_id=? WHERE id=?"); const task = S.store.createTask(S.a, { title: 'x' }); t.run(id, task.id);
  const V = await gate.check(runId, { emails: [], chats: [], files: [] });
  assert.ok(V.some((v) => v.code === 'project_direct' && /project propose/.test(v.question)));
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM projects WHERE id=?').get(id).c, 0); assert.equal(rowOf(S, 'שכונת הכרמל').status, 'open');
  assert.equal(S.store.getTask(task.id).project_default, 1); assert.equal(S.store.getTask(task.id).pending_project, 'שכונת הכרמל');
});

test('Telegram: the question has two buttons, "no" leads to a second step with at most 2 buttons per row, answers settle the buttons and resolve both places', async () => {
  const S = setup(); const calls = []; let mid = 100;
  const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); const body = JSON.parse(o.body || '{}'); calls.push({ method: m[1], body }); return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: ++mid } : m[1] === 'getMe' ? { username: 'b' } : true }) }; };
  const tg = createTelegram({ db: S.db, store: S.store, knowledge: createKnowledge(S.db, S.store), chat: S.chat, token: 'T', fetchImpl, proposals: S.proposals, filesDir: os.tmpdir() });
  await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7 }, text: '/start ' + tg.createBindCode() } });
  S.pa.propose(S.a, { name: 'שכונת הזית', from: `email:${S.eid}` }); calls.length = 0; await tg.deliverPending();
  let sent = calls.filter((c) => c.method === 'sendMessage'); assert.equal(sent.length, 1); const txt = sent[0].body.text; assert.ok(txt.includes('פרויקט חדש?') && txt.includes('«שכונת הזית»') && txt.includes('מתוך: תכנון שכונת הזית'), txt);
  const kb = sent[0].body.reply_markup.inline_keyboard; assert.deepEqual(kb.flat().map((b) => b.text), ['✅ כן, להוסיף', '❌ לא']); assert.ok(kb.every((r) => r.length <= 2));
  const pq = S.db.prepare("SELECT id, tg_message_id FROM proposals WHERE kind='project_new'").get(); assert.ok(pq.tg_message_id, 'delivery confirmed with a message id');
  await tg.handleUpdate({ update_id: 2, callback_query: { id: 'c', data: `pqn:${pq.id}`, message: { chat: { id: 7 }, message_id: pq.tg_message_id } } });
  calls.length = 0; await tg.deliverPending(); sent = calls.filter((c) => c.method === 'sendMessage'); assert.equal(sent.length, 1, 'the second step goes out'); const kb2 = sent[0].body.reply_markup.inline_keyboard;
  assert.ok(kb2.every((r) => r.length <= 2)); assert.equal(kb2[kb2.length - 1][0].text, '🚫 לא פרויקט'); const opt = kb2[0][0].callback_data; assert.match(opt, /^ppk:\d+:\d+$/);
  const pick = S.db.prepare("SELECT id FROM proposals WHERE kind='project_pick'").get().id;
  await tg.handleUpdate({ update_id: 3, callback_query: { id: 'd', data: opt, message: { chat: { id: 9999 }, message_id: 5 } } }); assert.equal(S.db.prepare('SELECT status FROM proposals WHERE id=?').get(pick).status, 'open', 'only the owner chat answers');
  calls.length = 0; await tg.handleUpdate({ update_id: 4, callback_query: { id: 'e', data: opt, message: { chat: { id: 7 }, message_id: 6 } } });
  assert.equal(S.db.prepare('SELECT status FROM proposals WHERE id=?').get(pick).status, 'applied'); assert.equal(rowOf(S, 'שכונת הזית').status, 'alias');
  assert.ok(calls.some((c) => c.method === 'editMessageReplyMarkup' && /^✓ שויך ל-/.test(c.body.reply_markup.inline_keyboard[0][0].text)), 'buttons settle into the choice');
  // a second name: yes in Telegram creates it
  S.pa.propose(S.a, { name: 'ברושים' }); await tg.deliverPending(); const q2 = S.db.prepare("SELECT id FROM proposals WHERE kind='project_new' AND status='open'").get().id;
  calls.length = 0; await tg.handleUpdate({ update_id: 5, callback_query: { id: 'f', data: `pqy:${q2}`, message: { chat: { id: 7 }, message_id: 7 } } });
  assert.ok(S.store.listProjects().some((p) => p.name_he === 'ברושים')); assert.ok(calls.some((c) => c.method === 'editMessageReplyMarkup' && c.body.reply_markup.inline_keyboard[0][0].text === '✓ נוסף פרויקט'));
});
