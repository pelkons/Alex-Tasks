'use strict';
// Knowledge items, uploaded documents (files + chunks) and the project page.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { now } = require('./db');
const { bad, missing, normDate } = require('./store');
const docs = require('./docs');
const crypto = require('crypto');
const { parseForwarded, isForwardSubject, stripSubjectPrefixes, threadFromHeaders } = require('./forward');
const { ensureContacts } = require('./email');
const { setKeys } = require('./threads');
const { createProfile, TOPICS, guessTopic } = require('./profile');

const vault = require('./vault');
const FILES_ROOT = process.env.MESIMOT_FILES || path.join(__dirname, '..', 'files');
const DEFAULT_MAX_MB = 1024;
const BUFFER_MAX = 100 * 1024 * 1024; // what one request may carry as a buffer (larger files arrive in chunks or from disk)
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const KINDS = ['fact', 'decision', 'contact', 'note', 'doc'];
const SOURCES = ['chat', 'email', 'file', 'manual'];

function createKnowledge(db, store) {
  const q = (sql) => db.prepare(sql);
  const profile = createProfile(db, store);
  const projectId = (v) => (v === undefined || v === null || v === '' ? null : store.findProject(v).id);

  // ---------- knowledge
  function getKnowledge(id) {
    const k = q(`SELECT k.*, p.name_he AS project, pe.name_he AS author FROM knowledge k
      LEFT JOIN projects p ON p.id = k.project_id LEFT JOIN people pe ON pe.id = k.created_by WHERE k.id=?`).get(id);
    if (!k) throw missing('פריט המידע לא נמצא');
    return k;
  }
  function addKnowledge(actor, b) {
    const title = String(b.title ?? '').trim();
    if (!title) throw bad('יש להזין כותרת');
    const kind = b.kind || 'fact';
    if (!KINDS.includes(kind)) throw bad('סוג מידע לא תקין. האפשרויות: ' + KINDS.join(', '));
    const source = b.source || 'manual';
    if (!SOURCES.includes(source)) throw bad('מקור לא תקין. האפשרויות: ' + SOURCES.join(', '));
    const t = now();
    return db.transaction(() => {
      const id = q(`INSERT INTO knowledge (project_id, kind, title, body, source, source_ref, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(projectId(b.project ?? b.project_id), kind, title, String(b.body ?? ''), source, b.source_ref == null ? null : String(b.source_ref), actor, t, t).lastInsertRowid;
      store.logEvent(actor, 'knowledge', id, 'create', 'title', null, title);
      return getKnowledge(id);
    })();
  }
  function updateKnowledge(actor, id, b) {
    const cur = getKnowledge(id);
    const sets = {}, ch = [];
    for (const f of ['title', 'body']) if (b[f] !== undefined && String(b[f]) !== cur[f]) { sets[f] = String(b[f]); ch.push([f, cur[f], sets[f]]); }
    if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) throw bad('סוג מידע לא תקין'); if (b.kind !== cur.kind) { sets.kind = b.kind; ch.push(['kind', cur.kind, b.kind]); } }
    if (b.project !== undefined || b.project_id !== undefined) {
      const pid = projectId(b.project ?? b.project_id);
      if (pid !== cur.project_id) { sets.project_id = pid; ch.push(['project', cur.project, pid]); }
    }
    if (sets.title === '') throw bad('יש להזין כותרת');
    if (!ch.length) return cur;
    return db.transaction(() => {
      sets.updated_at = now();
      const cols = Object.keys(sets);
      q(`UPDATE knowledge SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), id);
      for (const [f, o, n] of ch) store.logEvent(actor, 'knowledge', id, 'update', f, o, n);
      return getKnowledge(id);
    })();
  }
  // mark an old fact as replaced instead of deleting it; either point at an existing item or create the new one
  function supersede(actor, id, b) {
    const old = getKnowledge(id);
    if (old.superseded_by) throw bad('הפריט כבר הוחלף');
    return db.transaction(() => {
      let newId;
      if (b.by) { newId = getKnowledge(+b.by).id; if (newId === id) throw bad('פריט לא יכול להחליף את עצמו'); }
      else {
        const body = String(b.body ?? '').trim();
        if (!body && !b.title) throw bad('יש להזין את הנוסח החדש (body) או את מזהה הפריט המחליף (by)');
        newId = addKnowledge(actor, { project_id: old.project_id, kind: old.kind, title: b.title || old.title, body, source: b.source || old.source, source_ref: b.source_ref ?? old.source_ref }).id;
      }
      q('UPDATE knowledge SET superseded_by=?, updated_at=? WHERE id=?').run(newId, now(), id);
      store.logEvent(actor, 'knowledge', id, 'update', 'superseded_by', null, newId);
      return { replaced: getKnowledge(id), by: getKnowledge(newId) };
    })();
  }
  function listKnowledge({ project, include_superseded } = {}) {
    const where = [], args = [];
    if (project) { where.push('k.project_id=?'); args.push(store.findProject(project).id); }
    if (!include_superseded) where.push('k.superseded_by IS NULL');
    return q(`SELECT k.*, p.name_he AS project, pe.name_he AS author FROM knowledge k
      LEFT JOIN projects p ON p.id = k.project_id LEFT JOIN people pe ON pe.id = k.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY k.id DESC LIMIT 200`).all(...args);
  }

  // ---------- project facts: dated key/value items; the current value of a key is the newest non-superseded one
  const parseSource = (src) => {
    const m = /^(email|chat|file|manual)(?::(\d+))?$/.exec(String(src || 'manual').trim());
    if (!m) throw bad('מקור לא תקין. הפורמט: email:ID, chat:ID, file:ID או manual');
    return { type: m[1], id: m[2] ? +m[2] : null };
  };
  const factRow = (f) => f && ({ ...f, project: q('SELECT name_he FROM projects WHERE id=?').get(f.project_id)?.name_he });
  function currentFacts(projectId) {
    return q('SELECT * FROM project_facts WHERE project_id=? AND superseded_by IS NULL ORDER BY key').all(projectId).map(factRow);
  }
  function factHistory(projectId, key) {
    const rows = q('SELECT * FROM project_facts WHERE project_id=? AND key=? ORDER BY as_of_date DESC, id DESC').all(projectId, key);
    return rows.map((r) => {
      let src = null;
      if (r.source_type === 'email' && r.source_id) src = q('SELECT id, COALESCE(original_subject, subject) subject FROM emails WHERE id=?').get(r.source_id);
      if (r.source_type === 'file' && r.source_id) src = q('SELECT id, original_name subject FROM files WHERE id=?').get(r.source_id);
      return { ...factRow(r), current: r.superseded_by === null, source: src };
    });
  }
  function listFacts({ project, history } = {}) {
    const pid = store.findProject(project).id;
    if (!history) return currentFacts(pid);
    const keys = [...new Set(q('SELECT key FROM project_facts WHERE project_id=? ORDER BY key').all(pid).map((r) => r.key))];
    return keys.flatMap((k) => factHistory(pid, k));
  }
  function setFact(actor, b) {
    const pid = store.findProject(b.project ?? b.project_id).id;
    const key = String(b.key ?? '').trim().replace(/\s+/g, ' ');
    const value = String(b.value ?? '').trim();
    if (!key || !value) throw bad('יש להזין מפתח וערך לנתון');
    const unit = String(b.unit ?? '').trim();
    const asOf = b.as_of || b.as_of_date ? normDate(b.as_of || b.as_of_date) : todayISO();
    const src = parseSource(b.source);
    if (src.type === 'email' && src.id !== null && !q('SELECT 1 FROM emails WHERE id=?').get(src.id)) throw bad('הדוא״ל במקור לא נמצא');
    const cur = q('SELECT * FROM project_facts WHERE project_id=? AND key=? AND superseded_by IS NULL').get(pid, key);
    // the topic groups the fact on the project page: given, else the key's earlier topic, else a first guess from the words
    if (b.topic !== undefined && b.topic !== null && b.topic !== '' && !TOPICS[b.topic]) throw bad(`נושא לא מוכר: ${b.topic}. האפשרויות: ${Object.keys(TOPICS).join(', ')}`);
    const topic = b.topic || q('SELECT topic FROM project_facts WHERE project_id=? AND key=? AND topic IS NOT NULL ORDER BY id DESC LIMIT 1').get(pid, key)?.topic || guessTopic(key, value);
    return db.transaction(() => {
      if (b.topic && cur && cur.topic !== b.topic) q('UPDATE project_facts SET topic=? WHERE project_id=? AND key=?').run(b.topic, pid, key);
      // the same value confirmed by a newer source only moves the date forward
      if (cur && cur.value === value && cur.unit === unit) {
        if (asOf > cur.as_of_date) {
          q('UPDATE project_facts SET as_of_date=?, source_type=?, source_id=? WHERE id=?').run(asOf, src.type, src.id, cur.id);
          store.logEvent(actor, 'fact', cur.id, 'update', 'as_of_date', cur.as_of_date, asOf, { key });
        }
        return { fact: factRow(q('SELECT * FROM project_facts WHERE id=?').get(cur.id)), result: 'confirmed' };
      }
      const olderThanCurrent = cur && cur.as_of_date > asOf;
      const id = q(`INSERT INTO project_facts (project_id, key, value, unit, as_of_date, source_type, source_id, created_by, created_at, superseded_by, topic)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(pid, key, value, unit, asOf, src.type, src.id, actor, now(), olderThanCurrent ? cur.id : null, topic).lastInsertRowid;
      if (cur && !olderThanCurrent) q('UPDATE project_facts SET superseded_by=? WHERE id=?').run(id, cur.id);
      store.logEvent(actor, 'fact', id, 'create', key, cur ? `${cur.value} ${cur.unit}`.trim() : null, `${value} ${unit}`.trim(), { key, project_id: pid, replaced: olderThanCurrent ? null : (cur?.id ?? null), history_only: !!olderThanCurrent });
      return { fact: factRow(q('SELECT * FROM project_facts WHERE id=?').get(id)), result: olderThanCurrent ? 'history_only' : (cur ? 'superseded' : 'created') };
    })();
  }

  // two labels for the same thing become one: the history moves to the kept key, and when both have a current value the newer one wins
  function mergeFactKey(actor, b) {
    const pid = store.findProject(b.project ?? b.project_id).id;
    const from = String(b.from_key ?? b.from ?? '').trim().replace(/\s+/g, ' '), into = String(b.into_key ?? b.into ?? '').trim().replace(/\s+/g, ' ');
    if (!from || !into) throw bad('יש לציין את שני המפתחות למיזוג');
    if (from === into) throw bad('לא ניתן למזג מפתח לתוך עצמו');
    const rows = q('SELECT * FROM project_facts WHERE project_id=? AND key=?').all(pid, from);
    if (!rows.length) throw bad(`אין נתונים בשם "${from}" בפרויקט`);
    return db.transaction(() => {
      const curFrom = rows.find((r) => r.superseded_by === null);
      const curInto = q('SELECT * FROM project_facts WHERE project_id=? AND key=? AND superseded_by IS NULL').get(pid, into);
      for (const r of rows) {
        q('UPDATE project_facts SET key=? WHERE id=?').run(into, r.id);
        store.logEvent(actor, 'fact', r.id, 'update', 'key', from, into, { project_id: pid });
      }
      let kept = curFrom ? curFrom.id : curInto?.id ?? null;
      if (curFrom && curInto) {
        // same meaning, two current values: the newer one stays current, the other becomes history
        const fromWins = curFrom.as_of_date >= curInto.as_of_date;
        const loser = fromWins ? curInto : curFrom, winner = fromWins ? curFrom : curInto;
        q('UPDATE project_facts SET superseded_by=? WHERE id=?').run(winner.id, loser.id);
        store.logEvent(actor, 'fact', loser.id, 'update', 'superseded_by', null, winner.id, { project_id: pid });
        kept = winner.id;
      }
      return { project_id: pid, from, into, moved: rows.length, current: kept };
    })();
  }

  // ---------- files and chunks
  const fileRow = (f) => f && { ...f, has_text: !!q('SELECT 1 FROM chunks WHERE file_id=? LIMIT 1').get(f.id), chunk_count: q('SELECT COUNT(*) c FROM chunks WHERE file_id=?').get(f.id).c };
  function getFile(id) {
    const f = q(`SELECT f.id, f.original_name, f.path, f.mime, f.size, f.task_id, f.project_id, f.source, f.created_at, f.summary, f.email_id, f.text_status, f.index_note, f.facts_checked, f.archived, f.discarded, p.name_he AS project
      FROM files f LEFT JOIN projects p ON p.id=f.project_id WHERE f.id=?`).get(id);
    if (!f) throw missing('הקובץ לא נמצא');
    return fileRow(f);
  }
  const ownerAddrs = () => {
    const out = new Set(JSON.parse(q("SELECT value FROM settings WHERE key='email_allowlist'").get()?.value || '[]').map((x) => x.toLowerCase()));
    for (const p of store.listPeople()) if (p.role === 'owner') p.emails.forEach((e) => out.add(e.toLowerCase()));
    return out;
  };

  // a file whose NAME was damaged (Hebrew saved as "?"): the name, the file on disk and the search titles are corrected in place; the id and every link stay
  function renameFile(id, newName) {
    const f = q('SELECT * FROM files WHERE id=?').get(id); if (!f) throw missing('הקובץ לא נמצא');
    const name = String(newName || '').trim(); if (!name || name === f.original_name) return false;
    const np = path.join(path.dirname(f.path), `${id}-${safeName(name)}`); let finalPath = f.path;
    try { if (np !== f.path && fs.existsSync(f.path)) { fs.renameSync(f.path, np); finalPath = np; } else if (fs.existsSync(np)) finalPath = np; } catch { /* keep the old path */ }
    db.transaction(() => {
      q('UPDATE files SET original_name=?, path=? WHERE id=?').run(name, finalPath, id);
      for (const c of q('SELECT id, page FROM chunks WHERE file_id=?').all(id)) {
        const title = `${name} (עמוד ${c.page ?? 1})`;
        q("UPDATE search_index SET title=? WHERE kind='chunk' AND ref_id=?").run(title, c.id);
        try { q("UPDATE embeddings SET title=? WHERE kind='chunk' AND ref_id=?").run(title, c.id); } catch { /* no vectors */ }
      }
      q("UPDATE search_index SET title=? WHERE kind='file' AND ref_id=?").run(name, id);
    })();
    return true;
  }
  // an uploaded .eml/.msg becomes a row in `emails`, with its attachments stored (recursively) as files
  async function ingestEmailFile(actor, fileId, buffer, mail, o, depth) {
    const messageId = 'upload:' + (mail.message_id || crypto.createHash('sha1').update(buffer).digest('hex'));
    let emailId = q('SELECT id FROM emails WHERE message_id=?').get(messageId)?.id;
    let created = false;
    if (!emailId) {
      const fwd = parseForwarded(mail.body, mail.subject);
      const owner = ownerAddrs().has(mail.from_addr);
      const useFwd = fwd.forwarded && (owner || isForwardSubject(mail.subject));
      const from = useFwd ? fwd.from : mail.from;
      const date = useFwd ? (fwd.date || mail.date) : mail.date;
      const subj = useFwd && fwd.subject ? fwd.subject : stripSubjectPrefixes(mail.subject);
      const meta = useFwd ? { thread: fwd.thread, participants: fwd.participants }
        : threadFromHeaders({ from_name: mail.from_name, from_addr: mail.from_addr, to: mail.to, cc: mail.cc, date: mail.date, subject: mail.subject });
      emailId = db.transaction(() => {
        const id = q(`INSERT INTO emails (message_id, from_addr, to_addr, subject, received_at, body_text, forwarded_from, attachments, forwarded_date, original_subject, labels, file_id, participants, thread)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, mail.from, [...mail.to, ...mail.cc.map((c) => 'cc: ' + c)].join(', '), mail.subject, now(), mail.body, from, JSON.stringify(mail.attachments.map((a) => ({ filename: a.name, content_type: a.mime || null, size: a.content?.length ?? null }))), date, subj, '[]', fileId, JSON.stringify(meta.participants), JSON.stringify(meta.thread)).lastInsertRowid;
        // a mail file dropped in the chat (no project, no task) waits as "staged": the chat message decides whether it is a daily import batch or a normal upload
        const staged = !!o.stage || (o.source === 'web' && !o.project && !o.task);
        // a mail file whose attachments include more than 3 embedded messages is a daily-import CONTAINER: only acknowledged, its messages feed the import
        const isContainer = mail.attachments.filter((a) => a.embedded || /\.(msg|eml)$/i.test(a.name || '') || /message\/rfc822|ms-outlook/i.test(a.mime || '')).length > 3;
        if (isContainer) q("UPDATE emails SET import_state='container', processed_at=? WHERE id=?").run(now(), id);
        else if (staged) q("UPDATE emails SET import_state='staged', container_id=? WHERE id=?").run(o.container_id ?? null, id);
        else store.logEvent(actor, 'email', id, 'received', 'subject', null, mail.subject || '');
        return id;
      })();
      setKeys(db, emailId);
      // contacts of staged import mail are created later, only for the threads that matter (not for newsletters and noise)
      if (!q("SELECT 1 FROM emails WHERE id=? AND import_state IN ('staged','container')").get(emailId)) ensureContacts(db, store, meta.participants);
      created = true;
    }
    q('UPDATE files SET email_id=COALESCE(email_id, ?), text_status=? WHERE id=?').run(emailId, 'ok', fileId);
    const isCont = !!q("SELECT 1 FROM emails WHERE id=? AND import_state='container'").get(emailId);
    const children = [];
    if (created && depth < 3) {
      for (const a of mail.attachments) {
        if (!a.content || !a.content.length) continue;
        // signature pictures and tiny inline images are not worth storing (the same rule as for mail intake)
        const img = /^image\//i.test(a.mime || '') || /\.(png|jpe?g|gif|bmp)$/i.test(a.name || '');
        if (img && (/^image\d{1,4}\.(png|jpe?g|gif)$/i.test(a.name || '') || a.content.length < 30 * 1024)) continue;
        const embeddedMail = a.embedded || /\.(msg|eml)$/i.test(a.name || '');
        try { children.push(await saveUpload(actor, { name: a.name, mime: a.mime, buffer: Buffer.from(a.content), project: o.project, source: 'email', email_id: emailId, quiet: true, ...(isCont && embeddedMail ? { stage: true, container_id: emailId } : {}) }, depth + 1)); }
        catch { /* an unreadable attachment must not block the email */ }
      }
    }
    return { emailId, created, children, container: isCont, staged: created && !!q("SELECT 1 FROM emails WHERE id=? AND import_state IN ('staged','container')").get(emailId) };
  }

  const maxFileBytes = () => (parseInt(q("SELECT value FROM settings WHERE key='max_file_mb'").get()?.value || String(DEFAULT_MAX_MB), 10) || DEFAULT_MAX_MB) * 1024 * 1024;
  const tooBig = () => bad(`הקובץ גדול מדי. הגודל המרבי הוא ${Math.round(maxFileBytes() / 1048576).toLocaleString('he-IL')} מגה־בייט`);
  const safeName = (name) => String(name || 'file').replace(/[\\/\0]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  const storeDir = () => {
    const d = new Date();
    const dir = path.join(FILES_ROOT, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const sha256File = (file) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    vault.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

  // a file with the same content that is already processed: copy its text chunks, summary and project (no extraction, no model); the gate sees a complete attachment
  function twinOf(id, sha) {
    if (!sha) return null;
    const t = q("SELECT id, project_id, summary, text_status, index_note, facts_checked FROM files WHERE sha256=? AND id<>? AND text_status IS NOT NULL AND text_status NOT IN ('pending') ORDER BY (summary IS NOT NULL) DESC, id LIMIT 1").get(sha, id);
    if (!t) return null;
    const chunks = q('SELECT idx, text, page FROM chunks WHERE file_id=? ORDER BY idx').all(t.id);
    db.transaction(() => {
      const ins = q('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)');
      for (const c of chunks) ins.run(id, c.idx, c.text, c.page);
      q('UPDATE files SET text_status=?, index_note=?, summary=COALESCE(summary, ?), project_id=COALESCE(project_id, ?), facts_checked=? WHERE id=?').run(t.text_status, (t.index_note ? t.index_note + ' · ' : '') + `זהה לקובץ ${t.id}`, t.summary, t.project_id, t.summary ? 1 : t.facts_checked || 0, id);
    })();
    return { id: t.id, chunks: chunks.length };
  }

  // the text part of an upload: extraction, chunks, an uploaded e-mail. `o.buffer` is only needed for .eml/.msg
  async function indexFile(actor, id, o = {}, depth = 0) {
    const f = q('SELECT * FROM files WHERE id=?').get(id);
    if (!f) throw missing('הקובץ לא נמצא');
    let chunkCount = 0, status = 'unsupported', emailInfo = null, note = null;
    try {
      if (depth > 3) throw new Error('too deep');
      const ex = await docs.extract(f.path, f.original_name, f.mime);
      status = ex.text_status; note = ex.note || null;
      if (ex.email) {
        emailInfo = await ingestEmailFile(actor, id, o.buffer || vault.readFile(f.path), ex.email, { ...o, project: o.project ?? f.project_id }, depth);
      } else {
        const chunks = docs.chunkPages(ex.pages);
        db.transaction(() => {
          q('DELETE FROM chunks WHERE file_id=?').run(id);
          const ins = q('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)');
          chunks.forEach((c, i) => ins.run(id, i, c.text, c.page));
        })();
        chunkCount = chunks.length;
      }
    } catch (e) { status = 'unsupported'; }
    q('UPDATE files SET text_status=?, index_note=? WHERE id=?').run(status, note, id);
    return { chunkCount, emailInfo };
  }
  function result(id, { chunkCount, emailInfo }) {
    const f = getFile(id);
    return { ...f, chunk_count: chunkCount, email_id: emailInfo?.emailId ?? f.email_id, email_created: emailInfo?.created ?? null, attachments_saved: emailInfo?.children.map((c) => ({ id: c.id, name: c.original_name, text_status: c.text_status })) ?? [] };
  }
  function insertFileRow(o, safe, size) {
    return q('INSERT INTO files (original_name, path, mime, size, task_id, project_id, source, created_at, email_id, text_status) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(safe, '', o.mime || null, size, o.task ? store.getTask(+o.task).id : null, projectId(o.project), o.source || 'web', now(), o.email_id ?? null, o.pending ? 'pending' : null).lastInsertRowid;
  }

  async function saveUpload(actor, o, depth = 0) {
    const { name, mime, buffer, source } = o;
    if (!buffer || !buffer.length) throw bad('הקובץ ריק');
    if (buffer.length > Math.min(maxFileBytes(), BUFFER_MAX)) throw tooBig();
    const safe = safeName(name);
    const id = insertFileRow({ ...o, mime, source }, safe, buffer.length);
    const full = path.join(storeDir(), `${id}-${safe}`);
    vault.writeFile(full, buffer); // encrypted at rest
    q('UPDATE files SET path=?, sha256=? WHERE id=?').run(full, crypto.createHash('sha256').update(buffer).digest('hex'), id);
    // the same file (same sha256) already read, summarised and classified: reuse it instead of extracting, OCR-ing and summarising again
    const twin = !/\.(msg|eml)$/i.test(safe) ? twinOf(id, q('SELECT sha256 FROM files WHERE id=?').get(id)?.sha256) : null;
    if (twin) return result(id, { chunkCount: twin.chunks, emailInfo: null });
    const r = await indexFile(actor, id, o, depth);
    if (!o.quiet && !r.emailInfo?.staged) store.logEvent(actor, 'file', id, 'upload', 'file', null, safe);
    return result(id, r);
  }
  // a file that already sits on disk (chunked web upload, Telegram local Bot API): moved or linked into the archive without being read into memory.
  // Small ones are indexed at once; big ones in the background (status "pending"), and the assistant is told when the text is ready.
  async function saveUploadFromPath(actor, o) {
    const { name, mime, file, source } = o;
    const size = o.size || vault.plainSize(file);
    if (!size) throw bad('הקובץ ריק');
    if (size > maxFileBytes()) throw tooBig();
    const safe = safeName(name);
    const background = size > (o.inline_max ?? (+process.env.MESIMOT_INLINE_INDEX_BYTES || 20 * 1024 * 1024)) && !o.sync;
    const id = insertFileRow({ ...o, source, pending: background }, safe, size);
    const full = path.join(storeDir(), `${id}-${safe}`);
    if (o.move) { try { fs.renameSync(file, full); } catch { fs.copyFileSync(file, full); fs.unlinkSync(file); } } else fs.copyFileSync(file, full);
    await vault.seal(full); // encrypted at rest (no-op when the upload arrived encrypted)
    q('UPDATE files SET path=?, sha256=? WHERE id=?').run(full, o.sha256 || await sha256File(full), id);
    if (!background) {
      const r = await indexFile(actor, id, o);
      if (!o.quiet && !r.emailInfo?.staged) store.logEvent(actor, 'file', id, 'upload', 'file', null, safe);
      return result(id, r);
    }
    startBackground(id);
    return { ...result(id, { chunkCount: 0, emailInfo: null }), background: true };
  }
  function startBackground(fileId) {
    if (process.env.MESIMOT_NO_BG === '1') return;
    const { spawn } = require('child_process');
    const child = spawn('nice', ['-n', '10', process.execPath, path.join(__dirname, '..', 'bin', 'mesimot-extract'), String(fileId)], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  }
  // run by the background worker (bin/mesimot-extract): index, then tell the assistant
  async function indexInBackground(actor, id) {
    const r = await indexFile(actor, id, {});
    if (!r.emailInfo?.staged) store.logEvent(actor, 'file', id, 'upload', 'file', null, q('SELECT original_name FROM files WHERE id=?').get(id)?.original_name);
    return r;
  }
  function classifyFile(actor, id, b) {
    const cur = getFile(id);
    const sets = {}, ch = [];
    if (b.project !== undefined || b.project_id !== undefined) {
      const pid = projectId(b.project ?? b.project_id);
      if (pid !== cur.project_id) { sets.project_id = pid; ch.push(['project', cur.project, pid]); }
    }
    if (b.task !== undefined) {
      const tid = b.task ? store.getTask(+b.task).id : null;
      if (tid !== cur.task_id) { sets.task_id = tid; ch.push(['task', cur.task_id, tid]); }
    }
    if (b.summary !== undefined && String(b.summary) !== (cur.summary || '')) { sets.summary = String(b.summary); ch.push(['summary', cur.summary, sets.summary]); }
    const fc = b.facts_checked === undefined ? undefined : (['0', 'false', 'no', ''].includes(String(b.facts_checked)) ? 0 : 1);
    if (fc !== undefined && fc !== (cur.facts_checked ? 1 : 0)) { sets.facts_checked = fc; ch.push(['facts_checked', cur.facts_checked, sets.facts_checked]); }
    if (ch.length) {
      db.transaction(() => {
        const cols = Object.keys(sets);
        q(`UPDATE files SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), id);
        for (const [f, o, n] of ch) store.logEvent(actor, 'file', id, 'update', f, o, n);
      })();
    }
    return getFile(id);
  }
  function listFiles({ project } = {}) {
    const rows = project
      ? q('SELECT id FROM files WHERE project_id=? ORDER BY id DESC').all(store.findProject(project).id)
      : q('SELECT id FROM files WHERE archived = 0 ORDER BY id DESC LIMIT 200').all();
    return rows.map((r) => getFile(r.id));
  }
  function getChunk(id) {
    const c = q('SELECT c.id, c.file_id, c.idx, c.text, c.page, f.original_name, f.project_id FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.id=?').get(id);
    if (!c) throw missing('הקטע לא נמצא');
    const total = q('SELECT COUNT(*) n FROM chunks WHERE file_id=?').get(c.file_id).n;
    const prev = q('SELECT id FROM chunks WHERE file_id=? AND idx=?').get(c.file_id, c.idx - 1);
    const next = q('SELECT id FROM chunks WHERE file_id=? AND idx=?').get(c.file_id, c.idx + 1);
    return { ...c, total_chunks: total, prev_chunk: prev?.id ?? null, next_chunk: next?.id ?? null };
  }
  // metadata plus the first chunks only, never the whole document
  // OCR of photos, drawings and scans is often garbage: when the extracted text is thin or mostly digits/symbols the assistant must LOOK at the file itself
  function textPoor(id) {
    const f = q('SELECT mime, original_name FROM files WHERE id=?').get(id);
    if (!f) return false;
    const t = q('SELECT group_concat(text, \' \') AS t FROM (SELECT text FROM chunks WHERE file_id=? ORDER BY idx LIMIT 12)').get(id)?.t || '';
    const letters = (t.match(/[A-Za-z\u0590-\u05FF]/g) || []).length, words = (t.match(/[A-Za-z\u0590-\u05FF]{3,}/g) || []).length;
    const isImg = /^image\//.test(f.mime || '') || /\.(png|jpe?g|gif|bmp|tiff?|webp|heic)$/i.test(f.original_name);
    return letters < 60 || words < 12 || (isImg && letters < 200) || letters / Math.max(t.length, 1) < 0.3;
  }
  function showFile(id) {
    const f = getFile(id);
    const poor = textPoor(id);
    const preview = q('SELECT id, idx, page, substr(text,1,1200) AS text FROM chunks WHERE file_id=? ORDER BY idx LIMIT 2').all(id);
    const row = q('SELECT path FROM files WHERE id=?').get(id);
    // an archive attachment whose binary was discarded: only its extracted text exists here (the file itself is in Outlook)
    if (f.discarded) return { ...f, path: undefined, text_poor: poor, only_in_outlook: true, view_hint: 'הקובץ נמצא רק ב-Outlook: כאן נשמר רק הטקסט שחולץ ממנו (mesimot show chunk <id> לקריאת הקטעים)', preview_chunks: preview, hint: 'לקריאת קטעים נוספים: mesimot show chunk <id>' };
    return { ...f, path: undefined, text_poor: poor, ...(poor ? { view_path: vault.viewCopy(row.path, f.original_name), view_hint: 'הטקסט שחולץ דל או לא אמין (תמונה, שרטוט או סריקה): פתחו את הקובץ עצמו עם כלי Read על view_path (תמונות ו-PDF נקראים ויזואלית) ותארו מה רואים' } : {}), preview_chunks: preview, hint: 'לקריאת קטעים נוספים: mesimot show chunk <id>' };
  }

  // ---------- project views
  function recentEmails(pid, n = 10) {
    return q(`SELECT id, subject, forwarded_from AS from_sender, COALESCE(forwarded_date, received_at) AS date FROM emails WHERE project_id=? AND archived=0 ORDER BY COALESCE(forwarded_date, received_at) DESC LIMIT ?`).all(pid, n);
  }
  function projectShow(v) {
    const p = store.findProject(v);
    const proj = store.getProject(p.id);
    return {
      project: { id: proj.id, name: proj.name_he, aliases: proj.aliases, status: proj.status, description: proj.description },
      summary: proj.summary_he || null,
      passport: (() => { const pr = profile.getProfile(p.id); return { headline: pr.headline, fields: Object.fromEntries(pr.fields.map((f) => [f.field, f.value ? { value: f.value, as_of: f.as_of, by_owner: f.by_owner, source: f.source.type + (f.source.id ? ':' + f.source.id : '') } : null])), status: Object.fromEntries(pr.statuses.map((x) => [x.process, x.value ? { text: x.value, as_of: x.as_of, by_owner: x.by_owner, source: x.source.type + (x.source.id ? ':' + x.source.id : '') } : null])) }; })(),
      facts: currentFacts(p.id).map((f) => ({ id: f.id, key: f.key, value: f.value, unit: f.unit, as_of: f.as_of_date, topic: f.topic, source: f.source_type + (f.source_id ? ':' + f.source_id : '') })),
      knowledge: listKnowledge({ project: p.id }).slice(0, 30).map((k) => ({ id: k.id, kind: k.kind, title: k.title, body: k.body.length > 400 ? k.body.slice(0, 400) + '…' : k.body, date: k.updated_at })),
      documents: listFiles({ project: p.id }).map((f) => ({ id: f.id, name: f.original_name, summary: f.summary, chunks: f.chunk_count })),
      open_tasks: store.listTasks({ project: p.id, open: '1' }).map((t) => ({ id: t.id, title: t.title, requester: t.requester, assignee: t.assignee, due_date: t.due_date, due_source: t.due_source, status: t.status })),
      recent_emails: recentEmails(p.id, 8),
    };
  }
  function timeline(pid, limit = 80) {
    const items = [];
    for (const t of q('SELECT id, title, created_at, requester_id, source_date FROM tasks WHERE project_id=?').all(pid)) items.push({ kind: 'task', id: t.id, date: t.source_date || t.created_at, text: t.title, link: `/task/${t.id}` });
    for (const e of recentEmails(pid, 100)) items.push({ kind: 'email', id: e.id, date: e.date, text: `${e.subject || ''}${e.from_sender ? ' · ' + e.from_sender : ''}`, link: `/email/${e.id}` });
    for (const k of q('SELECT id, title, created_at, kind FROM knowledge WHERE project_id=? AND superseded_by IS NULL').all(pid)) items.push({ kind: 'knowledge', id: k.id, date: k.created_at, text: k.title, link: `/projects/${pid}` });
    for (const f of q('SELECT id, original_name, created_at FROM files WHERE project_id=?').all(pid)) items.push({ kind: 'file', id: f.id, date: f.created_at, text: f.original_name, link: `/projects/${pid}` });
    for (const n of q('SELECT n.id, n.text, n.created_at, n.task_id FROM notes n WHERE n.project_id=?').all(pid)) items.push({ kind: 'note', id: n.id, date: n.created_at, text: n.text, link: `/projects/${pid}` });
    return items.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
  }
  // people of the project: who asks and who handles its tasks, who sat in its meetings (the owner and the assistant are not listed)
  function projectPeople(pid, n = 8) {
    const hide = new Set([store.ownerId(), store.assistantId()]);
    const score = new Map();
    const bump = (id, w) => { if (id && !hide.has(id)) score.set(id, (score.get(id) || 0) + w); };
    for (const t of q("SELECT t.requester_id, t.assignee_id, s.is_closed FROM tasks t JOIN statuses s ON s.id=t.status_id WHERE t.project_id=? ORDER BY t.id DESC LIMIT 400").all(pid)) { const w = t.is_closed ? 1 : 3; bump(t.requester_id, w); bump(t.assignee_id, w); }
    for (const pr of q('SELECT participants FROM protocols WHERE project_id=? ORDER BY meeting_at DESC LIMIT 20').all(pid)) for (const x of JSON.parse(pr.participants || '[]')) bump(x.person_id, 2);
    return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, w]) => { const pe = q('SELECT id, name_he, company, role_text, role, status FROM people WHERE id=?').get(id); return pe && { ...pe, weight: w }; }).filter(Boolean);
  }
  const factSource = (f) => {
    if (f.source_type === 'email' && f.source_id) return { type: 'email', id: f.source_id, link: `/email/${f.source_id}`, label: q('SELECT COALESCE(original_subject, subject) s FROM emails WHERE id=?').get(f.source_id)?.s || 'מייל' };
    if (f.source_type === 'file' && f.source_id) return { type: 'file', id: f.source_id, link: `/api/files/${f.source_id}/download?inline=1`, label: q('SELECT original_name s FROM files WHERE id=?').get(f.source_id)?.s || 'קובץ' };
    if (f.source_type === 'chat') return { type: 'chat', id: f.source_id, link: null, label: 'צ׳אט' };
    return { type: f.source_type || 'manual', id: null, link: null, label: 'הוזן ידנית' };
  };
  function projectPage(v) {
    const p = store.findProject(v);
    const proj = store.getProject(p.id);
    const withSrc = (f) => ({ ...f, topic: f.topic || guessTopic(f.key, f.value), source: factSource(f) });
    return {
      project: proj,
      profile: profile.getProfile(p.id),
      topics: TOPICS,
      facts: currentFacts(p.id).map(withSrc),
      facts_history: q('SELECT * FROM project_facts WHERE project_id=? AND superseded_by IS NOT NULL ORDER BY as_of_date DESC, id DESC LIMIT 400').all(p.id).map(withSrc),
      people: projectPeople(p.id),
      knowledge: listKnowledge({ project: p.id }),
      files: listFiles({ project: p.id }),
      tasks: store.listTasks({ project: p.id, open: '1' }),
      emails: recentEmails(p.id, 10),
      timeline: timeline(p.id),
    };
  }

  // map every address of a thread to a known person (so the UI and the agent can say who is involved)
  function peopleByEmail(participants) {
    const map = {};
    const all = store.listPeople();
    for (const x of participants || []) {
      const em = (x.email || '').toLowerCase();
      if (!em || map[em]) continue;
      const p = all.find((pp) => pp.emails.map((e) => e.toLowerCase()).includes(em));
      if (p) map[em] = { id: p.id, name_he: p.name_he, role: p.role };
    }
    return map;
  }
  function emailShow(id) {
    const e = q('SELECT * FROM emails WHERE id=?').get(id);
    if (!e) throw missing('הדוא״ל לא נמצא');
    const participants = JSON.parse(e.participants || '[]');
    return { ...e, attachments: JSON.parse(e.attachments || '[]'), labels: JSON.parse(e.labels || '[]'), participants, thread: JSON.parse(e.thread || '[]'),
      people: peopleByEmail(participants),
      tasks: q('SELECT id, title FROM tasks WHERE source_email_id=?').all(id),
      files: q('SELECT id, original_name, mime, size, text_status, summary, discarded, archived FROM files WHERE email_id=? ORDER BY id').all(id),
      archive: e.archived ? { text_only: !!e.text_only, note: e.text_only ? 'ארכיון: נשמר הטקסט בלבד. הקבצים עצמם נמצאים רק ב-Outlook' : 'ארכיון: המייל והקבצים שמורים במלואם' } : null };
  }

  return { profile, renameFile, currentFacts, factHistory, listFacts, setFact, mergeFactKey, getKnowledge, addKnowledge, updateKnowledge, supersede, listKnowledge, getFile, saveUpload, saveUploadFromPath, indexInBackground, maxFileBytes, sha256File, classifyFile, textPoor, indexFile, listFiles, getChunk, showFile, projectShow, projectPage, emailShow, FILES_ROOT };
}

module.exports = { createKnowledge, FILES_ROOT };
