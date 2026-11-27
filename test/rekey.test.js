'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs'); const { spawnSync } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-rekey-'));
const env = { ...process.env, MESIMOT_DB: path.join(TMP, 'data', 'mesimot.db'), MESIMOT_DB_KEY_FILE: path.join(TMP, 'db.key'), MESIMOT_FILES: path.join(TMP, 'files'), MESIMOT_RUN_LOG: path.join(TMP, 'runs'), MESIMOT_BACKUP_DIRS: path.join(TMP, 'backups'), MESIMOT_TMP: path.join(TMP, 'shm'), MESIMOT_SEMANTIC: '0' };
Object.assign(process.env, env);
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../lib/dbkey'); const T = require('../lib/dbtools'); const vault = require('../lib/vault'); const { open } = require('../lib/db');
const WORD = 'שנאי-סודי-מאוד';

test('mesimot rekey: database, files, run logs and backups all move to a new key; the old key opens nothing; plain leftovers get encrypted; a second rotation works the same way', async () => {
  const db = open(env.MESIMOT_DB); db.prepare("INSERT INTO settings (key,value) VALUES ('s', ?)").run(WORD); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  const oldHex = K.loadKey();
  fs.mkdirSync(env.MESIMOT_FILES, { recursive: true }); fs.mkdirSync(env.MESIMOT_RUN_LOG, { recursive: true }); fs.mkdirSync(env.MESIMOT_BACKUP_DIRS, { recursive: true });
  const f1 = path.join(env.MESIMOT_FILES, 'a.txt'), f2 = path.join(env.MESIMOT_FILES, 'plain.txt'), r1 = path.join(env.MESIMOT_RUN_LOG, '1.prompt.txt');
  vault.writeFile(f1, Buffer.from(WORD)); fs.writeFileSync(f2, WORD); vault.writeFile(r1, Buffer.from(WORD));
  const bk = path.join(env.MESIMOT_BACKUP_DIRS, 'mesimot-2026-01-01.db'); T.backupTo(env.MESIMOT_DB, bk, oldHex);
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'rekey.js'), '--no-services'], { encoding: 'utf8', env });
  const r = run(); assert.equal(r.status, 0, r.stdout + r.stderr);
  const newHex = K.loadKey(); assert.notEqual(newHex, oldHex); assert.equal(fs.statSync(env.MESIMOT_DB_KEY_FILE).mode & 0o777, 0o600);
  assert.ok(fs.readdirSync(TMP).some((x) => x.startsWith('db.key.old-')), 'the old key is kept'); assert.ok(!fs.existsSync(env.MESIMOT_DB_KEY_FILE + '.new'));
  assert.throws(() => K.openRaw(env.MESIMOT_DB, { hex: oldHex }), /wrong key/); assert.throws(() => K.openRaw(bk, { hex: oldHex }), /wrong key/);
  const val = (d) => { const v = d.prepare("SELECT value FROM settings WHERE key='s'").get().value; d.close(); return v; };
  assert.equal(val(open(env.MESIMOT_DB)), WORD); assert.equal(val(K.openRaw(bk, { hex: newHex })), WORD);
  for (const f of [f1, f2, r1]) { assert.ok(vault.isEncrypted(f)); assert.equal(vault.readFile(f).toString(), WORD); assert.throws(() => vault.readFile(f, { keys: [oldHex] }), /not available/); }
  const r2 = run(); assert.equal(r2.status, 0, r2.stdout + r2.stderr); assert.match(r2.stdout, /0 failed/); assert.notEqual(K.loadKey(), newHex, 'a second run rotates again (new key)');
  assert.equal(vault.readFile(f1).toString(), WORD);
});
