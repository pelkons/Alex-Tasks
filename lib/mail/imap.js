'use strict';
// Generic IMAP + SMTP provider, built for the local Proton Mail Bridge in SPLIT address mode: the assistant has its OWN Proton address
// (e.g. assistant@proton.example) and its own IMAP account that sees only that address's mail.
//
// SCOPE, enforced in code: the provider may SELECT only two folders: the input (MAIL_IMAP_SCOPE_FOLDER, default "INBOX": the INBOX of the
// assistant's own account) and the processed marker (MAIL_IMAP_DONE_FOLDER, default "Labels/Alex-done"). Every other mailbox (All Mail, Sent,
// Trash, other labels) is refused with a ScopeError, whatever the calling code does: the raw client is wrapped (scopedClient).
//
// Processed state is a COPY into the done label (in Proton Bridge a label is a folder under Labels/; copying adds a label, the message
// stays). It never depends on \Seen. Housekeeping (MAIL_HOUSEKEEPING, default "trash" because the mailbox is the assistant's own): after the
// retention period and the verified local copy the message is copied into Trash (a copy DESTINATION only, never opened) and expunged from the
// input folder and from the done label. Mode "labels" only removes the done label.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class ScopeError extends Error { constructor(msg) { super(msg); this.name = 'ScopeError'; } }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

// a wrapper around an imapflow-like client: only the allowed folders can be opened, created or used as COPY destinations
function scopedClient(raw, { open, copyTo = [], create, rename = [] }) {
  const allowedOpen = new Set(open), allowedCopy = new Set([...open, ...copyTo]), allowedCreate = new Set(create || open);
  const refuse = (what, p) => { throw new ScopeError(`mail scope: ${what} "${p}" is not allowed (only ${[...allowedOpen].join(', ')})`); };
  return {
    async getMailboxLock(p, ...a) { if (!allowedOpen.has(p)) refuse('opening', p); return raw.getMailboxLock(p, ...a); },
    async mailboxOpen(p, ...a) { if (!allowedOpen.has(p)) refuse('opening', p); return raw.mailboxOpen(p, ...a); },
    async mailboxCreate(p) { if (!allowedCreate.has(p)) refuse('creating', p); return raw.mailboxCreate(p); },
    async mailboxRename(from, to) { if (!rename.some(([f, t]) => f === from && t === to)) refuse('renaming', `${from} -> ${to}`); return raw.mailboxRename(from, to); },
    async messageCopy(range, dest, o) { if (!allowedCopy.has(dest)) refuse('copying into', dest); return raw.messageCopy(range, dest, o); },
    get mailbox() { return raw.mailbox; },
    search: (...a) => raw.search(...a), fetch: (...a) => raw.fetch(...a), fetchOne: (...a) => raw.fetchOne(...a), download: (...a) => raw.download(...a),
    messageDelete: (...a) => raw.messageDelete(...a), noop: () => raw.noop(), logout: () => raw.logout(),
    // everything else (list, status, select, messageMove, mailboxDelete, ...) deliberately does not exist
  };
}

// The assistant's own Sent folder may be opened ONLY to find the copy of a message we just sent and COPY it into our own sent folder: the wrapper
// exposes nothing but findAndCopy(): a search by our exact Message-ID header AND our From address, then a COPY. It never lists, fetches, moves or deletes:
// on Proton "Sent" behaves like a system label (a sent message keeps showing in Sent after it is filed elsewhere), and expunging from Sent could delete
// the message entirely, so nothing is ever removed from Sent.
function sentClient(raw, { source, target, from }) {
  return {
    async findAndCopy(messageId) {
      if (!/^<[^<>\s]+>$/.test(String(messageId))) throw new ScopeError('mail scope: findAndCopy needs an exact Message-ID');
      const lock = await raw.getMailboxLock(source);
      try {
        const uids = await raw.search({ header: { 'message-id': messageId }, from }, { uid: true });
        if (!uids || !uids.length) return false;
        await raw.messageCopy(uids.map(String).join(','), target, { uid: true });
        return true;
      } finally { lock.release(); }
    },
    logout: () => raw.logout(),
  };
}

// the topmost Authentication-Results header is the one added by the receiving server; lower ones may be forged by the sender
function parseAuth(parsedOrHeaderLines) {
  const lines = parsedOrHeaderLines.filter((l) => /^authentication-results$/i.test(l.key));
  const first = lines.length ? lines[0].line.replace(/^[^:]*:\s*/, '') : '';
  const grab = (k) => (new RegExp(`\\b${k}=(\\w+)`, 'i').exec(first) || [])[1]?.toLowerCase();
  return { dmarc: grab('dmarc'), spf: grab('spf'), dkim: grab('dkim') };
}
const hdr = (lines, k) => (lines.find((l) => l.key.toLowerCase() === k) || {}).line?.replace(/^[^:]*:\s*/, '') ?? '';
const addrText = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');

function create(s, deps = {}) {
  const host = s.MAIL_IMAP_HOST || '127.0.0.1';
  const port = +(s.MAIL_IMAP_PORT || 1143);
  const smtpHost = s.MAIL_SMTP_HOST || host, smtpPort = +(s.MAIL_SMTP_PORT || 1025);
  const address = (s.MAIL_ADDRESS || s.MAIL_SMTP_USER || s.MAIL_IMAP_USER || '').toLowerCase();
  // intake folders: the INBOX (before the Proton filter exists) and the assistant's own incoming folder (after it)
  const cfg = require('../config').get();
  const parentDefault = `Folders/${(() => { try { return new URL(cfg.site_url).hostname; } catch { return 'mesimot'; } })()}`; // own folder tree, named after the site address
  const scopes = String(s.MAIL_IMAP_SCOPE_FOLDERS || s.MAIL_IMAP_SCOPE_FOLDER || `INBOX,${parentDefault}/Inbox`).split(',').map((x) => x.trim()).filter(Boolean);
  const scope = scopes[0];
  const done = s.MAIL_IMAP_DONE_FOLDER || `Labels/${cfg.assistant.name_en || 'Assistant'}-done`;
  const sentTarget = s.MAIL_IMAP_SENT_FOLDER || `${parentDefault}/Sent`;   // our outgoing mail
  const sentSource = s.MAIL_IMAP_SENT_SOURCE || 'Sent';                // where Proton first puts the copy; opened only by moveSentCopy
  // CREATE is allowed for exactly the configured own folders and their parents (plus the done label); every name comes from the configuration
  const own = [...scopes.filter((x) => x !== 'INBOX'), sentTarget];
  const folderTree = [...new Set(own.flatMap((f) => f.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')).filter((x) => x.includes('/'))))];
  const legacyParent = s.MAIL_IMAP_LEGACY_PARENT || '';  // optional: an older name of the parent folder, renamed to the new one, never deleted
  const newParent = sentTarget.split('/').slice(0, -1).join('/');
  const sentKeepDays = +(s.MAIL_SENT_RETENTION_DAYS || 90);
  const trash = s.MAIL_TRASH_FOLDER || 'Trash';
  const insecureLocal = s.MAIL_TLS_INSECURE_LOCAL === '1';
  const tlsFor = (h) => ({ rejectUnauthorized: !(insecureLocal && LOOPBACK.has(h)) }); // the self-signed Bridge certificate is accepted ONLY for loopback
  const starttls = (v, def) => (v === undefined || v === '' ? def : v === '1' || v === 'true');
  const removeAfterDone = s.MAIL_REMOVE_LABEL_AFTER_DONE === '1' && !scopes.includes('INBOX');
  const housekeeping = () => (s.MAIL_HOUSEKEEPING || 'trash').toLowerCase();
  const ownerProton = (s.MAIL_OWNER_ADDRESS || '').toLowerCase(); // the owner's own Proton address: unset = the internal-origin rule is off

  async function connect() {
    const mk = deps.makeClient || ((o) => new ImapFlow(o));
    const c = mk({ host, port, secure: s.MAIL_IMAP_SECURE === '1', doSTARTTLS: starttls(s.MAIL_IMAP_STARTTLS, true) ? true : undefined, auth: { user: s.MAIL_IMAP_USER, pass: s.MAIL_IMAP_PASS }, tls: tlsFor(host), logger: false, disableAutoIdle: true });
    await c.connect();
    return scopedClient(c, { open: [...scopes, done, sentTarget], copyTo: housekeeping() === 'trash' ? [trash] : [], create: [done, ...folderTree], rename: legacyParent ? [[legacyParent, newParent]] : [] });
  }
  // one connection, one folder, always released
  async function inFolder(folder, fn) {
    const c = await connect();
    try {
      const lock = await c.getMailboxLock(folder);
      try { return await fn(c); } finally { lock.release(); }
    } finally { await c.logout().catch(() => {}); }
  }
  const findUid = async (c, id) => (await c.search({ header: { 'message-id': id } }, { uid: true }) || [])[0] || null;
  const ensure = async (c, folder) => { try { await c.mailboxCreate(folder); } catch { /* exists */ } };
  // which intake folder holds this message (the INBOX before the Proton filter exists, the assistant's own folder after it)
  async function locate(id) {
    for (const f of scopes) { const hit = await inFolder(f, async (c) => !!(await findUid(c, id))); if (hit) return f; }
    return null;
  }
  // Proton shows our copy in Sent only after a while (about a minute): the move is retried in the background and remembered across restarts
  const pendingFile = s.MAIL_SENT_PENDING_FILE || path.join(__dirname, '..', '..', 'data', 'mail-sent-pending.json');
  const readPending = () => { try { return JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { return {}; } };
  const writePending = (o) => { try { fs.mkdirSync(path.dirname(pendingFile), { recursive: true }); fs.writeFileSync(pendingFile, JSON.stringify(o)); } catch { /* best effort */ } };
  const inflight = new Map();
  let resumed = false;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const labelsFor = (inDone) => (inDone ? ['received', 'mesimot-done'] : ['received']);
  async function envelopes(folder, { newest = 0 } = {}) {
    return inFolder(folder, async (c) => {
      const exists = c.mailbox.exists || 0;
      if (!exists) return [];
      const range = newest ? `${Math.max(1, exists - newest + 1)}:*` : '1:*';
      const out = [];
      for await (const m of c.fetch(range, { envelope: true, internalDate: true, headers: ['authentication-results', 'x-pm-origin'] })) {
        const lines = String(m.headers || '').split(/\r?\n(?=\S)/).map((l) => l.trim()).filter(Boolean).map((l) => ({ key: l.split(':')[0], line: l.replace(/\r?\n\s+/g, ' ') }));
        out.push({ uid: m.uid, message_id: m.envelope.messageId, from: addrText(m.envelope.from?.[0]), to: (m.envelope.to || []).map(addrText), subject: m.envelope.subject || '', timestamp: new Date(m.internalDate || m.envelope.date || Date.now()).toISOString(), lines });
      }
      return out;
    });
  }
  // Proton's own mail from the owner to himself has no Authentication-Results but is marked internal by Proton (X-Pm-Origin: internal)
  const authFor = (e) => {
    const a = parseAuth(e.lines);
    const internal = /^internal$/i.test(hdr(e.lines, 'x-pm-origin'));
    const fromAddr = (/<([^>]+)>/.exec(e.from) || [])[1] || e.from;
    if (internal && ownerProton && String(fromAddr).toLowerCase() === ownerProton) return { ...a, dmarc: 'pass', internal: true };
    return a;
  };

  return {
    name: 'imap', address, housekeepingMode: s.MAIL_HOUSEKEEPING || 'trash', scope, done, ScopeError,
    // test and diagnostics hook: opening any folder goes through the same guard
    async _open(folder) { return inFolder(folder, async () => true); },
    // login check for the watchdog: connect and log out, nothing is opened
    async ping() { const c = await connect(); await c.logout().catch(() => {}); return true; },

    async listNew({ known = new Set() } = {}) {
      this.resumeSent(); // after a restart, finish moving the Sent copies that were still pending
      const doneIds = new Set((await envelopes(done)).map((e) => e.message_id));
      const seen = new Set(), fresh = [];
      for (const f of scopes) for (const e of await envelopes(f, { newest: 100 })) if (e.message_id && !seen.has(e.message_id)) { seen.add(e.message_id); fresh.push(e); }
      return fresh.filter((e) => e.message_id && !doneIds.has(e.message_id) && !known.has(e.message_id))
        .map((e) => ({ message_id: e.message_id, from: e.from, to: e.to, subject: e.subject, timestamp: e.timestamp, labels: labelsFor(false), authentication_results: authFor(e) }));
    },

    async fetch(id) {
      for (const [folder, isDone] of [...scopes.map((f) => [f, false]), [done, true]]) {
        const got = await inFolder(folder, async (c) => {
          const uid = await findUid(c, id);
          if (!uid) return null;
          const msg = await c.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
          return { source: msg.source, internalDate: msg.internalDate };
        });
        if (!got) continue;
        const p = await simpleParser(got.source);
        const lines = (p.headerLines || []).map((l) => ({ key: l.key, line: l.line.replace(/\r?\n\s+/g, ' ') }));
        const e = { from: addrText(p.from?.value?.[0]), lines };
        const attachments = (p.attachments || []).map((a, i) => ({ filename: a.filename || `attachment-${i + 1}`, content_type: a.contentType, size: a.size || a.content?.length || 0, inline: a.contentDisposition === 'inline' || !!a.related, content_id: a.cid || null, attachment_id: String(i), content: a.content }));
        this._parsed = { id, attachments };
        return {
          message_id: p.messageId || id, from: e.from, to: (p.to?.value || []).map(addrText), subject: p.subject || '', text: p.text || '', html: p.html || '',
          timestamp: new Date(p.date || got.internalDate || Date.now()).toISOString(), labels: labelsFor(isDone), authentication_results: authFor(e),
          attachments: attachments.map(({ content, ...rest }) => rest),
        };
      }
      throw new Error(`message ${id} is not in ${[...scopes, done].join(', ')}`);
    },
    async attachment(id, attId) {
      if (!this._parsed || this._parsed.id !== id) await this.fetch(id);
      const a = this._parsed.attachments[+attId];
      if (!a) throw new Error('attachment not found');
      return a.content;
    },

    // "taken" has no folder: the database remembers it (known ids), so nothing outside the two folders is ever touched
    async addLabel() { /* no-op for 'mesimot' */ },
    async markDone(id) {
      const where = await locate(id);
      if (!where) return;
      const c = await connect();
      try {
        const lock = await c.getMailboxLock(where);
        try {
          const uid = await findUid(c, id);
          if (!uid) return;
          await ensure(c, done);
          const inDone = (await envelopes(done)).some((e) => e.message_id === id);
          if (!inDone) await c.messageCopy(String(uid), done, { uid: true }); // adds the label; the message itself stays
          if (removeAfterDone) await c.messageDelete(String(uid), { uid: true }); // expunge inside this label folder only: removes just the label
        } finally { lock.release(); }
      } finally { await c.logout().catch(() => {}); }
    },

    async list() {
      return (await envelopes(done)).map((e) => ({ message_id: e.message_id, labels: labelsFor(true), timestamp: e.timestamp, subject: e.subject, from: e.from, to: e.to }));
    },
    // after retention + verified local copy. "trash": copy into Trash, then expunge from the input folder and from the done label.
    // "labels": only the done label is removed. Nothing outside the two folders is ever opened.
    async remove(id, { mode } = {}) {
      const m = (mode || housekeeping()) === 'trash' && housekeeping() === 'trash' ? 'trash' : 'labels';
      let trashed = false;
      const where = (await locate(id)) || scope;
      if (m === 'trash') {
        const uid = await inFolder(where, async (c) => {
          const u = await findUid(c, id);
          if (u) await c.messageCopy(String(u), trash, { uid: true }); // a copy destination only: Trash is never selected
          return u;
        });
        trashed = !!uid;
      }
      const folders = m === 'trash' ? [where, done] : [done];
      for (const folder of folders) {
        if (m === 'trash' && folder === where && !trashed) continue; // never expunge the input if the Trash copy did not happen
        await inFolder(folder, async (c) => { const uid = await findUid(c, id); if (uid) await c.messageDelete(String(uid), { uid: true }); });
      }
      return { removed: trashed ? 'trash' : 'labels' };
    },

    // our outgoing copies (the configured sent folder, default Folders/<site host>/Sent): kept MAIL_SENT_RETENTION_DAYS (default 90), then Trash (or left alone in labels mode)
    async listSent() {
      return (await envelopes(sentTarget)).map((e) => ({ message_id: e.message_id, timestamp: e.timestamp, subject: e.subject, to: e.to }));
    },
    sentKeepDays,
    async removeSent(id) {
      if (housekeeping() !== 'trash') return { removed: 'kept' };
      const uid = await inFolder(sentTarget, async (c) => { const u = await findUid(c, id); if (u) await c.messageCopy(String(u), trash, { uid: true }); return u; });
      if (!uid) return { removed: 'missing' };
      await inFolder(sentTarget, async (c) => { const u = await findUid(c, id); if (u) await c.messageDelete(String(u), { uid: true }); });
      return { removed: 'trash' };
    },

    // the folders of the assistant (CREATE is allowed for exactly these names): the done label, the parent folder and its Inbox and Sent
    async ensureFolders() {
      const c = await connect();
      const out = {};
      try {
        // with MAIL_IMAP_LEGACY_PARENT set, rename that older parent (its Inbox and Sent move with it); the Proton filter follows the rename
        this.lastRename = 'not needed';
        if (legacyParent && legacyParent !== newParent) { try { await c.mailboxRename(legacyParent, newParent); this.lastRename = 'renamed'; } catch (e) { this.lastRename = e instanceof ScopeError ? 'refused by the scope guard' : `skipped: ${e.responseText || e.message}`; } }
        for (const f of [done, ...folderTree]) {
          try { await c.mailboxCreate(f); out[f] = 'created'; } catch (e) { out[f] = /exist/i.test(`${e.message} ${e.responseText || ''}`) ? 'exists' : `refused: ${e.responseText || e.message}`; }
        }
      } finally { await c.logout().catch(() => {}); }
      return out;
    },

    // After a send, Proton shows our copy in its Sent folder a while later (about a minute). We find it by OUR Message-ID and From and COPY it into the
    // sent folder (Folders/<site host>/Sent). Success means "the message is present in the target folder"; whether it also still shows in Sent
    // does not matter (on Proton it normally does) and is never retried or cleaned up. Sent is opened only here, through sentClient.
    async moveSentCopy(messageId) {
      const tries = +(s.MAIL_SENT_MOVE_TRIES || 15), delay = +(s.MAIL_SENT_MOVE_DELAY_MS || 5000);
      const inTarget = async () => inFolder(sentTarget, async (c) => !!(await findUid(c, messageId)));
      for (let i = 0; i < tries; i++) {
        if (i) await sleep(Math.min(delay * i, 6 * delay)); // growing waits, about six minutes in all with the defaults
        try {
          if (await inTarget()) return true;
          const mk = deps.makeClient || ((o) => new ImapFlow(o));
          const raw = mk({ host, port, secure: s.MAIL_IMAP_SECURE === '1', doSTARTTLS: starttls(s.MAIL_IMAP_STARTTLS, true) ? true : undefined, auth: { user: s.MAIL_IMAP_USER, pass: s.MAIL_IMAP_PASS }, tls: tlsFor(host), logger: false, disableAutoIdle: true });
          const sc = sentClient(raw, { source: sentSource, target: sentTarget, from: address });
          try { await raw.connect(); await sc.findAndCopy(messageId); } finally { await sc.logout().catch(() => {}); }
          if (await inTarget()) return true;
        } catch (e) { if (e instanceof ScopeError) throw e; }
      }
      return false;
    },

    async send({ to, subject, text }) {
      const t = (deps.makeTransport || nodemailer.createTransport)({ host: smtpHost, port: smtpPort, secure: s.MAIL_SMTP_SECURE === '1', requireTLS: starttls(s.MAIL_SMTP_STARTTLS, true), auth: s.MAIL_SMTP_USER ? { user: s.MAIL_SMTP_USER, pass: s.MAIL_SMTP_PASS } : undefined, tls: tlsFor(smtpHost) });
      const messageId = `<${crypto.randomUUID()}@${(address.split('@')[1] || 'mesimot.local')}>`; // our own Message-ID, to find the Sent copy
      const info = await t.sendMail({ from: { name: s.MAIL_FROM_NAME || 'אלכס', address }, to, subject, text, messageId });
      const pend = readPending(); pend[messageId] = Date.now(); writePending(pend);
      this.settleSent(messageId); // not awaited: the digest must not wait for Proton
      return { ...info, messageId, sentMoved: 'pending' };
    },
    // find our Sent copy and move it; remembered in a small file until it succeeds (or is a day old)
    settleSent(id) {
      if (inflight.has(id)) return inflight.get(id);
      const pr = (async () => {
        let ok = false;
        try { ok = await this.moveSentCopy(id); } catch { ok = false; }
        const pend = readPending();
        if (ok || Date.now() - (pend[id] || 0) > 86400000) { delete pend[id]; writePending(pend); }
        return ok;
      })().finally(() => inflight.delete(id));
      inflight.set(id, pr);
      return pr;
    },
    whenSentSettled() { return Promise.all([...inflight.values()]); },
    resumeSent() { if (resumed) return; resumed = true; for (const id of Object.keys(readPending())) this.settleSent(id); },
  };
}
module.exports = { create, scopedClient, sentClient, parseAuth, ScopeError };
