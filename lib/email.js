'use strict';
// Mail intake from the assistant's mailbox through the mail provider layer (lib/mail: agentmail or imap/Proton Bridge).
// Credentials stay in the environment or in ~/.config/...; they are never stored, logged or copied.
const { now } = require('./db');
const { parseForwarded, isForwardSubject, threadFromHeaders } = require('./forward');
const { setKeys } = require('./threads');

const WORK = require('./config').get().owner.work_email.toLowerCase();
const mail = () => require('./mail').get();
const providerOf = (db, messageId) => {
  const name = db && messageId ? db.prepare('SELECT mail_provider FROM emails WHERE message_id=?').get(messageId)?.mail_provider : null;
  return name ? require('./mail').byName(name) : mail();
};
const INBOX = () => mail().address;

const addrOf = (from) => ((/<([^>]+)>/.exec(from || '') || [])[1] || String(from || '')).trim().toLowerCase();

function dmarcPass(m) {
  const a = m.authentication_results || {};
  const d = a.dmarc;
  return (d && typeof d === 'object' ? d.result : d) === 'pass';
}

function stripHtml(h) {
  return String(h || '').replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}

// decide whether the runner should take this message (list entry from the API)
function wanted(m, allowlist) {
  const labels = m.labels || [];
  if (labels.includes('mesimot') || labels.includes('mesimot-done')) return false;
  if (!labels.includes('received')) return false;
  const from = addrOf(m.from);
  const allow = allowlist.map((x) => x.toLowerCase());
  const direct = from === WORK;
  const fwd = isForwardSubject(m.subject) && allow.includes(from);
  if (!direct && !fwd) return false;
  return dmarcPass(m);
}


// every address seen in a thread that no known person owns becomes a contact (with the address)
function ensureContacts(db, store, participants) {
  const known = new Set();
  for (const p of db.prepare('SELECT emails FROM people').all()) for (const e of JSON.parse(p.emails || '[]')) known.add(String(e).toLowerCase());
  const made = [];
  const bestName = {};
  for (const x of participants || []) { const em = (x.email || '').toLowerCase(); if (em && x.name && !bestName[em]) bestName[em] = x.name.replace(/[>\u200e\u200f]/g, '').trim(); }
  for (const x of participants || []) {
    const em = (x.email || '').toLowerCase();
    if (!em || known.has(em) || em === String(INBOX()).toLowerCase()) continue;
    known.add(em);
    const name = bestName[em] || em.split('@')[0];
    // the same person with another address: add the address to him instead of creating a duplicate
    const same = bestName[em] && store.listPeople().find((p) => p.role !== 'assistant' && [p.name_he, p.name_en].filter(Boolean).some((n) => n.toLowerCase() === name.toLowerCase()));
    if (same) { store.updatePerson(store.assistantId(), same.id, { emails: [...same.emails, em] }); continue; }
    made.push(store.createPerson(store.assistantId(), { name, role: 'contact', emails: [em] }));
  }
  return made;
}

// store one full message; returns the new email id (or the existing one)
function ingestMessage(db, store, msg, providerName = null) {
  const existing = db.prepare('SELECT id FROM emails WHERE message_id=?').get(msg.message_id);
  if (existing) return { id: existing.id, created: false };
  const body = msg.text && msg.text.trim() ? msg.text : stripHtml(msg.html || msg.extracted_html || '');
  const parsed = parseForwarded(body, msg.subject);
  const atts = (msg.attachments || []).map((a) => ({ filename: a.filename, content_type: a.content_type, size: a.size, attachment_id: a.attachment_id }));
  const t = now();
  const toList = Array.isArray(msg.to) ? msg.to : (msg.to ? [msg.to] : []);
  const meta = parsed.forwarded ? { thread: parsed.thread, participants: parsed.participants }
    : threadFromHeaders({ from: msg.from, to: toList, date: msg.timestamp || msg.created_at || t, subject: msg.subject });
  const id = db.transaction(() => {
    const id = db.prepare(`INSERT INTO emails (message_id, from_addr, to_addr, subject, received_at, body_text, forwarded_from, attachments, forwarded_date, original_subject, labels, participants, thread)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      msg.message_id, msg.from || null, Array.isArray(msg.to) ? msg.to.join(', ') : (msg.to || null), msg.subject || null,
      msg.timestamp || msg.created_at || t, body,
      parsed.forwarded ? parsed.from : (msg.from || null),
      JSON.stringify(atts), parsed.forwarded ? parsed.date : (msg.timestamp || t), parsed.subject || null, JSON.stringify(msg.labels || []),
      JSON.stringify(meta.participants), JSON.stringify(meta.thread),
    ).lastInsertRowid;
    store.logEvent(null, 'email', id, 'received', 'subject', null, msg.subject || '');
    return id;
  })();
  if (providerName) db.prepare('UPDATE emails SET mail_provider=? WHERE id=?').run(providerName, id);
  setKeys(db, id);
  ensureContacts(db, store, meta.participants);
  return { id, created: true, parsed };
}

// signature images and tiny inline pictures are not worth storing
function skipAttachment(a) {
  const img = /^image\//i.test(a.content_type || '') || /\.(png|jpe?g|gif|bmp)$/i.test(a.filename || '');
  if (!img) return false;
  if (/^image\d{1,4}\.(png|jpe?g|gif)$/i.test(a.filename || '')) return true;
  return (a.size || 0) < 30 * 1024 && !!(a.inline || a.content_id);
}

// download every real attachment of a stored email and run it through the file pipeline (text, OCR, chunks, nested mail)
async function downloadAttachments(db, store, knowledge, emailId, msg, log = () => {}, prov = null) {
  const saved = [];
  const meta = [];
  for (const a of msg.attachments || []) {
    const m = { filename: a.filename, content_type: a.content_type, size: a.size };
    if (skipAttachment(a)) { meta.push({ ...m, skipped: 'inline' }); continue; }
    if (!a.attachment_id) { meta.push(m); continue; }
    try {
      const buffer = await (prov || mail()).attachment(msg.message_id, a.attachment_id);
      const f = await knowledge.saveUpload(store.assistantId(), { name: a.filename || 'attachment', mime: a.content_type, buffer, source: 'email', email_id: emailId, quiet: true });
      saved.push(f); meta.push({ ...m, file_id: f.id, text_status: f.text_status });
    } catch (e) { log(`attachment ${a.filename} of email ${emailId} failed: ${e.message}`); meta.push({ ...m, error: e.message }); }
  }
  if (meta.length) db.prepare('UPDATE emails SET attachments=? WHERE id=?').run(JSON.stringify(meta), emailId);
  return saved;
}

async function fetchMessage(messageId, db = null) { return providerOf(db, messageId).fetch(messageId); }

async function pollOnce(db, store, log = () => {}, knowledge = null) {
  const allow = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='email_allowlist'").get()?.value || '[]');
  const known = new Set(db.prepare('SELECT message_id FROM emails').all().map((r) => r.message_id));
  const taken = [];
  let primaryError = null;
  // the primary provider and, for a limited time, the old one as intake-only fallback
  for (const prov of require('./mail').all()) {
    try {
      const list = (await prov.listNew({ known })) || [];
      for (const m of list) {
        if (!wanted(m, allow)) continue;
        const full = await prov.fetch(m.message_id);
        full.authentication_results = full.authentication_results || m.authentication_results;
        const r = ingestMessage(db, store, full, prov.name);
        if (r.created && knowledge) await downloadAttachments(db, store, knowledge, r.id, full, log, prov);
        await prov.addLabel(m.message_id, 'mesimot');
        taken.push(r.id);
        log(`email ${r.id} taken (${prov.name}): ${m.subject}`);
      }
    } catch (e) {
      if (prov === require('./mail').get()) primaryError = e; else log(`fallback mail provider ${prov.name} failed: ${e.message}`);
    }
  }
  if (primaryError) throw primaryError;
  return taken;
}

// the only outgoing mail of the system: a short digest to the owner. Any other recipient is refused.
async function sendOwnerEmail(db, { to, subject, text }) {
  const owner = new Set();
  for (const r of db.prepare("SELECT emails FROM people WHERE role='owner'").all()) for (const e of JSON.parse(r.emails || '[]')) owner.add(e.toLowerCase());
  if (!owner.has(String(to).toLowerCase())) throw new Error('refusing to send mail to an address that is not the owner');
  return mail().send({ to, subject, text });
}

async function markDone(messageId, db = null) {
  if (!messageId || /^(fixture|upload):/.test(messageId)) return;
  await providerOf(db, messageId).markDone(messageId);
}

module.exports = { mail, INBOX, sendOwnerEmail, downloadAttachments, fetchMessage, skipAttachment, ensureContacts, pollOnce, ingestMessage, markDone, wanted, addrOf, stripHtml };
