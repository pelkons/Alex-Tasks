#!/usr/bin/env node
'use strict';
// One-time conversion of the live database (and of old plaintext backups) to an encrypted database.
//
//   node scripts/encrypt-db.js              convert data/mesimot.db: stop services, encrypted copy, verify, swap, start (plaintext kept until --finalize)
//   node scripts/encrypt-db.js --dry        do everything on a scratch copy, touch nothing
//   node scripts/encrypt-db.js --finalize   after the health gate passed: securely remove the kept plaintext original
//   node scripts/encrypt-db.js --rollback   put the plaintext original back (only valid until --finalize)
//   node scripts/encrypt-db.js --backups    convert every plaintext backup in data/backups and backups (verified one by one, then the plaintext is removed)
//
// The key (~/.config/mesimot/db.key) is created here if it does not exist yet and is never printed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const { loadKey, openRaw, isPlainFile, keyFile } = require('../lib/dbkey');
const T = require('../lib/dbtools');

const ROOT = path.join(__dirname, '..');
const DB = process.env.MESIMOT_DB || path.join(ROOT, 'data', 'mesimot.db');
const KEPT = DB + '.plain-pre-encrypt';
const FAILED = DB + '.enc-failed';
const arg = (f) => process.argv.includes(f);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (m) => { console.error('FATAL:', m); process.exit(1); };
const sc = (...a) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' });

function shred(f) {
  if (!fs.existsSync(f)) return;
  const r = spawnSync('shred', ['-u', f]);
  if (r.status !== 0) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

function verify(plainFile, encFile, hex, { quick = false } = {}) {
  const a = openRaw(plainFile, { mode: 'plain', readonly: true });
  const b = openRaw(encFile, { hex, readonly: true });
  try {
    const res = { integrity: T.integrity(b) };
    if (res.integrity !== 'ok') throw new Error('integrity_check of the encrypted copy: ' + res.integrity);
    const c = T.compareCounts(a, b);
    if (!c.ok) throw new Error('row counts differ: ' + c.diffs.join('; '));
    res.tables = Object.keys(c.counts).length; res.rows = Object.values(c.counts).reduce((s, n) => s + (Number.isInteger(n) ? n : 0), 0);
    if (!quick) {
      T.loadVec(a); T.loadVec(b);
      res.searches = T.compareSearches(a, b, 5);
      if (res.searches.some((s) => !s.same)) throw new Error('search results differ: ' + JSON.stringify(res.searches.filter((s) => !s.same)));
    }
    return res;
  } finally { a.close(); b.close(); }
}

async function migrate() {
  if (!fs.existsSync(DB)) die(`no database at ${DB}`);
  if (!isPlainFile(DB)) die('the database is already encrypted (nothing to do)');
  if (fs.existsSync(KEPT)) die(`${KEPT} exists: a previous conversion was not finalized. Run --finalize or --rollback first`);
  const dry = arg('--dry');
  const hex = dry ? require('crypto').randomBytes(32).toString('hex') : loadKey({ create: true });
  const stop = ['mesimot-runner.service', 'mesimot.service'];
  const timers = sc('list-units', 'mesimot-*.timer', '--state=active', '--no-legend', '--plain').stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  const tmp = DB + '.enc-new';
  const t0 = Date.now();
  const restoreServices = () => { for (const s of ['mesimot.service', 'mesimot-runner.service']) sc('start', s); for (const t of timers) sc('start', t); };
  if (!dry) { log('stopping timers and services'); for (const t of timers) sc('stop', t); for (const s of stop) sc('stop', s); }
  try {
    if (!dry) { const d = openRaw(DB, { mode: 'plain' }); d.pragma('wal_checkpoint(TRUNCATE)'); d.close(); }
    log('making the encrypted copy');
    await T.encryptCopy(DB, tmp, hex);
    log('verifying the copy');
    const v = verify(DB, tmp, hex);
    log(`verified: integrity ok, ${v.tables} tables, ${v.rows} rows equal, searches equal (${v.searches.length})`);
    if (dry) { T.rmSidecars(tmp); fs.unlinkSync(tmp); log('dry run ok'); return; }
    // swap: the plaintext original stays as KEPT until --finalize
    T.rmSidecars(DB);
    fs.renameSync(DB, KEPT);
    fs.renameSync(tmp, DB);
    fs.chmodSync(DB, 0o600);
    try { const t = openRaw(DB, { hex, readonly: true }); const n = t.prepare('SELECT count(*) c FROM tasks').get().c; t.close(); log(`swapped; the encrypted database opens, ${n} tasks`); }
    catch (e) { fs.renameSync(DB, FAILED); fs.renameSync(KEPT, DB); throw e; }
  } catch (e) {
    log('FAILED:', e.message); try { T.rmSidecars(tmp); fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (!dry) restoreServices();
    die('conversion failed, the plaintext database is still in place and the services are started again');
  }
  restoreServices();
  log(`services started after ${(Date.now() - t0) / 1000}s of downtime`);
  console.log(`\nPlaintext original kept at ${KEPT} until the health gate has passed. Then: node scripts/encrypt-db.js --finalize`);
}

function finalize() {
  if (!fs.existsSync(KEPT)) { log('nothing to finalize'); return; }
  const hex = loadKey(); const b = openRaw(DB, { hex, readonly: true }); const ok = T.integrity(b); b.close();
  if (ok !== 'ok') die('the live database does not pass integrity_check: NOT removing the plaintext original');
  shred(KEPT); T.rmSidecars(KEPT); shred(FAILED);
  log('plaintext original removed (shred)');
}

function rollback() {
  if (!fs.existsSync(KEPT)) die('no kept plaintext original: cannot roll back');
  if (!arg('--no-services')) for (const s of ['mesimot-runner.service', 'mesimot.service']) sc('stop', s);
  T.rmSidecars(DB); if (fs.existsSync(DB)) fs.renameSync(DB, FAILED);
  fs.renameSync(KEPT, DB); fs.chmodSync(DB, 0o600);
  if (!arg('--no-services')) for (const s of ['mesimot.service', 'mesimot-runner.service']) sc('start', s);
  log(`plaintext database restored; the encrypted one is kept at ${FAILED}`);
}

async function gunzipTo(src, dest) { await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest, { mode: 0o600 })); }

// converts one backup file; returns 'converted' | 'already' | throws
async function convertBackup(file, hex) {
  const gz = file.endsWith('.gz');
  const finalName = gz ? file.slice(0, -3) : file;
  const work = finalName + '.enc-tmp';
  const plainTmp = finalName + '.plain-tmp';
  try {
    let plainSrc = file;
    if (gz) { await gunzipTo(file, plainTmp); plainSrc = plainTmp; }
    if (!isPlainFile(plainSrc)) { if (gz) { fs.unlinkSync(plainTmp); } return 'already'; }
    await T.encryptCopy(plainSrc, work, hex);
    const v = verify(plainSrc, work, hex, { quick: true });
    if (v.integrity !== 'ok') throw new Error('integrity');
    fs.renameSync(work, finalName); fs.chmodSync(finalName, 0o600);
    // only now the plaintext goes
    if (gz) { shred(plainTmp); shred(file); } else if (finalName === file) { /* the encrypted file replaced the plain one by rename: the plain inode is gone */ }
    return 'converted';
  } finally { for (const f of [work, plainTmp]) { T.rmSidecars(f); try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ } } }
}

async function backups() {
  const hex = loadKey({ create: true });
  const dirs = process.env.MESIMOT_BACKUP_DIRS ? process.env.MESIMOT_BACKUP_DIRS.split(':') : [path.join(ROOT, 'data', 'backups'), path.join(ROOT, 'backups')];
  const cnt = { converted: 0, already: 0, failed: 0 };
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (!/\.db(\.gz)?$/.test(f)) continue;
      const p = path.join(d, f);
      try {
        // a plain file renamed over would leave its blocks on disk: shred the original first when the name stays the same
        const wasPlain = !f.endsWith('.gz') && isPlainFile(p);
        let r;
        if (wasPlain) {
          const tmp = p + '.plain-tmp'; fs.renameSync(p, tmp);
          try { await T.encryptCopy(tmp, p + '.enc-tmp', hex); const v = verify(tmp, p + '.enc-tmp', hex, { quick: true }); fs.renameSync(p + '.enc-tmp', p); fs.chmodSync(p, 0o600); shred(tmp); T.rmSidecars(tmp); r = "converted"; void v; }
          catch (e) { try { fs.unlinkSync(p + '.enc-tmp'); } catch { /* ignore */ } fs.renameSync(tmp, p); throw e; }
        } else r = await convertBackup(p, hex);
        cnt[r]++; log(r, f);
      } catch (e) { cnt.failed++; log('FAILED', f, e.message); }
    }
  }
  // sanity: nothing plain left
  const left = []; for (const d of dirs) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (/\.db$/.test(f) && isPlainFile(p)) left.push(p); else if (/\.db\.gz$/.test(f)) left.push(p); }
  log(JSON.stringify(cnt), 'plaintext left:', left.length ? left.join(', ') : 'none');
  if (cnt.failed || left.length) process.exit(1);
}

(async () => {
  if (arg('--finalize')) return finalize();
  if (arg('--rollback')) return rollback();
  if (arg('--backups')) return backups();
  return migrate();
})().catch((e) => die(e.message));
