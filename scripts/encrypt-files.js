#!/usr/bin/env node
'use strict';
// Encrypts every stored file in place (AES-256-GCM, lib/vault.js): files/ (attachments, mail files, voice notes, documents) and data/runs (run logs).
// Safe to run while the service runs and to run again: encrypted files are skipped, a file that is being written is left for the next pass, and each file is
// verified (the encrypted copy is decrypted and its sha256 compared with the original) before the plaintext is overwritten (shred) and replaced.
//
//   node scripts/encrypt-files.js [--dry] [--limit N] [--dir PATH ...]
const fs = require('fs');
const path = require('path');
const vault = require('../lib/vault');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const limit = args.includes('--limit') ? +args[args.indexOf('--limit') + 1] : Infinity;
const dirs = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--dir') dirs.push(path.resolve(args[++i]));
if (!dirs.length) dirs.push(process.env.MESIMOT_FILES || path.join(ROOT, 'files'), process.env.MESIMOT_RUN_LOG || path.join(ROOT, 'data', 'runs'), require('../lib/archive').queueDir());
const SKIP = /\.(tmp|old-\d+)$|\.vault-\d+-[0-9a-f]+\.tmp$/;
const QUIET_MS = 120 * 1000; // a file touched in the last two minutes may still be written

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.isFile() && !SKIP.test(e.name)) yield p; } }

// DB rows, to compare the stored hash with what was just read (reported, never blocks)
let hashOf = () => null;
try { const { openRaw } = require('../lib/dbkey'); const dbFile = process.env.MESIMOT_DB || path.join(ROOT, 'data', 'mesimot.db'); const db = openRaw(dbFile, { readonly: true }); const m = new Map(db.prepare("SELECT path, sha256 FROM files WHERE path<>''").all().map((r) => [r.path, r.sha256])); db.close(); hashOf = (p) => m.get(p) || null; } catch (e) { log('note: database hashes not available:', e.message); }

(async () => {
  const c = { scanned: 0, encrypted: 0, already: 0, busy: 0, failed: 0, bytes: 0, hash_mismatch_with_db: 0 };
  const failed = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of walk(d)) {
      c.scanned++;
      try {
        if (vault.isEncrypted(f)) { c.already++; continue; }
        if (c.encrypted >= limit) continue;
        const st = fs.statSync(f);
        if (Date.now() - st.mtimeMs < QUIET_MS) { c.busy++; continue; }
        if (dry) { c.encrypted++; c.bytes += st.size; continue; }
        const sha = await vault.seal(f);
        if (sha) { c.encrypted++; c.bytes += st.size; const dbh = hashOf(f); if (dbh && dbh !== sha) c.hash_mismatch_with_db++; }
      } catch (e) { if (e.code === 'EVAULTBUSY') c.busy++; else { c.failed++; failed.push(`${f}: ${e.message}`); } }
      if (c.scanned % 500 === 0) log(JSON.stringify(c));
    }
  }
  log(JSON.stringify(c));
  if (failed.length) { log('FAILED:'); for (const x of failed.slice(0, 20)) console.log('  ' + x); }
  let plain = 0; if (!dry) for (const d of dirs) if (fs.existsSync(d)) for (const f of walk(d)) if (!vault.isEncrypted(f)) plain++;
  log(dry ? '(dry run)' : `plain files left: ${plain} (those written in the last two minutes are picked up by the next run)`);
  process.exit(c.failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
