'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs'); const { spawnSync } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-crypt-'));
process.env.MESIMOT_DB_KEY_FILE = path.join(TMP, 'k', 'db.key');
process.env.MESIMOT_FILES = path.join(TMP, 'files');
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../lib/dbkey');
const T = require('../lib/dbtools');
const { open } = require('../lib/db');
const WORD = 'שנאי-סודי-ייחודי';

test('a new database is created encrypted, with a key file created once (mode 600) and never overwritten', () => {
  assert.equal(K.loadKey(), null);
  const file = path.join(TMP, 'a.db'); const db = open(file);
  db.prepare("INSERT INTO settings (key,value) VALUES ('secret', ?)").run(WORD); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  const kf = K.keyFile(); const k1 = fs.readFileSync(kf, 'utf8');
  assert.match(k1.trim(), /^[0-9a-f]{64}$/); assert.equal(fs.statSync(kf).mode & 0o777, 0o600);
  open(file).close(); assert.equal(fs.readFileSync(kf, 'utf8'), k1, 'the key is not rewritten');
  const raw = fs.readFileSync(file); assert.notEqual(raw.subarray(0, 15).toString(), 'SQLite format 3'); assert.ok(!raw.includes(Buffer.from(WORD)), 'the value is not readable in the file');
  assert.equal(open(file).prepare("SELECT value FROM settings WHERE key='secret'").get().value, WORD);
});

test('a wrong key fails to open; a missing key file for an encrypted database is an error and does not create a new key', () => {
  const file = path.join(TMP, 'a.db');
  assert.throws(() => K.openRaw(file, { hex: 'cd'.repeat(32) }), /wrong key/);
  const save = process.env.MESIMOT_DB_KEY_FILE; process.env.MESIMOT_DB_KEY_FILE = path.join(TMP, 'nokey');
  assert.throws(() => K.openRaw(file), /no key file/); assert.ok(!fs.existsSync(path.join(TMP, 'nokey')));
  process.env.MESIMOT_DB_KEY_FILE = save;
});

test('encrypting a plain database: same rows, searches and integrity; the plain original is not modified; backups are encrypted copies', async () => {
  const plain = path.join(TMP, 'p.db'); const d = K.openRaw(plain, { mode: 'plain' });
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE VIRTUAL TABLE f USING fts5(a, tokenize='trigram')"); for (let i = 0; i < 50; i++) { d.prepare('INSERT INTO t (v) VALUES (?)').run(WORD + i); d.prepare('INSERT INTO f (a) VALUES (?)').run(WORD + i); }
  d.pragma('journal_mode = WAL'); d.close();
  assert.ok(K.isPlainFile(plain));
  const hex = K.loadKey(); const enc = path.join(TMP, 'e.db');
  await T.encryptCopy(plain, enc, hex);
  assert.ok(K.isPlainFile(plain)); assert.ok(!K.isPlainFile(enc));
  const a = K.openRaw(plain, { mode: 'plain', readonly: true }), b = K.openRaw(enc, { hex, readonly: true });
  assert.equal(T.integrity(b), 'ok'); assert.ok(T.compareCounts(a, b).ok);
  assert.equal(b.prepare("SELECT count(*) c FROM f WHERE f MATCH 'ייחודי'").get().c, 50);
  a.close(); b.close();
  const bk = path.join(TMP, 'bk.db'); T.backupTo(enc, bk, hex);
  assert.ok(!K.isPlainFile(bk)); assert.ok(!fs.readFileSync(bk).includes(Buffer.from(WORD)));
  const c = K.openRaw(bk, { hex, readonly: true }); assert.equal(c.prepare('SELECT count(*) c FROM t').get().c, 50); c.close();
  const bp = path.join(TMP, 'bp.db'); T.backupTo(plain, bp, hex); assert.ok(!K.isPlainFile(bp)); // even a plain source gives an encrypted backup
  T.rekeyInPlace(bk, hex, 'ef'.repeat(32)); assert.throws(() => K.openRaw(bk, { hex }), /wrong key/); K.openRaw(bk, { hex: 'ef'.repeat(32) }).close();
});

test('mesimot sql: read-only by default, --write changes data, works on the encrypted database', () => {
  const file = path.join(TMP, 'a.db'); const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'mesimot'), 'sql', ...a, '--db', file], { encoding: 'utf8', env: { ...process.env } });
  const r = run("SELECT value FROM settings WHERE key='secret'"); assert.equal(JSON.parse(r.stdout)[0].value, WORD);
  assert.notEqual(run("UPDATE settings SET value='x' WHERE key='secret'").status, 0);
  assert.equal(run("UPDATE settings SET value='y' WHERE key='secret'", '--write').status, 0);
  assert.equal(JSON.parse(run("SELECT value FROM settings WHERE key='secret'").stdout)[0].value, 'y');
});
