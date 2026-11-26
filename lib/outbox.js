'use strict';
// OUTBOUND EMAIL. The rule, enforced here in code: NOTHING is sent without the owner's explicit approval of the EXACT content.
//  * The assistant (token / CLI / apply) can only create and modify drafts. Approval is a separate function that only the owner's web session (cookie) or his bound Telegram chat reaches.
//  * Approval is bound to content_hash: sha256 of a canonical JSON of everything that affects what is sent. Any edit changes the hash, resets the status to pending and clears the approval.
//  * On approval the server signs "mesimot-outbox-v1|<id>|<content_hash>|<approved_at>" with an HMAC key kept in a file outside the agent's reach; the connector on the owner's PC verifies it.
//  * The connector claims an item (so it is sent once) and reports the result. Only that result marks a mail "sent".
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { now } = require('./db');
const { bad, missing } = require('./store');

const KEY_FILE = () => process.env.MESIMOT_OUTBOX_KEY_FILE || path.join(os.homedir(), '.config', 'mesimot', 'outbox-sign.key');
const EMAIL_RE = /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+\.[^\s@<>(),;:"\[\]\\]{2,}$/;
const TTL_MS = 24 * 3600000;
const KINDS = ['new', 'reply', 'reply_all', 'forward'];
const STATUSES = ['draft', 'pending', 'approved', 'sending', 'sent', 'failed', 'cancelled', 'expired'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// canonical JSON: sorted keys, no whitespace, raw UTF-8 (the connector recomputes it exactly)
const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// RTL-aware HTML made by code from the plain text (so the card shows exactly what the HTML says): one paragraph per block, direction decided per paragraph
const toHtml = (text) => `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${String(text).split(/\n{2,}/).map((p) => `<p dir="auto" style="margin:0 0 10px 0">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;

function parseAddr(x) {
  if (x && typeof x === 'object') return { name: String(x.name || '').trim(), email: String(x.email || '').trim().toLowerCase() };
  const s = String(x || '').trim(); const m = /^(.*?)<\s*([^<>]+?)\s*>$/.exec(s) || /^(.*?)\(\s*([^()\s]+@[^()\s]+)\s*\)$/.exec(s); // "Name <a@b>" or "Name (a@b)" (the assistant's shell rules forbid < and >)
  return m ? { name: m[1].replace(/^["'\s]+|["'\s]+$/g, ''), email: m[2].trim().toLowerCase() } : { name: '', email: s.toLowerCase() };
}
// "A, B" <a@b>; c@d : separators outside quotes and angle brackets
function splitList(str) { const out = []; let cur = '', q = false, ang = false; for (const ch of str) { if (ch === '"') q = !q; else if (!q && ch === '<') ang = true; else if (!q && ch === '>') ang = false; if (!q && !ang && /[;,\n]/.test(ch)) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out.filter(Boolean); }
function recipients(v, label) {
  const raw = Array.isArray(v) ? v : splitList(String(v ?? ''));
  const out = []; const seen = new Set();
  for (const x of raw) { const a = parseAddr(x); if (!a.email) continue; if (!EMAIL_RE.test(a.email)) throw bad(`כתובת לא תקינה ב-${label}: ${a.email}`); if (!seen.has(a.email)) { seen.add(a.email); out.push(a); } }
  return out;
}

function createOutbox({ db, store, keyFile = KEY_FILE, onSent = null }) {
  const q = (s) => db.prepare(s);
  const cfg = () => require('./config').get();
  const getSet = (k, d = null) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
  const setSet = (k, v) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const owner = () => store.ownerId();
  const fromAddr = () => String(cfg().owner.work_email || '').trim().toLowerCase();

  // ---- the signing key: a file outside agent/ and files/, mode 600, created on first use. It is never put in the environment (the agent inherits it) and never served.
  function key() {
    const f = typeof keyFile === 'function' ? keyFile() : keyFile;
    try { const k = fs.readFileSync(f, 'utf8').trim(); if (k.length >= 32) return k; } catch { /* create */ }
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const k = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, k + '\n', { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch { /* ignore */ }
    return k;
  }
  const sigString = (id, hash, approvedAt) => `mesimot-outbox-v1|${id}|${hash}|${approvedAt}`;
  const sign = (id, hash, approvedAt) => crypto.createHmac('sha256', key()).update(sigString(id, hash, approvedAt)).digest('hex');

  // ---- settings: the kill switch ships OFF; only the owner's web session turns it on
  const enabled = () => getSet('outbox_enabled', '0') === '1';
  const cap = () => Math.max(1, +getSet('outbox_daily_cap', '20') || 20);
  const jerusalemDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));
  const sentToday = () => { const d = jerusalemDay(now()); return q("SELECT claimed_at, sent_at FROM outbox WHERE status IN ('sending','sent') AND claimed_at IS NOT NULL").all().filter((r) => jerusalemDay(r.claimed_at) === d).length; };
  function setSettings(b) {
    if (b.enabled !== undefined) { setSet('outbox_enabled', b.enabled ? '1' : '0'); log(owner(), 0, 'setting', 'enabled', null, b.enabled ? 'on' : 'off'); }
    if (b.daily_cap !== undefined) { const v = Math.floor(+b.daily_cap); if (!(v >= 1 && v <= 500)) throw bad('המגבלה היומית חייבת להיות בין 1 ל-500'); setSet('outbox_daily_cap', v); log(owner(), 0, 'setting', 'daily_cap', null, String(v)); }
    return settings();
  }
  const settings = () => ({ enabled: enabled(), daily_cap: cap(), sent_today: sentToday(), from: fromAddr(), signature_set: !!String(cfg().outbox.signature || '').trim() });

  function log(actor, id, action, field = null, oldV = null, newV = null, meta = null) { try { store.logEvent(actor, 'outbox', id, action, field, oldV, newV, meta); } catch { /* the log must never break a send path */ } }

  // ---- the content that is sent (and hashed)
  function attachmentsOf(ids) {
    const out = [];
    for (const raw of Array.isArray(ids) ? ids : String(ids ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const f = q('SELECT id, original_name, path, size, sha256 FROM files WHERE id=?').get(+raw); if (!f) throw bad(`קובץ ${raw} לא נמצא`);
      let h = f.sha256; if (!h) { try { h = sha(fs.readFileSync(f.path)); q('UPDATE files SET sha256=? WHERE id=?').run(h, f.id); } catch { throw bad(`אי אפשר לקרוא את הקובץ ${f.original_name}`); } }
      out.push({ file_id: f.id, name: f.original_name, size: f.size || 0, sha256: h });
    }
    return out;
  }
  const effectiveText = (r) => { const sig = String(cfg().outbox.signature || '').trim(); return sig ? `${r.body_text}\n\n${sig}` : r.body_text; };
  // exactly what the connector must reproduce
  function payloadOf(r) {
    const text = effectiveText(r);
    return { kind: r.kind, from: fromAddr(), to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, body_text: text, body_html: toHtml(text),
      attachments: JSON.parse(r.attachments_json).map((a) => ({ name: a.name, sha256: a.sha256, size: a.size })), orig_entry_id: r.orig_entry_id || null, orig_internet_message_id: r.orig_internet_message_id || null };
  }
  const hashOf = (r) => sha(canon(payloadOf(r)));
  const getRow = (id) => { const r = q('SELECT * FROM outbox WHERE id=?').get(id); if (!r) throw missing('הטיוטה לא נמצאה'); return r; };

  // ---- a reply knows its original
  function originOf(emailId) {
    if (!emailId) return null;
    const e = q('SELECT id, COALESCE(original_subject, subject) subject, COALESCE(forwarded_from, from_addr) sender, COALESCE(forwarded_date, mail_date, received_at) date, from_addr, to_addr, msgid, message_id FROM emails WHERE id=?').get(+emailId);
    if (!e) throw bad('המייל המקורי לא נמצא');
    const ing = q("SELECT entry_id, internet_message_id FROM ingest_mail WHERE email_id=? AND entry_id IS NOT NULL ORDER BY (status='stored') DESC, id DESC LIMIT 1").get(e.id); // a re-push or a duplicate row also knows the Outlook entry id
    return { ...e, entry_id: ing?.entry_id || null, internet_message_id: String(ing?.internet_message_id || e.msgid || '').replace(/^<|>$/g, '').toLowerCase() || null };
  }
  const origRecipients = (e, all) => {
    const mine = new Set([fromAddr(), ...store.listPeople().filter((p) => p.role === 'owner').flatMap((p) => p.emails.map((x) => String(x).toLowerCase()))]);
    const entries = String(e.to_addr || '').split(/,\s*/).filter(Boolean).map((x) => ({ cc: /^cc:/i.test(x), a: parseAddr(x.replace(/^cc:\s*/i, '')) })).filter((x) => x.a.email && !mine.has(x.a.email));
    const from = parseAddr(e.from_addr || e.sender);
    const seen = new Set([...(from.email ? [from.email] : [])]);
    const take = (list) => list.filter((a) => !seen.has(a.email) && seen.add(a.email));
    const to = from.email && !mine.has(from.email) ? [from] : [];
    return all ? { to: [...to, ...take(entries.filter((x) => !x.cc).map((x) => x.a))], cc: take(entries.filter((x) => x.cc).map((x) => x.a)) } : { to, cc: [] };
  };

  // ---- drafts (the only thing the assistant can do)
  function fields(b, cur = null) {
    const kind = b.kind ?? cur?.kind ?? 'new'; if (!KINDS.includes(kind)) throw bad(`סוג לא מוכר: ${kind}. האפשרויות: ${KINDS.join(', ')}`);
    const replyId = b.reply_to_email_id ?? b.reply_email ?? b.reply ?? cur?.reply_to_email_id ?? null;
    const orig = replyId ? originOf(replyId) : null;
    if ((kind === 'reply' || kind === 'reply_all') && !orig) throw bad('תשובה דורשת reply_email: מזהה המייל המקורי');
    let to = b.to !== undefined ? recipients(b.to, 'אל') : (cur ? JSON.parse(cur.to_json) : null);
    let cc = b.cc !== undefined ? recipients(b.cc, 'עותק') : (cur ? JSON.parse(cur.cc_json) : null);
    const bcc = b.bcc !== undefined ? recipients(b.bcc, 'עותק מוסתר') : (cur ? JSON.parse(cur.bcc_json) : []);
    if (!cur && orig && (kind === 'reply' || kind === 'reply_all')) { const d = origRecipients(orig, kind === 'reply_all'); if (to === null || (b.to === undefined)) to = d.to; if (cc === null || b.cc === undefined) cc = d.cc; }
    to ||= []; cc ||= [];
    let subject = String(b.subject ?? cur?.subject ?? '').trim();
    if (!subject && orig) subject = orig.subject || '';
    if (orig && kind !== 'new' && b.subject === undefined && !cur) subject = (kind === 'forward' ? 'FW: ' : 'RE: ') + String(orig.subject || '').replace(/^(re|fw|fwd)\s*:\s*/i, '');
    const body = String(b.body ?? b.body_text ?? b.text ?? cur?.body_text ?? '').replace(/\r\n/g, '\n');
    const atts = b.attachments !== undefined || b.attach !== undefined ? attachmentsOf(b.attachments ?? b.attach) : (cur ? JSON.parse(cur.attachments_json) : []);
    const task = b.task_id !== undefined || b.task !== undefined ? (b.task_id ?? b.task ? store.getTask(+(b.task_id ?? b.task)).id : null) : (cur?.task_id ?? null);
    return { kind, to, cc, bcc, subject, body, atts, replyId: replyId ? +replyId : null, orig, task };
  }
  function validate(f) {
    if (!fromAddr()) throw bad('לא הוגדר מייל עבודה לבעלים (owner.work_email), אין מאיזו כתובת לשלוח');
    if (!f.to.length) throw bad('חסר נמען באל');
    if (!f.subject) throw bad('חסר נושא');
    if (!String(f.body).trim()) throw bad('גוף המייל ריק');
    if (f.to.length + f.cc.length + f.bcc.length > 50) throw bad('יותר מדי נמענים (עד 50)');
    if (f.body.length > 100000) throw bad('גוף המייל ארוך מדי');
  }
  function create(actor, b, { submit = true } = {}) {
    const f = fields(b); validate(f);
    const t = now();
    const id = q(`INSERT INTO outbox (kind, to_json, cc_json, bcc_json, subject, body_text, body_html, attachments_json, reply_to_email_id, orig_entry_id, orig_internet_message_id, task_id, status, content_hash, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.kind, JSON.stringify(f.to), JSON.stringify(f.cc), JSON.stringify(f.bcc), f.subject, f.body, '', JSON.stringify(f.atts), f.replyId, f.orig?.entry_id || null, f.orig?.internet_message_id || null, f.task, 'draft', '', actor, t, t).lastInsertRowid;
    const row = refresh(id); log(actor, id, 'create', 'subject', null, f.subject.slice(0, 120));
    if (submit !== false && b.submit !== false) return submitDraft(actor, id);
    return view(getRow(id));
  }
  // recompute html + hash from the fields
  function refresh(id) { const r = getRow(id); const html = toHtml(effectiveText(r)); const h = hashOf(r); q('UPDATE outbox SET body_html=?, content_hash=? WHERE id=?').run(html, h, id); return getRow(id); }
  function update(actor, id, b) {
    expire(); const cur = getRow(id);
    if (['sending', 'sent'].includes(cur.status)) throw bad(cur.status === 'sent' ? 'המייל כבר נשלח' : 'המייל נמצא בשליחה, אי אפשר לשנות');
    if (cur.status === 'cancelled') throw bad('הטיוטה בוטלה');
    const f = fields(b, cur); validate(f);
    const before = cur.content_hash;
    q(`UPDATE outbox SET kind=?, to_json=?, cc_json=?, bcc_json=?, subject=?, body_text=?, attachments_json=?, reply_to_email_id=?, orig_entry_id=?, orig_internet_message_id=?, task_id=?, updated_at=? WHERE id=?`)
      .run(f.kind, JSON.stringify(f.to), JSON.stringify(f.cc), JSON.stringify(f.bcc), f.subject, f.body, JSON.stringify(f.atts), f.replyId, f.orig ? (f.orig.entry_id || null) : cur.orig_entry_id, f.orig ? (f.orig.internet_message_id || null) : cur.orig_internet_message_id, f.task, now(), id);
    const r = refresh(id);
    if (r.content_hash === before && ['draft', 'pending', 'approved'].includes(cur.status)) return view(r); // nothing that affects the mail changed: the approval stays
    // ANY change after approval (or after a card was shown) resets: status pending, approval cleared, a new card
    q("UPDATE outbox SET approved_at=NULL, approved_via=NULL, approved_hash=NULL, approval_sig=NULL, claimed_at=NULL, error=NULL, status=?, submitted_at=? WHERE id=?").run(cur.status === 'draft' ? 'draft' : 'pending', cur.status === 'draft' ? null : now(), id);
    log(actor, id, 'update', 'content_hash', before.slice(0, 12), r.content_hash.slice(0, 12), { was: cur.status });
    if (cur.status !== 'draft') postCard(id);
    return view(getRow(id));
  }
  function submitDraft(actor, id) {
    expire(); const r = getRow(id);
    if (r.status !== 'draft') return view(r);
    validate({ to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, body: r.body_text });
    q("UPDATE outbox SET status='pending', submitted_at=? WHERE id=?").run(now(), id);
    log(actor, id, 'submit', 'status', 'draft', 'pending');
    postCard(id);
    return view(getRow(id));
  }
  // a failed (or expired) mail is re-sent as a NEW draft with a NEW card and a fresh approval: nothing is approved here, the connector never retries the old id
  function resend(actor, id) {
    expire(); const r = getRow(id);
    if (!['failed', 'expired'].includes(r.status)) throw bad(`אפשר לשלוח שוב רק מייל שנכשל או שפג תוקפו (המצב הנוכחי: ${r.status})`);
    if (r.resent_as) throw bad(`כבר נוצרה טיוטה חדשה (#${r.resent_as})`);
    const d = create(actor, { kind: r.kind, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, body: r.body_text, attachments: JSON.parse(r.attachments_json).map((a) => a.file_id), reply_to_email_id: r.reply_to_email_id, task_id: r.task_id });
    q('UPDATE outbox SET resend_of=? WHERE id=?').run(id, d.id); q('UPDATE outbox SET resent_as=? WHERE id=?').run(d.id, id);
    log(actor, id, 'resend', 'status', r.status, `draft ${d.id}`);
    return get(d.id);
  }
  function cancel(actor, id) {
    const r = getRow(id);
    if (['sending', 'sent'].includes(r.status)) throw bad(r.status === 'sent' ? 'המייל כבר נשלח' : 'המייל נמצא בשליחה, אי אפשר לבטל');
    if (r.status === 'cancelled') return view(r);
    q("UPDATE outbox SET status='cancelled', approved_at=NULL, approved_via=NULL, approved_hash=NULL, approval_sig=NULL, updated_at=? WHERE id=?").run(now(), id);
    log(actor, id, 'cancel', 'status', r.status, 'cancelled');
    return view(getRow(id));
  }
  function expire(at = Date.now()) {
    let n = 0;
    for (const r of q("SELECT * FROM outbox WHERE status IN ('pending','approved')").all()) {
      const since = r.status === 'approved' ? r.approved_at : r.submitted_at;
      if (since && at - Date.parse(since) > TTL_MS) { q("UPDATE outbox SET status='expired', approved_at=NULL, approved_via=NULL, approved_hash=NULL, approval_sig=NULL WHERE id=?").run(r.id); log(store.assistantId(), r.id, 'expire', 'status', r.status, 'expired'); n++; }
    }
    return n;
  }

  // ---- APPROVAL: reachable only from the owner's web session (server route checks the cookie) and the owner's Telegram chat (telegram.js checks the bound chat id). Never from the CLI, apply or the token.
  function approve(ownerActor, id, shownHash, via) {
    if (ownerActor !== owner()) throw bad('רק הבעלים יכול לאשר שליחה');
    if (!['web', 'telegram'].includes(via)) throw bad('ערוץ אישור לא תקין');
    expire(); const r = getRow(id);
    if (r.status === 'approved' && String(r.approved_hash).startsWith(String(shownHash || '').toLowerCase()) && shownHash) return view(r); // a double click
    if (r.status === 'sent' || r.status === 'sending') throw bad('המייל כבר נשלח או נמצא בשליחה');
    if (r.status === 'expired') throw bad('תוקף האישור פג (24 שעות). בקשו מהעוזר טיוטה חדשה');
    if (r.status !== 'pending') throw bad(`אי אפשר לאשר טיוטה במצב "${r.status}"`);
    const cur = hashOf(r);
    if (!shownHash || cur !== r.content_hash || !cur.startsWith(String(shownHash).toLowerCase()) || String(shownHash).length < 12) throw bad('הטיוטה השתנתה, אשר שוב');
    if (!enabled()) throw bad('שליחת מיילים מושבתת. הפעילו אותה בהגדרות');
    if (sentToday() >= cap()) throw bad(`הגעת למגבלה היומית (${cap()} מיילים)`);
    validate({ to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, body: r.body_text });
    const at = now();
    q("UPDATE outbox SET status='approved', approved_at=?, approved_via=?, approved_hash=?, approval_sig=?, error=NULL WHERE id=? AND status='pending'").run(at, via, cur, sign(id, cur, at), id);
    log(ownerActor, id, 'approve', 'status', 'pending', 'approved', { via, hash: cur.slice(0, 12) });
    return view(getRow(id));
  }

  // ---- the connector
  function payloadFor(r) {
    return { id: r.id, ...payloadOf(r), content_hash: r.content_hash, approved_at: r.approved_at, approved_via: r.approved_via, approval_sig: r.approval_sig, sig_format: 'HMAC-SHA256 hex over "mesimot-outbox-v1|<id>|<content_hash>|<approved_at>"',
      attachments: JSON.parse(r.attachments_json).map((a) => ({ file_id: a.file_id, name: a.name, size: a.size, sha256: a.sha256, download: `/outbox/${r.id}/attachment/${a.file_id}` })), reply_to: r.kind === 'new' ? null : { entry_id: r.orig_entry_id || null, internet_message_id: r.orig_internet_message_id ? `<${r.orig_internet_message_id}>` : null } }; // a reply ALWAYS carries the object: the entry id when the original came through the Outlook ingest, the Message-ID whenever we know it (the connector finds the original by PR_INTERNET_MESSAGE_ID)
  }
  // integrity: the stored approval must match the content as it is NOW (a direct database edit cannot produce a sendable item)
  const intact = (r) => r.approval_sig && r.approved_hash === r.content_hash && hashOf(r) === r.content_hash && sign(r.id, r.content_hash, r.approved_at) === r.approval_sig;
  function approvedList() {
    expire();
    if (!enabled()) return { enabled: false, items: [] };
    return { enabled: true, daily_cap: cap(), sent_today: sentToday(), items: q("SELECT * FROM outbox WHERE status='approved' ORDER BY approved_at").all().filter(intact).map(payloadFor) };
  }
  function claim(id) {
    expire(); const r = getRow(id);
    const fail = (code, msg) => { const e = new Error(msg); e.status = code; throw e; };
    if (r.status !== 'approved') fail(409, `המייל במצב "${r.status}", אי אפשר לתבוע אותו`);
    if (!enabled()) fail(409, 'שליחת מיילים מושבתת');
    if (sentToday() >= cap()) fail(429, 'הגעת למגבלה היומית');
    if (!intact(r)) fail(409, 'האישור אינו תואם את התוכן');
    const res = q("UPDATE outbox SET status='sending', claimed_at=? WHERE id=? AND status='approved'").run(now(), id);
    if (!res.changes) fail(409, 'המייל כבר נתבע');
    log(store.assistantId(), id, 'claim', 'status', 'approved', 'sending');
    return payloadFor(getRow(id));
  }
  function result(id, b) {
    const r = getRow(id);
    const fail = (code, msg) => { const e = new Error(msg); e.status = code; throw e; };
    if (b.ok === true && r.status === 'sent') return { status: 'sent', duplicate: true };
    if (r.status !== 'sending') fail(409, `המייל במצב "${r.status}", לא נשלח לשליחה`);
    const to = JSON.parse(r.to_json).map((x) => x.email).join(', ');
    if (b.ok === true) {
      const at = b.sent_at ? new Date(b.sent_at).toISOString() : now();
      q("UPDATE outbox SET status='sent', sent_at=?, sent_entry_id=?, error=NULL WHERE id=?").run(at, b.sent_entry_id ? String(b.sent_entry_id) : null, id);
      log(store.assistantId(), id, 'sent', 'status', 'sending', 'sent', { entry: b.sent_entry_id || null });
      note(`נשלח: ${r.subject} → ${to}`, r);
    } else {
      const err = String(b.error || 'שגיאה לא ידועה').slice(0, 500);
      q("UPDATE outbox SET status='failed', error=? WHERE id=?").run(err, id);
      log(store.assistantId(), id, 'failed', 'error', null, err);
      note(`השליחה נכשלה, המייל לא נשלח: ${r.subject} → ${to}. ${err}`, r, true);
    }
    return { status: getRow(id).status };
  }
  function attachmentFile(id, fileId) {
    const r = getRow(id); if (!['approved', 'sending'].includes(r.status)) throw missing('אין קובץ זמין');
    const a = JSON.parse(r.attachments_json).find((x) => x.file_id === +fileId); if (!a) throw missing('הקובץ אינו חלק מהמייל');
    const f = q('SELECT path, original_name, mime FROM files WHERE id=?').get(a.file_id);
    return { path: f.path, name: f.original_name, mime: f.mime || 'application/octet-stream' };
  }

  // ---- the card in the chat (and Telegram)
  const fmtList = (l) => l.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
  const dmy = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
  function cardText(r) {
    const to = JSON.parse(r.to_json), cc = JSON.parse(r.cc_json), bcc = JSON.parse(r.bcc_json), atts = JSON.parse(r.attachments_json);
    const orig = r.reply_to_email_id ? q('SELECT COALESCE(original_subject, subject) subject, COALESCE(forwarded_from, from_addr) sender, COALESCE(forwarded_date, mail_date, received_at) date FROM emails WHERE id=?').get(r.reply_to_email_id) : null;
    const L = [`✉️ טיוטת מייל #${r.id} לאישור (${{ new: 'מייל חדש', reply: 'תשובה', reply_all: 'תשובה לכולם', forward: 'העברה' }[r.kind]})`,
      `מאת: ${fromAddr()}`, `אל: ${fmtList(to)}`, ...(cc.length ? [`עותק: ${fmtList(cc)}`] : []), ...(bcc.length ? [`עותק מוסתר: ${fmtList(bcc)}`] : []), `נושא: ${r.subject}`,
      ...(orig ? [`תשובה ל: "${orig.subject}" מאת ${String(orig.sender || '').replace(/<[^>]*>/g, '').trim()}, ${dmy(orig.date)}`] : []),
      ...(r.kind !== 'new' ? [r.orig_entry_id || r.orig_internet_message_id ? 'אופן השליחה: תשובה בשרשור המקורי' : 'אופן השליחה: יישלח כמייל חדש (המייל המקורי לא נמצא ב-Outlook)'] : []),
      ...(atts.length ? [`קבצים מצורפים: ${atts.map((a) => a.name).join(', ')}`] : []), '────────', effectiveText(r), '────────',
      `מזהה נוסח: ${r.content_hash.slice(0, 12)}. המייל לא יישלח עד שתלחץ על ✅ שלח בכרטיס הזה. "כן" שנכתב בצ׳אט אינו אישור.`];
    return L.join('\n');
  }
  function postCard(id) {
    const r = getRow(id); const t = now();
    const mid = q(`INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, kind, outbox_id, outbox_hash) VALUES ('claude','web',?,'[]',?,?,0,'outbox',?,?)`)
      .run(cardText(r), JSON.stringify(r.task_id ? [r.task_id] : []), t, id, r.content_hash).lastInsertRowid;
    return mid;
  }
  function note(text, r, withCard = false) { // a plain assistant message (to Telegram too); a failure note is a small card with the re-send button
    q(`INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, kind, outbox_id, outbox_hash) VALUES ('claude','web',?,'[]',?,?,0,NULL,?,?)`).run(text, JSON.stringify(r.task_id ? [r.task_id] : []), now(), withCard ? r.id : null, withCard ? r.content_hash : null);
    if (onSent) { try { onSent(r); } catch { /* ignore */ } }
  }

  // ---- views
  function view(r, { forAgent = true } = {}) {
    const tooLong = cardText(r).length > 3800;
    return { id: r.id, kind: r.kind, status: r.status, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), bcc: JSON.parse(r.bcc_json), subject: r.subject, body_text: r.body_text, from: fromAddr(), attachments: JSON.parse(r.attachments_json).map((a) => ({ file_id: a.file_id, name: a.name })),
      reply_to_email_id: r.reply_to_email_id, task_id: r.task_id, content_hash: r.content_hash, hash_short: r.content_hash.slice(0, 12), submitted_at: r.submitted_at, approved_at: r.approved_at, approved_via: r.approved_via, sent_at: r.sent_at, sent_entry_id: r.sent_entry_id, error: r.error,
      expires_at: r.status === 'pending' && r.submitted_at ? new Date(Date.parse(r.submitted_at) + TTL_MS).toISOString() : r.status === 'approved' && r.approved_at ? new Date(Date.parse(r.approved_at) + TTL_MS).toISOString() : null,
      resend_of: r.resend_of || null, resent_as: r.resent_as || null, reply_mode: r.kind === 'new' ? null : (r.orig_entry_id || r.orig_internet_message_id ? 'thread' : 'new_mail'), telegram_approvable: !tooLong, created_at: r.created_at, updated_at: r.updated_at, ...(forAgent ? {} : {}) };
  }
  // the card as the chat shows it: bound to the hash that was shown; "stale" when the draft changed since
  function cardView(outboxId, shownHash) {
    expire();
    const r = q('SELECT * FROM outbox WHERE id=?').get(outboxId); if (!r) return null;
    return { ...view(r), shown_hash: shownHash, stale: shownHash !== r.content_hash, enabled: enabled() };
  }
  const list = ({ status, limit = 50 } = {}) => { expire(); return q(`SELECT * FROM outbox ${status ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT ?`).all(...(status ? [status] : []), Math.min(+limit || 50, 200)).map((r) => view(r)); };
  const get = (id) => { expire(); return view(getRow(id)); };
  // the audit trail for the activity screen
  function audit(limit = 60) {
    expire();
    const rows = q('SELECT * FROM outbox ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ id: r.id, status: r.status, subject: r.subject, to: JSON.parse(r.to_json).map((x) => x.email).join(', '), created_at: r.created_at, approved_at: r.approved_at, approved_via: r.approved_via, sent_at: r.sent_at, error: r.error }));
    const events = q("SELECT e.id, e.entity_id, e.action, e.field, e.new_value, e.created_at, e.meta FROM events e WHERE e.entity='outbox' ORDER BY e.id DESC LIMIT ?").all(limit * 2);
    return { settings: settings(), items: rows, events };
  }
  return { create, update, resend, submit: submitDraft, cancel, approve, approvedList, claim, result, attachmentFile, cardView, view, list, get, audit, settings, setSettings, expire, canon, hashOf, payloadOf, sign, sigString, key, postCard, toHtml };
}
module.exports = { createOutbox, canon, EMAIL_RE, parseAddr, recipients, toHtml, TTL_MS, STATUSES };
