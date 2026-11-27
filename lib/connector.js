'use strict';
// Connector devices: pairing codes, per-device tokens (only sha256 is stored), heartbeats, installer publishing.
// Used by the Tailscale-only listener (lib/ingest.js) and by the site routes (/api/connector/*).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { now } = require('./db');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_TTL_MS = 15 * 60000;
const MAX_LIVE_CODES = 5;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const err = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Updates are installed by Alex Link only with an Ed25519 signature from the owner's offline key over "alexlink-update-v1|<version>|<sha256>".
// The public half is built into the app; the server checks it too, so an unsigned or wrongly signed installer is never published.
const UPDATE_PUBKEY_HEX = process.env.ALEXLINK_UPDATE_PUBKEY || '5580fc91e6ba2f79226b9624ec799d2516379a29050d001ca04fcc3a1d96c438';
function verifyUpdateSig(version, sha256, sigB64, pubHex = UPDATE_PUBKEY_HEX) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pubHex, 'hex').toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(`alexlink-update-v1|${version}|${String(sha256).toLowerCase()}`), key, Buffer.from(String(sigB64).trim(), 'base64'));
  } catch { return false; }
}
const dataDir = () => process.env.MESIMOT_CONNECTOR_DIR || path.join(__dirname, '..', 'data', 'connector');

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS connector_devices (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', token_sha TEXT NOT NULL UNIQUE, app_version TEXT, created_at TEXT NOT NULL, last_contact_at TEXT, revoked_at TEXT,
    hb_at TEXT, hb_outlook_ok INTEGER, hb_paused_ingest INTEGER, hb_paused_send INTEGER, hb_last_sync_at TEXT, hb_last_error TEXT, alerted_state TEXT);
    CREATE TABLE IF NOT EXISTS connector_codes (code_sha TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);`);
}

function createConnector({ db, outboxKey, host = () => null, port = () => +(process.env.MESIMOT_INGEST_PORT || 8130), dir = dataDir }) {
  migrate(db);
  const q = (s) => db.prepare(s);
  const attempts = []; // pairing attempts (timestamps), rate limit 10 per minute in total

  function newCode() {
    q('DELETE FROM connector_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(new Date(Date.now() - 3600000).toISOString());
    if (q('SELECT COUNT(*) n FROM connector_codes WHERE used_at IS NULL AND expires_at > ?').get(now()).n >= MAX_LIVE_CODES) throw err(429, 'יש כבר 5 קודים פעילים, המתינו שיפוגו');
    const b = crypto.randomBytes(8); let c = ''; for (let i = 0; i < 8; i++) c += ALPHABET[b[i] % ALPHABET.length];
    const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
    q('INSERT INTO connector_codes (code_sha, expires_at, created_at) VALUES (?,?,?)').run(sha(c), expires, now());
    const code = `${c.slice(0, 4)}-${c.slice(4)}`; const h = host();
    return { code, connect_string: `alex://${h || '<server>'}:${port()}/${code}`, expires_at: expires };
  }

  // body {code, computer_name, app_version}; the code is looked up by hash and the comparison is constant time
  function pair(body = {}) {
    const t = Date.now();
    while (attempts.length && attempts[0] < t - 60000) attempts.shift();
    if (attempts.length >= 10) throw err(429, 'יותר מדי ניסיונות');
    attempts.push(t);
    const c = normCode(body.code); const hash = sha(c);
    const rows = q('SELECT * FROM connector_codes WHERE used_at IS NULL AND expires_at > ?').all(now());
    let hit = null; for (const r of rows) if (safeEq(r.code_sha, hash)) hit = r; // no early exit: constant time over the live codes
    if (!hit || c.length !== 8) throw err(404, 'קוד לא תקין או שפג תוקפו');
    const used = q('UPDATE connector_codes SET used_at=? WHERE code_sha=? AND used_at IS NULL').run(now(), hit.code_sha);
    if (!used.changes) throw err(404, 'קוד לא תקין או שפג תוקפו');
    const token = crypto.randomBytes(32).toString('hex');
    const r = q('INSERT INTO connector_devices (name, token_sha, app_version, created_at, last_contact_at) VALUES (?,?,?,?,?)').run(String(body.computer_name || '').slice(0, 80), sha(token), String(body.app_version || '').slice(0, 30), now(), now());
    let site_url = null; try { site_url = require('./config').siteUrl(db) || null; } catch { /* no config */ }
    return { device_id: Number(r.lastInsertRowid), token, outbox_sign_key: outboxKey(), server_name: 'Alex Tasks', site_url };
  }

  // a Bearer token that belongs to an active device (updates last contact); null when unknown or revoked
  function authToken(token) {
    const h = sha(token); const d = q('SELECT id, revoked_at, token_sha FROM connector_devices WHERE token_sha=?').get(h);
    if (!d || !safeEq(d.token_sha, h) || d.revoked_at) return null;
    q('UPDATE connector_devices SET last_contact_at=? WHERE id=?').run(now(), d.id);
    return d.id;
  }
  const bit = (v) => (v === undefined || v === null ? null : v ? 1 : 0);
  function heartbeat(deviceId, b = {}) {
    if (!deviceId) return {}; // the legacy token has no device row
    q('UPDATE connector_devices SET hb_at=?, app_version=COALESCE(?,app_version), name=COALESCE(NULLIF(?,\'\'),name), hb_outlook_ok=?, hb_paused_ingest=?, hb_paused_send=?, hb_last_sync_at=?, hb_last_error=? WHERE id=?')
      .run(now(), b.app_version ? String(b.app_version).slice(0, 30) : null, String(b.computer_name || '').slice(0, 80), bit(b.outlook_ok), bit(b.paused_ingest), bit(b.paused_send), b.last_sync_at ? String(b.last_sync_at).slice(0, 40) : null, b.last_error ? String(b.last_error).slice(0, 300) : null, deviceId);
    return {};
  }
  const list = () => q('SELECT id, name, app_version, created_at, last_contact_at, revoked_at, hb_at, hb_outlook_ok, hb_paused_ingest, hb_paused_send, hb_last_sync_at, hb_last_error FROM connector_devices ORDER BY id').all()
    .map((d) => ({ ...d, outlook_ok: d.hb_outlook_ok === null ? null : !!d.hb_outlook_ok, paused_ingest: !!d.hb_paused_ingest, paused_send: !!d.hb_paused_send, revoked: !!d.revoked_at }));
  function revoke(id) {
    const r = q('UPDATE connector_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(), id);
    if (!r.changes && !q('SELECT 1 FROM connector_devices WHERE id=?').get(id)) throw err(404, 'המחשב לא נמצא');
    return { ok: true };
  }

  // ---- installer
  function latest() {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir(), 'latest.json'), 'utf8')); if (!j.version || !j.file || !fs.existsSync(path.join(dir(), path.basename(j.file)))) return { version: null }; return j; } catch { return { version: null }; }
  }
  const latestPublic = () => { const j = latest(); return j.version ? { version: j.version, sha256: j.sha256, size: j.size, download: '/ingest/connector/download', signature: j.signature || null } : { version: null }; };
  function installer() { const j = latest(); if (!j.version) throw err(404, 'אין קובץ התקנה'); const f = path.join(dir(), path.basename(j.file)); return { path: f, name: path.basename(j.file), size: fs.statSync(f).size }; }
  return { newCode, pair, authToken, heartbeat, list, revoke, latestPublic, installer, sha };
}

// `mesimot connector publish <file>`: copy into data/connector and write latest.json (version from the file name)
function publish(file, targetDir = dataDir(), opts = {}) {
  const name = path.basename(file); const m = /AlexLink-Setup-(\d+(?:\.\d+){1,3})\.exe$/i.exec(name);
  if (!m) throw new Error('file name must look like AlexLink-Setup-<version>.exe');
  const buf = fs.readFileSync(file); const sum = crypto.createHash('sha256').update(buf).digest('hex');
  const sigFile = `${file}.sig`; const signature = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8').trim() : '';
  if (!opts.unsigned && !verifyUpdateSig(m[1], sum, signature)) throw new Error(`${name}.sig is missing or does not match (Ed25519 over alexlink-update-v1|version|sha256)`);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, name), buf);
  const info = { version: m[1], file: name, sha256: sum, size: buf.length, signature: signature || null, published_at: now() };
  fs.writeFileSync(path.join(targetDir, 'latest.json'), JSON.stringify(info, null, 1) + '\n');
  return info;
}
module.exports = { createConnector, publish, migrate, dataDir, verifyUpdateSig };
