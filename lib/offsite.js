'use strict';
// Nightly encrypted off-site backup to Proton Drive (official Proton Drive CLI), see docs/BACKUP.md.
// Everything that leaves this machine is already encrypted with the vault key (lib/vault.js): the database is compressed FIRST (encrypted data does not compress), then sealed;
// the stored files are uploaded exactly as they are on disk (vault format). The plaintext copy of the database exists only in the private /dev/shm directory and is always removed.
// Safety rules enforced in CODE (and unit-tested): every remote path must lie inside REMOTE_ROOT; local files must lie inside the allowed roots and never be a key or anything under ~/.config;
// remote deletion exists only for our own database copies inside <root>/db; nothing under <root>/files is ever deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');

const REMOTE_ROOT = '/my-files/Alex Tasks Backups';
const DB_DIR = REMOTE_ROOT + '/db';
const FILES_DIR = REMOTE_ROOT + '/files';
const DB_PREFIX = 'mesimot-db-';
const DB_SUFFIX = '.db.zst.vault';
const DB_NAME = /^mesimot-db-(\d{4})-(\d{2})-(\d{2})\.db\.zst\.vault$/;
const KEEP_DAILY = 7, KEEP_WEEKLY = 4;
const BUDGET_BYTES = 10 * 1024 ** 3;
const LOW_SPACE_BYTES = 2 * 1024 ** 3;
const STALE_MS = 36 * 3600000;
const BIN = process.env.MESIMOT_PROTON_DRIVE || path.join(os.homedir(), '.local', 'opt', 'proton-drive', 'proton-drive');

// ---------- safety guards
function guardRemote(p) {
  if (typeof p !== 'string' || !p || /[\0\\\r\n\t]/.test(p)) throw new Error(`remote path refused: ${JSON.stringify(String(p).slice(0, 80))}`);
  const segs = p.split('/');
  if (segs[0] !== '' || segs.slice(1).some((s) => s === '' || s === '.' || s === '..')) throw new Error(`remote path refused (not canonical): ${p}`);
  if (p !== REMOTE_ROOT && !p.startsWith(REMOTE_ROOT + '/')) throw new Error(`remote path refused (outside "${REMOTE_ROOT}"): ${p}`);
  return p;
}
const remoteJoin = (...parts) => guardRemote(parts.join('/'));

// a local file may be uploaded only from inside one of the roots, never a key and never from a config directory
function guardLocal(file, roots) {
  let real; try { real = fs.realpathSync(file); } catch { throw new Error(`local path refused (not found): ${file}`); }
  const ok = (roots || []).some((r) => { let rr; try { rr = fs.realpathSync(r); } catch { return false; } return real.startsWith(rr + path.sep); });
  if (!ok) throw new Error(`local path refused (outside the backup roots): ${file}`);
  if (/\.key(\.|$)/.test(path.basename(real)) || /(^|\/)\.config(\/|$)/.test(real) || /db\.key/.test(real)) throw new Error(`local path refused (key or configuration): ${file}`);
  return real;
}

// ---------- retention
const dbNameFor = (date) => `${DB_PREFIX}${date}${DB_SUFFIX}`;
function parseDbName(name) {
  const m = DB_NAME.exec(name); if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`); // a name with an impossible date (2026-13-99) is not ours
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const isSunday = (date) => new Date(date + 'T12:00:00Z').getUTCDay() === 0;
// items: [{name, size?}] (names that are not ours are ignored and never dropped). Keeps the newest 7 daily copies and the newest 4 Sunday copies.
// budgetBytes: if the kept copies together exceed it, the oldest are thinned out, but the 2 newest are never dropped.
function selectRetention(items, { budgetBytes = BUDGET_BYTES, keepDaily = KEEP_DAILY, keepWeekly = KEEP_WEEKLY } = {}) {
  const ours = items.map((i) => ({ ...i, date: parseDbName(i.name) })).filter((i) => i.date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  const keep = new Set();
  ours.slice(0, keepDaily).forEach((i) => keep.add(i.name));
  ours.filter((i) => isSunday(i.date)).slice(0, keepWeekly).forEach((i) => keep.add(i.name));
  let kept = ours.filter((i) => keep.has(i.name));
  let thinned = [];
  if (budgetBytes) {
    let total = kept.reduce((a, i) => a + (i.size || 0), 0);
    while (total > budgetBytes && kept.length > 2) { const old = kept[kept.length - 1]; kept = kept.slice(0, -1); keep.delete(old.name); total -= old.size || 0; thinned.push(old.name); }
  }
  const drop = ours.filter((i) => !keep.has(i.name)).map((i) => i.name);
  return { keep: kept.map((i) => i.name), drop, thinned };
}

// ---------- manifest of uploaded files (incremental)
function loadManifest(file) { try { const m = JSON.parse(fs.readFileSync(file, 'utf8')); return m && m.files ? m : { v: 1, files: {} }; } catch { return { v: 1, files: {} }; } }
function saveManifest(file, m) { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(m), { mode: 0o600 }); fs.renameSync(t, file); }
// local: [{rel, size, mtimeMs}]. new = never uploaded; changed = size or mtime differs (uploaded as a new revision, nothing is deleted)
function planFiles(local, manifest) {
  const add = [], changed = [];
  for (const f of local) {
    const m = manifest.files[f.rel];
    if (!m) add.push(f); else if (m.size !== f.size || Math.abs(m.mtimeMs - f.mtimeMs) > 1) changed.push(f);
  }
  return { add, changed };
}
function walk(root) {
  const out = [];
  (function rec(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) rec(p, r);
      else if (e.isFile() && !/\.(tmp|part)$|\.vault-\d+-[0-9a-f]+\.tmp$/.test(e.name)) { const st = fs.statSync(p); out.push({ rel: r, abs: p, size: st.size, mtimeMs: st.mtimeMs }); }
    }
  })(root, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// ---------- compress -> encrypt -> decrypt -> decompress
const compressor = () => (typeof zlib.createZstdCompress === 'function' ? zlib.createZstdCompress() : null);
const decompressor = () => zlib.createZstdDecompress();
async function sealFile(plainFile, outFile, keys) {
  const vault = require('./vault'); const z = compressor();
  if (!z) throw new Error('zstd is not available in this Node version');
  await pipeline(fs.createReadStream(plainFile), z, vault.encryptStream(keys), fs.createWriteStream(outFile, { mode: 0o600 }));
}
async function openFile(sealed, plainOut, keys) {
  const vault = require('./vault');
  await pipeline(fs.createReadStream(sealed), vault.decryptStream(keys), decompressor(), fs.createWriteStream(plainOut, { mode: 0o600 }));
}

// consistent snapshot of the live encrypted database as a PLAIN sqlite file (VACUUM INTO under the read lock, then the encryption is removed from the copy)
function plainSnapshot(srcFile, destFile, hex) {
  const { openRaw } = require('./dbkey');
  const d = openRaw(srcFile, { hex, readonly: true });
  try { d.exec(`VACUUM INTO '${destFile.replace(/'/g, "''")}'`); } finally { d.close(); }
  const p = openRaw(destFile, { hex }); try { p.pragma("rekey = ''"); } finally { p.close(); }
  for (const s of ['-wal', '-shm', '-journal']) { try { fs.unlinkSync(destFile + s); } catch { /* none */ } }
}

// ---------- the Proton Drive CLI behind one interface; every remote path goes through guardRemote
function createCliDrive({ bin = BIN, run = null } = {}) {
  const exec = run || ((args) => { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 6 * 3600000, maxBuffer: 256 * 1024 * 1024 }); return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }; });
  const call = (args, what) => { const r = exec(args); if (r.code !== 0) { const msg = `${what}: ${(r.stderr || r.stdout || '').trim().split('\n')[0].slice(0, 200)}`; const e = new Error(/login/i.test(msg) ? 'not logged in to Proton Drive (run: proton-drive auth login)' : msg); e.notLoggedIn = /login first|not logged/i.test(r.stderr + r.stdout); throw e; } return r.stdout; };
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const items = (j) => (Array.isArray(j) ? j : j && (j.items || j.nodes || j.entries || j.children || j.result || j.data)) || [];
  const norm = (n) => ({ name: n.name ?? n.Name ?? n.node?.name, type: /folder|dir/i.test(String(n.type ?? n.kind ?? n.Type ?? n.node?.type ?? '')) ? 'folder' : 'file', size: Number(n.size ?? n.Size ?? n.totalStorageSize ?? n.claimedSize ?? n.activeRevision?.claimedSize ?? 0) || 0 });
  return {
    list(p) { const out = call(['filesystem', 'list', '--json', guardRemote(p)], 'list'); return items(parse(out) || []).map(norm).filter((n) => n.name); },
    exists(p) { try { this.list(p); return true; } catch (e) { if (e.notLoggedIn) throw e; return false; } },
    createFolder(parent, name) { guardRemote(remoteJoin(parent, name)); call(['filesystem', 'create-folder', '--json', parent, name], 'create-folder'); },
    upload(locals, parent, { strategy = 'skip' } = {}) { guardRemote(parent); call(['filesystem', 'upload', '--json', '-t', '-f', strategy, '-d', 'merge', ...locals, parent], 'upload'); },
    download(p, localFolder) { call(['filesystem', 'download', '--json', '-f', 'remove', '-d', 'merge', guardRemote(p), localFolder], 'download'); },
    trash(p) { call(['filesystem', 'trash', '--json', guardRemote(p)], 'trash'); },
    deleteTrashed(p) { call(['filesystem', 'delete', '--json', guardRemote(p)], 'delete'); },
    size(p) { guardRemote(p); try { const j = parse(call(['filesystem', 'size', '--json', p], 'size')); const n = typeof j === 'number' ? j : Number(j?.size ?? j?.totalSize ?? j?.bytes ?? j?.Size); return Number.isFinite(n) ? n : null; } catch { return null; } },
    freeSpace() { try { const j = parse(call(['filesystem', 'info', '--json', '/my-files'], 'info')); const f = j?.quota?.free ?? j?.free ?? j?.available; if (Number.isFinite(+f)) return +f; const m = j?.quota?.max ?? j?.maxSpace, u = j?.quota?.used ?? j?.usedSpace; return Number.isFinite(+m) && Number.isFinite(+u) && +m > 0 ? +m - +u : null; } catch { return null; } },
  };
}
function ensureFolder(drive, p) {
  guardRemote(p);
  if (drive.exists(p)) return;
  const i = p.lastIndexOf('/'); const parent = p.slice(0, i), name = p.slice(i + 1);
  if (p !== REMOTE_ROOT) ensureFolder(drive, parent);
  drive.createFolder(parent, name);
}

// ---------- the job
const jerusalemDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);

async function run({ drive, db = null, dbFile, filesRoot, manifestFile, keys = null, hex, now = new Date(), dryRun = false, log = () => {}, tmpDir = null, batch = 40, budgetBytes = BUDGET_BYTES }) {
  const res = { ok: false, started_at: now.toISOString(), dry_run: dryRun, db: null, files: null, error: null };
  const date = jerusalemDate(now);
  const manifest = loadManifest(manifestFile);
  const local = walk(filesRoot);
  // only files already in the vault format leave the machine; a plain file (not migrated yet) is never uploaded
  const vault = require('./vault'); const plainSkipped = [];
  const sealed = local.filter((f) => { if (vault.isEncrypted(f.abs)) return true; plainSkipped.push(f.rel); return false; });
  const plan = planFiles(sealed, manifest);
  res.files = { total: local.length, to_add: plan.add.length, to_revise: plan.changed.length, bytes: [...plan.add, ...plan.changed].reduce((a, f) => a + f.size, 0), skipped_plain: plainSkipped.length, uploaded: 0, uploaded_bytes: 0 };
  res.db = { name: dbNameFor(date) };
  if (dryRun) { res.ok = true; res.finished_at = new Date().toISOString(); return res; }

  const dir = tmpDir || vault.tmpDir('offsite-');
  try {
    drive.list(REMOTE_ROOT).length; // login check and existence (throws when not logged in; folder created below)
  } catch (e) { if (e.notLoggedIn) { res.error = e.message; res.finished_at = new Date().toISOString(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } return res; } }
  try {
    ensureFolder(drive, REMOTE_ROOT); ensureFolder(drive, DB_DIR); ensureFolder(drive, FILES_DIR);
    // 1. database: plain snapshot (only in the private tmp dir) -> zstd -> vault -> upload
    const snap = path.join(dir, 'snapshot.db'); const out = path.join(dir, dbNameFor(date));
    plainSnapshot(dbFile, snap, hex);
    await sealFile(snap, out, keys); fs.rmSync(snap, { force: true });
    const outSize = fs.statSync(out).size;
    drive.upload([guardLocal(out, [dir])], DB_DIR, { strategy: 'replace' });
    const after = drive.list(DB_DIR).find((i) => i.name === dbNameFor(date));
    if (!after || (after.size && after.size !== outSize)) throw new Error('the uploaded database copy was not found or has the wrong size');
    res.db.bytes = outSize;
    // retention, only inside <root>/db and only our own names
    const sel = selectRetention(drive.list(DB_DIR), { budgetBytes });
    for (const n of sel.drop) { const p = remoteJoin(DB_DIR, n); drive.trash(p); try { drive.deleteTrashed(p); } catch (e) { log('delete after trash failed: ' + e.message); } }
    res.db.copies = sel.keep.length; res.db.removed = sel.drop.length; res.db.thinned = sel.thinned.length;
    // 2. files: new ones only, grouped per folder; the manifest is updated only for files seen on the Drive afterwards
    const byDir = new Map();
    for (const f of [...plan.add.map((f) => ({ f, strat: 'skip' })), ...plan.changed.map((f) => ({ f, strat: 'create-new-revision' }))]) {
      const d = path.posix.dirname(f.f.rel); const k = d + '|' + f.strat; if (!byDir.has(k)) byDir.set(k, []); byDir.get(k).push(f.f);
    }
    for (const [k, list] of byDir) {
      const rd = k.split('|')[0]; const strat = k.split('|')[1];
      const remoteDir = rd === '.' ? FILES_DIR : remoteJoin(FILES_DIR, rd);
      ensureFolder(drive, remoteDir);
      for (let i = 0; i < list.length; i += batch) {
        const part = list.slice(i, i + batch);
        drive.upload(part.map((f) => guardLocal(f.abs, [filesRoot])), remoteDir, { strategy: strat });
        const present = new Map(drive.list(remoteDir).map((x) => [x.name, x]));
        for (const f of part) { if (present.has(path.posix.basename(f.rel))) { manifest.files[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, at: new Date().toISOString() }; res.files.uploaded++; res.files.uploaded_bytes += f.size; } }
        saveManifest(manifestFile, manifest);
      }
    }
    // 3. numbers for the status card
    const used = drive.size(REMOTE_ROOT);
    res.remote_bytes = used ?? (drive.list(DB_DIR).reduce((a, i) => a + i.size, 0) + Object.values(manifest.files).reduce((a, m) => a + m.size, 0));
    res.free_bytes = drive.freeSpace();
    if (res.files.uploaded < res.files.to_add + res.files.to_revise) throw new Error(`${res.files.to_add + res.files.to_revise - res.files.uploaded} files were not confirmed on the Drive (they will be retried tomorrow)`);
    res.ok = true;
  } catch (e) { res.error = String(e.message || e).slice(0, 300); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  res.finished_at = new Date().toISOString();
  return res;
}

// download the newest database copy, decrypt, open, integrity_check. Nothing is swapped. Returns {ok, name, integrity, tables}.
async function restoreTest({ drive, hex, keys = null, tmpDir = null }) {
  const vault = require('./vault'); const dir = tmpDir || vault.tmpDir('offsite-restore-');
  try {
    const copies = drive.list(DB_DIR).map((i) => ({ ...i, date: parseDbName(i.name) })).filter((i) => i.date).sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!copies.length) throw new Error('no database copy found in the Proton Drive folder');
    const c = copies[0]; drive.download(remoteJoin(DB_DIR, c.name), dir);
    const sealed = path.join(dir, c.name); const plain = path.join(dir, 'restored.db');
    await openFile(sealed, plain, keys);
    const { openRaw } = require('./dbkey'); const d = openRaw(plain, { mode: 'plain', readonly: true });
    try { const integrity = d.pragma('integrity_check', { simple: true }); const tables = d.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n; return { ok: integrity === 'ok' && tables > 0, name: c.name, integrity, tables, bytes: fs.statSync(plain).size }; } finally { d.close(); }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// ---------- status kept in the settings table (read by the Settings card and by the health check)
const STATUS_KEY = 'offsite_status';
function readStatus(db) { try { return JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(STATUS_KEY)?.value || 'null'); } catch { return null; } }
function writeStatus(db, res) {
  const prev = readStatus(db) || {};
  const st = { ...prev, last_run_at: res.finished_at, last_ok: res.ok, last_error: res.error, last_dry: false };
  if (res.ok) { st.last_success_at = res.finished_at; st.db = res.db; st.files_uploaded_last = res.files?.uploaded; st.remote_bytes = res.remote_bytes; st.free_bytes = res.free_bytes; }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(STATUS_KEY, JSON.stringify(st));
  return st;
}
// the health verdict: null (nothing to say yet), 'ok', or a Hebrew problem text. Red when the last run failed or there was no success for 36 hours.
function verdict(st, nowMs = Date.now()) {
  if (!st) return null;
  if (st.last_ok === false) return `הגיבוי הלילי נכשל: ${st.last_error || 'שגיאה לא ידועה'}`;
  if (st.last_success_at && nowMs - Date.parse(st.last_success_at) > STALE_MS) return `לא היה גיבוי מוצלח ל-Proton Drive כבר ${Math.round((nowMs - Date.parse(st.last_success_at)) / 3600000)} שעות`;
  if (!st.last_success_at && st.last_run_at && nowMs - Date.parse(st.last_run_at) > STALE_MS) return 'עדיין לא היה גיבוי מוצלח ל-Proton Drive';
  return 'ok';
}
function localBackupInfo(dir) {
  let newest = 0, n = 0; try { for (const f of fs.readdirSync(dir)) if (/^mesimot-.*\.db(\.gz)?$/.test(f)) { n++; newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); } } catch { /* none */ }
  return { last_at: newest ? new Date(newest).toISOString() : null, copies: n };
}

module.exports = { REMOTE_ROOT, DB_DIR, FILES_DIR, BIN, STALE_MS, BUDGET_BYTES, LOW_SPACE_BYTES, guardRemote, guardLocal, remoteJoin, dbNameFor, parseDbName, selectRetention, loadManifest, saveManifest, planFiles, walk, sealFile, openFile, plainSnapshot, createCliDrive, ensureFolder, run, restoreTest, readStatus, writeStatus, verdict, localBackupInfo, jerusalemDate };
