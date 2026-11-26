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

  // one mail. Idempotent on entry_id and on the internet message id (also against mail imported earlier by hand or forwarded).
  async function mail(meta, buffer, filename = 'message.msg') {
    const entry = String(meta.entry_id || '').trim();
    if (!entry) { const e = new Error('entry_id חסר'); e.status = 400; throw e; }
    if (!buffer || !buffer.length) { const e = new Error('קובץ ה-msg חסר'); e.status = 400; throw e; }
    if (buffer.length > MAX_FILE) { const e = new Error('הקובץ גדול מ-100 MB'); e.status = 413; throw e; }
    const mid = normId(meta.internet_message_id);
    if (q('SELECT 1 FROM ingest_mail WHERE entry_id=?').get(entry)) return { status: 'duplicate', reason: 'entry_id' };
    const prior = mid && (q('SELECT email_id FROM ingest_mail WHERE internet_message_id=?').get(mid) || q('SELECT id AS email_id FROM emails WHERE msgid=? OR lower(message_id)=? OR lower(message_id)=?').get(mid, mid, `<${mid}>`));
    const folder = String(meta.folder || 'inbox'); const at = meta.received_or_sent_at ? new Date(meta.received_or_sent_at).toISOString() : null;
    const rec = (emailId, status) => q('INSERT INTO ingest_mail (entry_id, internet_message_id, store, folder, at, size, email_id, backfill, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(entry, mid || null, meta.store || null, folder, at, +meta.size || buffer.length, emailId || null, meta.backfill ? String(meta.backfill) : null, status, now());
    if (prior) { rec(prior.email_id, 'duplicate'); return { status: 'duplicate', reason: 'internet_message_id' }; }
    const name = `${entry.replace(/[^\w.-]+/g, '').slice(-24) || 'outlook'}.msg`;
    const f = await knowledge.saveUpload(store.ownerId(), { name, mime: 'application/vnd.ms-outlook', buffer, source: 'email', quiet: true, stage: true });
    const emailId = f.email_id || q('SELECT email_id FROM files WHERE id=?').get(f.id)?.email_id;
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
function createIngestApp({ ingest, token = readToken(), allowIp = inTailnet } = {}) {
  const Fastify = require('fastify');
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  app.register(require('@fastify/multipart'), { limits: { fileSize: MAX_FILE, files: 2, fields: 10 }, defParamCharset: 'utf8' });
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  app.addHook('onRequest', async (req, reply) => {
    if (!allowIp(req.ip)) return reply.code(403).send({ error: 'forbidden' });
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!token || !m || !same(m[1], token)) return reply.code(401).send({ error: 'unauthorized' });
    ingest.touch();
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
  app.post('/ingest/calendar', async (req) => ingest.calendarEvents(req.body));
  return app;
}
module.exports = { createIngest, createIngestApp, inTailnet, tailscaleAddr, readToken, normId };
