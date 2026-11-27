'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-offsite-'));
process.env.MESIMOT_DB_KEY_FILE = path.join(TMP, 'db.key'); process.env.MESIMOT_FILES = path.join(TMP, 'files'); process.env.MESIMOT_TMP = path.join(TMP, 'shm');
process.env.MESIMOT_SEMANTIC = '0'; process.env.MESIMOT_NO_OUTBOX_KEY = '1'; process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(TMP, 'ok');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const O = require('../lib/offsite');
const vault = require('../lib/vault');
const { loadKey, openRaw } = require('../lib/dbkey');

const R = O.REMOTE_ROOT;

test('remote path guard: only inside "Alex Tasks Backups", nothing else', () => {
  for (const ok of [R, R + '/db', R + '/files/2026/11/a.msg']) assert.equal(O.guardRemote(ok), ok);
  for (const bad of ['/', '/my-files', '/my-files/Other', '/my-files/Alex Tasks Backups2', '/my-files/Alex Tasks Backups2/x', R + '/../x', R + '/db/../../x', R + '//x', R + '/./x', R + '/', 'my-files/Alex Tasks Backups/x',
    '/shared-with-me/UID/x', R + '/a\\b', R + '/a\nb', '', null, undefined, 5, '/my-files/Alex Tasks Backups\0/x', '/trash/x']) assert.throws(() => O.guardRemote(bad), /refused/, String(bad));
  assert.throws(() => O.remoteJoin(R, '..', 'x'), /refused/);
});

test('the CLI wrapper refuses a path outside the folder before any command runs', () => {
  const calls = []; const d = O.createCliDrive({ run: (a) => { calls.push(a); return { code: 0, stdout: '[]', stderr: '' }; } });
  for (const f of [() => d.list('/my-files'), () => d.trash('/my-files/x'), () => d.deleteTrashed('/my-files/Documents/a'), () => d.upload(['/x'], '/my-files/Documents'), () => d.download('/my-files/x', '/tmp'), () => d.createFolder('/my-files', 'Other'), () => d.size('/')]) assert.throws(f, /refused/);
  assert.equal(calls.length, 0);
  d.list(R + '/db'); d.createFolder('/my-files', 'Alex Tasks Backups'); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['filesystem', 'list', '--json', R + '/db']);
});

test('the CLI wrapper reports "not logged in" clearly', () => {
  const d = O.createCliDrive({ run: () => ({ code: 1, stdout: '', stderr: 'You need to login first\n' }) });
  assert.throws(() => d.list(R), (e) => e.notLoggedIn === true && /auth login/.test(e.message));
});

test('local guard: only files inside the allowed roots, never a key or anything from a config directory', () => {
  const root = path.join(TMP, 'lg'); fs.mkdirSync(path.join(root, '.config'), { recursive: true }); fs.writeFileSync(path.join(root, 'a.msg'), 'x'); fs.writeFileSync(path.join(root, 'db.key'), 'k'); fs.writeFileSync(path.join(root, '.config', 'env'), 's');
  assert.ok(O.guardLocal(path.join(root, 'a.msg'), [root]));
  for (const bad of [path.join(root, 'db.key'), path.join(root, '.config', 'env'), process.env.MESIMOT_DB_KEY_FILE, path.join(os.homedir(), '.config', 'mesimot', 'db.key'), '/etc/passwd']) assert.throws(() => O.guardLocal(bad, [root]), /refused/, bad);
  const link = path.join(root, 'ln'); fs.symlinkSync('/etc/passwd', link); assert.throws(() => O.guardLocal(link, [root]), /refused/, 'a symlink out of the root');
});

test('retention: 7 daily + 4 Sunday copies, only our own names are ever dropped', () => {
  const day = (i) => new Date(Date.UTC(2026, 10, 27) - i * 86400000).toISOString().slice(0, 10); // 2026-11-27 is a Friday
  const items = [...Array(40).keys()].map((i) => ({ name: O.dbNameFor(day(i)), size: 100 }));
  const foreign = [{ name: 'notes.txt', size: 5 }, { name: 'mesimot-db-2026-13-99.db.zst.vault', size: 1 }, { name: 'mesimot-db-2026-11-20.db', size: 1 }];
  const r = O.selectRetention([...items, ...foreign], { budgetBytes: 0 });
  const dates = r.keep.map(O.parseDbName);
  assert.deepEqual(dates.slice(0, 7), [...Array(7).keys()].map(day), 'the newest 7 days');
  const sundays = dates.filter((d) => new Date(d + 'T12:00:00Z').getUTCDay() === 0); assert.equal(sundays.length, 4, 'four Sundays are kept');
  assert.equal(r.keep.length, 7 + 3, '7 daily (one of them a Sunday) + 3 more Sundays'); // 2026-11-22 is in the 7 days
  assert.ok(r.drop.every((n) => O.parseDbName(n)), 'only recognised names are dropped'); assert.ok(!r.drop.some((n) => /notes|2026-13|\.db$/.test(n)));
  assert.equal(r.keep.length + r.drop.length, 40, 'every valid copy is either kept or dropped');
});

test('retention budget: the oldest copies are thinned first, the two newest always stay', () => {
  const items = [...Array(11).keys()].map((i) => ({ name: O.dbNameFor(new Date(Date.UTC(2026, 10, 27) - i * 86400000).toISOString().slice(0, 10)), size: 1000 }));
  const r = O.selectRetention(items, { budgetBytes: 4500 });
  assert.equal(r.keep.length, 4); assert.deepEqual(r.keep, items.slice(0, 4).map((i) => i.name)); assert.ok(r.thinned.length > 0);
  const tiny = O.selectRetention(items, { budgetBytes: 1 }); assert.deepEqual(tiny.keep, items.slice(0, 2).map((i) => i.name));
});

test('manifest: only new files, changed files as revisions, nothing re-uploaded, atomic save', () => {
  const mf = path.join(TMP, 'm', 'manifest.json'); const m = O.loadManifest(mf); assert.deepEqual(m.files, {});
  const L = [{ rel: 'a/1.msg', size: 10, mtimeMs: 1000 }, { rel: 'a/2.msg', size: 20, mtimeMs: 2000 }];
  let p = O.planFiles(L, m); assert.equal(p.add.length, 2); assert.equal(p.changed.length, 0);
  for (const f of L) m.files[f.rel] = { size: f.size, mtimeMs: f.mtimeMs }; O.saveManifest(mf, m);
  const m2 = O.loadManifest(mf); p = O.planFiles(L, m2); assert.equal(p.add.length + p.changed.length, 0);
  p = O.planFiles([...L, { rel: 'b/3.msg', size: 5, mtimeMs: 5 }, { ...L[0], size: 11 }], m2); assert.deepEqual(p.add.map((f) => f.rel), ['b/3.msg']); assert.deepEqual(p.changed.map((f) => f.rel), ['a/1.msg']);
  fs.writeFileSync(mf, '{broken'); assert.deepEqual(O.loadManifest(mf).files, {}, 'a damaged manifest starts over (uploads are skipped when they already exist)');
});

test('compress -> encrypt -> decrypt -> decompress roundtrip; the sealed file has no readable content', async () => {
  const dir = path.join(TMP, 'rt'); fs.mkdirSync(dir, { recursive: true });
  const text = Buffer.from(('סודי-מאוד ' + 'שורה חוזרת '.repeat(50) + '\n').repeat(5000)); const plain = path.join(dir, 'p.bin'); fs.writeFileSync(plain, Buffer.concat([text, crypto.randomBytes(100000)]));
  const sealed = path.join(dir, 's.vault'); await O.sealFile(plain, sealed);
  assert.ok(vault.isEncrypted(sealed)); assert.ok(fs.statSync(sealed).size < fs.statSync(plain).size / 3, 'compressed before encrypting');
  assert.ok(!fs.readFileSync(sealed).includes(Buffer.from('סודי-מאוד')));
  const back = path.join(dir, 'b.bin'); await O.openFile(sealed, back); assert.ok(fs.readFileSync(back).equals(fs.readFileSync(plain)));
  const raw = fs.readFileSync(sealed); raw[raw.length - 20] ^= 1; fs.writeFileSync(sealed + '.bad', raw);
  await assert.rejects(() => O.openFile(sealed + '.bad', path.join(dir, 'x.bin')), 'a tampered copy is detected');
});

// an in-memory Proton Drive that enforces the same guard and keeps real bytes
function fakeDrive() {
  const nodes = new Map(); const log = []; // path -> {type, data}
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const d = {
    nodes, log,
    list(p) { O.guardRemote(p); const n = nodes.get(p); if (!n || n.type !== 'folder') { const e = new Error('not found'); throw e; } return [...nodes].filter(([k]) => parentOf(k) === p).map(([k, v]) => ({ name: k.slice(p.length + 1), type: v.type, size: v.data ? v.data.length : 0 })); },
    exists(p) { O.guardRemote(p); return nodes.has(p) && nodes.get(p).type === 'folder'; },
    createFolder(parent, name) { const p = O.remoteJoin(parent, name); log.push('mkdir ' + p); if (parent !== '/my-files' && !nodes.has(parent)) throw new Error('no parent'); nodes.set(p, { type: 'folder' }); },
    upload(locals, parent, { strategy }) { O.guardRemote(parent); log.push(`upload ${strategy} ${locals.length} -> ${parent}`); if (!nodes.has(parent)) throw new Error('no parent'); for (const l of locals) { const p = parent + '/' + path.basename(l); if (nodes.has(p) && strategy === 'skip') continue; nodes.set(p, { type: 'file', data: fs.readFileSync(l) }); } },
    download(p, dir) { O.guardRemote(p); fs.writeFileSync(path.join(dir, path.posix.basename(p)), nodes.get(p).data); },
    trash(p) { O.guardRemote(p); log.push('trash ' + p); const n = nodes.get(p); nodes.delete(p); nodes.set('TRASH:' + p, n); },
    deleteTrashed(p) { O.guardRemote(p); log.push('delete ' + p); nodes.delete('TRASH:' + p); },
    size(p) { return [...nodes].filter(([k, v]) => k.startsWith(p + '/') && v.data).reduce((a, [, v]) => a + v.data.length, 0); },
    freeSpace() { return 5 * 1024 ** 3; },
  };
  return d;
}

function setupInstance() {
  const dir = fs.mkdtempSync(path.join(TMP, 'inst-')); const files = path.join(dir, 'files'); fs.mkdirSync(path.join(files, '2026', '11'), { recursive: true }); fs.mkdirSync(path.join(files, 'voice'));
  const dbFile = path.join(dir, 'm.db'); const { open } = require('../lib/db'); const db = open(dbFile); db.prepare("INSERT INTO settings (key,value) VALUES ('probe','שלום')").run(); db.pragma('wal_checkpoint(TRUNCATE)');
  const mk = (rel, body, enc = true) => { const f = path.join(files, rel); if (enc) vault.writeFile(f, Buffer.from(body)); else fs.writeFileSync(f, body); return f; };
  return { dir, files, dbFile, db, mk, manifestFile: path.join(dir, 'manifest.json'), hex: loadKey({ file: dbFile }) };
}

test('end to end with a fake Drive: DB copy compressed+sealed, files incremental, retention only in db/, plain files and keys never leave, restore-test passes', async () => {
  const s = setupInstance(); s.mk('2026/11/a.msg', 'one'); s.mk('2026/11/b.pdf', 'two'); s.mk('voice/v.oga', 'three'); s.mk('2026/11/plain.txt', 'NOT ENCRYPTED', false);
  const drive = fakeDrive(); const opts = { drive, dbFile: s.dbFile, filesRoot: s.files, manifestFile: s.manifestFile, hex: s.hex, tmpDir: undefined };
  // pre-existing old copies: 12 daily ones, plus a foreign file in db/ that must survive
  drive.nodes.set(R, { type: 'folder' }); drive.nodes.set(R + '/db', { type: 'folder' }); drive.nodes.set(R + '/db/readme.txt', { type: 'file', data: Buffer.from('mine') });
  for (let i = 1; i <= 12; i++) drive.nodes.set(R + '/db/' + O.dbNameFor(new Date(Date.UTC(2026, 10, 27) - i * 86400000).toISOString().slice(0, 10)), { type: 'file', data: Buffer.alloc(10) });
  const dry = await O.run({ ...opts, now: new Date('2026-11-27T02:15:00Z'), dryRun: true }); assert.ok(dry.ok); assert.equal(dry.files.to_add, 3); assert.equal(dry.files.skipped_plain, 1); assert.deepEqual(drive.log, [], 'a dry run touches nothing');
  const r = await O.run({ ...opts, now: new Date('2026-11-27T02:15:00Z') });
  assert.ok(r.ok, r.error); assert.equal(r.files.uploaded, 3);
  const dbCopy = drive.nodes.get(R + '/db/' + O.dbNameFor('2026-11-27')); assert.ok(dbCopy, 'today\'s copy is on the Drive'); assert.ok(drive.nodes.has(R + '/db/readme.txt'), 'foreign files in db/ are never touched');
  assert.ok(!drive.log.some((l) => /^(trash|delete) /.test(l) && !l.includes(R + '/db/mesimot-db-')), 'deletes only our own copies');
  assert.ok(!drive.log.some((l) => /^(trash|delete) /.test(l) && l.includes(R + '/files')), 'nothing under files/ is ever deleted');
  assert.ok(drive.nodes.has(R + '/files/2026/11/a.msg') && drive.nodes.has(R + '/files/voice/v.oga'));
  assert.ok(![...drive.nodes.keys()].some((k) => /plain\.txt|\.key|\.config/.test(k)), 'plain files and keys never uploaded');
  // the stored files are uploaded exactly as on disk (still vault format)
  assert.ok(drive.nodes.get(R + '/files/2026/11/a.msg').data.equals(fs.readFileSync(path.join(s.files, '2026/11/a.msg'))));
  // the DB copy cannot be read without the key and contains no readable data
  assert.ok(!dbCopy.data.includes(Buffer.from('SQLite format 3')) && !dbCopy.data.includes(Buffer.from('probe')));
  assert.equal(drive.nodes.get(R + '/db/' + O.dbNameFor('2026-11-27')).data.subarray(0, 8).toString(), 'MSMVAULT');
  // retention: today + 6 more days + Sundays
  const names = [...drive.nodes.keys()].filter((k) => k.startsWith(R + '/db/mesimot-db-')); assert.ok(names.length <= 11 && names.length >= 7, String(names.length));
  // incremental: a second run uploads no files
  drive.log.length = 0; const r2 = await O.run({ ...opts, now: new Date('2026-11-27T02:20:00Z') }); assert.ok(r2.ok, r2.error); assert.equal(r2.files.to_add + r2.files.to_revise, 0); assert.ok(!drive.log.some((l) => /^upload/.test(l) && l.includes('Backups/files')), drive.log.join(' | '));
  // a changed file goes up as a new revision; a new one as new
  s.mk('2026/11/a.msg', 'one changed!'); s.mk('2026/11/c.msg', 'four'); drive.log.length = 0;
  const r3 = await O.run({ ...opts, now: new Date('2026-11-28T02:20:00Z') }); assert.ok(r3.ok, r3.error); assert.equal(r3.files.to_add, 1); assert.equal(r3.files.to_revise, 1);
  assert.ok(drive.log.some((l) => l.startsWith('upload create-new-revision 1'))); assert.ok(!drive.log.some((l) => /^(trash|delete) .*Backups\/files\//.test(l)));
  // restore test: download, decrypt, open, integrity_check
  const rt = await O.restoreTest({ drive, hex: s.hex }); assert.ok(rt.ok, JSON.stringify(rt)); assert.equal(rt.integrity, 'ok'); assert.equal(rt.name, O.dbNameFor('2026-11-28'));
  // no plaintext left anywhere in the private tmp root
  const left = fs.readdirSync(vault.tmpRoot()).filter((d) => d !== 'view'); assert.deepEqual(left, [], 'plaintext workspace removed');
});

test('a failed upload still removes the plaintext workspace and reports the error; not logged in is reported cleanly', async () => {
  const s = setupInstance(); s.mk('voice/v.oga', 'x'); const drive = fakeDrive(); drive.nodes.set(R, { type: 'folder' }); drive.nodes.set(R + '/db', { type: 'folder' }); drive.nodes.set(R + '/files', { type: 'folder' });
  drive.upload = () => { throw new Error('network down'); };
  const r = await O.run({ drive, dbFile: s.dbFile, filesRoot: s.files, manifestFile: s.manifestFile, hex: s.hex }); assert.equal(r.ok, false); assert.match(r.error, /network down/);
  assert.deepEqual(fs.readdirSync(vault.tmpRoot()).filter((d) => d !== 'view'), []);
  const d2 = { list() { const e = new Error('not logged in to Proton Drive (run: proton-drive auth login)'); e.notLoggedIn = true; throw e; } };
  const r2 = await O.run({ drive: d2, dbFile: s.dbFile, filesRoot: s.files, manifestFile: s.manifestFile, hex: s.hex }); assert.equal(r2.ok, false); assert.match(r2.error, /not logged in/);
});

test('status verdict: red after a failure or 36 hours without success; ok otherwise; silent before the first run', () => {
  const h = 3600000; const now = Date.parse('2026-11-27T10:00:00Z'); const iso = (ago) => new Date(now - ago).toISOString();
  assert.equal(O.verdict(null, now), null);
  assert.equal(O.verdict({ last_ok: true, last_success_at: iso(10 * h), last_run_at: iso(10 * h) }, now), 'ok');
  assert.match(O.verdict({ last_ok: false, last_error: 'network down', last_success_at: iso(5 * h) }, now), /נכשל.*network down/);
  assert.match(O.verdict({ last_ok: true, last_success_at: iso(37 * h) }, now), /37 שעות/);
  assert.equal(O.verdict({ last_ok: true, last_success_at: iso(35 * h) }, now), 'ok');
});

test('health: the off-site check is red on failure and the owner is told ONCE (no 6-hour repeat), then told when it recovers', async () => {
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createHealth } = require('../lib/health');
  const db = open(':memory:'); const store = createStore(db); const told = []; const state = { now: Date.parse('2026-11-27T10:00:00Z') };
  const h = createHealth(db, store, { nowMs: () => state.now, localUrl: 'http://x', password: '', apiToken: 't', backupDir: path.join(TMP, 'nob'), dbFile: path.join(TMP, 'none.db'), systemctl: () => ({ code: 0, stdout: 'active' }), fetch: async () => ({ ok: true, status: 200, json: async () => [] }), smoke: async () => ({ ok: true, facts: {}, problems: [] }), mailPing: async () => {}, tgToken: '', chrome: 'x', isQuiet: () => false, tell: async (t) => { told.push(t); return 'telegram'; } });
  const by = (r) => r.results.find((x) => x.id === 'data:offsite');
  assert.equal(by(await h.run()).status, 'ok', 'not started yet: silent');
  const set = (st) => db.prepare("INSERT INTO settings (key,value) VALUES ('offsite_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(st));
  set({ last_ok: true, last_success_at: new Date(state.now - 3600000).toISOString(), last_run_at: new Date(state.now - 3600000).toISOString() }); assert.equal(by(await h.run()).status, 'ok');
  set({ last_ok: false, last_error: 'לא מחובר', last_success_at: new Date(state.now - 3600000).toISOString() });
  assert.equal(by(await h.run()).status, 'red'); const n1 = told.filter((t) => /Proton/.test(t)).length; assert.equal(n1, 1);
  state.now += 7 * 3600000; await h.run(); state.now += 7 * 3600000; await h.run(); assert.equal(told.filter((t) => /Proton/.test(t) && /תקלה/.test(t)).length, 1, 'told once, not every 6 hours');
  set({ last_ok: true, last_success_at: new Date(state.now).toISOString(), last_run_at: new Date(state.now).toISOString() }); await h.run(); assert.equal(told.filter((t) => /חזר לפעול: גיבוי מוצפן/.test(t)).length, 1);
});

// ---- the key card: owner web session + password again, never the assistant's token, never cached, only "המפתח הוצג" in the log
test('key endpoint: needs the owner web session and the password; token is refused; no-store; the log never holds the key', async () => {
  const { open } = require('../lib/db'); const auth = require('../lib/auth'); const { build } = require('../lib/server');
  const db = open(path.join(TMP, 'api.db')); auth.setPassword(db, 'correct horse battery'); const app = build({ db, token: 'tok', loginDelayMs: 0 });
  const key = loadKey({ file: path.join(TMP, 'api.db') });
  const inj = (o) => app.inject({ method: 'POST', url: '/api/backup/key', payload: { password: 'correct horse battery' }, ...o });
  assert.equal((await inj({ headers: { authorization: 'Bearer tok' } })).statusCode, 403, 'the assistant token is refused even with the right password');
  assert.equal((await inj({})).statusCode, 401, 'no session');
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct horse battery' } }); const cookie = login.headers['set-cookie'].split(';')[0];
  const H = { cookie, 'x-mesimot': '1' };
  const bad = await inj({ headers: H, payload: { password: 'nope' } }); assert.equal(bad.statusCode, 403); assert.ok(!bad.body.includes(key));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE entity='security'").get().n, 0, 'a wrong password logs nothing');
  const ok = await inj({ headers: H }); assert.equal(ok.statusCode, 200); assert.equal(ok.json().key, key); assert.match(ok.headers['cache-control'], /no-store/);
  const ev = db.prepare("SELECT * FROM events WHERE entity='security'").all(); assert.equal(ev.length, 1); assert.equal(ev[0].new_value, 'המפתח הוצג'); assert.ok(!JSON.stringify(ev).includes(key));
  const act = await app.inject({ method: 'GET', url: '/api/activity', headers: { authorization: 'Bearer tok' } }); assert.equal(act.json().security[0].new_value, 'המפתח הוצג'); assert.ok(!act.body.includes(key));
  const st = await app.inject({ method: 'GET', url: '/api/backup/status', headers: { authorization: 'Bearer tok' } }); assert.equal(st.statusCode, 200); assert.ok(!st.body.includes(key)); assert.equal(st.json().offsite.configured, false);
});

test('key endpoint is rate limited like the login (lock after repeated wrong passwords)', async () => {
  const { open } = require('../lib/db'); const auth = require('../lib/auth'); const { build } = require('../lib/server');
  const db = open(path.join(TMP, 'api2.db')); auth.setPassword(db, 'correct horse battery'); const app = build({ db, token: 'tok', loginDelayMs: 0 });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct horse battery' } }); const H = { cookie: login.headers['set-cookie'].split(';')[0], 'x-mesimot': '1' };
  let last; for (let i = 0; i < 6; i++) last = await app.inject({ method: 'POST', url: '/api/backup/key', headers: H, payload: { password: 'wrong' + i } });
  assert.equal(last.statusCode, 429);
  const right = await app.inject({ method: 'POST', url: '/api/backup/key', headers: H, payload: { password: 'correct horse battery' } }); assert.equal(right.statusCode, 429, 'locked even for the right password');
  auth.resetFailures && auth.resetFailures();
});
