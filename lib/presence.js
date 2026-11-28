'use strict';
// MAIL PRESENCE: deletions made in Outlook (docs/OUTLOOK-INGEST.md, "Mail presence"). Alex Link reports the ids of every mail currently in the mailbox since a moment (`since`);
// stored Outlook mail of that window that is in no listed folder (by entry id AND by internet message id) was deleted there and goes to the recycle bin (lib/trash.js, kind 'email').
// A mail found under another folder was only moved: its folder is updated. A mass disappearance (> 30% of the covered mail and at least 20) is never applied by itself:
// the owner is asked once (lib/confirm.js, "כן, העבר לסל"). Mail the bin got this way comes back by itself when it shows up again in a listed folder (restored in Outlook).
const { now } = require('./db');
const { normId } = require('./ingest');

const MIN_AGE_MS = 10 * 60000;          // a just-arrived mail is never judged
const HOLD_SHARE = 0.3, HOLD_MIN = 20;  // more than 30% of the covered mail AND at least 20: hold and ask
const MAX_MAILS = 400000;
const err = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const ts = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };

// body validation (400 with a plain message)
function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw err('body must be a JSON object');
  if (b.store !== undefined && b.store !== null && typeof b.store !== 'string') throw err('store must be a string');
  if (b.scope !== undefined && !['recent', 'full'].includes(b.scope)) throw err('scope must be "recent" or "full"');
  if (typeof b.since !== 'string' || ts(b.since) === null) throw err('since must be an ISO 8601 time');
  if (ts(b.since) > Date.now() + 5 * 60000) throw err('since is in the future');
  if (b.complete !== true) throw err('complete must be true (send nothing after an error)');
  if (!Array.isArray(b.folders)) throw err('folders must be an array');
  if (b.deleted_items !== undefined && b.deleted_items !== null && !Array.isArray(b.deleted_items)) throw err('deleted_items must be an array');
  let n = 0;
  const mailOk = (m) => m && typeof m === 'object' && (m.entry_id === undefined || m.entry_id === null || (typeof m.entry_id === 'string' && m.entry_id.length <= 2048))
    && (m.internet_message_id === undefined || m.internet_message_id === null || (typeof m.internet_message_id === 'string' && m.internet_message_id.length <= 2048)) && (m.entry_id || m.internet_message_id);
  for (const f of b.folders) {
    if (!f || typeof f !== 'object' || typeof f.folder !== 'string' || !f.folder.trim() || f.folder.length > 500) throw err('every folder needs a "folder" name');
    if (!Array.isArray(f.mails)) throw err(`folder "${f.folder.slice(0, 60)}": mails must be an array`);
    for (const m of f.mails) { if (!mailOk(m)) throw err(`folder "${f.folder.slice(0, 60)}": every mail needs entry_id or internet_message_id (strings)`); n++; }
  }
  for (const m of b.deleted_items || []) { if (!mailOk(m)) throw err('deleted_items: every mail needs entry_id or internet_message_id'); n++; }
  if (n > MAX_MAILS) throw err(`too many mails (${n} > ${MAX_MAILS})`);
}

function createPresence({ db, store, trash, confirm = null }) {
  const q = (s) => db.prepare(s);
  const chunk = (a, n = 400) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

  // ONE activity line per pass that moved something to the bin (bookkeeping: no assistant run)
  function logPass(removed, trashIds, via) {
    const t = now();
    q('INSERT INTO events (actor_id, entity, entity_id, action, field, old_value, new_value, created_at, processed_at, run_id, meta) VALUES (?,?,?,?,?,?,?,?,?,NULL,?)')
      .run(store.assistantId(), 'trash', 0, 'outlook_delete', 'count', null, `Outlook: ${removed} מיילים נמחקו ב-Outlook והועברו לסל${via ? ` (${via})` : ''}`, t, t, JSON.stringify({ trash_ids: trashIds.slice(0, 500) }));
  }
  // move these mails to the bin (one bin item per mail); mail that is gone already is skipped
  function applyGone(ids, { via = '' } = {}) {
    const trashIds = [];
    for (const id of ids) {
      if (!q('SELECT 1 FROM emails WHERE id=?').get(id)) continue;
      try { trashIds.push(trash.trashEmail(store.assistantId(), id, { summary: 'נמחק ב-Outlook' }).trash_id); } catch (e) { console.error(`presence: mail ${id} not moved to the bin: ${e.message}`); }
    }
    if (trashIds.length) logPass(trashIds.length, trashIds, via);
    return { removed: trashIds.length, trash_ids: trashIds };
  }

  function record(deviceId, detail) {
    const j = JSON.stringify(detail);
    if (deviceId) q('UPDATE connector_devices SET presence_at=?, presence_detail=? WHERE id=?').run(detail.at, j, deviceId);
    else q("INSERT INTO settings (key,value) VALUES ('presence_last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(j); // the legacy token has no device row
  }
  const openHold = () => q("SELECT * FROM confirmations WHERE kind='mail_presence' AND status='open' ORDER BY id DESC LIMIT 1").get();

  function pass(body, { deviceId = null, at = Date.now() } = {}) {
    validate(body);
    const since = ts(body.since), storeName = String(body.store || '').trim();
    // what Outlook has now (folders only: Deleted Items counts as gone)
    const byEntry = new Map(), byMid = new Map();
    for (const f of body.folders) {
      const folder = f.folder.trim();
      for (const m of f.mails) {
        if (m.entry_id && !byEntry.has(m.entry_id)) byEntry.set(m.entry_id, folder);
        const mid = normId(m.internet_message_id); if (mid && !byMid.has(mid)) byMid.set(mid, folder);
      }
    }
    // the server's Outlook mail of this store (a row without a store name is the same mailbox: early pushes did not always send one)
    const rows = q(`SELECT im.id, im.entry_id, im.internet_message_id mid, im.folder, im.at, im.created_at, im.email_id, im.presence_keep keep, e.msgid, e.message_id, COALESCE(e.mail_date, e.forwarded_date, e.received_at) edate,
        (e.archived = 0 AND e.import_id IS NOT NULL AND COALESCE(e.import_state,'') NOT IN ('done','dup','noise','failed','review','outer','container','archived')) busy
      FROM ingest_mail im JOIN emails e ON e.id = im.email_id WHERE im.gone_at IS NULL AND (? = '' OR im.store IS NULL OR im.store = ?)`).all(storeName, storeName);
    const mails = new Map();
    for (const r of rows) {
      let m = mails.get(r.email_id);
      if (!m) { m = { id: r.email_id, rows: [], mids: new Set(), date: null, created: null }; for (const x of [r.msgid, r.message_id]) { const n = normId(x); if (n && n.includes('@')) m.mids.add(n); } mails.set(r.email_id, m); }
      m.rows.push(r); if (r.keep) m.keep = true; if (r.busy) m.busy = true; const n = normId(r.mid); if (n) m.mids.add(n);
      const d = ts(r.at) ?? ts(r.edate); if (d !== null && (m.date === null || d < m.date)) m.date = d;
      const c = ts(r.created_at); if (c !== null && (m.created === null || c > m.created)) m.created = c;
    }
    let moved = 0, checked = 0; const gone = [];
    const setFolder = q('UPDATE ingest_mail SET folder=? WHERE id=?'), clearKeep = q('UPDATE ingest_mail SET presence_keep=0 WHERE email_id=?');
    const tx = db.transaction(() => {
      for (const m of mails.values()) {
        // where Outlook has it now: by entry id first, then by message id
        const hits = m.rows.filter((r) => byEntry.has(r.entry_id));
        let target = null;
        if (hits.length) { for (const r of hits) if (byEntry.get(r.entry_id) !== r.folder) { setFolder.run(byEntry.get(r.entry_id), r.id); target = target || 'moved'; } }
        else { for (const mid of m.mids) if (byMid.has(mid)) { target = byMid.get(mid); break; } if (target) { if (!m.rows.some((r) => r.folder === target)) { for (const r of m.rows) setFolder.run(target, r.id); target = 'moved'; } } }
        if (target === 'moved') moved++;
        const present = hits.length > 0 || [...m.mids].some((x) => byMid.has(x));
        // judged only inside the window and only when it is at least 10 minutes old (by its date and by when the server stored it)
        if (m.date === null || m.date < since || m.date > at - MIN_AGE_MS || (m.created !== null && m.created > at - MIN_AGE_MS)) continue;
        if (m.busy) continue; // still in the live pipeline (the assistant is reading it): judged on a later pass
        if (present && m.keep) clearKeep.run(m.id); // Outlook has it again: from now on it follows Outlook like any other mail
        if (m.keep && !present) continue; // the owner restored it on the site although it is deleted in Outlook: it stays
        checked++;
        if (!present) gone.push(m.id);
      }
    });
    tx();
    // mail this check moved to the bin that is back in a listed folder (restored in Outlook) comes back
    let restored = 0;
    const back = q('SELECT DISTINCT trash_id, entry_id, internet_message_id mid FROM ingest_mail WHERE gone_at IS NOT NULL AND trash_id IS NOT NULL AND (? = \'\' OR store IS NULL OR store = ?)').all(storeName, storeName);
    const seen = new Set();
    for (const r of back) {
      if (seen.has(r.trash_id) || !(byEntry.has(r.entry_id) || (normId(r.mid) && byMid.has(normId(r.mid))))) continue;
      seen.add(r.trash_id);
      try { const t = q("SELECT kind FROM trash WHERE id=?").get(r.trash_id); if (t && t.kind === 'email') { const x = trash.restore(store.assistantId(), r.trash_id); clearKeep.run(x.id); restored++; } } catch (e) { console.error(`presence: restore ${r.trash_id} failed: ${e.message}`); }
    }
    let removed = 0, held = false;
    const hold = openHold();
    if (gone.length >= HOLD_MIN && gone.length > HOLD_SHARE * checked) {
      held = true;
      const payload = { email_ids: gone, n: gone.length, checked, since: body.since, at: new Date(at).toISOString() };
      if (hold) q('UPDATE confirmations SET payload=? WHERE id=?').run(JSON.stringify(payload), hold.id); // the owner was told already: only the list is refreshed
      else if (confirm) { try { confirm.ask(store.assistantId(), 'mail_presence', 0, { payload, internal: require('./confirm').INTERNAL }); } catch (e) { console.error('presence: could not ask the owner:', e.message); } }
    } else {
      if (hold) q("UPDATE confirmations SET status='expired', decided_at=?, result=? WHERE id=?").run(now(), JSON.stringify({ superseded: true }), hold.id); // a normal pass since: the question is moot
      if (gone.length) removed = applyGone(gone).removed;
    }
    const out = { checked, removed, moved, held };
    if (restored) out.restored = restored;
    if (held) out.held_count = gone.length;
    record(deviceId, { at: new Date(at).toISOString(), since: body.since, scope: body.scope || 'recent', ...out, listed: byEntry.size });
    return out;
  }

  // the owner's "yes" on a held pass: the mails of the latest held pass that are still on the site go to the bin
  function applyHeld(c) {
    const p = JSON.parse(c.payload || '{}');
    const r = applyGone(Array.isArray(p.email_ids) ? p.email_ids.map(Number).filter(Boolean) : [], { via: 'באישורך' });
    return { removed: r.removed, trash_ids: r.trash_ids.slice(0, 50), title: `${r.removed} מיילים` };
  }
  const last = (deviceId = null) => {
    if (deviceId) { const d = q('SELECT presence_at, presence_detail FROM connector_devices WHERE id=?').get(deviceId); return d && d.presence_detail ? JSON.parse(d.presence_detail) : null; }
    const s = q("SELECT value FROM settings WHERE key='presence_last'").get(); return s ? JSON.parse(s.value) : null;
  };
  return { pass, applyHeld, applyGone, last, validate };
}

module.exports = { createPresence, validate, MIN_AGE_MS, HOLD_SHARE, HOLD_MIN };
