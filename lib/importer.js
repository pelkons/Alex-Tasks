  function startFromFiles(actor, files, text, { author = 'owner' } = {}) {
    // one transaction: the driver (a different process) must never see the import before all its messages are adopted
    return db.transaction(() => {
      const id = q('INSERT INTO imports (created_at, file_count, status, stats, file_ids, text) VALUES (?,?,?,?,?,?)').run(now(), files.length, 'staging', JSON.stringify({ total: files.length, files: files.length }), JSON.stringify(files.map((f) => f.id)), String(text || '').slice(0, 500)).lastInsertRowid;
      for (const f of files) if (f.email_id) adopt(id, f.email_id);
      const mid = q(`INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, import_id) VALUES (?,'web',?,'[]','[]',?,1,?)`).run(author, `ייבוא יומי: ${files.length} קבצים`, now(), id).lastInsertRowid;
      q('UPDATE imports SET chat_message_id=? WHERE id=?').run(mid, id);
      store.logEvent(actor, 'import', id, 'create', 'files', null, String(files.length));
      return { id, mid };
    })();
  }
'use strict';
// DAILY BULK EMAIL IMPORT: the owner drags a day of Outlook mail (.msg / .eml / .zip of them, received AND sent) into the chat.
// Pipeline (all state lives in the database, so it resumes after a restart):
//   staged -> parsed (real headers, direction) -> dedupe (Message-ID, or sender+minute+subject against forwarded copies) -> noise (code)
//   -> threads (References / In-Reply-To, fallback thread_key) -> triage (one batched cheap call: relevant / FYI / noise) -> one run per thread.
const path = require('path');
const fs = require('fs');
const { now } = require('./db');
const { threadFromHeaders, stripSubjectPrefixes } = require('./forward');
const { setKeys, normalizeSubject } = require('./threads');

const MAIL_RE = /\.(msg|eml)$/i;
const BATCH_MIN = 4; // "more than 3 files"
const TRIGGER_RE = /ייבוא\s*יומי/;

const addrOf = (s) => String(((/<([^>]+)>/.exec(s || '') || [])[1] || s || '')).trim().toLowerCase();
const minute = (iso) => String(iso || '').slice(0, 16);

// ---- noise: decided by code before anything is spent on a model
const NOREPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|mailer-daemon|postmaster|bounce[sd]?|notifications?|alerts?|system|automailer)([-_.+].*)?@/i;
const OOO_SUBJ = /^\s*(automatic reply|auto[- ]?reply|autoreply|out of office|ooo|מחוץ למשרד|תשובה אוטומטית|תגובה אוטומטית|הודעת היעדרות)(?=[\s:\-–,.]|$)/i;
const OOO_BODY = /(i am|i'm) (currently )?(out of (the )?office|away)|אני (נמצא|נמצאת)? ?(כרגע )?(מחוץ למשרד|בחופשה)|מחוץ למשרד עד|out of the office/i;
const CAL_SUBJ = /^\s*(accepted|declined|tentative(ly accepted)?|canceled|cancelled|updated invitation|התקבל|התקבלה|נדחה|נדחתה|בוטל|בוטלה|אושר|אושרה|בהסתייגות)\s*:/i;
const RECEIPT_SUBJ = /^\s*(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice|delivery has failed|read:|delivered:|relayed:|not read:|נקרא:|לא נקרא:|לא ניתן למסירה|הודעה לא נמסרה)/i;
function noiseReason(m) {
  const h = m.headers || {};
  const subj = String(m.subject || '');
  if (h['list-unsubscribe']) return 'ידיעון (List-Unsubscribe)';
  if (h['x-autoreply'] || h['x-autorespond'] || (h['auto-submitted'] && !/^no$/i.test(h['auto-submitted']))) return 'מענה אוטומטי';
  if (/^(bulk|junk|auto_reply|list)$/i.test(String(h.precedence || ''))) return 'דואר המוני (Precedence)';
  if (OOO_SUBJ.test(subj) || (String(m.body || '').length < 900 && OOO_BODY.test(String(m.body || '').slice(0, 600)))) return 'מענה "מחוץ למשרד"';
  if (m.has_calendar && /^IPM\.Schedule\.Meeting\.(Resp|Notification|Canceled)/i.test(m.message_class || '')) return 'תגובת הזמנה ליומן';
  if (CAL_SUBJ.test(subj)) return 'תגובת הזמנה ליומן';
  if (RECEIPT_SUBJ.test(subj)) return 'אישור מסירה/קריאה';
  if (NOREPLY.test(addrOf(m.from) + '')) return 'שולח אוטומטי (no-reply)';
  return null;
}

function createImporter({ db, store, knowledge, chat }) {
  const q = (s) => db.prepare(s);
  const filters = require('./filters').createFilters({ db, store });
  const getImport = (id) => q('SELECT * FROM imports WHERE id=?').get(id);
  const setStats = (id, patch) => { const cur = JSON.parse(getImport(id).stats || '{}'); q('UPDATE imports SET stats=? WHERE id=?').run(JSON.stringify({ ...cur, ...patch }), id); };
  const setStatus = (id, status) => q('UPDATE imports SET status=?, finished_at=CASE WHEN ?=\'done\' THEN ? ELSE finished_at END WHERE id=?').run(status, status, now(), id);

  const ownerAddrs = () => {
    const out = new Set([String(require('./config').get().owner.work_email || '').toLowerCase()]);
    for (const x of JSON.parse(q("SELECT value FROM settings WHERE key='email_allowlist'").get()?.value || '[]')) out.add(String(x).toLowerCase());
    for (const p of store.listPeople()) if (p.role === 'owner') p.emails.forEach((e) => out.add(String(e).toLowerCase()));
    out.delete('');
    return out;
  };

  // ---- intake: decide whether a chat message is a daily import batch
  const mailFilesOf = (fileIds) => fileIds.map((id) => { try { return knowledge.getFile(id); } catch { return null; } }).filter(Boolean);
  const zipHasMail = (f) => { try { return require('child_process').execFileSync('unzip', ['-Z1', f.path], { encoding: 'utf8', timeout: 10000 }).split('\n').some((n) => MAIL_RE.test(n)); } catch { return false; } };
  function isBatch(text, fileIds) {
    const all = mailFilesOf(fileIds);
    const mail = all.filter((f) => MAIL_RE.test(f.original_name)).length, zips = all.filter((f) => /\.zip$/i.test(f.original_name) && zipHasMail(f)).length;
    const containers = all.filter((f) => f.email_id && q("SELECT 1 FROM emails WHERE id=? AND import_state='container'").get(f.email_id)).length;
    return containers >= 1 || mail >= BATCH_MIN || zips >= 1 || (TRIGGER_RE.test(String(text)) && mail >= 1);
  }
  // staged emails of ordinary chat uploads (1-3 files) go to the normal flow
  function release(fileIds) {
    for (const f of mailFilesOf(fileIds)) {
      const e = f.email_id ? q("SELECT id FROM emails WHERE id=? AND import_state='staged' AND import_id IS NULL").get(f.email_id) : null;
      if (e) { q('UPDATE emails SET import_state=NULL WHERE id=?').run(e.id); store.logEvent(store.ownerId(), 'email', e.id, 'received', 'subject', null, ''); }
    }
  }
  function releaseOrphans() { // uploads that never got a message: after 10 minutes they join the normal flow
    const cut = new Date(Date.now() - 10 * 60000).toISOString();
    // messages of a container always wait for their import (the script / chat intake adopts them), they never go to the normal flow
    for (const e of q("SELECT id FROM emails WHERE import_state='staged' AND import_id IS NULL AND container_id IS NULL AND received_at < ?").all(cut)) {
      q('UPDATE emails SET import_state=NULL WHERE id=?').run(e.id); store.logEvent(store.ownerId(), 'email', e.id, 'received', 'subject', null, '');
    }
  }
  // called from chat.sendChat for owner messages; returns the chat message (the card) or null for a normal message
  // staged messages and the messages of containers belong to the import
  function adopt(importId, emailId) {
    q("UPDATE emails SET import_id=COALESCE(import_id, ?) WHERE id=? AND import_state IN ('staged','container')").run(importId, emailId);
    q("UPDATE emails SET import_id=COALESCE(import_id, ?) WHERE container_id=? AND import_state IN ('staged','done')").run(importId, emailId); // 'done': already handled by the normal path
  }
  // one import for these files (also used to re-run containers): the row, the card, the links
  function startFromFiles(actor, files, text, { author = 'owner' } = {}) {
    const id = q('INSERT INTO imports (created_at, file_count, status, stats, file_ids, text) VALUES (?,?,?,?,?,?)').run(now(), files.length, 'staging', JSON.stringify({ total: files.length, files: files.length }), JSON.stringify(files.map((f) => f.id)), String(text || '').slice(0, 500)).lastInsertRowid;
    for (const f of files) if (f.email_id) adopt(id, f.email_id);
    const mid = q(`INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, import_id) VALUES (?,'web',?,'[]','[]',?,1,?)`).run(author, `ייבוא יומי: ${files.length} קבצים`, now(), id).lastInsertRowid;
    q('UPDATE imports SET chat_message_id=? WHERE id=?').run(mid, id);
    store.logEvent(actor, 'import', id, 'create', 'files', null, String(files.length));
    return { id, mid };
  }
  // called from chat.sendChat for owner messages; returns the chat message (the card) or null for a normal message
  function intake(actor, { text, fileIds }) {
    if (!isBatch(text, fileIds)) { release(fileIds); return null; }
    const files = mailFilesOf(fileIds).filter((f) => MAIL_RE.test(f.original_name) || /\.zip$/i.test(f.original_name));
    const { mid } = startFromFiles(actor, files, text);
    return chat.decorate(q('SELECT * FROM chat_messages WHERE id=?').get(mid));
  }

  // ---- second intake path: ONE email from the owner with many mail messages attached ("forward as attachment", Ctrl+Alt+F in classic Outlook)
  const isMailPart = (a) => /message\/rfc822/i.test(a.content_type || '') || /\.(msg|eml)$/i.test(a.filename || '') || /ms-outlook/i.test(a.content_type || '');
  const mailParts = (full) => (full.attachments || []).filter(isMailPart);
  const isBatchMail = (full) => mailParts(full).length >= BATCH_MIN;
  const quietMs = () => (process.env.MESIMOT_IMPORT_QUIET_S === undefined || process.env.MESIMOT_IMPORT_QUIET_S === '' ? 600 : +process.env.MESIMOT_IMPORT_QUIET_S) * 1000;
  const liveQuietMs = () => (process.env.MESIMOT_LIVE_QUIET_S === undefined || process.env.MESIMOT_LIVE_QUIET_S === '' ? 60 : +process.env.MESIMOT_LIVE_QUIET_S) * 1000;
  const MERGE_MS = 2 * 3600 * 1000;
  // the import this email belongs to: an open mail-path batch from the last 2 hours (collecting, or still being processed), else a new one
  function batchFor() {
    const cut = new Date(Date.now() - MERGE_MS).toISOString();
    const row = q("SELECT * FROM imports WHERE status <> 'done' AND created_at >= ? AND json_extract(stats,'$.source')='mail' ORDER BY id DESC LIMIT 1").get(cut);
    if (row) return row;
    const id = q('INSERT INTO imports (created_at, file_count, status, stats, file_ids, text) VALUES (?,?,?,?,?,?)').run(now(), 0, 'collecting', JSON.stringify({ source: 'mail', outer: 0, parts: 0, total: 0 }), '[]', 'email').lastInsertRowid;
    const mid = q("INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, import_id) VALUES ('claude','web','ייבוא יומי','[]','[]',?,1,?)").run(now(), id).lastInsertRowid;
    q('UPDATE imports SET chat_message_id=? WHERE id=?').run(mid, id);
    return getImport(id);
  }
  // ---- LIVE OUTLOOK INGEST: mail pushed by the connector joins a rolling batch. A live batch has no chat card (the owner hears only about urgent items and in the morning digest);
  // a BACKFILL batch (an older period, pushed in chunks) is one import with a card and a normal digest, and always waits behind live mail.
  function liveBatch(backfill = null) {
    const row = backfill
      ? q("SELECT * FROM imports WHERE status='collecting' AND json_extract(stats,'$.source')='outlook' AND json_extract(stats,'$.backfill')=? ORDER BY id DESC LIMIT 1").get(String(backfill))
      : q("SELECT * FROM imports WHERE status='collecting' AND json_extract(stats,'$.source')='outlook' AND json_extract(stats,'$.live')=1 ORDER BY id DESC LIMIT 1").get();
    if (row) return row;
    return db.transaction(() => {
      const st = backfill ? { source: 'outlook', backfill: String(backfill), total: 0 } : { source: 'outlook', live: 1, total: 0 };
      const id = q('INSERT INTO imports (created_at, file_count, status, stats, file_ids, text) VALUES (?,?,?,?,?,?)').run(now(), 0, 'collecting', JSON.stringify(st), '[]', backfill ? `Outlook: ${backfill}` : 'outlook-live').lastInsertRowid;
      if (backfill) { const mid = q("INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, import_id) VALUES ('claude','web',?,'[]','[]',?,1,?)").run(`ייבוא מ-Outlook: ${backfill}`, now(), id).lastInsertRowid; q('UPDATE imports SET chat_message_id=? WHERE id=?').run(mid, id); }
      return getImport(id);
    })();
  }
  function adoptLive(emailId, { backfill = null, msgid = null } = {}) {
    const imp = liveBatch(backfill);
    q("UPDATE emails SET import_id=?, msgid=COALESCE(msgid, ?) WHERE id=? AND import_state IN ('staged','parsed')").run(imp.id, msgid, emailId);
    const st = JSON.parse(getImport(imp.id).stats || '{}');
    setStats(imp.id, { parts: (st.parts || 0) + 1, last_part_at: now() });
    q('UPDATE imports SET file_count=file_count+1 WHERE id=?').run(imp.id);
    return imp.id;
  }
  // emailId: the stored outer email; prov/full: the provider and the full message (attachments are fetched here)
  async function intakeMailBatch(prov, full, emailId, log = () => {}) {
    const imp = batchFor();
    // the outer email is not a task and not noise: it only counts on the card
    q("UPDATE emails SET import_id=?, import_state='outer', processed_at=? WHERE id=?").run(imp.id, now(), emailId);
    q("UPDATE events SET processed_at=? WHERE entity='email' AND entity_id=? AND processed_at IS NULL").run(now(), emailId);
    const owner = store.ownerId(); let n = 0, failed = 0;
    const parts = mailParts(full);
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      try {
        const buffer = await prov.attachment(full.message_id, a.attachment_id ?? i);
        const name = MAIL_RE.test(a.filename || '') ? a.filename : `${emailId}-part${i + 1}.eml`;
        const f = await knowledge.saveUpload(owner, { name, mime: 'message/rfc822', buffer, source: 'email', quiet: true, stage: true });
        const em = f.email_id && f.email_id !== emailId ? f.email_id : null; // the parsed message (the saved file is its source)
        if (em) { q("UPDATE emails SET import_id=COALESCE(import_id, ?) WHERE id=? AND import_state IN ('staged','parsed')").run(imp.id, em); adopt(imp.id, em); }
        n++;
      } catch (e) { failed++; log(`import part ${i + 1} of email ${emailId} failed: ${e.message}`); }
    }
    const st = JSON.parse(getImport(imp.id).stats || '{}');
    setStats(imp.id, { outer: (st.outer || 0) + 1, parts: (st.parts || 0) + n, parts_failed: (st.parts_failed || 0) + failed, last_part_at: now() });
    q('UPDATE imports SET file_count=? WHERE id=?').run((st.parts || 0) + n, imp.id);
    // more mail arrived while the earlier part was already being processed: wait for the quiet period again
    if (!['collecting'].includes(getImport(imp.id).status)) setStatus(imp.id, 'collecting');
    return { importId: imp.id, parts: n, failed };
  }
  // collecting batches whose last part is older than the quiet period start their pipeline
  function releaseCollecting() {
    for (const i of q("SELECT * FROM imports WHERE status='collecting'").all()) {
      const st = JSON.parse(i.stats || '{}'); const last = st.last_part_at || i.created_at;
      if (Date.now() - Date.parse(last) >= (st.live ? liveQuietMs() : quietMs())) setStatus(i.id, 'staging');
    }
  }

  // ---- staging: zips are opened, every mail file is parsed with its real headers
  async function stage(importId) {
    const imp = getImport(importId);
    const ids = JSON.parse(imp.file_ids);
    const actor = store.ownerId();
    for (const fid of ids) {
      const f = q('SELECT * FROM files WHERE id=?').get(fid);
      if (!f || !/\.zip$/i.test(f.original_name)) continue;
      try {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(fs.readFileSync(f.path));
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir || !MAIL_RE.test(name)) continue;
          const buffer = await entry.async('nodebuffer');
          const up = await knowledge.saveUpload(actor, { name: path.basename(name), mime: 'message/rfc822', buffer, source: 'web', quiet: true });
          const row = up.id ? q('SELECT email_id FROM files WHERE id=?').get(up.id) : null;
          if (row?.email_id) q("UPDATE emails SET import_id=? WHERE id=? AND import_state='staged'").run(importId, row.email_id);
        }
      } catch (e) { setStats(importId, { zip_errors: ((JSON.parse(getImport(importId).stats).zip_errors) || 0) + 1 }); }
    }
    const mine = q("SELECT id, file_id FROM emails WHERE import_id=? AND import_state='staged' ORDER BY id").all(importId);
    const { parseMailFile } = require('./mailfile');
    const owners = ownerAddrs();
    let parsed = 0, failed = 0, calendarMade = 0;
    for (const e of mine) {
      try {
        const f = q('SELECT path, original_name FROM files WHERE id=?').get(e.file_id);
        const m = await parseMailFile(fs.readFileSync(f.path), f.original_name);
        const from = addrOf(m.from_addr || m.from);
        const ing = q('SELECT folder, at FROM ingest_mail WHERE email_id=? LIMIT 1').get(e.id); // pushed by the Outlook connector: its folder knows what the owner SENT
        const direction = owners.has(from) || (ing && /^sent/i.test(ing.folder || '')) ? 'sent' : 'received';
        const meta = threadFromHeaders({ from_name: m.from_name, from_addr: m.from_addr, to: m.to, cc: m.cc, date: m.date, subject: m.subject });
        let nr = noiseReason(m);
        if (direction === 'sent' && nr && !/יומן|מענה/.test(nr)) nr = null; // the owner's own mail is never a newsletter or a no-reply
        q(`UPDATE emails SET from_addr=?, to_addr=?, subject=?, body_text=?, forwarded_from=?, forwarded_date=?, original_subject=?, participants=?, thread=?, msgid=COALESCE(?, msgid), in_reply_to=?, refs=?, direction=?, mail_date=?,
            import_state='parsed', noise_reason=? WHERE id=?`).run(m.from, [...m.to, ...m.cc.map((c) => 'cc: ' + c)].join(', '), m.subject, m.body, m.from, m.date, stripSubjectPrefixes(m.subject), JSON.stringify(meta.participants), JSON.stringify(meta.thread),
          m.msgid, m.in_reply_to, JSON.stringify(m.references || []), direction, m.date || ing?.at || null, nr, e.id);
        setKeys(db, e.id);
        // a meeting invitation (text/calendar part): the calendar item is made in code and the mail needs no model
        const ics = (m.attachments || []).find((a) => /calendar/i.test(a.mime || '') || /\.ics$/i.test(a.name || ''));
        if (ics && ics.content) {
          try {
            const { method, events } = require('./ics').parse(Buffer.from(ics.content).toString('utf8'));
            if (events.length && ['REQUEST', 'PUBLISH'].includes(method)) {
              const cal = require('./calendar').createCalendar(db, store);
              for (const ev of events.slice(0, 3)) { if (ev.status === 'CANCELLED') continue; cal.addItem(store.assistantId(), { title: ev.title, start: ev.start.time ? `${ev.start.date} ${ev.start.time}` : ev.start.date, end: ev.end ? (ev.end.time ? `${ev.end.date} ${ev.end.time}` : ev.end.date) : undefined, location: ev.location || '', email: e.id }); }
              q("UPDATE emails SET noise_reason='הזמנה ליומן (נרשמה בקוד, בלי מודל)' WHERE id=?").run(e.id); calendarMade += events.length;
            }
          } catch { /* the model sees the mail instead */ }
        }
        parsed++;
      } catch { q("UPDATE emails SET import_state='failed' WHERE id=?").run(e.id); failed++; }
    }
    const total = q("SELECT COUNT(*) c FROM emails WHERE import_id=? AND import_state NOT IN ('outer','container')").get(importId).c;
    setStats(importId, { total, parsed, failed, calendar_items: calendarMade });
    q('UPDATE imports SET file_count=? WHERE id=?').run(total, importId);
    setStatus(importId, 'parsed');
  }

  // ---- dedupe: Message-ID against everything stored, then sender + minute + normalized subject (a forwarded copy has another Message-ID)
  function dedupe(importId) {
    let dup = 0;
    const seenInBatch = new Map(); const seenKey = new Map();
    const key = (from, date, subject) => `${addrOf(from)}|${minute(date)}|${normalizeSubject(subject)}`;
    // keys of everything stored before this import
    const stored = new Map(), storedIds = new Map();
    for (const r of q('SELECT id, msgid, message_id, forwarded_from, from_addr, forwarded_date, received_at, original_subject, subject FROM emails WHERE COALESCE(import_id,0) <> ? OR import_id IS NULL').all(importId)) {
      if (r.msgid) storedIds.set(r.msgid, r.id);
      const mm = /^<?(.+?)>?$/.exec(r.message_id || ''); if (mm && !String(r.message_id).startsWith('upload:')) storedIds.set(mm[1].toLowerCase(), r.id);
      stored.set(key(r.forwarded_from || r.from_addr, r.forwarded_date || r.received_at, r.original_subject || r.subject), r.id);
    }
    for (const e of q("SELECT * FROM emails WHERE import_id=? AND import_state='parsed' ORDER BY id").all(importId)) {
      const k = key(e.forwarded_from || e.from_addr, e.mail_date, e.subject);
      const hit = (e.msgid && (storedIds.get(e.msgid) || seenInBatch.get(e.msgid))) || stored.get(k) || seenKey.get(k);
      if (hit && hit !== e.id) { q("UPDATE emails SET import_state='dup', dup_of=?, processed_at=? WHERE id=?").run(hit, now(), e.id); dup++; continue; }
      if (e.msgid) seenInBatch.set(e.msgid, e.id); seenKey.set(k, e.id);
    }
    setStats(importId, { dup });
  }

  // the owner's own rules first (a "relevant" rule even rescues a mail that the code noise filter would drop), then the code noise filter
  function applyNoise(importId) {
    let skipped = 0, fyi = 0, rescued = 0;
    for (const e of q("SELECT id FROM emails WHERE import_id=? AND import_state='parsed'").all(importId)) {
      const m = filters.apply(e.id); if (!m) continue;
      if (m.action === 'skip') skipped++; else if (m.action === 'fyi') fyi++; else { rescued++; q('UPDATE emails SET noise_reason=NULL WHERE id=?').run(e.id); }
    }
    const rows = q("SELECT id FROM emails WHERE import_id=? AND import_state='parsed' AND noise_reason IS NOT NULL").all(importId);
    for (const r of rows) q("UPDATE emails SET import_state='noise', triage='noise', processed_at=? WHERE id=?").run(now(), r.id);
    setStats(importId, { noise_code: rows.length, filter_skipped: skipped, filter_fyi: fyi, filter_relevant: rescued });
  }

  // ---- threads: References / In-Reply-To first, thread_key as the fallback for mails with no links
  function buildThreads(importId) {
    const rows = q("SELECT id, msgid, in_reply_to, refs, thread_key, mail_date FROM emails WHERE import_id=? AND import_state='parsed' ORDER BY mail_date, id").all(importId);
    const parent = new Map(rows.map((r) => [r.id, r.id])); const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(b, a); };
    const byId = new Map(); for (const r of rows) if (r.msgid) byId.set(r.msgid, r.id);
    const linked = new Set(); const refTarget = new Map(); // message ids referenced by several mails join them even when the root is not in the batch
    for (const r of rows) {
      const ids = [r.in_reply_to, ...JSON.parse(r.refs || '[]')].filter(Boolean);
      for (const id of ids) { if (byId.has(id)) { union(r.id, byId.get(id)); linked.add(r.id); linked.add(byId.get(id)); } else { if (refTarget.has(id)) union(r.id, refTarget.get(id)); else refTarget.set(id, r.id); linked.add(r.id); } }
    }
    const byKey = new Map();
    for (const r of rows) { if (linked.has(r.id) || !r.thread_key) continue; if (byKey.has(r.thread_key)) union(r.id, byKey.get(r.thread_key)); else byKey.set(r.thread_key, r.id); }
    const groups = new Map(); for (const r of rows) { const g = find(r.id); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
    let n = q('SELECT COALESCE(MAX(thread_no),0) m FROM emails WHERE import_id=?').get(importId).m;
    for (const list of [...groups.values()].sort((a, b) => String(a[0].mail_date).localeCompare(String(b[0].mail_date)))) { n++; for (const r of list) q('UPDATE emails SET thread_no=? WHERE id=?').run(n, r.id); }
    setStats(importId, { threads: n });
    return groups.size;
  }
  const threadEmails = (importId, no) => q('SELECT * FROM emails WHERE import_id=? AND thread_no=? ORDER BY mail_date, id').all(importId, no);

  // ---- triage input / output
  // a thread forced by the owner's rules: any "relevant" mail -> relevant; every mail "fyi" -> fyi (the model is not asked)
  const forcedLabel = (em) => (em.some((e) => e.filter_action === 'relevant') ? 'relevant' : em.every((e) => e.filter_action === 'fyi') ? 'fyi' : null);
  function triageItems(importId) {
    const out = [];
    const nos = q("SELECT DISTINCT thread_no FROM emails WHERE import_id=? AND thread_no IS NOT NULL AND import_state='parsed' ORDER BY thread_no").all(importId).map((r) => r.thread_no);
    for (const no of nos) {
      const em = threadEmails(importId, no); const last = em[em.length - 1];
      if (forcedLabel(em)) continue;
      out.push({ thread: no, subject: stripSubjectPrefixes(em[0].subject || ''), emails: em.length, sent_by_owner: em.some((e) => e.direction === 'sent'),
        from: [...new Set(em.map((e) => e.from_addr))].slice(0, 3).join(' ; '), attachments: q('SELECT original_name FROM files WHERE email_id IN (' + em.map((e) => e.id).join(',') + ')').all().map((f) => f.original_name).slice(0, 4), newest: String(last.body_text || '').replace(/\s+/g, ' ').slice(0, 280) });
    }
    return out;
  }
  function applyTriage(importId, labels) { // labels: { threadNo: 'relevant'|'fyi'|'noise' } ; anything missing stays relevant (never lose mail)
    let rel = 0, fyi = 0, noise = 0;
    for (const no of q("SELECT DISTINCT thread_no FROM emails WHERE import_id=? AND thread_no IS NOT NULL AND import_state='parsed'").all(importId).map((r) => r.thread_no)) {
      let l = labels[no]; if (!['relevant', 'fyi', 'noise'].includes(l)) l = 'relevant';
      const forced = forcedLabel(threadEmails(importId, no)); if (forced) l = forced;
      // an owner's own sent mail is never noise
      if (l === 'noise' && threadEmails(importId, no).some((e) => e.direction === 'sent')) l = 'fyi';
      if (l === 'noise') { q("UPDATE emails SET import_state='noise', triage='noise', noise_reason=COALESCE(noise_reason,'מיון: לא רלוונטי'), processed_at=? WHERE import_id=? AND thread_no=?").run(now(), importId, no); noise++; }
      else { q('UPDATE emails SET import_state=?, triage=? WHERE import_id=? AND thread_no=?').run(l, l, importId, no); if (l === 'fyi') fyi++; else rel++; }
    }
    // contacts only for the mail that matters
    for (const e of q("SELECT participants FROM emails WHERE import_id=? AND import_state IN ('relevant','fyi')").all(importId)) { try { require('./email').ensureContacts(db, store, JSON.parse(e.participants || '[]')); } catch { /* optional */ } }
    setStats(importId, { relevant_threads: rel, fyi_threads: fyi, noise_threads: noise });
  }
  // the next unit of LLM work: a relevant thread (chronological; a thread that already failed once waits until the others are done) or up to 6 FYI threads together
  function nextWork(importId) {
    const tries = JSON.parse(getImport(importId).stats || '{}').tries || {};
    const rel = q("SELECT thread_no, MIN(mail_date) d, MIN(id) first FROM emails WHERE import_id=? AND import_state='relevant' GROUP BY thread_no").all(importId)
      .map((r) => ({ ...r, t: tries[`t${r.first}`] || 0 })).sort((a, b) => a.t - b.t || String(a.d).localeCompare(String(b.d)))[0];
    if (rel) {
      let emails = threadEmails(importId, rel.thread_no);
      // small single-mail threads travel together (up to 3 per run, one apply): the instructions and the project context are paid once
      const small = (em) => em.length === 1 && String(em[0].body_text || '').length < 3000 && !q('SELECT 1 FROM files WHERE email_id=? LIMIT 1').get(em[0].id);
      if (small(emails)) {
        const more = q("SELECT thread_no, MIN(mail_date) d, MIN(id) first FROM emails WHERE import_id=? AND import_state='relevant' AND thread_no<>? GROUP BY thread_no").all(importId, rel.thread_no)
          .map((r) => ({ ...r, t: tries[`t${r.first}`] || 0 })).filter((r) => r.t === rel.t).sort((a, b) => String(a.d).localeCompare(String(b.d)));
        for (const r of more) { if (emails.length >= 3) break; const em = threadEmails(importId, r.thread_no); if (small(em)) emails = emails.concat(em); }
      }
      return { kind: 'relevant', key: `t${rel.first}`, emails };
    }
    const fy = q("SELECT thread_no, MIN(id) first FROM emails WHERE import_id=? AND import_state='fyi' GROUP BY thread_no ORDER BY MIN(mail_date) LIMIT 6").all(importId);
    if (fy.length) return { kind: 'fyi', key: `t${fy[0].first}`, emails: fy.flatMap((r) => threadEmails(importId, r.thread_no)).slice(0, 14) };
    return null;
  }
  // a thread that failed twice is never lost and never blocks: it is parked as "review" and counted once in the digest
  const markReview = (ids) => { for (const id of ids) q("UPDATE emails SET import_state='review', processed_at=COALESCE(processed_at, ?) WHERE id=?").run(now(), id); };
  const markDone = (ids) => { for (const id of ids) q("UPDATE emails SET import_state='done', processed_at=COALESCE(processed_at, ?) WHERE id=?").run(now(), id); };

  // ---- progress (the chat card) and digest
  function progress(importId) {
    const imp = getImport(importId); if (!imp) return null;
    const c = q("SELECT import_state s, COUNT(*) n FROM emails WHERE import_id=? GROUP BY 1").all(importId); const n = (s) => c.find((x) => x.s === s)?.n || 0;
    const total = c.filter((x) => x.s !== 'outer' && x.s !== 'container').reduce((a, x) => a + x.n, 0) || imp.file_count;
    const processed = n('dup') + n('noise') + n('done') + n('failed') + n('review');
    const st = JSON.parse(imp.stats || '{}');
    return { id: importId, status: imp.status, total, processed, dup: n('dup'), noise: n('noise'), fyi: n('fyi') + q("SELECT COUNT(*) n FROM emails WHERE import_id=? AND import_state='done' AND triage='fyi'").get(importId).n, relevant: q("SELECT COUNT(*) n FROM emails WHERE import_id=? AND triage='relevant'").get(importId).n, failed: n('failed'), review: n('review'), threads: st.threads || 0, outer: st.outer || 0, parts: st.parts || 0, source: st.source || 'chat', created_at: imp.created_at, finished_at: imp.finished_at };
  }

  const site = () => require('./config').siteUrl(db);
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  function digest(importId, { since = null } = {}) {
    const p = progress(importId); const S = site();
    const runs = (since ? q('SELECT id FROM claude_runs WHERE import_id=? AND started_at >= ?').all(importId, since) : q('SELECT id FROM claude_runs WHERE import_id=?').all(importId)).map((r) => r.id); const inRuns = runs.length ? runs.join(',') : '0';
    const assistant = store.assistantId(), owner = store.ownerId();
    const created = q(`SELECT DISTINCT entity_id id FROM events WHERE entity='task' AND action='create' AND actor_id=? AND run_id IN (${inRuns})`).all(assistant).map((r) => store.getTask(r.id));
    const closed = q(`SELECT d.task_id id, d.reason, e.direction FROM decisions d LEFT JOIN emails e ON e.id=d.email_id WHERE d.action='close' AND d.run_id IN (${inRuns})`).all();
    const open = created.filter((t) => !t.status_closed);
    const waiting = open.filter((t) => t.assignee_id === owner && t.requester_id !== owner);
    const promises = open.filter((t) => t.assignee_id === owner && t.requester_id !== owner && t.due_date && t.due_date <= today() && q('SELECT 1 FROM emails WHERE id=? AND direction=\'sent\'').get(t.source_email_id));
    const waitingOthers = open.filter((t) => t.requester_id === owner && t.assignee_id && t.assignee_id !== owner);
    const qrows = q('SELECT id, text FROM import_questions WHERE import_id=? AND digested=0 ORDER BY id').all(importId); const questions = qrows.slice(0, 5); const qMore = qrows.length - questions.length;
    if (qrows.length) q('UPDATE import_questions SET digested=1 WHERE import_id=? AND digested=0').run(importId);
    // what the gate could not get fixed in the import runs: ONE aggregated line, never an attention item per email
    const openG = q(`SELECT g.code, COUNT(*) n FROM gate_log g WHERE g.outcome='accepted' AND g.run_id IN (${inRuns}) GROUP BY g.code`).all();
    const openTotal = openG.reduce((a, x) => a + x.n, 0);
    const link = (t) => `${S}/task/${t.id}`;
    const cl = (x, n) => { x = String(x || ''); return x.length > n ? x.slice(0, n).replace(/\s+\S*$/, '') + '…' : x; };
    const L = [];
    if (since) { L.push(`המשך לייבוא היומי: עובדו עכשיו שרשורים שנכשלו קודם (${q("SELECT COUNT(DISTINCT thread_no) n FROM emails WHERE import_id=? AND import_state='done' AND processed_at >= ?").get(importId, since).n} שרשורים).`); }
    else L.push(`סיכום ייבוא יומי: ${p.total} מיילים (${p.dup} כפולים, ${p.noise} רעש). ${p.relevant} רלוונטיים ב-${p.threads} שרשורים.`);
    // a batch that spans days (two weeks of mail): a line per week
    const span = q("SELECT MIN(mail_date) a, MAX(mail_date) b FROM emails WHERE import_id=? AND mail_date IS NOT NULL AND import_state NOT IN ('outer','container')").get(importId);
    if (span.a && span.b && Date.parse(span.b) - Date.parse(span.a) >= 4 * 86400000) {
      const wk = (iso) => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.toISOString().slice(0, 10); };
      const ddmm = (iso) => String(iso).slice(0, 10).split('-').reverse().slice(0, 2).join('/');
      const per = new Map();
      for (const e of q("SELECT mail_date, triage FROM emails WHERE import_id=? AND import_state NOT IN ('outer','container','dup')").all(importId)) { const k = wk(e.mail_date); const r = per.get(k) || { all: 0, rel: 0, tasks: 0 }; r.all++; if (e.triage !== 'noise') r.rel++; per.set(k, r); }
      for (const t of created) { const em = t.source_email_id && q('SELECT mail_date FROM emails WHERE id=?').get(t.source_email_id); const k = wk(em?.mail_date || t.created_at); const r = per.get(k) || { all: 0, rel: 0, tasks: 0 }; r.tasks++; per.set(k, r); }
      L.push(`טווח ${ddmm(span.a)}–${ddmm(span.b)}. לפי שבוע: ${[...per.entries()].sort().map(([k, r]) => `שבוע ${ddmm(k)}: ${r.rel}/${r.all} מיילים, ${r.tasks} משימות חדשות`).join(' · ')}`);
    }
    L.push(created.length ? `משימות חדשות (${created.length}): ${created.slice(0, 5).map((t) => `${cl(t.title, 55)} ${link(t)}`).join(' · ')}${created.length > 5 ? ` ועוד ${created.length - 5}` : ''}` : 'לא נפתחו משימות חדשות.');
    if (closed.length) L.push(`נסגרו (${closed.length}): ${closed.slice(0, 5).map((c) => { const t = store.getTask(c.id); return `${cl(t.title, 45)}${c.direction === 'sent' ? ' (לפי מייל שלך)' : ''} ${link(t)}`; }).join(' · ')}`);
    if (waiting.length) L.push(`מחכים לתשובה שלך (${waiting.length}): ${waiting.slice(0, 5).map((t) => `${t.requester || '?'}: ${cl(t.title, 45)} ${link(t)}`).join(' · ')}`);
    if (promises.length) L.push(`הבטחות שלך שפוקעות היום (${promises.length}): ${promises.slice(0, 5).map((t) => `${cl(t.title, 45)} ${link(t)}`).join(' · ')}`);
    if (waitingOthers.length) L.push(`ממתינים לאחרים (${waitingOthers.length}): ${waitingOthers.slice(0, 4).map((t) => `${t.assignee || '?'}: ${cl(t.title, 45)} ${link(t)}`).join(' · ')}`);
    const fl = q("SELECT SUM(filter_action='skip') s, SUM(filter_action='fyi') f, SUM(filter_action='relevant') r FROM emails WHERE import_id=? AND filter_action IS NOT NULL").get(importId);
    if (fl && (fl.s || fl.f)) L.push(`סוננו ${(fl.s || 0) + (fl.f || 0)} לפי כללים שלך (${fl.s || 0} דולגו, ${fl.f || 0} לידיעה בלבד${fl.r ? `, ${fl.r} סומנו תמיד-רלוונטי` : ''}).`);
    const rv = q("SELECT COUNT(DISTINCT thread_no) n FROM emails WHERE import_id=? AND import_state='review'").get(importId).n;
    if (rv) L.push(`${rv} שרשורים לא עובדו אחרי שני ניסיונות ודורשים בדיקה (מסך הפעילות).`);
    if (openTotal) L.push(`דורשים בדיקה (${openTotal}): ${openG.map((x) => `${require('./gate').CODES[x.code] || x.code} ${x.n}`).join(', ')}. הפירוט במסך הפעילות.`);
    if (questions.length) L.push(`שאלות אליך (${questions.length + qMore}): ${questions.map((x) => x.text.slice(0, 90)).join(' | ')}${qMore > 0 ? ` ועוד ${qMore}` : ''}`);
    L.push(`פירוט: כרטיס הייבוא בצ׳אט (${S}/chat).`);
    return L.slice(0, 15).join('\n');
  }
  // active learning: up to 3 yes/no questions on the least certain decisions of this import (an FYI call on a mail with attachments or a long thread; a task with a guessed due date)
  function questions(importId) {
    const out = [];
    const fyi = q(`SELECT e.id, COALESCE(e.original_subject, e.subject) subj, e.forwarded_from f, e.thread_no, (SELECT COUNT(*) FROM files WHERE email_id=e.id) nf, (SELECT COUNT(*) FROM emails x WHERE x.import_id=e.import_id AND x.thread_no=e.thread_no) nt
      FROM emails e WHERE e.import_id=? AND e.triage='fyi' AND e.import_state='done' GROUP BY e.thread_no ORDER BY (nf>0) DESC, nt DESC LIMIT 2`).all(importId);
    for (const e of fyi) out.push({ kind: 'question', target_id: 0, other_id: e.id, text: `סימנתי כ״לידיעה בלבד״ (בלי משימה): "${String(e.subj || '').slice(0, 80)}" מ-${String(e.f || '').replace(/<[^>]*>/g, '').trim() || '?'}. נכון שלא דורש פעולה?`, reason: 'כן = ההחלטה נכונה, לא = היה צריך משימה' });
    const t = q(`SELECT t.id, t.title, t.source_email_id FROM tasks t WHERE t.due_source='estimated' AND t.source_email_id IN (SELECT id FROM emails WHERE import_id=?) AND t.status_id NOT IN (SELECT id FROM statuses WHERE is_closed=1) ORDER BY t.id LIMIT 1`).get(importId);
    if (t) out.push({ kind: 'question', target_id: t.id, other_id: t.source_email_id, text: `פתחתי משימה עם תאריך יעד משוער: "${String(t.title).slice(0, 80)}". המשימה באמת נדרשת?`, reason: 'כן = נכון, לא = לא היה צריך' });
    return out.slice(0, 3);
  }
  // ---- what is urgent enough to tell the owner right away (decided in code): a boss's request, something due today or tomorrow, a direct question to the owner.
  // Everything else waits for the morning digest. Each task is announced once per reason.
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function liveUrgent(importId) {
    const owner = store.ownerId(), assistant = store.assistantId();
    const runs = q('SELECT id FROM claude_runs WHERE import_id=?').all(importId).map((r) => r.id); if (!runs.length) return [];
    const bossIds = store.listPeople().filter((p) => /הממונה/.test(p.notes || '')).map((p) => p.id);
    const t0 = today(), t1 = addDays(t0, 1); const out = [];
    const seen = (id, why) => q('SELECT 1 FROM live_urgent WHERE task_id=? AND reason=?').get(id, why);
    const mark = (id, why) => q('INSERT OR IGNORE INTO live_urgent (task_id, reason, at) VALUES (?,?,?)').run(id, why, now());
    const ids = q(`SELECT DISTINCT entity_id id FROM events WHERE entity='task' AND actor_id=? AND run_id IN (${runs.join(',')})`).all(assistant).map((r) => r.id);
    for (const id of ids) {
      let t; try { t = store.getTask(id); } catch { continue; }
      if (t.status_closed) continue;
      const mine = t.assignee_id === owner || !t.assignee_id;
      if (t.requester_id && bossIds.includes(t.requester_id) && !seen(id, 'boss')) { mark(id, 'boss'); out.push({ task: t, why: `בקשה של ${t.requester}` }); continue; }
      if (mine && t.due_date && t.due_date <= t1 && !seen(id, 'due')) { mark(id, 'due'); out.push({ task: t, why: t.due_date <= t0 ? 'יעד היום או באיחור' : 'יעד מחר' }); continue; }
      if (mine && t.requester_id && t.requester_id !== owner && !seen(id, 'question')) {
        const em = t.source_email_id && q("SELECT body_text, direction FROM emails WHERE id=?").get(t.source_email_id);
        if (em && em.direction !== 'sent' && /\?|\u061F/.test(String(em.body_text || '').slice(0, 500)) && /^(לענות|להשיב|לחזור|לאשר|לברר)/.test(t.title)) { mark(id, 'question'); out.push({ task: t, why: `שאלה מ${t.requester || ''}` }); }
      }
    }
    return out;
  }
  // ONE morning digest over the last 24 hours of live mail (07:30): counts, new tasks, closings, what waits for the owner, today's meetings
  function liveDigest(sinceIso) {
    const S = site(); const owner = store.ownerId(), assistant = store.assistantId();
    const imps = q("SELECT id FROM imports WHERE json_extract(stats,'$.live')=1 AND created_at >= ?").all(sinceIso).map((r) => r.id);
    const inImps = imps.length ? imps.join(',') : '0';
    const runs = q(`SELECT id FROM claude_runs WHERE import_id IN (${inImps}) AND started_at >= ?`).all(sinceIso).map((r) => r.id); const inRuns = runs.length ? runs.join(',') : '0';
    const c = q(`SELECT import_state s, COUNT(*) n FROM emails WHERE import_id IN (${inImps}) GROUP BY 1`).all(); const n = (s) => c.find((x) => x.s === s)?.n || 0;
    const total = c.filter((x) => !['outer', 'container'].includes(x.s)).reduce((a, x) => a + x.n, 0);
    const sent = q(`SELECT COUNT(*) n FROM emails WHERE import_id IN (${inImps}) AND direction='sent' AND import_state NOT IN ('dup')`).get().n;
    const created = q(`SELECT DISTINCT entity_id id FROM events WHERE entity='task' AND action='create' AND actor_id=? AND run_id IN (${inRuns})`).all(assistant).map((r) => { try { return store.getTask(r.id); } catch { return null; } }).filter(Boolean);
    const closed = q(`SELECT d.task_id id, e.direction FROM decisions d LEFT JOIN emails e ON e.id=d.email_id WHERE d.action='close' AND d.run_id IN (${inRuns})`).all();
    const open = created.filter((t) => !t.status_closed);
    const waiting = open.filter((t) => t.assignee_id === owner && t.requester_id !== owner);
    const review = q(`SELECT COUNT(DISTINCT thread_no) n FROM emails WHERE import_id IN (${inImps}) AND import_state='review'`).get().n;
    const qrows = q(`SELECT id, text FROM import_questions WHERE digested=0 AND created_at >= ? ORDER BY id`).all(sinceIso);
    const cl = (x, k) => { x = String(x || ''); return x.length > k ? x.slice(0, k).replace(/\s+\S*$/, '') + '…' : x; };
    const link = (t) => `${S}/task/${t.id}`;
    const L = [`בוקר טוב. מה נקלט מ-Outlook ב-24 השעות האחרונות: ${total} מיילים (${sent} ששלחת, ${n('dup')} כפולים, ${n('noise')} רעש).`];
    L.push(created.length ? `משימות חדשות (${created.length}): ${created.slice(0, 6).map((t) => `${cl(t.title, 55)} ${link(t)}`).join(' · ')}${created.length > 6 ? ` ועוד ${created.length - 6}` : ''}` : 'לא נפתחו משימות חדשות.');
    if (closed.length) L.push(`נסגרו (${closed.length}): ${closed.slice(0, 5).map((x) => { try { const t = store.getTask(x.id); return `${cl(t.title, 45)}${x.direction === 'sent' ? ' (לפי מייל שלך)' : ''} ${link(t)}`; } catch { return ''; } }).filter(Boolean).join(' · ')}`);
    if (waiting.length) L.push(`מחכים לך (${waiting.length}): ${waiting.slice(0, 5).map((t) => `${t.requester || '?'}: ${cl(t.title, 45)} ${link(t)}`).join(' · ')}`);
    if (review) L.push(`${review} שרשורים לא עובדו ודורשים בדיקה (מסך הפעילות).`);
    // background jobs have no voice in the chat: ONE line here, the detail is in the activity screen
    const bg = q("SELECT trigger, COUNT(*) n FROM claude_runs WHERE started_at >= ? AND trigger IN ('facts-backfill','files-backfill','reconcile','curator','audit','names') GROUP BY trigger").all(sinceIso);
    if (bg.length) L.push(`עיבוד ברקע: ${bg.map((b) => `${{ 'facts-backfill': 'חילוץ נתונים ממיילים', 'files-backfill': 'קריאת קבצים', reconcile: 'בקרת משימות פתוחות', curator: 'תחזוקת זיכרון', audit: 'ביקורת איכות', names: 'תיקון שמות' }[b.trigger]} (${b.n})`).join(', ')}. הפירוט במסך הפעילות.`);
    if (qrows.length) { L.push(`שאלות אליך (${qrows.length}): ${qrows.slice(0, 5).map((x) => x.text.slice(0, 90)).join(' | ')}${qrows.length > 5 ? ` ועוד ${qrows.length - 5}` : ''}`); q('UPDATE import_questions SET digested=1 WHERE digested=0 AND created_at >= ?').run(sinceIso); }
    try {
      const day = today(); const ms = require('./calendar').createCalendar(db, store).range(day, day).filter((x) => x.kind === 'meeting');
      if (ms.length) L.push(`הפגישות שלך היום (${ms.length}): ${ms.slice(0, 8).map((m) => `${m.time || 'כל היום'} ${cl(m.title, 40)}`).join(' · ')}`);
    } catch { /* no calendar */ }
    return { text: L.join('\n'), total };
  }
  const active = () => q("SELECT * FROM imports WHERE status NOT IN ('done','collecting') ORDER BY (json_extract(stats,'$.backfill') IS NOT NULL), id LIMIT 1").get(); // live mail first, a backfill never blocks it

  return { liveBatch, adoptLive, liveUrgent, liveDigest, questions, filters, markReview, startFromFiles, adopt, intakeMailBatch, releaseCollecting, isBatchMail, mailParts, intake, release, releaseOrphans, isBatch, stage, dedupe, applyNoise, buildThreads, triageItems, applyTriage, nextWork, markDone, progress, digest, setStatus, setStats, getImport, active, noiseReason, threadEmails, ownerAddrs };
}
module.exports = { createImporter, noiseReason, MAIL_RE };
