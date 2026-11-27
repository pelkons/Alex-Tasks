'use strict';
// Daily housekeeping (code only): verified cleanup of the AgentMail mailbox, disk checks, log rotation, database maintenance.
// Files are never deleted automatically: they are the archive.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { now } = require('./db');

const ROOT = path.join(__dirname, '..');
const DAY = 86400000;
const sha256File = (p) => crypto.createHash('sha256').update(require('./vault').readFile(p)).digest('hex'); // of the content (stored files are encrypted)

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = path.join(d, e.name); try { if (e.isDirectory()) walk(p); else if (e.isFile()) total += fs.statSync(p).size; } catch { /* vanished */ } }
  };
  walk(dir);
  return total;
}

function legacyAgentMail(am, base) {
  return {
    async list() { const out = []; let token = null; for (let i = 0; i < 50; i++) { const r = await am('GET', `${base}?limit=100${token ? '&page_token=' + encodeURIComponent(token) : ''}`); out.push(...(r.messages || [])); token = r.next_page_token; if (!token) break; } return out; },
    async remove(id) { await am('DELETE', `${base}/${encodeURIComponent(id)}`); return { removed: 'deleted' }; },
    housekeepingMode: 'delete',
  };
}
function createHousekeeping(db, store, { mail, mails, am, base, notify = null, dirs = {}, log = () => {} }) {
  // `mail` is a provider (lib/mail); `mails` several (primary + fallback); the older am+base pair is wrapped into one for compatibility
  if (!mail && am) mail = legacyAgentMail(am, base);
  const providers = mails && mails.length ? mails : [mail];
  const q = (sql) => db.prepare(sql);
  const get = (k, d) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
  const set = (k, v) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const D = {
    data: dirs.data || path.join(ROOT, 'data'), files: dirs.files || process.env.MESIMOT_FILES || path.join(ROOT, 'files'), backups: dirs.backups || path.join(ROOT, 'backups'),
    models: dirs.models || path.join(ROOT, 'models'), runs: dirs.runs || process.env.MESIMOT_RUN_LOG || path.join(ROOT, 'data', 'runs'), agentTmp: dirs.agentTmp || path.join(process.env.MESIMOT_AGENT_DIR || path.join(ROOT, 'agent'), 'tmp'),
    uploads: dirs.uploads || process.env.MESIMOT_UPLOADS || path.join(ROOT, 'data', 'uploads'), botapi: dirs.botapi || process.env.TELEGRAM_LOCAL_DIR || path.join(ROOT, 'data', 'botapi'),
    voice: dirs.voice || path.join(dirs.files || process.env.MESIMOT_FILES || path.join(ROOT, 'files'), 'voice'),
  };
  const record = (action, detail) => { q('INSERT INTO housekeeping_log (at, action, detail) VALUES (?,?,?)').run(now(), action, detail); log(`housekeeping ${action}: ${detail}`); };
  const keepDays = () => Math.max(1, parseInt(get('mailbox_keep_days', '30'), 10) || 30);

  // ---- 1. mailbox: delete only what is verified to be completely stored here
  function verifyLocalCopy(msgId) {
    const e = q('SELECT * FROM emails WHERE message_id=?').get(msgId);
    if (!e) return { ok: false, why: 'no local email row' };
    if (!e.processed_at) return { ok: false, why: 'email not processed yet' };
    if (!String(e.body_text || '').trim()) return { ok: false, why: 'empty local body' };
    let atts = []; try { atts = JSON.parse(e.attachments || '[]'); } catch { return { ok: false, why: 'unreadable attachment list' }; }
    for (const a of atts) {
      if (a.skipped) continue;
      if (a.error) return { ok: false, why: `attachment ${a.filename} failed to download` };
      if (!a.file_id) return { ok: false, why: `attachment ${a.filename} was never stored` };
      const f = q('SELECT * FROM files WHERE id=?').get(a.file_id);
      if (!f || !f.path || !fs.existsSync(f.path)) return { ok: false, why: `file of ${a.filename} is missing on disk` };
      if (a.size && require('./vault').plainSize(f.path) !== a.size) return { ok: false, why: `file of ${a.filename} has a different size` };
      if (!f.sha256) return { ok: false, why: `file of ${a.filename} has no hash` };
      if (sha256File(f.path) !== f.sha256) return { ok: false, why: `file of ${a.filename} fails its hash check` };
    }
    return { ok: true };
  }

  // agentmail deletes the message; imap (the assistant's own Proton address) moves it to Trash and removes the done label (MAIL_HOUSEKEEPING=trash|labels)
  const housekeepingMode = (m) => (m.name === 'agentmail' ? 'delete' : (process.env.MAIL_HOUSEKEEPING || require('./mail').settings().MAIL_HOUSEKEEPING || m.housekeepingMode || 'labels'));
  async function cleanupOne(mail, { dryRun = false } = {}) {
    const cutoff = Date.now() - keepDays() * DAY;
    const res = { scanned: 0, candidates: 0, deleted: [], kept: [] };
    let msgs;
    try { msgs = await mail.list(); } catch (e) { record('mailbox', `could not list messages: ${e.message}`); return { ...res, error: e.message }; }
    for (const m of msgs) {
      res.scanned++;
      const labels = m.labels || [];
      // never touch what is not ours: only messages we labelled as handled, never sent mail
      if (!labels.includes('mesimot-done') || labels.includes('sent')) continue;
      if (Date.parse(m.timestamp || m.created_at) > cutoff) continue;
      res.candidates++;
      const v = verifyLocalCopy(m.message_id);
      if (!v.ok) { res.kept.push({ id: m.message_id, subject: m.subject, why: v.why }); record('mailbox-kept', `${m.subject || m.message_id}: ${v.why}`); continue; }
      if (dryRun) { res.deleted.push({ id: m.message_id, subject: m.subject, dry: true }); continue; }
      try {
        const out = await mail.remove(m.message_id, { mode: housekeepingMode(mail) });
        res.deleted.push({ id: m.message_id, subject: m.subject, how: out && out.removed });
        record('mailbox-deleted', `${m.subject || ''} (${m.message_id}) [${(out && out.removed) || 'removed'}]`);
      } catch (e) { res.kept.push({ id: m.message_id, subject: m.subject, why: e.message }); record('mailbox-error', `${m.message_id}: ${e.message}`); if (/quota|limit/i.test(e.message)) warn(`תיבת הדוא״ל של המערכת מדווחת על מכסה: ${e.message}`); }
    }
    // the assistant's own outgoing copies (the sent folder): kept 90 days by default (MAIL_SENT_RETENTION_DAYS), then Trash
    if (mail.listSent) {
      res.sent = { scanned: 0, removed: [] };
      try {
        const cutS = Date.now() - (mail.sentKeepDays || 90) * DAY;
        for (const m of await mail.listSent()) {
          res.sent.scanned++;
          if (Date.parse(m.timestamp) > cutS) continue;
          if (dryRun) { res.sent.removed.push({ id: m.message_id, dry: true }); continue; }
          const out = await mail.removeSent(m.message_id);
          if (out.removed === 'trash') { res.sent.removed.push({ id: m.message_id, how: out.removed }); record('mailbox-sent-removed', `${m.subject || ''} (${m.message_id})`); }
        }
      } catch (e) { record('mailbox-error', `sent folder: ${e.message}`); res.sent.error = e.message; }
    }
    return res;
  }

  // every configured provider (the primary and the intake-only fallback) is cleaned by its own rules
  async function mailboxCleanup(o = {}) {
    const total = { scanned: 0, candidates: 0, deleted: [], kept: [] };
    for (const m of providers) {
      const r = await cleanupOne(m, o);
      if (r.sent) total.sent = r.sent;
      total.scanned += r.scanned; total.candidates += r.candidates; total.deleted.push(...r.deleted); total.kept.push(...r.kept);
      if (r.error) total.error = (total.error ? total.error + '; ' : '') + `${m.name}: ${r.error}`;
    }
    return total;
  }

  function warn(text, urgent = false) {
    if (!q("SELECT 1 FROM attention WHERE status='open' AND text=?").get(text)) {
      q("INSERT INTO attention (kind, text, created_at) VALUES ('reminder',?,?)").run(text, now());
      if (urgent && notify) notify.enqueue({ title: 'אזהרת מערכת', body: text, urgency: 'urgent', dedupe: `warn:${text.slice(0, 40)}` });
    }
  }

  // ---- 2. disk
  const gb = (n) => (n / 1073741824).toFixed(1);
  function diskStatus() {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, free_pct: free / total * 100 };
  }
  function checkDisk() {
    const d = diskStatus();
    if (d.free_pct < 15 || d.free < 15 * 1073741824) {
      warn(`מעט מקום פנוי בשרת: נותרו ${gb(d.free)} ג״ב (${d.free_pct.toFixed(0)}%). יש לפנות מקום או להרחיב את הדיסק.`, true);
      record('disk-warning', `${gb(d.free)} GB free (${d.free_pct.toFixed(0)}%)`);
    }
    return d;
  }
  function storage() {
    const sizes = { data: dirSize(D.data), files: dirSize(D.files), backups: dirSize(D.backups), models: dirSize(D.models) };
    const disk = diskStatus();
    return { ...sizes, disk_total: disk.total, disk_free: disk.free, disk_free_pct: Math.round(disk.free_pct) };
  }

  // ---- 3. rotation
  function removeOlder(dir, days, pred = () => true) {
    let n = 0, bytes = 0;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { n, bytes }; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      try { const st = fs.statSync(p); if (e.isFile() && Date.now() - st.mtimeMs > days * DAY && pred(e.name)) { fs.unlinkSync(p); n++; bytes += st.size; } } catch { /* ignore */ }
    }
    return { n, bytes };
  }
  function removeOlderRecursive(dir, days) {
    let n = 0;
    const walk = (d) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { try { if (Date.now() - fs.statSync(p).mtimeMs > days * DAY) { fs.unlinkSync(p); n++; } } catch { /* ignore */ } }
      }
    };
    walk(dir);
    return n;
  }
  function rotate({ dryRun = false } = {}) {
    const out = {};
    if (dryRun) return out;
    out.runLogs = removeOlder(D.runs, 30); // prompts and tool calls; the claude_runs rows stay
    out.agentTmp = removeOlder(D.agentTmp, 1);
    out.voice = removeOlderRecursive(D.voice, 90); // transcripts stay in the database
    out.halfUploads = 0; // chunked uploads nobody continued
    try { for (const d of fs.readdirSync(D.uploads)) { const p = path.join(D.uploads, d); if (Date.now() - fs.statSync(p).mtimeMs > 3 * DAY) { fs.rmSync(p, { recursive: true, force: true }); out.halfUploads++; } } } catch { /* none */ }
    // files the local Bot API server downloaded for us (already copied into the archive); its own state files stay
    out.botapi = 0;
    try { for (const tokenDir of fs.readdirSync(D.botapi)) for (const sub of ['documents', 'photos', 'videos', 'voice', 'video_notes', 'audios', 'animations', 'stickers', 'temp']) { const d = path.join(D.botapi, tokenDir, sub); if (fs.existsSync(d) && fs.statSync(d).isDirectory()) out.botapi += removeOlderRecursive(d, 3); } } catch { /* no local server */ }
    for (const k of Object.keys(out)) record('rotate', `${k}: ${JSON.stringify(out[k])}`);
    return out;
  }
  function backfillHashes() {
    let n = 0;
    for (const f of q('SELECT id, path FROM files WHERE sha256 IS NULL AND path <> \'\'').all()) {
      try { if (fs.existsSync(f.path)) { q('UPDATE files SET sha256=? WHERE id=?').run(sha256File(f.path), f.id); n++; } } catch { /* ignore */ }
    }
    return n;
  }
  function maintainDb({ dryRun = false } = {}) {
    if (dryRun) return {};
    db.pragma('optimize');
    const last = +get('last_vacuum', 0);
    let vacuumed = false;
    if (Date.now() - last > 6.5 * DAY) { db.exec('VACUUM'); set('last_vacuum', Date.now()); vacuumed = true; }
    record('db', `optimize${vacuumed ? ', vacuum' : ''}`);
    return { vacuumed };
  }

  // ---- 4. archive growth, reported weekly (files are never deleted)
  function weeklyFilesReport({ dryRun = false } = {}) {
    const size = dirSize(D.files);
    const prev = JSON.parse(get('files_size_history', '[]'));
    const last = prev[prev.length - 1];
    if (last && Date.now() - last.t < 6.5 * DAY) return null;
    const growth = last ? size - last.size : null;
    if (!dryRun) {
      set('files_size_history', JSON.stringify([...prev, { t: Date.now(), size }].slice(-60)));
      warn(`ארכיון הקבצים: ${gb(size)} ג״ב${growth !== null ? ` (${growth >= 0 ? '+' : '−'}${gb(Math.abs(growth))} ג״ב מאז הבדיקה הקודמת)` : ''}. הקבצים אינם נמחקים אוטומטית.`);
      record('files-report', `${gb(size)} GB`);
    }
    return { size, growth };
  }

  // journald: keep our own (user) journal to 30 days; warn when the whole journal is large (system cap needs root).
  function journal() {
    const { spawnSync } = require('child_process');
    const out = { user_bytes: null, total_bytes: null };
    try {
      spawnSync('journalctl', ['--user', '--vacuum-time=30d'], { timeout: 30000 });
      const parse = (args) => { const r = spawnSync('journalctl', args, { encoding: 'utf8', timeout: 15000 }); const m = /take up ([\d.]+)([KMGT])/.exec(r.stdout || ''); return m ? Math.round(parseFloat(m[1]) * { K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 }[m[2]]) : null; };
      out.user_bytes = parse(['--user', '--disk-usage']); out.total_bytes = parse(['--disk-usage']);
      if (out.total_bytes && out.total_bytes > 2 * 1073741824) {
        warn(`יומן המערכת (journald) תופס ${gb(out.total_bytes)} ג״ב ואין לו הגבלה. מומלץ להגדיר SystemMaxUse (דורש הרשאת מנהל).`, false);
      }
    } catch (e) { out.error = e.message; }
    record('journal', JSON.stringify(out));
    return out;
  }
  async function run({ dryRun = false } = {}) {
    const result = { dryRun, mailbox: await mailboxCleanup({ dryRun }) };
    if (!dryRun) { result.tmp = require('./vault').sweepTmp(); result.hashes = backfillHashes(); result.disk = checkDisk(); result.rotate = rotate(); result.journal = journal(); result.db = maintainDb(); result.files = weeklyFilesReport(); }
    else { result.disk = diskStatus(); }
    return result;
  }

  return { run, mailboxCleanup, verifyLocalCopy, checkDisk, storage, rotate, journal, maintainDb, weeklyFilesReport, backfillHashes, keepDays, dirSize };
}

module.exports = { createHousekeeping, dirSize };
