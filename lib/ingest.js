'use strict';
// LIVE OUTLOOK INGEST. A connector on the owner's Windows PC pushes new mail (.msg) and calendar changes over Tailscale.
// This module is the storage side (idempotent, testable without a network); `createIngestApp` is a SEPARATE Fastify instance that listens only on the Tailscale
// address, accepts only 100.64.0.0/10 source addresses and requires a Bearer token. The public site and the Cloudflare tunnel never see it.
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { now } = require('./db');

const MAX_FILE = 100 * 1024 * 1024;
const normId = (s) => { const m = /<?\s*([^<>\s]+)\s*>?/.exec(String(s || '')); return m ? m[1].toLowerCase() : ''; };
const inTailnet = (ip) => { // 100.64.0.0/10 (also as an IPv4-mapped IPv6 address); loopback only when explicitly allowed (tests)
  const v = String(ip || '').replace(/^::ffff:/i, ''); const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v);
  return !!m && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127;
};
const ENV_FILE = process.env.MESIMOT_ENV_FILE || path.join(os.homedir(), '.config', 'mesimot', 'env');
function readToken() {
  if (process.env.MESIMOT_INGEST_TOKEN) return process.env.MESIMOT_INGEST_TOKEN;
  try { const m = /^\s*MESIMOT_INGEST_TOKEN\s*=\s*(.*?)\s*$/m.exec(fs.readFileSync(ENV_FILE, 'utf8')); return m ? m[1].replace(/^["']|["']$/g, '') : ''; } catch { return ''; }
}
// the address of the tailscale interface (never 0.0.0.0, never loopback)
function tailscaleAddr() {
  if (process.env.MESIMOT_INGEST_HOST) return process.env.MESIMOT_INGEST_HOST;
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && (/^tailscale/i.test(name) || inTailnet(a.address)) && inTailnet(a.address)) return a.address;
  return null;
}

function createIngest({ db, store, knowledge, importer, calendar, version = '1' }) {
  const q = (s) => db.prepare(s);
  const touch = () => q("INSERT INTO settings (key,value) VALUES ('ingest_last_contact',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(now());
  const getSet = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;

  // ---- RE-INGEST: the connector re-sends a mail it first saved in a damaged (ANSI) format. The stored raw file, the headers, the body and the attachment NAMES are replaced in place:
  // the email id and everything linked to it (tasks, task_emails, facts with source email:ID / file:ID) stay. The assistant is NOT re-run, except for mail whose old text was garbled ("?" ratio above 20%):
  // those go to a low-priority background queue (facts and extraction only).
  async function reingest(meta, buffer, entry, mid) {
    const { garbledRatio, GARBLED } = require('./textclean'); const { parseMailFile } = require('./mailfile'); const { threadFromHeaders, stripSubjectPrefixes } = require('./forward'); const { setKeys } = require('./threads');
    const row = q('SELECT * FROM ingest_mail WHERE entry_id=? AND email_id IS NOT NULL').get(entry) || (mid && q('SELECT * FROM ingest_mail WHERE internet_message_id=? AND email_id IS NOT NULL ORDER BY id LIMIT 1').get(mid));
    const em = row ? q('SELECT * FROM emails WHERE id=?').get(row.email_id) : (mid ? q('SELECT * FROM emails WHERE msgid=? ORDER BY id LIMIT 1').get(mid) : null);
    if (!em) return null; // nothing stored yet: an ordinary new mail
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileRow = em.file_id ? q('SELECT * FROM files WHERE id=?').get(em.file_id) : null;
    if (fileRow && fileRow.sha256 === sha) { q('UPDATE ingest_mail SET reingested_at=? WHERE entry_id=?').run(now(), entry); return { status: 'reingested', email_id: em.id, unchanged: true }; }
    const m = await parseMailFile(buffer, `${entry}.msg`);
    const kids = q('SELECT * FROM files WHERE email_id=? AND id<>COALESCE(?,0) ORDER BY id').all(em.id, em.file_id);
    const kidText = (f) => q('SELECT text FROM chunks WHERE file_id=? ORDER BY idx LIMIT 3').all(f.id).map((c) => c.text).join(' ');
    const garbledBefore = garbledRatio(em.body_text) > GARBLED || kids.some((k) => garbledRatio(k.original_name) > GARBLED || garbledRatio(kidText(k)) > GARBLED);
    // the new attachments, with the same filter the first ingest used
    const keep = (m.attachments || []).filter((a) => { if (!a.content || !a.content.length) return false; const img = /^image\//i.test(a.mime || '') || /\.(png|jpe?g|gif|bmp)$/i.test(a.name || ''); return !(img && (/^image\d{1,4}\.(png|jpe?g|gif)$/i.test(a.name || '') || a.content.length < 30 * 1024)); });
    const used = new Set(); let renamed = 0, added = 0; const touchedKids = [];
    for (let i = 0; i < keep.length; i++) {
      const a = keep[i]; const size = a.content.length;
      const old = (kids[i] && !used.has(kids[i].id) && kids[i].size === size ? kids[i] : null) || kids.find((k) => !used.has(k.id) && k.size === size);
      if (old) { used.add(old.id); if (knowledge.renameFile(old.id, a.name)) renamed++; touchedKids.push(old.id); continue; }
      try { const f = await knowledge.saveUpload(store.assistantId(), { name: a.name, mime: a.mime, buffer: Buffer.from(a.content), source: 'email', email_id: em.id, quiet: true }); added++; touchedKids.push(f.id); } catch { /* an unreadable attachment must not block */ }
    }
    // the raw file, in place (same path, same row)
    if (fileRow) { try { require('./vault').writeFile(fileRow.path, buffer); } catch { /* keep the old bytes */ } q('UPDATE files SET size=?, sha256=? WHERE id=?').run(buffer.length, sha, fileRow.id); }
    const meta2 = threadFromHeaders({ from_name: m.from_name, from_addr: m.from_addr, to: m.to, cc: m.cc, date: m.date, subject: m.subject });
    db.transaction(() => {
      q(`UPDATE emails SET from_addr=?, to_addr=?, subject=?, body_text=?, forwarded_from=?, original_subject=?, participants=?, thread=?, msgid=COALESCE(msgid, ?), attachments=? WHERE id=?`)
        .run(m.from, [...m.to, ...m.cc.map((c) => 'cc: ' + c)].join(', '), m.subject, m.body, m.from, stripSubjectPrefixes(m.subject), JSON.stringify(meta2.participants), JSON.stringify(meta2.thread), m.msgid || null, JSON.stringify(keep.map((a) => ({ filename: a.name, content_type: a.mime, size: a.content.length }))), em.id);
      try { q('DELETE FROM vec_items WHERE rowid IN (SELECT id FROM embeddings WHERE kind=? AND ref_id=?)').run("email", em.id); q('DELETE FROM embeddings WHERE kind=? AND ref_id=?').run('email', em.id); } catch { /* no vector index */ }
    })();
    try { setKeys(db, em.id); } catch { /* keys are an optimisation */ }
    // contacts first created with a damaged name get their real name (matched by e-mail address)
    let peopleFixed = 0;
    for (const x of meta2.participants || []) {
      if (!x.email || !x.name || /\?/.test(x.name)) continue;
      const hit = store.listPeople().find((p) => p.emails.map((e) => String(e).toLowerCase()).includes(String(x.email).toLowerCase()));
      if (hit && /\?/.test(hit.name_he) && (hit.name_he.match(/\?/g) || []).length >= hit.name_he.replace(/\s/g, '').length / 2) { try { store.updatePerson(store.assistantId(), hit.id, { name: x.name }); peopleFixed++; } catch { /* keep */ } }
    }
    if (row) q('UPDATE ingest_mail SET reingested_at=?, garbled_before=?, status=?, size=? WHERE id=?').run(now(), garbledBefore ? 1 : 0, 'reingested', buffer.length, row.id);
    else q('INSERT INTO ingest_mail (entry_id, internet_message_id, folder, at, size, email_id, status, created_at, reingested_at, garbled_before) VALUES (?,?,?,?,?,?,?,?,?,?)').run(entry, mid || null, meta.folder || 'inbox', meta.received_or_sent_at ? new Date(meta.received_or_sent_at).toISOString() : null, buffer.length, em.id, 'reingested', now(), now(), garbledBefore ? 1 : 0);
    if (garbledBefore) {
      for (const id of touchedKids) q('UPDATE files SET facts_checked=0 WHERE id=?').run(id);
      q('INSERT INTO reingest_queue (email_id, file_ids, created_at) VALUES (?,?,?) ON CONFLICT(email_id) DO UPDATE SET file_ids=excluded.file_ids, done_at=NULL').run(em.id, JSON.stringify(touchedKids), now());
    }
    try { await require('./fixnames').createFixNames({ db, store, knowledge }).run({ emailId: em.id }); } catch { /* the repair is best effort */ }
    store.logEvent(store.assistantId(), 'email', em.id, 'update', 'reingest', null, `${renamed} שמות קבצים תוקנו${garbledBefore ? ', הטקסט היה משובש' : ''}`);
    return { status: 'reingested', email_id: em.id, garbled_before: garbledBefore, files_renamed: renamed, files_added: added, people_fixed: peopleFixed, queued_for_extraction: garbledBefore };
  }

  // one mail. Idempotent on entry_id and on the internet message id (also against mail imported earlier by hand or forwarded).
  async function mail(meta, buffer, filename = 'message.msg') {
    const entry = String(meta.entry_id || '').trim();
    if (!entry) { const e = new Error('entry_id חסר'); e.status = 400; throw e; }
    if (!buffer || !buffer.length) { const e = new Error('קובץ ה-msg חסר'); e.status = 400; throw e; }
    if (buffer.length > MAX_FILE) { const e = new Error('הקובץ גדול מ-100 MB'); e.status = 413; throw e; }
    const mid = normId(meta.internet_message_id);
    if (meta.reingest === true || meta.reingest === 'true') { const r = await reingest(meta, buffer, entry, mid); if (r) return r; }
    if (q('SELECT 1 FROM ingest_mail WHERE entry_id=?').get(entry)) return { status: 'duplicate', reason: 'entry_id' };
    const prior = mid && (q('SELECT email_id FROM ingest_mail WHERE internet_message_id=?').get(mid) || q('SELECT id AS email_id FROM emails WHERE msgid=? OR lower(message_id)=? OR lower(message_id)=?').get(mid, mid, `<${mid}>`));
    const folder = String(meta.folder || 'inbox'); const at = meta.received_or_sent_at ? new Date(meta.received_or_sent_at).toISOString() : null;
    const rec = (emailId, status) => q('INSERT INTO ingest_mail (entry_id, internet_message_id, store, folder, at, size, email_id, backfill, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(entry, mid || null, meta.store || null, folder, at, +meta.size || buffer.length, emailId || null, meta.backfill ? String(meta.backfill) : null, status, now());
    if (prior) { rec(prior.email_id, 'duplicate'); return { status: 'duplicate', reason: 'internet_message_id' }; }
    const name = `${entry.replace(/[^\w.-]+/g, '').slice(-24) || 'outlook'}.msg`;
    const f = await knowledge.saveUpload(store.ownerId(), { name, mime: 'application/vnd.ms-outlook', buffer, source: 'email', quiet: true, stage: true });
    const emailId = f.email_id || q('SELECT email_id FROM files WHERE id=?').get(f.id)?.email_id;
    if (emailId) require('./mailview').createMailView(db).ensure(emailId).catch(() => {}); // keep the original HTML and the inline pictures (display only)
    if (!emailId) { const e = new Error('לא ניתן לקרוא את קובץ ה-msg'); e.status = 422; throw e; }
    if (q("SELECT 1 FROM emails WHERE id=? AND import_id IS NOT NULL").get(emailId)) { rec(emailId, 'duplicate'); return { status: 'duplicate', reason: 'same_file' }; }
    const importId = importer.adoptLive(emailId, { backfill: meta.backfill || null, msgid: mid || null });
    rec(emailId, 'stored');
    return { status: 'stored', email_id: emailId, import_id: importId };
  }

  // calendar events: a JSON array, upserted as a read-only mirror
  function calendarEvents(list) {
    if (!Array.isArray(list)) { const e = new Error('נדרש מערך אירועים'); e.status = 400; throw e; }
    const out = { received: list.length, created: 0, updated: 0, deleted: 0, ignored: 0, errors: [] };
    db.transaction(() => {
      for (const ev of list) {
        try { const r = calendar.upsertOutlook(ev); out[r === 'created' ? 'created' : r === 'updated' ? 'updated' : r === 'deleted' ? 'deleted' : 'ignored']++; }
        catch (e) { out.errors.push({ entry_id: ev && ev.entry_id, error: e.message }); }
      }
      q('INSERT INTO ingest_calendar_log (at, received, upserted, deleted) VALUES (?,?,?,?)').run(now(), out.received, out.created + out.updated, out.deleted);
    })();
    return out;
  }

  function status() {
    const folders = q("SELECT folder, MAX(at) last_item_at, MAX(created_at) last_received_at, COUNT(*) total, SUM(status='stored') stored, SUM(status='duplicate') duplicates FROM ingest_mail GROUP BY folder").all();
    const cal = q('SELECT MAX(at) last_received_at FROM ingest_calendar_log').get();
    const perDay = q("SELECT substr(created_at,1,10) day, COUNT(*) received, SUM(status='stored') stored FROM ingest_mail WHERE created_at >= ? GROUP BY 1 ORDER BY 1 DESC").all(new Date(Date.now() - 14 * 86400000).toISOString());
    const pending = q("SELECT COUNT(*) n FROM emails e WHERE e.import_id IN (SELECT id FROM imports WHERE status<>'done') AND import_state NOT IN ('done','dup','noise','failed','review','outer','container')").get().n;
    return {
      server_version: version, now: now(), last_contact_at: getSet('ingest_last_contact'),
      mail: { folders, last_received_at: q('SELECT MAX(created_at) m FROM ingest_mail').get().m, total: q('SELECT COUNT(*) n FROM ingest_mail').get().n, per_day: perDay, pending_in_pipeline: pending },
      calendar: { last_received_at: cal.last_received_at, items: q("SELECT COUNT(*) n FROM calendar_items WHERE source='outlook'").get().n },
    };
  }
  return { mail, calendarEvents, status, touch };
}

// the separate listener (Tailscale only)
function createIngestApp({ ingest, outbox = null, connector = null, token = readToken(), allowIp = inTailnet } = {}) {
  const Fastify = require('fastify');
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  app.register(require('@fastify/multipart'), { limits: { fileSize: MAX_FILE, files: 2, fields: 10 }, defParamCharset: 'utf8' });
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  app.addHook('onRequest', async (req, reply) => {
    if (!allowIp(req.ip)) return reply.code(403).send({ error: 'forbidden' });
    if (connector && req.method === 'POST' && req.url.split('?')[0] === '/ingest/pair') return; // pairing: no Bearer, the one-use code is the credential
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return reply.code(401).send({ error: 'unauthorized' });
    if (token && same(m[1], token)) { ingest.touch(); return; } // the legacy token
    const dev = connector ? connector.authToken(m[1]) : null;
    if (!dev) return reply.code(401).send({ error: 'unauthorized' });
    req.deviceId = dev; ingest.touch();
  });
  app.setErrorHandler((err, req, reply) => reply.code(err.status || err.statusCode || 500).send({ error: err.message || 'error' }));
  app.get('/ingest/status', async () => ingest.status());
  app.post('/ingest/mail', async (req, reply) => {
    let meta = null, file = null, filename = 'message.msg';
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'meta') { const raw = await part.toBuffer(); try { meta = JSON.parse(raw.toString('utf8')); } catch { const e = new Error('meta אינו JSON תקין'); e.status = 400; throw e; } } // a client that sends meta as a file part
      else if (part.type === 'file') { file = await part.toBuffer(); filename = part.filename || filename; }
      else if (part.fieldname === 'meta') { try { meta = typeof part.value === 'object' && part.value ? part.value : JSON.parse(part.value); } /* the plugin already parses a part sent as application/json */ catch { const e = new Error('meta אינו JSON תקין'); e.status = 400; throw e; } }
    }
    if (!meta) { const e = new Error('meta חסר'); e.status = 400; throw e; }
    return reply.code(200).send(await ingest.mail(meta, file, filename));
  });
  if (connector) {
    app.post('/ingest/pair', async (req) => connector.pair(req.body || {}));
    app.post('/ingest/heartbeat', async (req) => connector.heartbeat(req.deviceId, req.body || {}));
    app.get('/ingest/connector/latest', async () => connector.latestPublic());
    app.get('/ingest/connector/download', async (req, reply) => { const f = connector.installer(); return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', f.size).header('Content-Disposition', `attachment; filename="${f.name}"`).send(fs.createReadStream(f.path)); });
  }
  app.post('/ingest/calendar', async (req) => ingest.calendarEvents(req.body));
  // outbound mail: the connector fetches what the owner approved, claims it (so it is sent once) and reports the result. It verifies the signature itself.
  if (outbox) {
    app.get('/outbox/approved', async () => outbox.approvedList());
    app.post('/outbox/:id/claim', async (req) => outbox.claim(+req.params.id));
    app.post('/outbox/:id/result', async (req) => outbox.result(+req.params.id, req.body || {}));
    app.get('/outbox/:id/attachment/:file', async (req, reply) => {
      const f = outbox.attachmentFile(+req.params.id, +req.params.file);
      return reply.header('Content-Type', f.mime).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`).send(require('./vault').createReadStream(f.path));
    });
  }
  return app;
}
module.exports = { createIngest, createIngestApp, inTailnet, tailscaleAddr, readToken, normId };
