#!/usr/bin/env node
'use strict';
// Key rotation:  mesimot rekey [--dry]
// Replaces the master key (~/.config/mesimot/db.key) and re-encrypts EVERYTHING with the new one: the database, every stored file and run log, and every backup.
// Order: new key written to db.key.new -> services stopped -> database copy re-keyed, verified, swapped -> files -> backups -> db.key.new becomes db.key
// (the old key is kept as db.key.old-<time> until you delete it) -> services started. If it stops half way, run it again: it resumes with the same new key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const K = require('../lib/dbkey');
const T = require('../lib/dbtools');
const vault = require('../lib/vault');

const ROOT = path.join(__dirname, '..');
const DB = process.env.MESIMOT_DB || path.join(ROOT, 'data', 'mesimot.db');
const FILES = process.env.MESIMOT_FILES || path.join(ROOT, 'files');
const RUNS = process.env.MESIMOT_RUN_LOG || path.join(ROOT, 'data', 'runs');
const BACKUPS = process.env.MESIMOT_BACKUP_DIRS ? process.env.MESIMOT_BACKUP_DIRS.split(':') : [path.join(ROOT, 'data', 'backups'), path.join(ROOT, 'backups')];
const dry = process.argv.includes('--dry');
const noServices = process.argv.includes('--no-services');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (m) => { console.error('FATAL:', m); process.exit(1); };
const sc = (...a) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' });
function* walk(d) { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.isFile() && !/\.(tmp|old-\d+)$/.test(e.name)) yield p; } }

(async () => {
  const keyFile = K.keyFile(DB); const newFile = keyFile + '.new';
  const oldHex = K.loadKey(); if (!oldHex) die(`no key file at ${keyFile}`);
  if (K.isPlainFile(DB)) die('the database is not encrypted yet: run scripts/encrypt-db.js first');
  let newHex; try { newHex = fs.readFileSync(newFile, 'utf8').trim(); log('resuming an interrupted rotation (db.key.new exists)'); } catch { newHex = null; }
  if (!newHex) { newHex = crypto.randomBytes(32).toString('hex'); if (!dry) fs.writeFileSync(newFile, newHex + '\n', { flag: 'wx', mode: 0o600 }); }
  if (!K.validKey(newHex)) die('db.key.new is not a valid key');
  const keys = [newHex, oldHex];
  const backups = BACKUPS.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.db$/.test(f)).map((f) => path.join(d, f)) : []));
  const fileList = [...walk(FILES), ...walk(RUNS), ...walk(require('../lib/archive').queueDir())]; // the archive queue (raw mail waiting for the worker) is encrypted with the same key
  log(`plan: database, ${fileList.length} stored files and run logs, ${backups.length} backups`);
  if (dry) { log('dry run: nothing changed'); return; }

  const timers = sc('list-units', 'mesimot-*.timer', '--state=active', '--no-legend', '--plain').stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  if (!noServices) { log('stopping timers and services'); for (const t of timers) sc('stop', t); for (const s of ['mesimot-archive.service', 'mesimot-runner.service', 'mesimot.service']) sc('stop', s); }
  const start = () => { if (!noServices) { for (const s of ['mesimot.service', 'mesimot-runner.service', 'mesimot-archive.service']) sc('start', s); for (const t of timers) sc('start', t); } };
  try {
    // 1. database
    let dbNew = false; try { K.openRaw(DB, { hex: newHex, readonly: true }).close(); dbNew = true; } catch { /* still on the old key */ }
    if (!dbNew) {
      const cur = K.openRaw(DB, { hex: oldHex }); cur.pragma('wal_checkpoint(TRUNCATE)'); cur.close();
      const tmp = DB + '.rekey-new'; T.backupTo(DB, tmp, oldHex); T.rekeyInPlace(tmp, oldHex, newHex);
      const a = K.openRaw(DB, { hex: oldHex, readonly: true }), b = K.openRaw(tmp, { hex: newHex, readonly: true });
      const ok = T.integrity(b) === 'ok' && T.compareCounts(a, b).ok; a.close(); b.close();
      if (!ok) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw new Error('the re-keyed database did not verify'); }
      T.rmSidecars(DB); fs.renameSync(DB, DB + '.pre-rekey'); fs.renameSync(tmp, DB); fs.chmodSync(DB, 0o600); log('database re-keyed and verified');
    } else log('database already on the new key');
    // 2. files and run logs
    let done = 0, already = 0, failed = 0;
    for (const f of fileList) { try { if (await vault.reseal(f, oldHex, newHex)) done++; else already++; } catch (e) { failed++; log('FAILED', f, e.message); } }
    log(`files: ${done} re-encrypted, ${already} already on the new key, ${failed} failed`);
    if (failed) throw new Error('some files could not be re-encrypted');
    // 3. backups
    let bk = 0, bkAlready = 0;
    for (const b of backups) {
      try { K.openRaw(b, { hex: newHex, readonly: true }).close(); bkAlready++; continue; } catch { /* not yet */ }
      T.rekeyInPlace(b, oldHex, newHex); K.openRaw(b, { hex: newHex, readonly: true }).close(); bk++;
    }
    log(`backups: ${bk} re-keyed, ${bkAlready} already on the new key`);
    // 4. the new key becomes THE key; the old one stays on disk (mode 600) until you delete it
    const oldCopy = `${keyFile}.old-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 12)}`;
    fs.copyFileSync(keyFile, oldCopy); fs.chmodSync(oldCopy, 0o600); fs.renameSync(newFile, keyFile); fs.chmodSync(keyFile, 0o600);
    try { fs.unlinkSync(DB + '.pre-rekey'); } catch { /* none */ } T.rmSidecars(DB + '.pre-rekey');
    log(`done. The old key is kept in ${oldCopy}: delete it once your key backup holds the NEW key.`);
  } catch (e) { log('FAILED:', e.message, '(run `mesimot rekey` again to resume)'); start(); process.exit(1); }
  start();
  log('services started. Back up the new key file now (docs/ENCRYPTION.md).');
})().catch((e) => die(e.message));
