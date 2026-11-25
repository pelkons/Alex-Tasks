'use strict';
const crypto = require('crypto');

const SESSION_DAYS = 90;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const COOKIE = 'mesimot_session';

const failures = new Map(); // client -> { count, until }

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}

function getAuth(db) {
  const r = db.prepare("SELECT value FROM settings WHERE key='auth'").get();
  return r ? JSON.parse(r.value) : null;
}

function setPassword(db, password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('הסיסמה חייבת להכיל לפחות 12 תווים');
  const salt = crypto.randomBytes(16).toString('hex');
  const data = { salt, hash: hash(password, salt), secret: crypto.randomBytes(32).toString('hex') };
  db.prepare("INSERT INTO settings (key,value) VALUES ('auth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(data));
}

function eq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function lockedFor(client) {
  const f = failures.get(client);
  if (!f || !f.until) return 0;
  if (f.until <= Date.now()) { failures.delete(client); return 0; }
  return f.until - Date.now();
}

function checkPassword(db, password, client) {
  const a = getAuth(db);
  const ok = !!a && typeof password === 'string' && eq(hash(password, a.salt), a.hash);
  if (ok) { failures.delete(client); return true; }
  const f = failures.get(client) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILURES) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(client, f);
  return false;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function makeSession(db) {
  const a = getAuth(db);
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400000, sid: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload, a.secret)}`;
}

function readSession(db, cookie) {
  if (!cookie || !cookie.includes('.')) return null;
  const a = getAuth(db);
  if (!a) return null;
  const i = cookie.lastIndexOf('.');
  const payload = cookie.slice(0, i), sig = cookie.slice(i + 1);
  if (!eq(sign(payload, a.secret), sig)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

function resetFailures() { failures.clear(); }

module.exports = { COOKIE, SESSION_DAYS, setPassword, checkPassword, lockedFor, makeSession, readSession, eq, resetFailures, getAuth };
