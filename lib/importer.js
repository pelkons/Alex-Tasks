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
    return mail >= BATCH_MIN || zips >= 1 || (TRIGGER_RE.test(String(text)) && mail >= 1);
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
    for (const e of q("SELECT id FROM emails WHERE import_state='staged' AND import_id IS NULL AND received_at < ?").all(cut)) {
      q('UPDATE emails SET import_state=NULL WHERE id=?').run(e.id); store.logEvent(store.ownerId(), 'email', e.id, 'received', 'subject', null, '');
    }
  }
  // called from chat.sendChat for owner messages; returns the chat message (the card) or null for a normal message
  function intake(actor, { text, fileIds }) {
    if (!isBatch(text, fileIds)) { release(fileIds); return null; }
    const files = mailFilesOf(fileIds).filter((f) => MAIL_RE.test(f.original_name) || /\.zip$/i.test(f.original_name));
    const id = q('INSERT INTO imports (created_at, file_count, status, stats, file_ids, text) VALUES (?,?,?,?,?,?)').run(now(), files.length, 'staging', JSON.stringify({ total: files.length, files: files.length }), JSON.stringify(files.map((f) => f.id)), String(text).slice(0, 500)).lastInsertRowid;
    for (const f of files) if (f.email_id) q("UPDATE emails SET import_id=? WHERE id=? AND import_state='staged'").run(id, f.email_id);
    const mid = q(`INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, import_id) VALUES ('owner','web',?,'[]','[]',?,1,?)`).run(`ייבוא יומי: ${files.length} קבצים`, now(), id).lastInsertRowid;
    q('UPDATE imports SET chat_message_id=? WHERE id=?').run(mid, id);
    store.logEvent(actor, 'import', id, 'create', 'files', null, String(files.length));
    return chat.decorate(q('SELECT * FROM chat_messages WHERE id=?').get(mid));
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
    let parsed = 0, failed = 0;
    for (const e of mine) {
      try {
        const f = q('SELECT path, original_name FROM files WHERE id=?').get(e.file_id);
        const m = await parseMailFile(fs.readFileSync(f.path), f.original_name);
        const from = addrOf(m.from_addr || m.from);
        const direction = owners.has(from) ? 'sent' : 'received';
        const meta = threadFromHeaders({ from_name: m.from_name, from_addr: m.from_addr, to: m.to, cc: m.cc, date: m.date, subject: m.subject });
        let nr = noiseReason(m);
        if (direction === 'sent' && nr && !/יומן|מענה/.test(nr)) nr = null; // the owner's own mail is never a newsletter or a no-reply
        q(`UPDATE emails SET from_addr=?, to_addr=?, subject=?, body_text=?, forwarded_from=?, forwarded_date=?, original_subject=?, participants=?, thread=?, msgid=?, in_reply_to=?, refs=?, direction=?, mail_date=?,
            import_state='parsed', noise_reason=? WHERE id=?`).run(m.from, [...m.to, ...m.cc.map((c) => 'cc: ' + c)].join(', '), m.subject, m.body, m.from, m.date, stripSubjectPrefixes(m.subject), JSON.stringify(meta.participants), JSON.stringify(meta.thread),
          m.msgid, m.in_reply_to, JSON.stringify(m.references || []), direction, m.date, nr, e.id);
        setKeys(db, e.id);
        try { require('./email').ensureContacts(db, store, meta.participants); } catch { /* contacts are optional here */ }
        parsed++;
      } catch { q("UPDATE emails SET import_state='failed' WHERE id=?").run(e.id); failed++; }
    }
    const total = q('SELECT COUNT(*) c FROM emails WHERE import_id=?').get(importId).c;
    setStats(importId, { total, parsed, failed });
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

  function applyNoise(importId) {
    const rows = q("SELECT id FROM emails WHERE import_id=? AND import_state='parsed' AND noise_reason IS NOT NULL").all(importId);
    for (const r of rows) q("UPDATE emails SET import_state='noise', triage='noise', processed_at=? WHERE id=?").run(now(), r.id);
    setStats(importId, { noise_code: rows.length });
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
    let n = 0;
    for (const list of [...groups.values()].sort((a, b) => String(a[0].mail_date).localeCompare(String(b[0].mail_date)))) { n++; for (const r of list) q('UPDATE emails SET thread_no=? WHERE id=?').run(n, r.id); }
    setStats(importId, { threads: n });
    return n;
  }
  const threadEmails = (importId, no) => q('SELECT * FROM emails WHERE import_id=? AND thread_no=? ORDER BY mail_date, id').all(importId, no);

  // ---- triage input / output
  function triageItems(importId) {
    const out = [];
    const nos = q("SELECT DISTINCT thread_no FROM emails WHERE import_id=? AND thread_no IS NOT NULL AND import_state='parsed' ORDER BY thread_no").all(importId).map((r) => r.thread_no);
    for (const no of nos) {
      const em = threadEmails(importId, no); const last = em[em.length - 1];
      out.push({ thread: no, subject: stripSubjectPrefixes(em[0].subject || ''), emails: em.length, sent_by_owner: em.some((e) => e.direction === 'sent'),
        from: [...new Set(em.map((e) => e.from_addr))].slice(0, 3).join(' ; '), attachments: q('SELECT original_name FROM files WHERE email_id IN (' + em.map((e) => e.id).join(',') + ')').all().map((f) => f.original_name).slice(0, 4), newest: String(last.body_text || '').replace(/\s+/g, ' ').slice(0, 280) });
    }
    return out;
  }
  function applyTriage(importId, labels) { // labels: { threadNo: 'relevant'|'fyi'|'noise' } ; anything missing stays relevant (never lose mail)
    let rel = 0, fyi = 0, noise = 0;
    for (const no of q("SELECT DISTINCT thread_no FROM emails WHERE import_id=? AND thread_no IS NOT NULL AND import_state='parsed'").all(importId).map((r) => r.thread_no)) {
      let l = labels[no]; if (!['relevant', 'fyi', 'noise'].includes(l)) l = 'relevant';
      // an owner's own sent mail is never noise
      if (l === 'noise' && threadEmails(importId, no).some((e) => e.direction === 'sent')) l = 'fyi';
      if (l === 'noise') { q("UPDATE emails SET import_state='noise', triage='noise', noise_reason=COALESCE(noise_reason,'מיון: לא רלוונטי'), processed_at=? WHERE import_id=? AND thread_no=?").run(now(), importId, no); noise++; }
      else { q('UPDATE emails SET import_state=?, triage=? WHERE import_id=? AND thread_no=?').run(l, l, importId, no); if (l === 'fyi') fyi++; else rel++; }
    }
    setStats(importId, { relevant_threads: rel, fyi_threads: fyi, noise_threads: noise });
  }
  // the next unit of LLM work: a relevant thread (chronological) or up to 6 FYI threads together
  function nextWork(importId) {
    const rel = q("SELECT thread_no FROM emails WHERE import_id=? AND import_state='relevant' GROUP BY thread_no ORDER BY MIN(mail_date) LIMIT 1").get(importId);
    if (rel) return { kind: 'relevant', emails: threadEmails(importId, rel.thread_no) };
    const fy = q("SELECT thread_no FROM emails WHERE import_id=? AND import_state='fyi' GROUP BY thread_no ORDER BY MIN(mail_date) LIMIT 6").all(importId);
    if (fy.length) return { kind: 'fyi', emails: fy.flatMap((r) => threadEmails(importId, r.thread_no)).slice(0, 14) };
    return null;
  }
  const markDone = (ids) => { for (const id of ids) q("UPDATE emails SET import_state='done', processed_at=COALESCE(processed_at, ?) WHERE id=?").run(now(), id); };

  // ---- progress (the chat card) and digest
  function progress(importId) {
    const imp = getImport(importId); if (!imp) return null;
    const c = q("SELECT import_state s, COUNT(*) n FROM emails WHERE import_id=? GROUP BY 1").all(importId); const n = (s) => c.find((x) => x.s === s)?.n || 0;
    const total = c.reduce((a, x) => a + x.n, 0) || imp.file_count;
    const processed = n('dup') + n('noise') + n('done') + n('failed');
    const st = JSON.parse(imp.stats || '{}');
    return { id: importId, status: imp.status, total, processed, dup: n('dup'), noise: n('noise'), fyi: n('fyi') + q("SELECT COUNT(*) n FROM emails WHERE import_id=? AND import_state='done' AND triage='fyi'").get(importId).n, relevant: q("SELECT COUNT(*) n FROM emails WHERE import_id=? AND triage='relevant'").get(importId).n, failed: n('failed'), threads: st.threads || 0, created_at: imp.created_at, finished_at: imp.finished_at };
  }

  const site = () => require('./config').siteUrl(db);
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  function digest(importId) {
    const p = progress(importId); const S = site();
    const runs = q('SELECT id FROM claude_runs WHERE import_id=?').all(importId).map((r) => r.id); const inRuns = runs.length ? runs.join(',') : '0';
    const assistant = store.assistantId(), owner = store.ownerId();
    const created = q(`SELECT DISTINCT entity_id id FROM events WHERE entity='task' AND action='create' AND actor_id=? AND run_id IN (${inRuns})`).all(assistant).map((r) => store.getTask(r.id));
    const closed = q(`SELECT d.task_id id, d.reason, e.direction FROM decisions d LEFT JOIN emails e ON e.id=d.email_id WHERE d.action='close' AND d.run_id IN (${inRuns})`).all();
    const open = created.filter((t) => !t.status_closed);
    const waiting = open.filter((t) => t.assignee_id === owner && t.requester_id !== owner);
    const promises = open.filter((t) => t.assignee_id === owner && t.requester_id !== owner && t.due_date && t.due_date <= today() && q('SELECT 1 FROM emails WHERE id=? AND direction=\'sent\'').get(t.source_email_id));
    const waitingOthers = open.filter((t) => t.requester_id === owner && t.assignee_id && t.assignee_id !== owner);
    const questions = q(`SELECT text FROM attention WHERE status='open' AND created_at >= ? ORDER BY id DESC LIMIT 3`).all(getImport(importId).created_at);
    const link = (t) => `${S}/task/${t.id}`;
    const cl = (x, n) => { x = String(x || ''); return x.length > n ? x.slice(0, n).replace(/\s+\S*$/, '') + '…' : x; };
    const L = [];
    L.push(`סיכום ייבוא יומי: ${p.total} מיילים (${p.dup} כפולים, ${p.noise} רעש). ${p.relevant} רלוונטיים ב-${p.threads} שרשורים.`);
    L.push(created.length ? `משימות חדשות (${created.length}): ${created.slice(0, 5).map((t) => `${cl(t.title, 55)} ${link(t)}`).join(' · ')}${created.length > 5 ? ` ועוד ${created.length - 5}` : ''}` : 'לא נפתחו משימות חדשות.');
    if (closed.length) L.push(`נסגרו (${closed.length}): ${closed.slice(0, 5).map((c) => { const t = store.getTask(c.id); return `${cl(t.title, 45)}${c.direction === 'sent' ? ' (לפי מייל שלך)' : ''} ${link(t)}`; }).join(' · ')}`);
    if (waiting.length) L.push(`מחכים לתשובה שלך (${waiting.length}): ${waiting.slice(0, 5).map((t) => `${t.requester || '?'}: ${cl(t.title, 45)} ${link(t)}`).join(' · ')}`);
    if (promises.length) L.push(`הבטחות שלך שפוקעות היום (${promises.length}): ${promises.slice(0, 5).map((t) => `${cl(t.title, 45)} ${link(t)}`).join(' · ')}`);
    if (waitingOthers.length) L.push(`ממתינים לאחרים (${waitingOthers.length}): ${waitingOthers.slice(0, 4).map((t) => `${t.assignee || '?'}: ${cl(t.title, 45)} ${link(t)}`).join(' · ')}`);
    if (questions.length) L.push(`שאלות אליך: ${questions.map((x) => x.text.slice(0, 80)).join(' | ')}`);
    L.push(`פירוט: כרטיס הייבוא בצ׳אט (${S}/chat).`);
    return L.slice(0, 15).join('\n');
  }
  const active = () => q("SELECT * FROM imports WHERE status <> 'done' ORDER BY id LIMIT 1").get();

  return { intake, release, releaseOrphans, isBatch, stage, dedupe, applyNoise, buildThreads, triageItems, applyTriage, nextWork, markDone, progress, digest, setStatus, setStats, getImport, active, noiseReason, threadEmails, ownerAddrs };
}
module.exports = { createImporter, noiseReason, MAIL_RE };
