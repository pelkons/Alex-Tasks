#!/usr/bin/env node
'use strict';
// Nightly encrypted off-site backup to Proton Drive:  node scripts/offsite-backup.js [--dry-run] | --restore-test | --status
// (also: `mesimot backup offsite [--dry-run]`, `mesimot backup restore-test`). See docs/BACKUP.md. Never prints the key; the database copy leaves this machine only compressed and encrypted.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const offsite = require('../lib/offsite');
const { loadKey } = require('../lib/dbkey');
const args = process.argv.slice(2); const flag = (f) => args.includes(f);
const dbFile = process.env.MESIMOT_DB || path.join(root, 'data', 'mesimot.db');
const filesRoot = process.env.MESIMOT_FILES || path.join(root, 'files');
const manifestFile = process.env.MESIMOT_OFFSITE_MANIFEST || path.join(root, 'data', 'offsite-manifest.json');
const lockFile = process.env.MESIMOT_OFFSITE_LOCK || path.join(root, 'data', 'offsite.lock');
const out = (v) => console.log(JSON.stringify(v, null, 1));

function lock() {
  try { const pid = +fs.readFileSync(lockFile, 'utf8'); if (pid) { try { process.kill(pid, 0); throw Object.assign(new Error('another off-site backup is running'), { busy: true }); } catch (e) { if (e.busy) throw e; } } } catch (e) { if (e.busy) throw e; }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true }); fs.writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
  const un = () => { try { fs.unlinkSync(lockFile); } catch { /* gone */ } };
  process.on('exit', un); for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { un(); process.exit(130); });
}

async function main() {
  const hex = loadKey({ file: dbFile }); if (!hex) { console.error('no key file: the system is not encrypted'); process.exit(3); }
  const drive = offsite.createCliDrive();
  if (flag('--restore-test')) {
    lock();
    try { const r = await offsite.restoreTest({ drive, hex }); out(r); process.exit(r.ok ? 0 : 1); } catch (e) { out({ ok: false, error: e.message }); process.exit(1); }
  }
  const { open } = require('../lib/db'); const db = open(dbFile);
  if (flag('--status')) { out({ status: offsite.readStatus(db), local: offsite.localBackupInfo(path.join(root, 'backups')), verdict: offsite.verdict(offsite.readStatus(db)) }); return; }
  const dry = flag('--dry-run');
  lock();
  const res = await offsite.run({ drive, db, dbFile, filesRoot, manifestFile, hex, dryRun: dry, log: (m) => console.error(m) });
  if (!dry) {
    offsite.writeStatus(db, res);
    // the owner is told once when the Drive is nearly full (and again only after it was fine in between); failures are reported by the health check
    const get = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value; const set = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
    if (res.ok && res.free_bytes != null) {
      if (res.free_bytes < offsite.LOW_SPACE_BYTES) {
        if (!get('offsite_lowspace_alerted')) {
          try { const { createStore } = require('../lib/store'); const { createWatchdog } = require('../lib/watchdog'); const store = createStore(db);
            await createWatchdog(db, store, { log: console.error }).tell(`⚠️ ב-Proton Drive נשארו פחות מ-2 ג״ב פנויים (${(res.free_bytes / 1024 ** 3).toFixed(1)} ג״ב). הגיבוי הלילי ימשיך, אבל כדאי לפנות מקום או להרחיב את החבילה.`); set('offsite_lowspace_alerted', new Date().toISOString()); } catch (e) { console.error('could not send the low-space notice:', e.message); }
        }
      } else if (get('offsite_lowspace_alerted')) db.prepare("DELETE FROM settings WHERE key='offsite_lowspace_alerted'").run();
    }
  }
  out(res);
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => { console.error(e.busy ? e.message : 'off-site backup failed: ' + e.message); process.exit(e.busy ? 0 : 1); });
