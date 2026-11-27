'use strict';
// The one place that knows about the encryption key and how to open an encrypted SQLite file.
// The master key is 32 random bytes (hex) in ~/.config/mesimot/db.key (mode 600). It is created once, never overwritten, never logged.
// The database uses SQLCipher 4 (AES-256) through better-sqlite3-multiple-ciphers; stored files use the vault (lib/vault.js), whose key is derived from the same master key.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PLAIN_MAGIC = 'SQLite format 3\0';

const TEST_DIR = path.join(os.tmpdir(), 'mesimot-test');
// the test instance (scripts/testenv.sh) has its own throw-away key, so development scripts that open its database directly never touch the real key
function keyFile(dbFile) {
  if (process.env.MESIMOT_DB_KEY_FILE) return process.env.MESIMOT_DB_KEY_FILE;
  if (dbFile && dbFile !== ':memory:' && path.resolve(dbFile).startsWith(TEST_DIR + path.sep)) return path.join(TEST_DIR, 'db.key');
  return path.join(os.homedir(), '.config', 'mesimot', 'db.key');
}

function validKey(s) { return /^[0-9a-f]{64}$/.test(s); }

// Returns the key as 64 hex chars, or null when there is no key file (and create is false).
function loadKey({ create = false, file = null } = {}) {
  const f = keyFile(file);
  try {
    const s = fs.readFileSync(f, 'utf8').trim().toLowerCase();
    if (!validKey(s)) throw new Error(`the key file ${f} is not 64 hex characters`);
    return s;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!create) return null;
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const k = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(f, k + '\n', { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code === 'EEXIST') return loadKey({ file }); throw e; } // lost a race: use the winner's key, never overwrite
  return k;
}

// Separate keys for separate purposes, derived from the master key (HKDF-SHA256). The info label keeps them independent.
function deriveKey(label, masterHex) {
  const m = masterHex || loadKey({ create: true });
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(m, 'hex'), Buffer.alloc(0), Buffer.from(label), 32));
}

function isPlainFile(file) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return false; }
  try { const b = Buffer.alloc(16); const n = fs.readSync(fd, b, 0, 16, 0); return n === 16 && b.toString('latin1') === PLAIN_MAGIC; } finally { fs.closeSync(fd); }
}
const fileHasData = (file) => { try { return fs.statSync(file).size > 0; } catch { return false; } };

// Must run before anything else on a fresh connection.
function applyKey(db, hex) {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key = "x'${hex}'"`); // raw key: no password stretching, so opening is instant
}

function Driver() { return require('better-sqlite3-multiple-ciphers'); }

// Opens a database file. mode: 'auto' (default: encrypted when a key applies; an existing plain file is opened plain until encrypt-db has converted it),
// 'plain' (never use a key), 'encrypted' (always use the key; error on a plain file).
function openRaw(file, { readonly = false, mode = 'auto', hex = null } = {}) {
  const Database = Driver();
  let useKey = null;
  if (file !== ':memory:' && mode !== 'plain') {
    const exists = fileHasData(file);
    if (mode === 'auto' && exists && isPlainFile(file)) useKey = null; // legacy plaintext database, converted by scripts/encrypt-db.js
    else {
      useKey = hex || loadKey({ create: !exists && !readonly, file });
      if (!useKey) throw new Error(`the database ${file} is encrypted but there is no key file (${keyFile(file)}): restore it from your key backup`);
    }
  }
  const db = new Database(file, { readonly });
  if (useKey) {
    applyKey(db, useKey);
    try { db.prepare('SELECT count(*) FROM sqlite_master').get(); } catch (e) { try { db.close(); } catch { /* ignore */ } throw new Error(`cannot open ${file}: wrong key or not a database (${e.message})`); }
  }
  return db;
}

module.exports = { keyFile, loadKey, deriveKey, isPlainFile, applyKey, openRaw, validKey, PLAIN_MAGIC };
