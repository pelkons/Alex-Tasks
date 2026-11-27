'use strict';
// The Outlook mail ARCHIVE (lib/archive.js, docs/OUTLOOK-INGEST.md "Archive mode"): zero assistant work, text-only storage beyond the cutoff, the cutoff enforced by the server,
// dedupe, live priority, search (own index, chip flag), offsite exclusion. Fictional data only.
process.env.MESIMOT_LIVE_QUIET_S = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-archive-'));
process.env.MESIMOT_FILES = path.join(tmp, 'files'); process.env.MESIMOT_ARCHIVE_QUEUE = path.join(tmp, 'queue');
process.env.MESIMOT_ARCHIVE_FULL_SINCE = '2025-11-27';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createCalendar } = require('../lib/calendar');
const { createImporter } = require('../lib/importer');
const { createIngest, createIngestApp } = require('../lib/ingest');
const { createArchive } = require('../lib/archive');
const { createSearch } = require('../lib/search');
const { createSemantic } = require('../lib/semantic');
const { buildMsg } = require('./helpers/msg-builder');

const TOKEN = 'test-ingest-token-0123456789'; const TS = '100.106.52.82';
// a deterministic fake embedder: a bag-of-words hash into 384 dimensions (no model download)
const fakeEmbed = async (texts) => texts.map((t) => { const v = new Array(384).fill(0); for (const w of String(t).toLowerCase().split(/\W+/).filter(Boolean)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 384] += 1; } const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map((x) => x / n); });
function lib({ semantic = false } = {}) {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const calendar = createCalendar(db, store); const importer = createImporter({ db, store, knowledge, chat });
  const sem = semantic ? createSemantic(db, { embedder: fakeEmbed }) : null;
  const archive = createArchive({ db, store, knowledge, semantic: sem });
  const ingest = createIngest({ db, store, knowledge, importer, calendar, archive, version: 'test' });
  const app = createIngestApp({ ingest, token: TOKEN });
  return { db, store, knowledge, chat, calendar, importer, ingest, archive, app, sem, searcher: createSearch(db) };
}
const msg = (n, o = {}) => buildMsg({ from_name: o.from_name || `ספק ${n}`, from_addr: o.from_addr || `vendor${n}@supplier.example`, to: [{ name: 'דנה', addr: 'dana@exconstruct.example' }], subject: o.subject || `הצעת מחיר מספר ${n} לעבודות איטום`, body: o.body || `שלום, מצורפת הצעת מחיר ${n} לעבודות האיטום בקומת המרתף.`, date: o.date || Date.parse('2025-03-10T08:00:00Z') + n * 60000, attachments: o.attachments });
function multipart(meta, file) {
  const b = '----t' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="m.msg"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { payload: Buffer.concat([head, file, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
const post = (L, meta, file) => { const m = multipart(meta, file); return L.app.inject({ method: 'POST', url: '/ingest/mail', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${TOKEN}` }, remoteAddress: TS }); };
const arch = (id, over = {}) => ({ entry_id: `AR${id}`, folder: 'inbox', received_or_sent_at: '2025-03-10T08:00:00+02:00', internet_message_id: `<ar${id}@supplier.example>`, archive: true, backfill: 'archive-2025', ...over });
const drain = async (L) => { process.env.MESIMOT_ARCHIVE_IGNORE_LIVE = '1'; try { for (let i = 0; i < 200; i++) { const r = await L.archive.step(); if (r === 'idle') return; } } finally { process.env.MESIMOT_ARCHIVE_IGNORE_LIVE = ''; } };
const counts = (db) => Object.fromEntries(['tasks', 'claude_runs', 'proposals', 'proposal_batches', 'notifications', 'attention', 'project_facts', 'decisions', 'knowledge'].map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));

test('archive mail is queued by the listener and processed by the worker WITHOUT any task, run, proposal, notification, fact or event', async () => {
  const L = lib(); const before = counts(L.db); const evBefore = L.db.prepare('SELECT COUNT(*) c FROM events').get().c;
  const r = await post(L, arch(1), msg(1)); assert.equal(r.statusCode, 200);
  const j = r.json(); assert.equal(j.status, 'stored'); assert.equal(j.archive, true); assert.equal(j.queued, true); assert.equal(j.text_only, true, '2025-03 is older than the cutoff');
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM emails').get().c, 0, 'nothing is parsed in the request');
  assert.ok(fs.readdirSync(process.env.MESIMOT_ARCHIVE_QUEUE).length >= 1, 'the raw file waits in the queue');
  assert.ok(require('../lib/vault').isEncrypted(path.join(process.env.MESIMOT_ARCHIVE_QUEUE, fs.readdirSync(process.env.MESIMOT_ARCHIVE_QUEUE)[0])), 'and it is encrypted there');
  await drain(L);
  const e = L.db.prepare('SELECT * FROM emails').get();
  assert.equal(e.archived, 1); assert.equal(e.text_only, 1); assert.equal(e.import_state, 'archived'); assert.ok(e.processed_at, 'marked processed so no runner looks at it');
  assert.equal(e.direction, 'received'); assert.equal(e.msgid, 'ar1@supplier.example'); assert.ok(e.thread_key); assert.equal(e.forwarded_date.slice(0, 10), '2025-03-10');
  assert.deepEqual(counts(L.db), before, 'no task, run, proposal, notification, attention item, fact, decision, knowledge');
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM events').get().c, evBefore, 'not even an event (nothing for the runner to wake up for)');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM emails WHERE processed_at IS NULL AND import_state IS NULL").get().c, 0, 'the runner query that picks new mail finds nothing');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM search_index WHERE kind='email'").get().c, 0, 'not in the live index');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM search_archive WHERE kind='email'").get().c, 1, 'but in the archive index');
  assert.equal(L.importer.active(), undefined, 'the live import pipeline never sees the archive');
  assert.deepEqual(L.db.prepare('SELECT state FROM archive_queue').all().map((x) => x.state), ['done']);
  assert.equal(fs.readdirSync(process.env.MESIMOT_ARCHIVE_QUEUE).length, 0, 'the queue file is gone');
});

test('text only: binaries are discarded, the text of attachments (also in a nested message) stays searchable, names and sizes stay', async () => {
  const L = lib();
  const nested = { subject: 'הודעה מקורית', from_name: 'קבלן', from_addr: 'k@c.example', body: 'בתוך ההודעה המצורפת מופיעה המילה ביטונטיט ייחודית', date: Date.parse('2025-01-01T00:00:00Z') };
  const file = msg(2, { attachments: [{ name: 'כתב כמויות.csv', data: Buffer.from('סעיף,תיאור,כמות\n1,איטום יסודות בציפוי צמנטי,420\n2,בידוד תרמי,310\n'), mime: 'text/csv' }, { name: 'הערות.txt', data: Buffer.from('הערות הפיקוח: נדרשת בדיקת אטימות ציפורנית בקומה מינוס שתיים.'), mime: 'text/plain' }, { name: 'קודם.msg', msg: nested }] });
  assert.equal((await post(L, arch(2), file)).json().text_only, true);
  await drain(L);
  const e = L.db.prepare('SELECT id, attachments FROM emails').get();
  const files = L.db.prepare('SELECT * FROM files WHERE email_id=? ORDER BY id').all(e.id);
  assert.equal(files.length, 3); assert.ok(files.every((f) => f.discarded === 1 && f.path === '' && f.archived === 1), 'no binary kept, no path');
  assert.deepEqual(files.map((f) => f.original_name).sort(), ['הערות.txt', 'כתב כמויות.csv', 'קודם.msg'].sort());
  assert.ok(files.every((f) => f.size > 0 && f.sha256), 'names, sizes, hashes remain');
  assert.equal(fs.existsSync(path.join(process.env.MESIMOT_FILES, 'archive')), false, 'nothing was written under files/archive');
  const meta = JSON.parse(e.attachments); assert.equal(meta.length, 3); assert.ok(meta.every((a) => a.discarded === true && a.file_id));
  const s = (q) => L.searcher.search({ q, limit: 20 });
  const hit = (q, kind) => s(q).results.filter((r) => r.kind === kind);
  assert.equal(hit('איטום יסודות בציפוי', 'chunk').length, 1, 'text of the csv attachment is searchable');
  assert.equal(hit('אטימות ציפורנית', 'chunk').length, 1, 'text of the txt attachment');
  assert.equal(hit('ביטונטיט ייחודית', 'chunk').length, 1, 'text of the nested message');
  assert.ok(s('איטום יסודות בציפוי').results.every((r) => r.archived === true && r.link === `/email/${e.id}`), 'an attachment hit opens the mail');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM search_index WHERE kind IN ('chunk','file')").get().c, 0, 'live index untouched');
  // the email view tells the truth
  const show = L.knowledge.emailShow(e.id); assert.equal(show.archived, 1); assert.match(show.archive.note, /רק ב-Outlook/);
  assert.ok(show.files.every((f) => f.discarded === 1));
  assert.match(L.knowledge.showFile(files[0].id).view_hint, /רק ב-Outlook/);
});

test('the cutoff is enforced by the SERVER: older mail is text only whatever the connector says, newer mail is complete unless text_only is asked', async () => {
  const L = lib(); const att = [{ name: 'דוח.txt', data: Buffer.from('דוח התקדמות שבועי מספר שבע'), mime: 'text/plain' }];
  const old = await post(L, arch(10, { text_only: false, received_or_sent_at: '2025-11-26T23:30:00+02:00' }), msg(10, { attachments: att }));
  assert.equal(old.json().text_only, true, 'the day before the cutoff, with text_only:false, is still text only');
  const edge = await post(L, arch(11, { received_or_sent_at: '2025-11-27T00:10:00+02:00' }), msg(11, { attachments: att }));
  assert.equal(edge.json().text_only, false, 'the cutoff day itself is complete');
  const flagged = await post(L, arch(12, { received_or_sent_at: '2026-05-01T10:00:00+03:00', text_only: true }), msg(12, { attachments: att }));
  assert.equal(flagged.json().text_only, true, 'text_only can reduce what is kept');
  const recent = await post(L, arch(13, { received_or_sent_at: '2026-05-01T10:00:00+03:00' }), msg(13, { attachments: att }));
  assert.equal(recent.json().text_only, false);
  await drain(L);
  const by = (n) => L.db.prepare('SELECT * FROM emails WHERE msgid=?').get(`ar${n}@supplier.example`);
  assert.deepEqual([10, 11, 12, 13].map((n) => by(n).text_only), [1, 0, 1, 0]);
  // a complete mail: the .msg and the attachment are stored (encrypted) under files/archive, and openable
  const full = by(13); const f = L.db.prepare('SELECT * FROM files WHERE email_id=? ORDER BY id').all(full.id);
  assert.equal(f.length, 2, 'the attachment and the original .msg');
  assert.ok(f.every((x) => x.discarded === 0 && x.path.includes(`${path.sep}archive${path.sep}`) && fs.existsSync(x.path) && require('../lib/vault').isEncrypted(x.path)));
  assert.equal(full.file_id, f.find((x) => /\.msg$/.test(x.original_name)).id);
  assert.equal(require('../lib/vault').readFile(f.find((x) => x.original_name === 'דוח.txt').path).toString(), 'דוח התקדמות שבועי מספר שבע');
  assert.ok(L.db.prepare("SELECT COUNT(*) c FROM search_archive WHERE kind='chunk'").get().c >= 4, 'attachment text of every mail is indexed');
  // and the connector that sends a date the server cannot read gets the date inside the message
  const noDate = await post(L, { entry_id: 'AR14', folder: 'inbox', archive: true, internet_message_id: '<ar14@s.example>' }, msg(14, { date: Date.parse('2024-02-01T10:00:00Z') }));
  await drain(L); assert.equal(L.db.prepare("SELECT text_only FROM emails WHERE msgid='ar14@s.example'").get().text_only, 1, 'the date of the message decides when the request carries none');
  assert.equal(noDate.json().status, 'stored');
});

test('dedupe: by entry id, by internet message id, against mail stored normally (left as it is) and inside the archive', async () => {
  const L = lib();
  assert.equal((await post(L, arch(20), msg(20))).json().status, 'stored');
  assert.equal((await post(L, arch(20), msg(20))).json().status, 'duplicate', 'same entry id');
  assert.equal((await post(L, arch(21, { internet_message_id: '<AR20@supplier.example>' }), msg(20))).json().reason, 'internet_message_id', 'same message id while the first is still queued');
  // mail stored by the normal (live) route before: untouched
  const live = await post(L, { entry_id: 'LV1', folder: 'inbox', received_or_sent_at: '2026-11-26T08:01:00Z', internet_message_id: '<live1@s.example>' }, msg(30, { date: Date.parse('2026-11-26T08:01:00Z') }));
  assert.equal(live.json().status, 'stored'); const liveBody = L.db.prepare('SELECT * FROM emails WHERE id=?').get(live.json().email_id);
  const dup = await post(L, arch(31, { internet_message_id: '<live1@s.example>' }), msg(30)); assert.deepEqual([dup.json().status, dup.json().reason], ['duplicate', 'internet_message_id']);
  await drain(L);
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM emails WHERE archived=1').get().c, 1);
  assert.deepEqual(L.db.prepare('SELECT * FROM emails WHERE id=?').get(live.json().email_id), liveBody, 'the normally stored mail is left exactly as it is');
  assert.equal(L.db.prepare("SELECT archived FROM emails WHERE id=?").get(live.json().email_id).archived, 0);
  // a mail that exists by its message id in `emails` (hand import) is a duplicate as well
  L.db.prepare("INSERT INTO emails (message_id, msgid, from_addr, subject, received_at, body_text) VALUES ('upload:9','hand.9@s.example','x@y','s',?,'b')").run(new Date().toISOString());
  assert.equal((await post(L, arch(32, { internet_message_id: '<hand.9@s.example>' }), msg(32))).json().status, 'duplicate');
});

test('live mail has priority: the worker yields while live mail is arriving or being processed, and the archive import never blocks the live pipeline', async () => {
  const L = lib(); process.env.MESIMOT_ARCHIVE_CONCURRENCY = '1';
  await post(L, arch(40), msg(40)); await post(L, arch(41), msg(41));
  assert.equal(await L.archive.step(), 'processed', 'idle system: the archive works');
  // a live mail arrives: its batch is collecting
  const live = await post(L, { entry_id: 'LV2', folder: 'inbox', received_or_sent_at: '2026-11-26T08:01:00Z', internet_message_id: '<live2@s.example>' }, msg(31, { date: Date.parse('2026-11-26T08:01:00Z') }));
  assert.equal(live.json().status, 'stored');
  assert.equal(L.archive.liveBusy(), true); assert.equal(await L.archive.step(), 'yield', 'the archive waits');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM archive_queue WHERE state='queued'").get().c, 1, 'nothing was taken from the queue');
  // the live batch is picked by the live pipeline first, never the archive import
  L.importer.releaseCollecting(); const imp = L.importer.active(); assert.ok(JSON.parse(imp.stats).live, 'live import is the active one');
  await L.importer.stage(imp.id); L.importer.dedupe(imp.id); L.importer.applyNoise(imp.id); L.importer.buildThreads(imp.id);
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM emails WHERE import_id=? AND import_state='parsed'").get(imp.id).c, 1, 'live mail went through the normal stages with archive mail waiting');
  L.importer.setStatus(imp.id, 'done');
  process.env.MESIMOT_ARCHIVE_IGNORE_LIVE = '';
  L.db.prepare("UPDATE ingest_mail SET created_at=? WHERE archive=0").run(new Date(Date.now() - 3600000).toISOString());
  assert.equal(L.archive.liveBusy(), false); assert.equal(await L.archive.step(), 'processed', 'live mail done: the archive continues');
  // a chat message waiting for the assistant also holds the archive back
  L.db.prepare("INSERT INTO events (actor_id, entity, entity_id, action, created_at) VALUES (1,'chat',1,'create',?)").run(new Date().toISOString());
  assert.equal(L.archive.liveBusy(), true);
  delete process.env.MESIMOT_ARCHIVE_CONCURRENCY;
});

test('guards: a full queue answers 429 with Retry-After, a nearly full disk answers 507, both without losing anything', async () => {
  const L = lib();
  process.env.MESIMOT_ARCHIVE_QUEUE_MAX_MB = '0.0001';
  const r = await post(L, arch(50), msg(50)); assert.equal(r.statusCode, 429); assert.ok(r.headers['retry-after']); assert.ok(r.json().retry_after_s > 0);
  delete process.env.MESIMOT_ARCHIVE_QUEUE_MAX_MB;
  process.env.MESIMOT_ARCHIVE_FREE_BYTES = String(5 * 1024 ** 3);
  const d = await post(L, arch(51), msg(51)); assert.equal(d.statusCode, 507); assert.match(d.json().error, /מקום/);
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM archive_queue').get().c, 0, 'nothing queued');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM ingest_mail WHERE entry_id IN ('AR50','AR51')").get().c, 0, 'not recorded, so the connector retries the same mail later');
  const st = L.archive.status(); assert.equal(st.disk_ok, false);
  process.env.MESIMOT_ARCHIVE_FREE_BYTES = String(500 * 1024 ** 3);
  assert.equal((await post(L, arch(51), msg(51))).json().status, 'stored', 'after space is freed the same request works');
  delete process.env.MESIMOT_ARCHIVE_FREE_BYTES;
  // the health check goes red when the disk is low
  process.env.MESIMOT_ARCHIVE_FREE_BYTES = String(3 * 1024 ** 3);
  const h = require('../lib/health').createHealth(L.db, L.store, { systemctl: () => ({ code: 0, stdout: 'active' }) });
  assert.equal(h.archiveCheck().find((c) => c.id === 'archive:disk').status, 'red'); delete process.env.MESIMOT_ARCHIVE_FREE_BYTES;
});

test('search: archive results carry the archived flag and the mail date, the filter excludes / isolates them, context for new mail excludes them', async () => {
  const L = lib({ semantic: true });
  const live = await post(L, { entry_id: 'LV3', folder: 'inbox', received_or_sent_at: '2026-11-26T08:01:00Z', internet_message_id: '<live3@s.example>' }, msg(60, { subject: 'איטום גגות עדכני', body: 'עדכון חי על איטום הגג בבניין', date: Date.parse('2026-11-26T08:01:00Z') }));
  assert.equal(live.json().status, 'stored');
  await post(L, arch(61), msg(61, { subject: 'איטום גגות ישן', body: 'דיון ישן על איטום הגג בבניין' }));
  await drain(L);
  const all = L.searcher.search({ q: 'איטום הגג', limit: 20 }); const flags = Object.fromEntries(all.results.map((r) => [r.title, !!r.archived]));
  assert.equal(flags['איטום גגות ישן'], true); assert.equal(flags['איטום גגות עדכני'], false);
  const old = all.results.find((r) => r.archived); assert.equal(old.date.slice(0, 10), '2025-03-10'); assert.match(old.link, /^\/email\/\d+$/);
  assert.deepEqual(L.searcher.search({ q: 'איטום הגג', mail_archive: '0' }).results.map((r) => r.title), ['איטום גגות עדכני']);
  assert.deepEqual(L.searcher.search({ q: 'איטום הגג', mail_archive: 'only' }).results.map((r) => r.title), ['איטום גגות ישן']);
  // semantic layer: vectors exist for the archive mail (flagged) and filtering works there too
  assert.ok(L.db.prepare('SELECT COUNT(*) c FROM embeddings WHERE archive=1').get().c >= 1);
  const hy = await L.searcher.searchHybrid({ q: 'איטום הגג בבניין', mail_archive: 'only', limit: 10 }, L.sem); assert.ok(hy.results.length >= 1 && hy.results.every((r) => r.archived));
  const hl = await L.searcher.searchHybrid({ q: 'איטום הגג בבניין', mail_archive: '0', limit: 10 }, L.sem); assert.ok(hl.results.length >= 1 && hl.results.every((r) => !r.archived));
  // the live indexer never touches the archive's rows (and does not delete their vectors as "stale")
  const before = L.db.prepare('SELECT COUNT(*) c FROM embeddings WHERE archive=1').get().c; L.sem.stop?.(); while (await L.sem.indexBatch(8)) { /* drain */ }
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM embeddings WHERE archive=1').get().c, before);
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM embeddings WHERE archive=0 AND kind='email'").get().c, 1, 'only the live mail was embedded by the live indexer');
  // context gathering for NEW mail: the archive is not mixed in with the current items, only a few keyword hits ranked last
  const { createContext } = require('../lib/context'); const threads = require('../lib/threads').createThreads(L.db, L.store, L.knowledge);
  const ctx = createContext({ db: L.db, store: L.store, knowledge: L.knowledge, threads, searcher: L.searcher, semantic: L.sem });
  const newMail = L.db.prepare('SELECT * FROM emails WHERE archived=0').get();
  const g = await ctx.gather({ emails: [newMail] }); assert.match(g.block, /\[ארכיון\]/, 'a clearly marked archive hit may appear'); assert.ok((g.block.match(/\[ארכיון\]/g) || []).length <= 3, 'never more than three');
  // related mails of a thread: the archive follows the live ones and is flagged
  const rel = threads.relatedEmails(L.db.prepare("SELECT id FROM emails WHERE archived=0").get().id); assert.ok(rel.every((r) => r.archived === true || r.tasks));
});

test('project guess is rule based (names, aliases, project numbers, thread), no model, and only a clear winner is used', async () => {
  const L = lib(); const a = L.store.assistantId();
  const p1 = L.store.createProject(a, { name: 'מגדל הדוגמה', aliases: ['מגדל הדגם'] }); const p2 = L.store.createProject(a, { name: 'פארק הניסוי' });
  await post(L, arch(70), msg(70, { subject: 'מגדל הדוגמה: לוח זמנים' })); await post(L, arch(71), msg(71, { subject: 'שאלה כללית', body: 'אין כאן שום שם' })); await post(L, arch(72), msg(72, { subject: 'מגדל הדוגמה ופארק הניסוי יחד', body: 'מגדל הדוגמה ופארק הניסוי' }));
  await drain(L);
  const pid = (n) => L.db.prepare('SELECT project_id p FROM emails WHERE msgid=?').get(`ar${n}@supplier.example`).p;
  assert.equal(pid(70), p1.id); assert.equal(pid(71), null); assert.equal(pid(72), null, 'a tie is not guessed');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM events WHERE entity='project'").get().c, 2, 'only the two project creations: the guess changed nothing');
});

test('one card for the whole import, updated in place; status counts; people are resolved, not created', async () => {
  const L = lib();
  L.store.createPerson(L.store.assistantId(), { name: 'ספקית הדוגמה', role: 'contact', emails: ['vendor80@supplier.example'] }); const peopleBefore = L.db.prepare('SELECT COUNT(*) c FROM people').get().c;
  for (let i = 80; i < 86; i++) await post(L, arch(i, { backfill: i % 2 ? 'archive-2025' : 'archive-2024' }), msg(i));
  const cards = L.db.prepare("SELECT * FROM chat_messages WHERE import_id IS NOT NULL").all(); assert.equal(cards.length, 1, 'ONE card, whatever the number of mails and labels');
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM imports").get().c, 1);
  const p0 = L.importer.progress(cards[0].import_id); assert.equal(p0.archive, true); assert.equal(p0.status, 'archive'); assert.equal(p0.total, 6); assert.equal(p0.processed, 0);
  await drain(L);
  const p1 = L.importer.progress(cards[0].import_id); assert.equal(p1.status, 'done'); assert.equal(p1.processed, 6); assert.equal(p1.text_only, 6); assert.equal(L.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE import_id IS NOT NULL").get().c, 1, 'still one card');
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM people').get().c, peopleBefore, 'no new people');
  const c = L.db.prepare("SELECT * FROM archive_contacts WHERE email='vendor80@supplier.example'").get(); assert.ok(c.person_id, 'resolved to the existing person'); assert.equal(c.n_received, 1);
  assert.ok(L.db.prepare("SELECT COUNT(*) c FROM archive_contacts").get().c >= 6, 'the others are recorded as addresses');
  const st = L.archive.status(); assert.equal(st.emails, 6); assert.equal(st.text_only, 6); assert.equal(st.full, 0); assert.equal(st.failed, 0); assert.ok(st.last_stored_at); assert.equal(st.queued, 0);
  const is = L.ingest.status(); assert.equal(is.mail.total, 0, 'archive rows do not move the live resume numbers'); assert.equal(is.archive.emails, 6); assert.ok(is.archive.folders.length >= 1);
  assert.ok(L.archive.estimate({ emails: 20000 }).projected_bytes > 0);
});

test('a damaged file fails alone (the rest goes on) and can be retried', async () => {
  const L = lib();
  await post(L, arch(90), Buffer.from('this is not an outlook message at all, just text')); await post(L, arch(91), msg(91));
  await drain(L);
  assert.equal(L.archive.status().failed, 1); assert.equal(L.db.prepare('SELECT COUNT(*) c FROM emails WHERE archived=1').get().c, 1);
  assert.equal(L.archive.failed().length, 1); assert.equal(L.archive.retryFailed(), 1); await drain(L); assert.equal(L.archive.status().failed, 1, 'still unreadable');
});

test('OFFSITE: the archive files never go to Proton Drive (directory rule, files table rule, upload guard); the database does', async () => {
  const offsite = require('../lib/offsite'); const keepRoot = process.env.MESIMOT_FILES; process.env.MESIMOT_FILES = path.join(tmp, 'files-offsite');
  const L = lib(); const root = process.env.MESIMOT_FILES; try {
  await post(L, arch(100, { received_or_sent_at: '2026-05-01T10:00:00+03:00' }), msg(100, { attachments: [{ name: 'a.txt', data: Buffer.from('כאן טקסט'), mime: 'text/plain' }] })); await drain(L);
  const af = L.db.prepare("SELECT path FROM files WHERE archived=1 AND path<>''").all(); assert.ok(af.length >= 2);
  // a normal file next to them
  fs.mkdirSync(path.join(root, '2026', '11'), { recursive: true }); require('../lib/vault').writeFile(path.join(root, '2026', '11', '1-normal.txt'), Buffer.from('normal'));
  // a stray archive file elsewhere on disk but recorded in the files table
  fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true }); require('../lib/vault').writeFile(path.join(root, 'elsewhere', 'x.msg'), Buffer.from('x'));
  L.db.prepare("INSERT INTO files (original_name, path, size, source, created_at, archived) VALUES ('x.msg',?,1,'email',?,1)").run(path.join(root, 'elsewhere', 'x.msg'), new Date().toISOString());
  assert.ok(offsite.isArchiveRel('archive/2026/05/1-a.txt') && !offsite.isArchiveRel('2026/05/archive.txt') && !offsite.isArchiveRel('archived/x'));
  const uploaded = []; const drive = { list: () => [], exists: () => true, createFolder() {}, upload: (locals, parent) => { uploaded.push(...locals.map((l) => path.relative(root, l))); }, trash() {}, deleteTrashed() {}, size: () => 1, freeSpace: () => 10 ** 12, download() {} };
  const dbFile = path.join(tmp, 'x.db'); // a dry run needs no database copy
  const dry = await offsite.run({ drive, db: L.db, dbFile, filesRoot: root, manifestFile: path.join(tmp, 'm.json'), hex: 'a'.repeat(64), dryRun: true });
  assert.equal(dry.files.skipped_archive, af.length + 1, 'every archive file is skipped, in the directory or recorded in the table');
  assert.equal(dry.files.to_add, 1, 'only the normal file would be uploaded'); assert.equal(uploaded.length, 0);
  assert.throws(() => offsite.guardNotArchive(af[0].path, root), /archive files are never uploaded/);
  assert.equal(offsite.guardNotArchive(path.join(root, '2026', '11', '1-normal.txt'), root), path.join(root, '2026', '11', '1-normal.txt'));
  } finally { process.env.MESIMOT_FILES = keepRoot; }
});

test('embeddings: the archive worker embeds the body and the first chunks (capped), commits the vectors and the done mark together', async () => {
  const L = lib({ semantic: true });
  await post(L, arch(110), msg(110, { attachments: [{ name: 'ארוך.txt', data: Buffer.from(('מילה '.repeat(399) + '\n').repeat(12)), mime: 'text/plain' }] })); await drain(L);
  const eid = L.db.prepare('SELECT id FROM emails WHERE archived=1').get().id;
  const vec = L.db.prepare("SELECT kind, COUNT(*) c FROM embeddings WHERE archive=1 GROUP BY kind").all(); const by = Object.fromEntries(vec.map((v) => [v.kind, v.c]));
  assert.ok(by.email >= 1 && by.email <= 3, 'at most 3 body parts'); assert.ok(by.chunk >= 1 && by.chunk <= 4, 'at most 4 chunks of an attachment');
  assert.deepEqual(L.db.prepare('SELECT state FROM archive_queue').all().map((r) => r.state), ['done']);
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM vec_archive').get().c, L.db.prepare('SELECT COUNT(*) c FROM embeddings WHERE archive=1').get().c, 'every archive embedding row has its (int8) vector, in the archive table');
  assert.equal(L.db.prepare('SELECT COUNT(*) c FROM vec_items').get().c, 0, 'and none in the live table');
  assert.ok(L.sem.status().archive_vectors >= 2); assert.ok(eid > 0);
});

test('`mesimot ask` finds archive mail and its attachment text (marked archive, with the date and the mail to open); mail_archive=0 leaves it out', async () => {
  const { createAsk } = require('../lib/ask'); const { createTrace } = require('../lib/trace');
  const L = lib();
  await post(L, arch(120), msg(120, { subject: 'התמורה לחדר השנאים', body: 'סוכם בעל פה', attachments: [{ name: 'הסכם.txt', data: Buffer.from('סעיף 9.1 התמורה עבור חדר השנאים תעמוד על 182,640 ש"ח'), mime: 'text/plain' }] }));
  await drain(L);
  const asker = createAsk({ db: L.db, store: L.store, knowledge: L.knowledge, searcher: L.searcher, semantic: null, trace: createTrace(L.db) });
  const a = await asker.ask({ q: 'מה התמורה עבור חדר השנאים' });
  const chunk = a.results.find((r) => r.kind === 'chunk');
  assert.ok(chunk && chunk.archive === true, 'the attachment text of an old mail is found'); assert.match(chunk.text, /182,640/); assert.equal(chunk.date, '2025-03-10'); assert.ok(chunk.email_id, 'with the mail it came from');
  assert.ok(a.results.some((r) => r.kind === 'email' && r.archive === true));
  const none = await asker.ask({ q: 'מה התמורה עבור חדר השנאים', mail_archive: '0' });
  assert.ok(!none.results.some((r) => r.archive), 'excluded on request');
});
