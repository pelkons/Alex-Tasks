'use strict';
// ARCHIVE INGEST: the owner's OLD Outlook mail (tens of thousands of messages) made searchable on the site and by the assistant, with ZERO assistant (LLM) calls.
// Contract: docs/OUTLOOK-INGEST.md ("Archive mode"). The connector sends `POST /ingest/mail` with `meta.archive = true`; this module does the rest.
//
//   enqueue()  (in the ingest listener, cheap): dedupe, disk and queue guards, the raw .msg is written ENCRYPTED to the queue directory, one row in `archive_queue`.
//   worker     (bin/mesimot-archive, a separate low-priority process, one mail at a time, yields to live mail): parse -> store -> text of the attachments -> own search index -> vectors.
//
// What an archive mail IS: an `emails` row with archived = 1 (import_state 'archived', processed_at set, so no runner / agent / gate / digest / notification ever looks at it), its attachments as
// `files` + `chunks` rows (archived = 1), its text in `search_archive` (a second FTS5 table with the layout of `search_index`; the live triggers skip archived rows), its vectors in `embeddings`
// (archive = 1). It never creates tasks, runs, proposals, notifications, project facts or links to existing tasks, and it changes nothing that exists.
// Storage rule: mail received on/after `archive_full_since` (config, default 2025-11-27) is stored COMPLETE (the .msg and the attachments, encrypted, under files/archive/ which is never uploaded off-site);
// older mail is TEXT ONLY: body + text extracted from the attachments (PDF, Word, Excel, OCR of images, nested messages); the binary .msg and the attachment files are discarded after extraction,
// only names, sizes and types stay (files.discarded = 1). The server enforces the cutoff itself, whatever the connector says.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { now } = require('./db');
const vault = require('./vault');
const { normId } = require('./ingest');

const ROOT = path.join(__dirname, '..');
const MAX_FILE = 100 * 1024 * 1024;
const MAX_BODY = 300000; // characters of one mail body kept
const MAX_CHUNKS_PER_FILE = 60, MAX_CHUNK_CHARS_PER_MAIL = 400000;
const MAX_EXTRACT_BYTES = 60 * 1024 * 1024; // attachments larger than this are not read (a name only)
// disk model of a TEXT-ONLY mail inside the database (text + trigram search index + vectors), measured with scripts/bench-archive.js on this server (docs/OUTLOOK-INGEST.md)
const DEFAULT_TEXT_ONLY_BYTES = 90 * 1024, TEXT_INDEX_FACTOR = 4;
const EMBED_BODY_PARTS = 3, EMBED_FILE_CHUNKS = 4, EMBED_WORDS = 200;
const jerusalemDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
const addrOf = (s) => String(((/<([^>]+)>/.exec(s || '') || [])[1] || s || '')).trim().toLowerCase();
const safeName = (name) => String(name || 'file').replace(/[\\/\0]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';

const queueDir = () => process.env.MESIMOT_ARCHIVE_QUEUE || path.join(path.dirname(path.resolve(process.env.MESIMOT_DB || path.join(ROOT, 'data', 'mesimot.db'))), 'archive-queue');
const filesRoot = () => process.env.MESIMOT_FILES || path.join(ROOT, 'files');
const ARCHIVE_DIR = 'archive'; // files/archive/...: the stored (complete) archive files. docs/BACKUP.md: NEVER uploaded to Proton Drive.
function freeBytes(dir) {
  if (process.env.MESIMOT_ARCHIVE_FREE_BYTES) return +process.env.MESIMOT_ARCHIVE_FREE_BYTES;
  let d = dir; while (d && !fs.existsSync(d)) d = path.dirname(d);
  const s = fs.statfsSync(d || '/'); return Number(s.bavail) * Number(s.bsize);
}
const err = (status, msg, extra = {}) => Object.assign(new Error(msg), { status }, extra);

// ---- the progress object of the ONE chat card (importer.progress delegates here for the archive import row)
function archiveProgress(db, imp) {
  const c = db.prepare('SELECT state, COUNT(*) n FROM archive_queue GROUP BY state').all(); const n = (s) => c.find((x) => x.state === s)?.n || 0;
  const total = c.reduce((a, x) => a + x.n, 0);
  const waiting = n('queued') + n('working') + n('stored');
  const e = db.prepare('SELECT COUNT(*) total, SUM(text_only=1) text_only, SUM(text_only=0) full_n FROM emails WHERE archived=1').get();
  const dup = db.prepare('SELECT COUNT(*) n FROM ingest_mail WHERE archive=1 AND status=\'duplicate\'').get().n;
  const last = db.prepare('SELECT MAX(stored_at) a FROM archive_queue').get().a;
  return { id: imp.id, archive: true, status: waiting ? 'archive' : 'done', total, processed: total - waiting, stored: e.total || 0, text_only: e.text_only || 0, full: e.full_n || 0, dup, failed: n('failed'), queued: n('queued') + n('working'), embedding: n('stored'), indexed: n('done'),
    source: 'archive', created_at: imp.created_at, finished_at: waiting ? null : (last || imp.finished_at || null), last_at: last || null };
}

function createArchive({ db, store, knowledge = null, semantic = null, log = () => {} } = {}) {
  const q = (s) => db.prepare(s);
  const cfg = () => require('./config').get();
  const set = (k, v) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const getSet = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
  const fullSince = () => String(process.env.MESIMOT_ARCHIVE_FULL_SINCE || cfg().archive_full_since || '2025-11-27').slice(0, 10);
  const minFree = () => (+process.env.MESIMOT_ARCHIVE_MIN_FREE_GB || cfg().archive_min_free_gb || 20) * 1024 ** 3;
  const queueMax = () => (+process.env.MESIMOT_ARCHIVE_QUEUE_MAX_MB || cfg().archive_queue_max_mb || 3000) * 1024 * 1024;

  // the storage rule, decided by the SERVER: older than the cutoff is always text only (also when the connector asks for more), `text_only: true` can only reduce what is kept
  function decideTextOnly(meta, atIso) {
    const day = atIso ? jerusalemDay(atIso) : null;
    if (day && day < fullSince()) return true;
    return meta && (meta.text_only === true || meta.text_only === 'true');
  }

  // ---- the one import row (and its ONE chat card) of the whole archive; status 'done' so the live import pipeline never touches it
  function ensureImport() {
    const row = q("SELECT id FROM imports WHERE json_extract(stats,'$.source')='archive' ORDER BY id LIMIT 1").get();
    if (row) return row.id;
    return db.transaction(() => {
      const id = q('INSERT INTO imports (created_at, file_count, status, stats, file_ids, text, finished_at) VALUES (?,?,?,?,?,?,?)').run(now(), 0, 'done', JSON.stringify({ source: 'archive', archive: 1 }), '[]', 'Outlook archive', now()).lastInsertRowid;
      const mid = q("INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, import_id) VALUES ('claude','web','ייבוא ארכיון מ-Outlook','[]','[]',?,1,?)").run(now(), id).lastInsertRowid;
      q('UPDATE imports SET chat_message_id=? WHERE id=?').run(mid, id);
      return id;
    })();
  }

  function guard(size) {
    const dir = queueDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const free = freeBytes(dir);
    if (free < minFree()) { set('archive_disk_low', now()); throw err(507, `אין מספיק מקום פנוי בדיסק לארכיון (${(free / 1024 ** 3).toFixed(1)} GB פנויים, נדרשים לפחות ${(minFree() / 1024 ** 3).toFixed(0)} GB)`, { retryAfter: 600 }); }
    if (getSet('archive_disk_low')) set('archive_disk_low', '');
    const pend = q("SELECT COALESCE(SUM(size),0) b FROM archive_queue WHERE state IN ('queued','working')").get().b;
    if (pend + size > queueMax()) throw err(429, 'תור הארכיון מלא, יש לנסות שוב בעוד דקה', { retryAfter: 60 });
  }

  // ---- the ingest side: one request, cheap
  async function enqueue(meta, buffer) {
    const entry = String(meta.entry_id || '').trim();
    if (!entry) throw err(400, 'entry_id חסר');
    if (!buffer || !buffer.length) throw err(400, 'קובץ ה-msg חסר');
    if (buffer.length > MAX_FILE) throw err(413, 'הקובץ גדול מ-100 MB');
    const mid = normId(meta.internet_message_id);
    const folder = String(meta.folder || 'inbox');
    const at = meta.received_or_sent_at && !Number.isNaN(Date.parse(meta.received_or_sent_at)) ? new Date(meta.received_or_sent_at).toISOString() : null;
    const rec = (status, emailId = null, size = buffer.length) => q('INSERT INTO ingest_mail (entry_id, internet_message_id, store, folder, at, size, email_id, backfill, status, created_at, archive) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
      .run(entry, mid || null, meta.store || null, folder, at, +meta.size || size, emailId, meta.backfill ? String(meta.backfill) : null, status, now());
    // dedupe exactly like live mail: an email that exists (stored normally, by forward, by import, or already in the archive) is left as it is
    if (q('SELECT 1 FROM ingest_mail WHERE entry_id=?').get(entry)) return { status: 'duplicate', reason: 'entry_id' };
    const prior = mid && (q('SELECT email_id FROM ingest_mail WHERE internet_message_id=?').get(mid) || q('SELECT id AS email_id FROM emails WHERE msgid=? OR lower(message_id)=? OR lower(message_id)=?').get(mid, mid, `<${mid}>`));
    if (prior) { try { rec('duplicate', prior.email_id || null); } catch { /* a concurrent request recorded it */ } return { status: 'duplicate', reason: 'internet_message_id' }; }
    guard(buffer.length);
    const textOnly = decideTextOnly(meta, at);
    const dir = queueDir(); const file = path.join(dir, crypto.randomUUID() + '.msg');
    vault.writeFile(file, buffer); // encrypted at rest, also while it waits
    let importId;
    try {
      importId = ensureImport();
      db.transaction(() => {
        q('INSERT INTO archive_queue (entry_id, internet_message_id, folder, at, size, path, backfill, text_only, state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(entry, mid || null, folder, at, buffer.length, file, meta.backfill ? String(meta.backfill) : null, textOnly ? 1 : 0, 'queued', now());
        rec('queued');
      })();
    } catch (e) { try { fs.unlinkSync(file); } catch { /* none */ } if (/UNIQUE/i.test(String(e.message))) return { status: 'duplicate', reason: 'entry_id' }; throw e; }
    return { status: 'stored', archive: true, queued: true, text_only: textOnly, import_id: importId };
  }

  // ---- the worker side
  // live mail has absolute priority: while a live import is collecting / being processed, or chat messages wait for the assistant, the archive does nothing (CPU, database, disk).
  function liveBusy() {
    if (process.env.MESIMOT_ARCHIVE_IGNORE_LIVE === '1') return false;
    if (q("SELECT 1 FROM imports WHERE status <> 'done' AND created_at >= ? AND COALESCE(json_extract(stats,'$.source'),'') <> 'archive' AND json_extract(stats,'$.backfill') IS NULL LIMIT 1").get(new Date(Date.now() - 6 * 3600000).toISOString())) return true; // live (rolling) batches and chat imports
    if (q("SELECT 1 FROM ingest_mail WHERE archive=0 AND created_at >= ? LIMIT 1").get(new Date(Date.now() - 45000).toISOString())) return true; // a live mail arrived a moment ago: its batch is about to start
    if (q("SELECT 1 FROM events WHERE processed_at IS NULL AND entity='chat' LIMIT 1").get()) return true;
    return false;
  }

  // people and projects, cached for a while (the worker handles thousands of mails)
  let cache = { at: 0 };
  function refresh() {
    if (Date.now() - cache.at < 60000 && cache.projects) return cache;
    const people = new Map();
    for (const p of q('SELECT id, emails FROM people').all()) for (const e of JSON.parse(p.emails || '[]')) people.set(String(e).toLowerCase(), p.id);
    const owner = new Set([String(cfg().owner.work_email || '').toLowerCase(), ...(cfg().owner.emails || []).map((x) => String(x).toLowerCase())]);
    for (const x of JSON.parse(getSet('email_allowlist') || '[]')) owner.add(String(x).toLowerCase());
    for (const p of q("SELECT emails FROM people WHERE role='owner'").all()) for (const e of JSON.parse(p.emails || '[]')) owner.add(String(e).toLowerCase());
    owner.delete('');
    const projects = store.listProjects().filter((p) => !p.is_default).map((p) => ({ id: p.id, names: [p.name_he, ...(p.aliases || [])].filter((n) => n && [...String(n)].length >= 3).map((n) => String(n).toLowerCase()), nums: [p.name_he, ...(p.aliases || []), p.description || ''].join(' ').match(/\b\d{3}\.\d{3,5}\b/g) || [] }));
    const sender = new Map(); // address -> Map(project -> count), from mail the assistant already classified (never from archive guesses)
    for (const r of q('SELECT forwarded_from f, project_id p FROM emails WHERE archived=0 AND project_id IS NOT NULL AND forwarded_from IS NOT NULL').all()) { const a = addrOf(r.f); if (!a) continue; const m = sender.get(a) || new Map(); m.set(r.p, (m.get(r.p) || 0) + 1); sender.set(a, m); }
    cache = { at: Date.now(), people, owner, projects, sender };
    return cache;
  }

  // a CHEAP rule-based project guess, no model: project numbers, names and aliases in the subject / body, a sender who always writes about one project, the project of the same thread.
  // Only a clear winner is used; otherwise the mail has no project.
  function guessProject({ subject, body, from, numbers, threadKey }) {
    const { projects, sender } = refresh(); const score = new Map(); const bump = (id, w) => score.set(id, (score.get(id) || 0) + w);
    const subj = String(subject || '').toLowerCase(), text = String(body || '').slice(0, 2500).toLowerCase();
    for (const p of projects) {
      for (const n of p.names) { if (subj.includes(n)) bump(p.id, 3); else if (text.includes(n)) bump(p.id, 1); }
      for (const num of numbers || []) if (p.nums.includes(num)) bump(p.id, 4);
    }
    for (const num of (numbers || []).slice(0, 3)) for (const r of q('SELECT project_id p, COUNT(*) n FROM emails WHERE archived=0 AND project_id IS NOT NULL AND project_numbers LIKE ? GROUP BY project_id').all(`%"${num}"%`)) bump(r.p, Math.min(3, r.n));
    const sm = sender.get(addrOf(from)); if (sm) { const tot = [...sm.values()].reduce((a, b) => a + b, 0); const [pid, cnt] = [...sm.entries()].sort((a, b) => b[1] - a[1])[0]; if (tot >= 3 && cnt / tot >= 0.7) bump(pid, 2); }
    if (threadKey) { const t = q("SELECT project_id p FROM emails WHERE thread_key=? AND project_id IS NOT NULL LIMIT 1").get(threadKey); if (t) bump(t.p, 3); }
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    return ranked.length && ranked[0][1] >= 3 && (ranked.length === 1 || ranked[0][1] - ranked[1][1] >= 1) ? ranked[0][0] : null;
  }

  // ---- text of one attachment (the binary is read from memory, written for the external tools to a private /dev/shm file, and removed at once)
  const SKIP_IMG = (a) => { const img = /^image\//i.test(a.mime || '') || /\.(png|jpe?g|gif|bmp)$/i.test(a.name || ''); return img && (/^image\d{1,4}\.(png|jpe?g|gif)$/i.test(a.name || '') || (a.content?.length || 0) < 30 * 1024); }; // signatures and tiny pictures: not worth reading
  async function textOf(a, { depth = 0, noise = false } = {}) {
    const docs = require('./docs');
    const size = a.content.length;
    if (size > MAX_EXTRACT_BYTES) return { pages: [], text_status: 'too_big', note: 'קובץ גדול מדי לקריאה' };
    const isImg = /^image\//i.test(a.mime || '') || /\.(png|jpe?g|gif|bmp|tiff?|webp|heic)$/i.test(a.name || '');
    if (noise && isImg) return { pages: [], text_status: 'empty', note: 'תמונה בדואר המוני: ללא OCR' };
    if (isImg && (size > 3 * 1024 * 1024 || /\.(heic|heif)$/i.test(a.name || ''))) return { pages: [], text_status: 'empty', note: 'תמונה גדולה (צילום): ללא OCR בארכיון' }; // camera photos take minutes on this CPU and read as noise
    const dir = vault.tmpDir('arch-');
    try {
      const f = path.join(dir, safeName(a.name || 'file')); fs.writeFileSync(f, a.content, { mode: 0o600 });
      const ex = await docs.extract(f, a.name, a.mime);
      if (ex.email) { // a mail inside a mail: its header, body and (down to 2 levels) its own attachments become the text
        const m = ex.email; const pages = [`${m.subject || ''}\n${m.from || ''}\n${(m.to || []).join(', ')}\n${m.date || ''}\n\n${String(m.body || '').slice(0, 60000)}`];
        if (depth < 2) for (const n of (m.attachments || []).slice(0, 10)) { if (!n.content || !n.content.length || SKIP_IMG(n)) continue; try { const t = await textOf(n, { depth: depth + 1, noise }); if (t.pages.length) pages.push(`[${n.name}]\n` + t.pages.join('\n')); } catch { /* skip */ } }
        return { pages, text_status: 'ok', note: null };
      }
      return { pages: ex.pages || [], text_status: ex.text_status, note: ex.note || null };
    } catch { return { pages: [], text_status: 'unsupported', note: null }; }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  // ---- parse, store, extract. ONE mail. Returns { status: 'stored' | 'duplicate', email_id }.
  async function storeMail(row, buffer) {
    const { parseMailFile } = require('./mailfile'); const { threadFromHeaders, stripSubjectPrefixes } = require('./forward'); const { threadInfo } = require('./threads'); const docs = require('./docs');
    const { noiseReason } = require('./importer');
    const m = await parseMailFile(buffer, `${row.entry_id}.msg`);
    const mailDate = row.at || m.date || null;
    const textOnly = row.text_only === 1 || row.text_only === true || (mailDate ? jerusalemDay(mailDate) < fullSince() : false); // the cutoff again, with the date the message itself carries
    const ctx = refresh();
    const from = addrOf(m.from_addr || m.from);
    const direction = ctx.owner.has(from) || /^sent/i.test(row.folder || '') ? 'sent' : 'received';
    let noise = noiseReason(m); if (direction === 'sent' && noise && !/יומן|מענה/.test(noise)) noise = null;
    const meta = threadFromHeaders({ from_name: m.from_name, from_addr: m.from_addr, to: m.to, cc: m.cc, date: mailDate || m.date, subject: m.subject });
    const t = threadInfo(stripSubjectPrefixes(m.subject), m.subject);
    const body = String(m.body || '').slice(0, MAX_BODY);
    const projectId = guessProject({ subject: m.subject, body, from: m.from, numbers: t.numbers, threadKey: t.key });
    const mid = m.msgid || normId(row.internet_message_id) || null;
    if (mid && q('SELECT 1 FROM emails WHERE msgid=? OR lower(message_id)=? OR lower(message_id)=?').get(mid, mid, `<${mid}>`)) return { status: 'duplicate' };
    // the attachments, read BEFORE the database transaction (extraction can take seconds; the write transaction below takes milliseconds)
    const atts = []; let chunkChars = 0;
    for (const a of m.attachments || []) {
      if (!a.content || !a.content.length || SKIP_IMG(a)) continue;
      const x = await textOf(a, { noise: !!noise });
      let chunks = docs.chunkPages(x.pages).slice(0, MAX_CHUNKS_PER_FILE); let note = x.note;
      if (chunks.length === MAX_CHUNKS_PER_FILE) note = (note ? note + ' · ' : '') + 'נוצר אינדקס לחלק הראשון של הקובץ';
      chunks = chunks.filter((c) => { chunkChars += c.text.length; return chunkChars <= MAX_CHUNK_CHARS_PER_MAIL; });
      atts.push({ name: a.name || 'attachment', mime: a.mime || null, size: a.content.length, sha: crypto.createHash('sha256').update(a.content).digest('hex'), text_status: x.text_status, note, chunks, content: textOnly ? null : a.content });
    }
    // complete storage: the binaries go to files/archive/YYYY/MM/ (encrypted) before the transaction; they are removed again if it fails
    const written = [];
    const place = (name, content) => {
      const d = mailDate ? new Date(mailDate) : new Date(); const dir = path.join(filesRoot(), ARCHIVE_DIR, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, `${crypto.randomBytes(5).toString('hex')}-${safeName(name)}`); vault.writeFile(p, content); written.push(p); return p;
    };
    try {
      let rawPath = null; if (!textOnly) { rawPath = place(`${row.entry_id.replace(/[^\w.-]+/g, '').slice(-24) || 'outlook'}.msg`, buffer); for (const a of atts) a.path = place(a.name, a.content); }
      const imp = ensureImport(); const ts = mailDate || now();
      const emailId = db.transaction(() => {
        const info = q(`INSERT INTO emails (message_id, from_addr, to_addr, subject, received_at, body_text, forwarded_from, attachments, project_id, processed_at, forwarded_date, original_subject, labels, participants, thread, import_id, direction, msgid, in_reply_to, refs, import_state, noise_reason, mail_date, thread_key, project_numbers, archived, text_only)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
          .run(`archive:${mid || crypto.createHash('sha1').update(row.entry_id).digest('hex')}`, m.from, [...m.to, ...m.cc.map((c) => 'cc: ' + c)].join(', '), m.subject, now(), body, m.from, '[]', projectId, now(), mailDate || m.date || null, stripSubjectPrefixes(m.subject), '[]',
            JSON.stringify(meta.participants), JSON.stringify(meta.thread), imp, direction, mid, m.in_reply_to || null, JSON.stringify(m.references || []), 'archived', noise, mailDate || m.date || null, t.key, JSON.stringify(t.numbers), textOnly ? 1 : 0);
        const id = Number(info.lastInsertRowid);
        const addFile = q('INSERT INTO files (original_name, path, mime, size, source, created_at, email_id, text_status, index_note, sha256, archived, discarded) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)');
        const addChunk = q('INSERT INTO chunks (file_id, idx, text, page, archived) VALUES (?,?,?,?,1)');
        const addIdx = q('INSERT INTO search_archive (title, body, kind, ref_id, project_id, ts, person) VALUES (?,?,?,?,?,?,?)');
        const attMeta = [];
        for (const a of atts) {
          const fid = Number(addFile.run(a.name, a.path || '', a.mime, a.size, 'email', ts, id, a.text_status, a.note, a.sha, a.path ? 0 : 1).lastInsertRowid);
          addIdx.run(a.name, '', 'file', fid, projectId, ts, '');
          a.chunks.forEach((c, i) => { const cid = Number(addChunk.run(fid, i, c.text, c.page).lastInsertRowid); addIdx.run(`${a.name} (עמוד ${c.page ?? 1})`, c.text, 'chunk', cid, projectId, ts, ''); });
          attMeta.push({ filename: a.name, content_type: a.mime, size: a.size, file_id: fid, text_status: a.text_status, discarded: !a.path });
        }
        // the names of attachments that were not worth reading (signature pictures) stay in the list too
        for (const a of m.attachments || []) if (a.content?.length && SKIP_IMG(a)) attMeta.push({ filename: a.name, content_type: a.mime || null, size: a.content.length, skipped: 'inline' });
        let fileId = null;
        if (rawPath) { fileId = Number(addFile.run(`${row.entry_id.replace(/[^\w.-]+/g, '').slice(-24) || 'outlook'}.msg`, rawPath, 'application/vnd.ms-outlook', buffer.length, 'email', ts, id, 'ok', null, crypto.createHash('sha256').update(buffer).digest('hex'), 0).lastInsertRowid); }
        q('UPDATE emails SET attachments=?, file_id=? WHERE id=?').run(JSON.stringify(attMeta), fileId, id);
        addIdx.run(m.subject || '', body, 'email', id, projectId, mailDate || m.date || ts, m.from || '');
        // address book: who wrote / received (resolved to an existing person when the address is known; no new people are created)
        const upd = q(`INSERT INTO archive_contacts (email, name, person_id, first_at, last_at, n_received, n_sent) VALUES (?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=COALESCE(NULLIF(excluded.name,''), name), person_id=COALESCE(person_id, excluded.person_id),
          first_at=MIN(first_at, excluded.first_at), last_at=MAX(last_at, excluded.last_at), n_received=n_received+excluded.n_received, n_sent=n_sent+excluded.n_sent`);
        for (const x of meta.participants || []) {
          const a = String(x.email || '').toLowerCase(); if (!a || ctx.owner.has(a)) continue;
          upd.run(a, String(x.name || '').slice(0, 120), ctx.people.get(a) ?? null, ts, ts, direction === 'received' && x.role === 'from' ? 1 : 0, direction === 'sent' && x.role !== 'from' ? 1 : 0);
        }
        q("UPDATE archive_queue SET state='stored', email_id=?, stored_at=? WHERE id=?").run(id, now(), row.id);
        q("UPDATE ingest_mail SET status='archived', email_id=? WHERE entry_id=?").run(id, row.entry_id);
        return id;
      })();
      return { status: 'stored', email_id: emailId, text_only: textOnly };
    } catch (e) { for (const p of written) { try { fs.unlinkSync(p); } catch { /* ignore */ } } throw e; }
  }

  // ---- vectors of an archive mail: the body (3 parts at most) and the first chunks of each attachment, from the rows that are stored (so a crash between the steps loses nothing)
  const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
  function jobsFor(emailId) {
    const e = q('SELECT id, subject, body_text, project_id, from_addr, forwarded_from, COALESCE(forwarded_date, received_at) ts FROM emails WHERE id=?').get(emailId); if (!e) return [];
    const jobs = []; const w = words(e.body_text);
    for (let i = 0, part = 0; i < Math.max(w.length, 1) && part < EMBED_BODY_PARTS; i += EMBED_WORDS, part++) { const text = ((i === 0 && e.subject ? e.subject + '\n' : '') + w.slice(i, i + EMBED_WORDS).join(' ')).trim(); if (text) jobs.push({ kind: 'email', ref_id: e.id, part, title: e.subject || '', text, project_id: e.project_id, ts: e.ts, person: e.forwarded_from || e.from_addr || '' }); }
    for (const f of q('SELECT id, original_name FROM files WHERE email_id=? ORDER BY id').all(emailId)) {
      for (const c of q('SELECT id, page, text FROM chunks WHERE file_id=? ORDER BY idx LIMIT ?').all(f.id, EMBED_FILE_CHUNKS)) { const text = words(c.text).slice(0, EMBED_WORDS).join(' '); if (text) jobs.push({ kind: 'chunk', ref_id: c.id, part: 0, title: `${f.original_name} (עמוד ${c.page ?? 1})`, text: `${f.original_name}\n${text}`, project_id: e.project_id, ts: e.ts, person: '' }); }
    }
    return jobs;
  }
  async function embedStep(limit = 12) {
    const rows = q("SELECT id, email_id FROM archive_queue WHERE state='stored' ORDER BY id LIMIT ?").all(limit); if (!rows.length) return 0;
    const done = () => q(`UPDATE archive_queue SET state='done', finished_at=? WHERE id IN (${rows.map(() => '?').join(',')})`).run(now(), ...rows.map((r) => r.id));
    if (!semantic || !semantic.available()) { done(); return rows.length; }
    const jobs = rows.flatMap((r) => jobsFor(r.email_id));
    const vec = await semantic.embedJobs(jobs);
    semantic.storeJobs(vec, done); // the vectors and the 'done' mark commit together
    return rows.length;
  }

  // one unit of work: the next queued mail
  async function processOne() {
    const row = db.transaction(() => { const r = q("SELECT * FROM archive_queue WHERE state='queued' ORDER BY id LIMIT 1").get(); if (!r) return null; q("UPDATE archive_queue SET state='working', started_at=?, attempts=attempts+1 WHERE id=?").run(now(), r.id); return r; })();
    if (!row) return null;
    try {
      const buffer = vault.readFile(row.path);
      const r = await storeMail(row, buffer);
      if (r.status === 'duplicate') { q("UPDATE archive_queue SET state='done', finished_at=? WHERE id=?").run(now(), row.id); q("UPDATE ingest_mail SET status='duplicate' WHERE entry_id=?").run(row.entry_id); }
      try { fs.unlinkSync(row.path); } catch { /* already gone */ } // text only: the binary is gone for good (a complete mail keeps its own copy under files/archive/)
      return { id: row.id, ...r };
    } catch (e) {
      const final = row.attempts >= 3 || /not an email|msg:/i.test(String(e.message));
      q('UPDATE archive_queue SET state=?, error=? WHERE id=?').run(final ? 'failed' : 'queued', String(e.message || e).slice(0, 300), row.id);
      if (final) q("UPDATE ingest_mail SET status='failed' WHERE entry_id=?").run(row.entry_id);
      log(`archive: mail ${row.entry_id.slice(-12)} ${final ? 'failed' : 'will be retried'}: ${e.message}`);
      return { id: row.id, status: final ? 'failed' : 'retry', error: String(e.message || e) };
    }
  }
  // one step of the worker loop. Live mail first: while it is being received or processed the archive does nothing at all.
  async function step() {
    if (liveBusy()) return 'yield';
    const queued = q("SELECT COUNT(*) n FROM archive_queue WHERE state='queued'").get().n, stored = q("SELECT COUNT(*) n FROM archive_queue WHERE state='stored'").get().n;
    if (stored >= 12 || (stored && !queued)) { await embedStep(12); return 'embedded'; }
    if (queued) { // attachments are read by external tools (pdftotext, tesseract, ...): a few mails at once use the cores of this machine; all at the lowest priority
      const conc = Math.max(1, +process.env.MESIMOT_ARCHIVE_CONCURRENCY || 3);
      const rs = await Promise.all(Array.from({ length: Math.min(conc, queued) }, () => processOne()));
      return rs.some(Boolean) ? 'processed' : 'idle';
    }
    return 'idle';
  }
  // a worker that died in the middle leaves 'working' rows: they go back to the queue (3 attempts, then failed)
  function recover() {
    const cut = new Date(Date.now() - 15 * 60000).toISOString();
    return q("UPDATE archive_queue SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END WHERE state='working' AND started_at < ?").run(cut).changes;
  }
  function retryFailed() { return q("UPDATE archive_queue SET state='queued', attempts=0, error=NULL WHERE state='failed' AND path IS NOT NULL").run().changes; }

  // ---- status (CLI, Settings, /ingest/status, health)
  function status() {
    const c = q('SELECT state, COUNT(*) n, COALESCE(SUM(size),0) b FROM archive_queue GROUP BY state').all(); const n = (s) => c.find((x) => x.state === s)?.n || 0; const bytes = (s) => c.find((x) => x.state === s)?.b || 0;
    const e = q('SELECT COUNT(*) total, COALESCE(SUM(text_only=1),0) text_only, COALESCE(SUM(text_only=0),0) full_n, MIN(COALESCE(forwarded_date,received_at)) oldest, MAX(COALESCE(forwarded_date,received_at)) newest FROM emails WHERE archived=1').get();
    const f = q('SELECT COUNT(*) n, COALESCE(SUM(discarded),0) discarded, COALESCE(SUM(CASE WHEN discarded=0 THEN size ELSE 0 END),0) kept_bytes FROM files WHERE archived=1').get();
    const last = q('SELECT MAX(stored_at) a, MAX(created_at) r FROM archive_queue').get();
    const since = new Date(Date.now() - 10 * 60000).toISOString(); const recent = q('SELECT COUNT(*) n FROM archive_queue WHERE stored_at >= ?').get(since).n;
    const rate = recent / 10; const waiting = n('queued') + n('working');
    let vectors = 0; try { vectors = q('SELECT COUNT(*) n FROM embeddings WHERE archive=1').get().n; } catch { /* no vector table */ }
    let free = null; try { free = freeBytes(queueDir()); } catch { /* unknown */ }
    const hb = q("SELECT at FROM heartbeat WHERE key='archive_worker'").get();
    const imp = q("SELECT id FROM imports WHERE json_extract(stats,'$.source')='archive' ORDER BY id LIMIT 1").get();
    return { emails: e.total, text_only: e.text_only, full: e.full_n, queued: n('queued'), working: n('working'), embedding: n('stored'), indexed: n('done'), failed: n('failed'), duplicates: q("SELECT COUNT(*) n FROM ingest_mail WHERE archive=1 AND status='duplicate'").get().n,
      attachments: f.n, attachments_discarded: f.discarded, full_files_bytes: f.kept_bytes, queue_bytes: bytes('queued') + bytes('working'), vectors, oldest_mail: e.oldest, newest_mail: e.newest, last_stored_at: last.a, last_received_at: last.r,
      emails_per_minute: +rate.toFixed(2), eta_minutes: rate > 0 ? Math.round((waiting + n('stored')) / rate) : null, free_bytes: free, min_free_bytes: minFree(), disk_ok: free == null || free >= minFree(), full_since: fullSince(), worker_beat_at: hb?.at || null, import_id: imp?.id || null };
  }

  function failed() { return q("SELECT id, entry_id, folder, at, attempts, error, created_at FROM archive_queue WHERE state='failed' ORDER BY id LIMIT 200").all(); }
  // disk needed for N more mails: measured averages when there is data (a complete mail ~ the average size of a live mail with its attachments), otherwise the benchmark defaults of docs/OUTLOOK-INGEST.md
  function estimate({ emails = 20000, fullShare } = {}) {
    const live = q('SELECT COUNT(DISTINCT e.id) n, COALESCE(SUM(f.size),0) b FROM emails e LEFT JOIN files f ON f.email_id=e.id WHERE e.archived=0 AND e.import_state IS NOT NULL').get();
    const fullAvg = live.n ? Math.round(live.b / live.n) : 1.8 * 1024 * 1024;
    const textAvg = (() => { const t = q('SELECT COUNT(*) n FROM emails WHERE archived=1 AND text_only=1').get().n; if (t < 50) return DEFAULT_TEXT_ONLY_BYTES;
      const s = q('SELECT COALESCE(SUM(length(body_text)),0) b FROM emails WHERE archived=1 AND text_only=1').get().b + q('SELECT COALESCE(SUM(length(text)),0) b FROM chunks WHERE archived=1').get().b; return Math.round(s / t * TEXT_INDEX_FACTOR); })();
    const share = fullShare !== undefined && !Number.isNaN(fullShare) ? fullShare : (() => { const f = q('SELECT SUM(text_only=0) f, COUNT(*) n FROM emails WHERE archived=1').get(); return f.n >= 50 ? (f.f || 0) / f.n : 0.3; })();
    const full = Math.round(emails * share), textOnly = emails - full;
    const bytes = full * (fullAvg + textAvg) + textOnly * textAvg; let free = null; try { free = freeBytes(queueDir()); } catch { /* unknown */ }
    return { emails, full_share: +share.toFixed(2), full_emails: full, text_only_emails: textOnly, avg_full_bytes: fullAvg, avg_text_only_bytes: textAvg, projected_bytes: bytes, projected_gb: +(bytes / 1024 ** 3).toFixed(1), free_bytes: free, min_free_bytes: minFree(), fits: free == null ? null : free - bytes >= minFree(),
      note: 'database growth also multiplies in the daily local backups (backups/, 30 copies) and the pre-deploy copies: see docs/OUTLOOK-INGEST.md, "Disk"' };
  }

  return { step, failed, estimate, enqueue, processOne, embedStep, recover, retryFailed, liveBusy, status, guessProject, decideTextOnly, ensureImport, jobsFor, fullSince, storeMail, refresh: () => { cache = { at: 0 }; } };
}

module.exports = { createArchive, archiveProgress, ARCHIVE_DIR, queueDir };
