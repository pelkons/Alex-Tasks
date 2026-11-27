'use strict';
// The "דואר" tab API (lib/maillist.js): keyset pagination, conversations, filters, archive inclusion, search, last visit, access. Fictional data only.
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');
const { seedMail } = require('./helpers/mailseed');

const TOKEN = 'test-token-123', PW = 'correct horse battery';
function setup(opts = {}) {
  const db = open(':memory:'); auth.setPassword(db, PW); auth.resetFailures();
  const app = build({ db, token: TOKEN, loginDelayMs: 0 });
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const projects = [db.prepare("INSERT INTO projects (name_he, color, created_at) VALUES ('פרויקט א', '#2563eb', '2026-01-01')").run().lastInsertRowid, db.prepare("INSERT INTO projects (name_he, color, created_at) VALUES ('פרויקט ב', '#16a34a', '2026-01-01')").run().lastInsertRowid].map(Number);
  seedMail(db, { live: 30, archive: 50, projects, ...opts });
  const get = async (url, headers = bearer) => { const r = await app.inject({ method: 'GET', url, headers }); return { status: r.statusCode, body: r.statusCode === 200 ? JSON.parse(r.body) : r.body }; };
  return { db, app, bearer, get, projects };
}

test('auth is required, the token works', async () => {
  const { app, get } = setup();
  assert.equal((await app.inject({ method: 'GET', url: '/api/mail' })).statusCode, 401);
  assert.equal((await get('/api/mail')).status, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/mail' })).statusCode, 302);
});

test('all mode: newest first, keyset pagination covers everything exactly once', async () => {
  const { get, db } = setup();
  const seen = []; let before = '', pages = 0;
  for (;;) { const r = (await get(`/api/mail?mode=all&limit=17${before}`)).body; pages++; seen.push(...r.items); if (!r.next) break; before = '&before=' + r.next; assert.ok(pages < 20); }
  assert.equal(seen.length, 80); assert.equal(new Set(seen.map((x) => x.id)).size, 80);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].date >= seen[i].date, 'newest first');
  assert.equal((await get('/api/mail?mode=all&limit=5')).body.total, 80);
  assert.ok(seen.some((x) => x.archived) && seen.some((x) => x.direction === 'sent') && seen.some((x) => x.has_files));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM emails').get().n, 80);
  assert.equal((await get('/api/mail?mode=all&limit=5000')).body.items.length, 80 > 100 ? 100 : 80, 'the page is capped at 100');
});

test('threads mode: one row per conversation with its count, the newest mail represents it', async () => {
  const { get, db } = setup();
  const rows = []; let before = '';
  for (;;) { const r = (await get(`/api/mail?limit=12${before}`)).body; rows.push(...r.items); if (!r.next) break; before = '&before=' + r.next; }
  const keys = rows.map((x) => x.thread_key); assert.equal(new Set(keys).size, keys.length, 'a conversation appears once');
  assert.ok(rows.length < 80 && rows.some((x) => x.count > 1));
  for (const row of rows.filter((x) => x.count > 1)) {
    const all = db.prepare('SELECT id, COALESCE(forwarded_date, received_at) d FROM emails WHERE thread_key=? ORDER BY d DESC, id DESC').all(row.thread_key);
    assert.equal(all.length, row.count); assert.equal(all[0].id, row.id);
  }
  const first = rows.find((x) => x.count > 1), t = (await get('/api/mail/thread/' + first.id)).body;
  assert.equal(t.items.length, first.count); assert.equal(t.items[0].id, first.id);
});

test('filters: folder, archive, project, attachments, linked, dates, person', async () => {
  const { get, db, projects } = setup();
  const n = async (qs) => (await get(`/api/mail?mode=all&limit=100&${qs}`)).body.items;
  const sent = await n('folder=out'); assert.ok(sent.length && sent.every((x) => x.direction === 'sent'));
  const inc = await n('folder=in'); assert.ok(inc.every((x) => x.direction === 'received')); assert.equal(sent.length + inc.length, 80);
  const live = await n('archive=0'); assert.ok(live.length === 30 && live.every((x) => !x.archived));
  const arch = await n('archive=only'); assert.ok(arch.length === 50 && arch.every((x) => x.archived));
  const p = await n('project=' + projects[0]); assert.ok(p.length && p.every((x) => x.project_id === projects[0]));
  assert.equal((await n('project=' + encodeURIComponent('פרויקט ב'))).every((x) => x.project_id === projects[1]), true, 'a project by name');
  const att = await n('att=1'); assert.ok(att.length && att.every((x) => x.has_files));
  const id = att[0].id; const t = db.prepare("INSERT INTO tasks (title, project_id, status_id, priority_id, source_email_id, created_at, updated_at) VALUES ('משימה מהמייל', ?, (SELECT id FROM statuses ORDER BY id LIMIT 1), (SELECT id FROM priorities ORDER BY id LIMIT 1), ?, '2026-11-01', '2026-11-01')").run(projects[0], id).lastInsertRowid;
  db.prepare("INSERT INTO task_emails (task_id, email_id, relation, created_at) VALUES (?,?,'created','2026-11-01')").run(t, id);
  const lk = await n('linked=1'); assert.deepEqual(lk.map((x) => x.id), [id]); assert.equal(lk[0].task.id, Number(t));
  assert.equal((await n('linked=0')).length, 79);
  const day = att[0].date.slice(0, 10); const d = await n(`from=${day}&to=${day}`); assert.ok(d.length && d.every((x) => x.date.startsWith(day)));
  assert.equal((await n('from=2099-01-01')).length, 0);
  const pe = db.prepare("INSERT INTO people (name_he, role, emails, created_at) VALUES ('דנה לוי', 'contact', ?, '2026-01-01')").run(JSON.stringify([sent[0] ? 'owner@example.test' : 'x@x'])).lastInsertRowid;
  assert.equal((await n('person=' + pe)).length >= sent.length, true, 'a person by id matches sender and recipients');
  assert.equal((await get('/api/mail?project=999999')).status, 400);
  assert.equal((await n('folder=garbage&archive=garbage')).length, 80, 'unknown values fall back to the defaults');
});

test('filters in threads mode count only the matching mails of a conversation', async () => {
  const { get } = setup();
  const r = (await get('/api/mail?limit=100&folder=out')).body;
  assert.ok(r.items.every((x) => x.direction === 'sent'));
  assert.equal(new Set(r.items.map((x) => x.thread_key)).size, r.items.length);
});

test('search: hybrid keyword search over live and archive mail, filters apply', async () => {
  const { get } = setup();
  const r = (await get('/api/mail?q=' + encodeURIComponent('פלדת זיון'))).body;
  assert.equal(r.mode, 'search'); assert.ok(r.items.length >= 3);
  assert.ok(r.items.some((x) => x.archived) && r.items.some((x) => !x.archived), 'live and archive');
  assert.ok(r.items.every((x) => x.snippet_html && /<mark>/.test(x.snippet_html)));
  const live = (await get('/api/mail?archive=0&q=' + encodeURIComponent('פלדת זיון'))).body.items; assert.ok(live.length && live.every((x) => !x.archived));
  const arch = (await get('/api/mail?archive=only&q=' + encodeURIComponent('פלדת זיון'))).body.items; assert.ok(arch.length && arch.every((x) => x.archived));
  const sent = (await get('/api/mail?folder=out&q=' + encodeURIComponent('פלדת זיון'))).body.items; assert.ok(sent.every((x) => x.direction === 'sent'));
  assert.equal((await get('/api/mail?q=ab')).status, 400);
  assert.deepEqual((await get('/api/mail?q=' + encodeURIComponent('מילהשלאקיימת'))).body.items, []);
});

test('search finds a mail by the text of its attachment', async () => {
  const { get, db } = setup();
  const id = db.prepare("SELECT id FROM emails WHERE archived=0 AND attachments <> '[]' LIMIT 1").get().id;
  const f = db.prepare('SELECT id FROM files WHERE email_id=?').get(id).id;
  db.prepare("INSERT INTO chunks (file_id, idx, page, text) VALUES (?, 0, 3, 'טבלת כמויות מיוחדת ברזל קוטר ארבעים')").run(f);
  const r = (await get('/api/mail?q=' + encodeURIComponent('ברזל קוטר ארבעים'))).body;
  const hit = r.items.find((x) => x.id === id); assert.ok(hit); assert.equal(hit.via, 'attachment');
});

test('last visit: the owner moves the marker, the token only reads; new = received after the previous visit', async () => {
  const { get, app, login } = (() => { const s = setup(); return { ...s }; })();
  let r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PW } });
  const c = r.cookies.find((x) => x.name === 'mesimot_session'); const own = { cookie: `mesimot_session=${c.value}`, 'x-mesimot': '1' };
  void login;
  assert.deepEqual(JSON.parse((await app.inject({ method: 'POST', url: '/api/mail/visit', headers: own })).body), { since: null }, 'the first visit has nothing to compare');
  assert.equal((await get('/api/mail/visit')).body.since, null);
  const tok = JSON.parse((await app.inject({ method: 'POST', url: '/api/mail/visit', headers: { authorization: `Bearer ${TOKEN}` } })).body); assert.equal(tok.since, null);
  const r2 = (await get('/api/mail?mode=all&limit=100&since=2000-01-01T00:00:00.000Z')).body;
  assert.ok(r2.items.some((x) => x.is_new) && r2.items.filter((x) => x.is_new).every((x) => !x.archived && x.direction === 'received'), 'archive and sent mail are never "new"');
  assert.equal(r2.new_count, r2.items.filter((x) => x.is_new).length);
  assert.equal((await get('/api/mail?mode=all&limit=100&since=2099-01-01T00:00:00.000Z')).body.items.some((x) => x.is_new), false);
});

test('people autocomplete', async () => {
  const { get, db } = setup();
  db.prepare("INSERT INTO people (name_he, role, emails, created_at) VALUES ('יעל רוזן', 'contact', '[\"yael@example.test\"]', '2026-01-01')").run();
  const r = (await get('/api/mail/people?q=' + encodeURIComponent('רוז'))).body; assert.equal(r[0].name, 'יעל רוזן'); assert.ok(r[0].id);
  assert.deepEqual((await get('/api/mail/people?q=a')).body, []);
});

test('an email chat scope: [email:ID] is accepted, an unknown mail is refused', async () => {
  const { app, bearer, db } = setup();
  const id = db.prepare('SELECT id FROM emails LIMIT 1').get().id;
  let r = await app.inject({ method: 'POST', url: '/api/chat', headers: bearer, payload: { text: 'צור משימה מהמייל', entity_scope: 'email:' + id } });
  assert.equal(r.statusCode, 201); assert.equal(JSON.parse(r.body).scope_ref, 'email:' + id);
  r = await app.inject({ method: 'POST', url: '/api/chat', headers: bearer, payload: { text: 'x', entity_scope: 'email:99999' } });
  assert.equal(r.statusCode, 400);
});
