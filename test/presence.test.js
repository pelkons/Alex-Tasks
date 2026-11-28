'use strict';
// Mail presence (deletions made in Outlook): POST /ingest/mail-presence, lib/presence.js, the recycle bin kind 'email'. Fictional mailbox only.
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs'); const zlib = require('zlib');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-presence-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createTrash } = require('../lib/trash');
const { createTaskDelete } = require('../lib/taskdel');
const { createConfirm } = require('../lib/confirm');
const { createPresence } = require('../lib/presence');
const { createConnector } = require('../lib/connector');
const { createIngestApp } = require('../lib/ingest');
const { createMailList } = require('../lib/maillist');
const { seedMail } = require('./helpers/mailseed');

const TOKEN = 'test-ingest-token-presence-0123';
const TS = '100.64.0.9';
const STORE = 'owner@example.test';
const HOUR = 3600000, DAY = 86400000;
const c = (db, sql, ...a) => db.prepare(sql).get(...a).c;

// a fake mailbox: n stored Outlook mails of the last days (entry id E<i>, message id from the seed), each with its ingest record; some with an attachment file on disk
function setup(n = 200) {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const trash = createTrash({ db, store }); const taskdel = createTaskDelete({ db, store, trash });
  const confirm = createConfirm({ db, store, chat, taskdel, trash }); store.hooks.confirmView = confirm.get;
  const presence = createPresence({ db, store, trash, confirm });
  const connector = createConnector({ db, outboxKey: () => 'k', dir: () => process.env.MESIMOT_FILES });
  const ingest = { touch: () => {}, status: () => ({}) };
  const app = createIngestApp({ ingest, connector, presence, token: TOKEN });
  const end = Date.now() - HOUR;
  const ids = seedMail(db, { live: n, archive: 0, owner: STORE, end });
  const ins = db.prepare("INSERT INTO ingest_mail (entry_id, internet_message_id, store, folder, at, size, email_id, status, created_at) VALUES (?,?,?,?,?,?,?,'stored',?)");
  const mails = ids.map((id, i) => {
    const e = db.prepare('SELECT id, message_id, direction, mail_date FROM emails WHERE id=?').get(id);
    const m = { id, entry_id: `00000000AB${String(i).padStart(4, '0')}${'F'.repeat(150)}`, mid: e.message_id, folder: e.direction === 'sent' ? 'sent' : 'inbox', at: e.mail_date };
    ins.run(m.entry_id, e.message_id.replace(/[<>]/g, '').toLowerCase(), STORE, m.folder, m.at, 1000, id, new Date(Date.parse(m.at) + 60000).toISOString());
    return m;
  });
  // real files on disk for the attachments the seed made up
  for (const f of db.prepare('SELECT id FROM files WHERE email_id IS NOT NULL').all()) { const p = path.join(process.env.MESIMOT_FILES, `att-${f.id}.pdf`); fs.writeFileSync(p, 'pdf'); db.prepare('UPDATE files SET path=? WHERE id=?').run(p, f.id); db.prepare("INSERT INTO chunks (file_id, idx, text, page) VALUES (?, 0, 'תוכן המסמך המצורף פלדה', 1)").run(f.id); }
  return { db, store, chat, trash, confirm, presence, connector, app, mails, end };
}
// what Alex Link would send: every mail except `skip`, with folder overrides
function listing(mails, { skip = [], move = {}, since = Date.now() - 14 * DAY, extra = [] } = {}) {
  const folders = new Map();
  for (const m of mails) {
    if (skip.includes(m.id)) continue;
    const mv = move[m.id]; const folder = (mv && mv.folder) || m.folder;
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push({ entry_id: (mv && mv.entry_id) || m.entry_id, internet_message_id: m.mid });
  }
  for (const x of extra) { if (!folders.has(x.folder)) folders.set(x.folder, []); folders.get(x.folder).push(x.mail); }
  return { store: STORE, scope: 'recent', since: new Date(since).toISOString().replace('Z', '+00:00'), complete: true, folders: [...folders].map(([folder, list]) => ({ folder, mails: list })), deleted_items: [] };
}
const post = (L, body, { token = TOKEN, headers = {}, raw = null } = {}) => L.app.inject({ method: 'POST', url: '/ingest/mail-presence', payload: raw ?? JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, remoteAddress: TS });

test('the owner deleted 5 mails and moved 3 in Outlook: 5 go to the bin, 3 change folder, tasks stay and only lose the link; the same list again changes nothing', async () => {
  const L = setup(200); const { db, store, mails } = L;
  const owner = store.ownerId();
  const del = [mails[10], mails[50], mails[120], mails[150], mails[199]].map((m) => m.id);
  const withFile = mails.find((m) => !del.includes(m.id) && c(db, 'SELECT COUNT(*) c FROM files WHERE email_id=?', m.id) > 0);
  del[4] = withFile.id;
  const task = store.createTask(owner, { title: 'לענות לספק על המסמכים', requester: owner });
  db.prepare('UPDATE tasks SET source_email_id=? WHERE id=?').run(del[0], task.id);
  db.prepare("INSERT INTO task_emails (task_id, email_id, relation, created_at) VALUES (?,?, 'created', ?)").run(task.id, del[0], new Date().toISOString());
  const move = { [mails[20].id]: { folder: 'inbox/ספקים' }, [mails[21].id]: { folder: 'inbox/ספקים/2026' }, [mails[22].id]: { folder: 'ארכיון', entry_id: 'NEW-ENTRY-AFTER-MOVE' } };
  // a mail stored 5 minutes ago is never judged; a mail before `since` is not judged; a hand-imported mail (no entry id) is never touched
  const fresh = db.prepare("INSERT INTO emails (message_id, subject, received_at, mail_date, body_text, direction) VALUES ('<fresh@x>', 'חדש', ?, ?, 'גוף', 'received')").run(new Date().toISOString(), new Date(Date.now() - 4 * 60000).toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO ingest_mail (entry_id, internet_message_id, store, folder, at, email_id, status, created_at) VALUES ('FRESH', 'fresh@x', ?, 'inbox', ?, ?, 'stored', ?)").run(STORE, new Date(Date.now() - 4 * 60000).toISOString(), fresh, new Date(Date.now() - 3 * 60000).toISOString());
  const old = db.prepare("INSERT INTO emails (message_id, subject, received_at, mail_date, body_text) VALUES ('<old@x>', 'ישן', ?, ?, 'גוף')").run(new Date().toISOString(), new Date(Date.now() - 20 * DAY).toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO ingest_mail (entry_id, internet_message_id, store, folder, at, email_id, status, created_at) VALUES ('OLD', 'old@x', ?, 'inbox', ?, ?, 'stored', ?)").run(STORE, new Date(Date.now() - 20 * DAY).toISOString(), old, new Date(Date.now() - 20 * DAY).toISOString());
  const hand = db.prepare("INSERT INTO emails (message_id, subject, received_at, mail_date, body_text) VALUES ('upload:1', 'ידני', ?, ?, 'גוף')").run(new Date().toISOString(), new Date(Date.now() - DAY).toISOString()).lastInsertRowid;
  const busy = mails[60].id; db.prepare("UPDATE emails SET import_id=1, import_state='staged' WHERE id=?").run(busy); // still in the live pipeline
  const fileRows = db.prepare('SELECT * FROM files WHERE email_id=?').all(withFile.id);
  assert.ok(c(db, "SELECT COUNT(*) c FROM search_index WHERE kind='email' AND ref_id=?", del[0]) === 1);
  db.exec('CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY, kind TEXT, ref_id INTEGER, part INTEGER, src_rowid INTEGER, project_id INTEGER, ts TEXT, person TEXT, title TEXT, snippet TEXT, archive INTEGER NOT NULL DEFAULT 0)');
  db.prepare("INSERT INTO embeddings (kind, ref_id, part, title, snippet) VALUES ('email', ?, 0, 't', 's')").run(del[1]); // a vector entry (the table without the vector extension)

  const r = await post(L, listing(mails, { skip: [...del, busy], move }));
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { checked: 199, removed: 5, moved: 3, held: false });
  assert.equal(c(db, 'SELECT COUNT(*) c FROM emails WHERE id=?', busy), 1, 'a mail still in the pipeline waits for a later pass');
  for (const id of del) assert.equal(c(db, 'SELECT COUNT(*) c FROM emails WHERE id=?', id), 0);
  assert.equal(c(db, "SELECT COUNT(*) c FROM trash WHERE kind='email'"), 5);
  for (const id of [fresh, old, hand]) assert.equal(c(db, 'SELECT COUNT(*) c FROM emails WHERE id=?', id), 1, 'not judged');
  // gone from search (also the attachment and its text), the mail list and the counts; the files stay on disk until the final delete
  assert.equal(c(db, "SELECT COUNT(*) c FROM search_index WHERE kind='email' AND ref_id=?", del[0]), 0);
  assert.equal(c(db, "SELECT COUNT(*) c FROM embeddings WHERE kind='email' AND ref_id=?", del[1]), 0, 'out of the vector index');
  for (const f of fileRows) { assert.equal(c(db, "SELECT COUNT(*) c FROM search_index WHERE kind='file' AND ref_id=?", f.id), 0); assert.ok(fs.existsSync(f.path)); }
  const ml = createMailList({ db, store, searcher: null, semantic: null });
  const all = await ml.list({ mode: 'all', limit: 100 });
  assert.ok(!all.items.some((x) => del.includes(x.id)));
  // the task stays, only the link is gone
  assert.equal(c(db, 'SELECT COUNT(*) c FROM tasks WHERE id=? AND source_email_id IS NULL', task.id), 1);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM task_emails WHERE task_id=?', task.id), 0);
  // moves: the folder follows Outlook, nothing else
  assert.equal(db.prepare('SELECT folder FROM ingest_mail WHERE email_id=?').get(mails[20].id).folder, 'inbox/ספקים');
  assert.equal(db.prepare('SELECT folder FROM ingest_mail WHERE email_id=?').get(mails[22].id).folder, 'ארכיון', 'moved under another entry id: found by message id');
  // one activity line; the pass is recorded
  const ev = db.prepare("SELECT * FROM events WHERE entity='trash' AND action='outlook_delete'").all();
  assert.equal(ev.length, 1); assert.match(ev[0].new_value, /Outlook: 5 מיילים נמחקו ב-Outlook והועברו לסל/); assert.ok(ev[0].processed_at);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='presence_last'").get().value).removed, 5, 'the legacy token records the pass in settings');

  // idempotent
  assert.deepEqual((await post(L, listing(mails, { skip: del, move }))).json(), { checked: 194, removed: 0, moved: 0, held: false });
  assert.equal(c(db, "SELECT COUNT(*) c FROM events WHERE action='outlook_delete'"), 1, 'no event for a pass that removed nothing');

  // restore the mail with the task: it comes back with its id, its folder, its link and its search entry; the next pass leaves it (restored by hand)
  const tr = db.prepare("SELECT id FROM trash WHERE kind='email' AND entity_id=?").get(del[0]).id;
  const back = L.trash.restore(owner, tr);
  assert.equal(back.id, del[0]);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM tasks WHERE id=? AND source_email_id=?', task.id, del[0]), 1);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM task_emails WHERE task_id=? AND email_id=?', task.id, del[0]), 1);
  assert.equal(c(db, "SELECT COUNT(*) c FROM search_index WHERE kind='email' AND ref_id=?", del[0]), 1);
  assert.equal(db.prepare('SELECT folder FROM ingest_mail WHERE email_id=?').get(del[0]).folder, mails[10].folder);
  assert.ok((await ml.list({ mode: 'all', limit: 100, to: new Date(Date.parse(mails[10].at) + DAY).toISOString().slice(0, 10) })).items.some((x) => x.id === del[0]), 'back in the mail list');
  assert.equal((await post(L, listing(mails, { skip: del, move }))).json().removed, 0, 'a mail restored by hand is not taken away again');
  assert.equal(c(db, 'SELECT COUNT(*) c FROM emails WHERE id=?', del[0]), 1);

  // the attachment mail: restored with its files and chunks, searchable again; deleting another one for good removes its files from disk
  const trf = db.prepare("SELECT id FROM trash WHERE kind='email' AND entity_id=?").get(withFile.id).id;
  L.trash.restore(owner, trf);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM files WHERE email_id=?', withFile.id), fileRows.length);
  assert.ok(c(db, "SELECT COUNT(*) c FROM search_index WHERE kind='chunk' AND body LIKE '%פלדה%'") >= 1);
  L.trash.trashEmail(L.store.assistantId(), withFile.id);
  const tr2 = db.prepare("SELECT id FROM trash WHERE kind='email' AND entity_id=?").get(withFile.id).id;
  L.trash.destroy(owner, tr2);
  for (const f of fileRows) assert.ok(!fs.existsSync(f.path), 'the file is deleted with the bin item');
  assert.equal(c(db, 'SELECT COUNT(*) c FROM ingest_mail WHERE email_id IS NULL AND gone_at IS NOT NULL AND entry_id=?', withFile.entry_id), 1, 'the Outlook record stays (not taken for new mail)');
});

test('a mail deleted in Outlook and then restored there comes back from the bin by itself', async () => {
  const L = setup(40); const { db, mails } = L;
  const gone = mails[5].id;
  assert.equal((await post(L, listing(mails, { skip: [gone] }))).json().removed, 1);
  const r = (await post(L, listing(mails))).json();
  assert.equal(r.restored, 1); assert.equal(r.removed, 0);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM emails WHERE id=?', gone), 1);
  assert.equal(c(db, "SELECT COUNT(*) c FROM trash WHERE kind='email'"), 0);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM ingest_mail WHERE email_id=? AND presence_keep=0', gone), 1, 'follows Outlook again');
  assert.equal((await post(L, listing(mails, { skip: [gone] }))).json().removed, 1, 'deleted again in Outlook: goes again');
});

test('safety: more than 30% and at least 20 would go -> nothing removed, the owner is asked once; "כן, העבר לסל" applies it; a normal pass later closes the question', async () => {
  const L = setup(200); const { db, mails, confirm, store } = L;
  const keepHalf = mails.filter((m, i) => i % 2).map((m) => m.id);
  const skip = mails.map((m) => m.id).filter((id) => !keepHalf.includes(id));
  const r = (await post(L, listing(mails, { skip }))).json();
  assert.equal(r.held, true); assert.equal(r.removed, 0); assert.equal(r.checked, 200);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM emails'), 200);
  const cf = db.prepare("SELECT * FROM confirmations WHERE kind='mail_presence'").all();
  assert.equal(cf.length, 1); assert.match(cf[0].text, /100 מיילים מתוך 200/);
  const msg = db.prepare('SELECT * FROM chat_messages WHERE confirm_id=?').get(cf[0].id);
  assert.ok(msg && msg.tg_sent === 0, 'goes to the chat and Telegram'); assert.equal(confirm.get(cf[0].id).yes_label, 'כן, העבר לסל');
  assert.equal((await post(L, listing(mails, { skip }))).json().held, true);
  assert.equal(c(db, "SELECT COUNT(*) c FROM confirmations WHERE kind='mail_presence'"), 1, 'told once');
  const a = confirm.answer(store.ownerId(), cf[0].id, true);
  assert.equal(a.status, 'yes'); assert.equal(a.result.removed, 100);
  assert.equal(c(db, 'SELECT COUNT(*) c FROM emails'), 100);
  assert.equal(c(db, "SELECT COUNT(*) c FROM events WHERE action='outlook_delete'"), 1);
  // a second hold that a normal pass makes moot
  const L2 = setup(60);
  assert.equal((await post(L2, listing(L2.mails, { skip: L2.mails.slice(0, 30).map((m) => m.id) }))).json().held, true);
  assert.deepEqual((await post(L2, listing(L2.mails))).json(), { checked: 60, removed: 0, moved: 0, held: false });
  assert.equal(L2.db.prepare("SELECT status FROM confirmations WHERE kind='mail_presence'").get().status, 'expired');
  // the assistant's API can never create this question
  assert.throws(() => confirm.ask(store.assistantId(), 'mail_presence', 0, { payload: { email_ids: [1] }, internal: true }), /סוג בקשה לא מוכר/);
  // below the floor of 20 the share does not matter
  const L3 = setup(30);
  const r3 = (await post(L3, listing(L3.mails, { skip: L3.mails.slice(0, 15).map((m) => m.id) }))).json();
  assert.equal(r3.held, false); assert.equal(r3.removed, 15);
});

test('HTTP: device token and standby 409, legacy token, gzip body, invalid bodies 400, size limit, auth', async () => {
  const L = setup(30); const { db, connector, mails } = L;
  const code = connector.newCode().code; const p1 = connector.pair({ code, computer_name: 'MAINPC', app_version: '1.2.0' });
  const code2 = connector.newCode().code; const p2 = connector.pair({ code: code2, computer_name: 'LAPTOP', app_version: '1.2.0' });
  assert.equal(connector.roleOf(p2.device_id), 'standby');
  const body = listing(mails, { skip: [mails[3].id] });
  const sb = await post(L, body, { token: p2.token });
  assert.equal(sb.statusCode, 409); assert.deepEqual(sb.json(), { error: 'standby' });
  assert.equal(c(db, 'SELECT COUNT(*) c FROM emails'), 30, 'standby changes nothing');
  const ok = await post(L, body, { token: p1.token, raw: zlib.gzipSync(JSON.stringify(body)), headers: { 'content-encoding': 'gzip' } });
  assert.equal(ok.statusCode, 200, ok.body); assert.equal(ok.json().removed, 1);
  const dev = connector.list().find((d) => d.id === p1.device_id);
  assert.ok(dev.presence_at); assert.equal(dev.presence.removed, 1);
  assert.equal((await post(L, body)).statusCode, 200, 'legacy token');
  assert.equal((await post(L, body, { token: 'wrong' })).statusCode, 401);
  for (const bad of [{ ...body, complete: false }, { ...body, since: 'yesterday' }, { ...body, folders: 'x' }, { ...body, folders: [{ folder: 'inbox', mails: [{}] }] }, { ...body, folders: [{ mails: [] }] }, { ...body, scope: 'all' }, [1, 2]]) {
    const r = await post(L, bad); assert.equal(r.statusCode, 400, JSON.stringify(bad).slice(0, 80)); assert.ok(r.json().error);
  }
  assert.equal((await post(L, null, { raw: '{not json' })).statusCode, 400);
  assert.equal((await post(L, null, { raw: Buffer.from('not gzip at all'), headers: { 'content-encoding': 'gzip' } })).statusCode, 400);
  // more than 5 MB after inflating is refused (it compresses to a few KB)
  const big = JSON.stringify({ ...body, folders: [{ folder: 'inbox', mails: Array.from({ length: 40000 }, (_, i) => ({ entry_id: 'X'.repeat(140) + i, internet_message_id: null })) }] });
  assert.ok(big.length > 5 * 1024 * 1024);
  assert.equal((await post(L, null, { raw: zlib.gzipSync(big), headers: { 'content-encoding': 'gzip' } })).statusCode, 413);
  // an Exchange-sized pass (long entry ids) for a year fits easily
  const year = JSON.stringify({ ...body, folders: [{ folder: 'inbox', mails: Array.from({ length: 20000 }, (_, i) => ({ entry_id: '0'.repeat(170) + i, internet_message_id: `<m${i}@corp.example.test>` })) }] });
  const ry = await post(L, null, { raw: zlib.gzipSync(year), headers: { 'content-encoding': 'gzip' } });
  assert.equal(ry.statusCode, 200, ry.body);
});

test('archive mail with an Outlook entry id: its own index and vectors leave with it and come back', async () => {
  const L = setup(5); const { db, store } = L;
  const id = db.prepare("INSERT INTO emails (message_id, subject, received_at, mail_date, body_text, archived, import_state) VALUES ('archive:a1@x', 'ארכיון ישן', ?, ?, 'גוף מיוחד קורנס', 1, 'archived')").run(new Date().toISOString(), new Date(Date.now() - 2 * DAY).toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO search_archive (title, body, kind, ref_id, project_id, ts, person) VALUES ('ארכיון ישן', 'גוף מיוחד קורנס', 'email', ?, NULL, '', '')").run(id);
  db.prepare("INSERT INTO ingest_mail (entry_id, internet_message_id, store, folder, at, email_id, status, archive, created_at) VALUES ('ARCH1', 'a1@x', ?, 'inbox', ?, ?, 'archived', 1, ?)").run(STORE, new Date(Date.now() - 2 * DAY).toISOString(), id, new Date(Date.now() - DAY).toISOString());
  assert.equal(c(db, 'SELECT COUNT(*) c FROM search_index WHERE kind=\'email\' AND ref_id=?', id), 0);
  const r = (await post(L, listing(L.mails))).json();
  assert.equal(r.removed, 1);
  assert.equal(c(db, "SELECT COUNT(*) c FROM search_archive WHERE ref_id=? AND kind='email'", id), 0);
  L.trash.restore(store.ownerId(), db.prepare("SELECT id FROM trash WHERE kind='email'").get().id);
  assert.equal(c(db, "SELECT COUNT(*) c FROM search_archive WHERE body LIKE '%קורנס%'"), 1);
  assert.equal(c(db, "SELECT COUNT(*) c FROM search_index WHERE kind='email' AND ref_id=?", id), 0, 'archive mail stays out of the live index');
});
