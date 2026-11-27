'use strict';
// The vault: every stored file (attachments, mail files, voice notes, documents under files/) is encrypted at rest with AES-256-GCM.
// All readers and writers of those files go through this module. Plaintext only ever exists in memory or, for external tools (pdftotext, tesseract,
// ffmpeg, the assistant's Read tool), in a private 0700 directory under /dev/shm that is removed right after use (try/finally) and swept if a crash leaves one.
//
// File format (version 1):  "MSMVAULT" | version(1) | key id(4) | salt(16) | chunk size(4, big endian) | chunks...
//   every chunk is AES-256-GCM(plain chunk) + 16-byte tag; the nonce is the chunk counter (12 bytes), the key is unique per file:
//   HKDF-SHA256(files key, salt=file salt), the files key is HKDF-SHA256(master key, info "mesimot-files-v1"). The header and a "last chunk" flag are
//   authenticated with every chunk, so a changed header, a reordered, removed or truncated chunk is detected.
// Files that do not start with the magic are plain (not migrated yet) and are passed through unchanged, so old and new files can coexist.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const { loadKey, deriveKey } = require('./dbkey');

const MAGIC = Buffer.from('MSMVAULT');
const VERSION = 1;
const HEADER = 33;
const TAG = 16;
const CHUNK = 64 * 1024;
const INFO_FILES = 'mesimot-files-v1';

// ---- keys
const keyCache = new Map();
function filesKeyFor(masterHex) { let k = keyCache.get(masterHex); if (!k) { k = deriveKey(INFO_FILES, masterHex); keyCache.set(masterHex, k); } return k; }
const keyIdOf = (filesKey) => crypto.createHash('sha256').update(filesKey).digest().subarray(0, 4);
const fileKey = (filesKey, salt) => Buffer.from(crypto.hkdfSync('sha256', filesKey, salt, Buffer.from('mesimot-file'), 32));
function masterHex() { return loadKey({ create: true, file: process.env.MESIMOT_DB || process.env.MESIMOT_FILES || null }); }

// a keyring is a list of master keys (hex): the first encrypts, all of them decrypt (used while a key is being rotated)
function ring(keys) { const list = (keys && keys.length ? keys : [masterHex()]).map((h) => filesKeyFor(h)); return { enc: list[0], byId: new Map(list.map((k) => [keyIdOf(k).toString('hex'), k])) }; }

// ---- chunk crypto
function nonce(i) { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(i), 4); return n; }
function sealChunk(key, header, i, plain, last) { const c = crypto.createCipheriv('aes-256-gcm', key, nonce(i)); c.setAAD(Buffer.concat([header, Buffer.from([last ? 1 : 0])])); const ct = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([ct, c.getAuthTag()]); }
function openChunk(key, header, i, data, last) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(i)); d.setAAD(Buffer.concat([header, Buffer.from([last ? 1 : 0])])); d.setAuthTag(data.subarray(data.length - TAG));
  try { return Buffer.concat([d.update(data.subarray(0, data.length - TAG)), d.final()]); } catch { throw vaultError('the file is damaged or was tampered with (authentication failed)'); }
}
function vaultError(m, code = 'EVAULT') { const e = new Error(m); e.code = code; return e; }
function newHeader(filesKey) { const h = Buffer.alloc(HEADER); MAGIC.copy(h, 0); h[8] = VERSION; keyIdOf(filesKey).copy(h, 9); crypto.randomBytes(16).copy(h, 13); h.writeUInt32BE(CHUNK, 29); return h; }
function parseHeader(h, r) {
  if (h.length < HEADER || !h.subarray(0, 8).equals(MAGIC)) throw vaultError('not a vault file');
  if (h[8] !== VERSION) throw vaultError('unknown vault version ' + h[8]);
  const fk = r.byId.get(h.subarray(9, 13).toString('hex')); if (!fk) throw vaultError('the file was encrypted with a key that is not available', 'EVAULTKEY');
  const cs = h.readUInt32BE(29); if (cs < 1024 || cs > 16 * 1024 * 1024) throw vaultError('bad chunk size');
  return { key: fileKey(fk, h.subarray(13, 29)), chunk: cs };
}

// ---- detection and sizes
function isEncrypted(file) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return false; }
  try { const b = Buffer.alloc(8); return fs.readSync(fd, b, 0, 8, 0) === 8 && b.equals(MAGIC); } finally { fs.closeSync(fd); }
}
// size of the content (the file's own size when it is not encrypted yet)
function plainSize(file) {
  const st = fs.statSync(file); if (!isEncrypted(file)) return st.size;
  const fd = fs.openSync(file, 'r'); try { const h = Buffer.alloc(HEADER); fs.readSync(fd, h, 0, HEADER, 0); const cs = h.readUInt32BE(29); const body = st.size - HEADER; const n = Math.max(1, Math.ceil(body / (cs + TAG))); return body - n * TAG; } finally { fs.closeSync(fd); }
}

// ---- streams
function encryptStream(keys) {
  const r = ring(keys); const header = newHeader(r.enc); const key = fileKey(r.enc, header.subarray(13, 29));
  let buf = Buffer.alloc(0), i = 0, started = false;
  return new Transform({
    transform(c, _e, cb) { try { if (!started) { this.push(header); started = true; } buf = buf.length ? Buffer.concat([buf, c]) : c; while (buf.length > CHUNK) { this.push(sealChunk(key, header, i++, buf.subarray(0, CHUNK), false)); buf = buf.subarray(CHUNK); } cb(); } catch (e) { cb(e); } },
    flush(cb) { try { if (!started) this.push(header); this.push(sealChunk(key, header, i++, buf, true)); cb(); } catch (e) { cb(e); } },
  });
}
function decryptStream(keys) {
  const r = ring(keys); let buf = Buffer.alloc(0), header = null, key = null, cs = 0, i = 0;
  return new Transform({
    transform(c, _e, cb) {
      try {
        buf = buf.length ? Buffer.concat([buf, c]) : c;
        if (!header) { if (buf.length < HEADER) return cb(); header = buf.subarray(0, HEADER); ({ key, chunk: cs } = parseHeader(header, r)); buf = buf.subarray(HEADER); }
        while (buf.length > cs + TAG) { this.push(openChunk(key, header, i++, buf.subarray(0, cs + TAG), false)); buf = buf.subarray(cs + TAG); }
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) { try { if (!header) throw vaultError('the file is truncated'); if (buf.length < TAG) throw vaultError('the file is truncated'); this.push(openChunk(key, header, i++, buf, true)); cb(); } catch (e) { cb(e); } },
  });
}

// plaintext stream of a stored file (decrypted on the fly; a plain file is passed through)
function createReadStream(file, { keys } = {}) {
  if (!isEncrypted(file)) return fs.createReadStream(file);
  const src = fs.createReadStream(file); const dec = decryptStream(keys);
  src.on('error', (e) => dec.destroy(e)); dec.on('close', () => src.destroy());
  return src.pipe(dec);
}
// ciphertext -> plain buffer / buffer -> ciphertext file
function readFile(file, { keys } = {}) {
  const raw = fs.readFileSync(file);
  if (!raw.subarray(0, 8).equals(MAGIC)) return raw;
  const r = ring(keys); const header = raw.subarray(0, HEADER); const { key, chunk } = parseHeader(header, r);
  const out = []; let off = HEADER, i = 0;
  while (true) { const rest = raw.length - off; if (rest < TAG) throw vaultError('the file is truncated'); const last = rest <= chunk + TAG; const len = last ? rest : chunk + TAG; out.push(openChunk(key, header, i++, raw.subarray(off, off + len), last)); off += len; if (last) break; }
  return Buffer.concat(out);
}
const tmpName = (file) => `${file}.vault-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
function writeFile(file, buffer, { keys, mode = 0o600 } = {}) {
  const r = ring(keys); const header = newHeader(r.enc); const key = fileKey(r.enc, header.subarray(13, 29));
  const parts = [header]; let i = 0, off = 0;
  while (buffer.length - off > CHUNK) { parts.push(sealChunk(key, header, i++, buffer.subarray(off, off + CHUNK), false)); off += CHUNK; }
  parts.push(sealChunk(key, header, i++, buffer.subarray(off), true));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpName(file); fs.writeFileSync(tmp, Buffer.concat(parts), { mode }); fs.renameSync(tmp, file);
}
// a readable (plain bytes) -> encrypted file, atomically; resolves { size, sha256 } of the plain content
async function writeStream(file, readable, { keys, mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpName(file); const h = crypto.createHash('sha256'); let size = 0;
  const meter = new Transform({ transform(c, _e, cb) { h.update(c); size += c.length; cb(null, c); } });
  try { await pipeline(readable, meter, encryptStream(keys), fs.createWriteStream(tmp, { mode })); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
  return { size, sha256: h.digest('hex') };
}
async function sha256(file, { keys } = {}) { const h = crypto.createHash('sha256'); for await (const c of createReadStream(file, { keys })) h.update(c); return h.digest('hex'); }

function shred(file) { const r = spawnSync('shred', ['-n', '1', '-u', file]); if (r.status !== 0) { try { fs.unlinkSync(file); } catch { /* gone */ } } }

// encrypts a plain file in place (atomic swap, content verified by hash before the plaintext is shredded). Returns the sha256 of the content, or false when it was already
// encrypted. Throws (and leaves the plain file untouched) when the file changed while it was being encrypted: the caller tries again later.
async function seal(file, { keys } = {}) {
  if (isEncrypted(file)) return false;
  const st = fs.statSync(file); const tmp = tmpName(file);
  const { sha256: want } = await writeStream(tmp, fs.createReadStream(file), { keys, mode: st.mode & 0o777 || 0o600 }).catch((e) => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; });
  let got; try { got = await sha256(tmp, { keys }); } catch (e) { fs.unlinkSync(tmp); throw e; }
  if (got !== want) { fs.unlinkSync(tmp); throw vaultError('verification failed: the encrypted copy does not decrypt to the original'); }
  const now = fs.statSync(file); if (now.ino !== st.ino || now.size !== st.size || now.mtimeMs !== st.mtimeMs) { fs.unlinkSync(tmp); throw vaultError('the file changed while it was being encrypted', 'EVAULTBUSY'); }
  const old = `${file}.old-${process.pid}`; fs.linkSync(file, old); fs.renameSync(tmp, file); // readers now get the encrypted file; the old inode lives on under another name only to be wiped
  shred(old);
  return want;
}
// re-encrypts a file with another key (rotation). `from` and `to` are master keys (hex). Returns false when it already uses the new key.
async function reseal(file, from, to) {
  if (!isEncrypted(file)) return seal(file, { keys: [to] });
  const toRing = ring([to]); const head = Buffer.alloc(HEADER); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, HEADER, 0); fs.closeSync(fd);
  if (toRing.byId.has(head.subarray(9, 13).toString('hex'))) return false;
  const tmp = tmpName(file); const mode = fs.statSync(file).mode & 0o777;
  const { sha256: want } = await writeStream(tmp, createReadStream(file, { keys: [from] }), { keys: [to], mode });
  if ((await sha256(tmp, { keys: [to] })) !== want) { fs.unlinkSync(tmp); throw vaultError('verification failed while re-encrypting'); }
  const old = `${file}.old-${process.pid}`; fs.linkSync(file, old); fs.renameSync(tmp, file); shred(old);
  return true;
}

// ---- temporary plaintext (external tools): /dev/shm, private, always removed
function tmpRoot() {
  const base = process.env.MESIMOT_TMP || (fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir());
  const dir = path.join(base, `mesimot-vault-${typeof process.getuid === 'function' ? process.getuid() : 'u'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  return dir;
}
function tmpDir(prefix = 't-') { return fs.mkdtempSync(path.join(tmpRoot(), prefix)); }
// removes leftovers of crashed runs (older than maxAgeMs)
function sweepTmp(maxAgeMs = 3 * 3600 * 1000) {
  let n = 0; let root; try { root = tmpRoot(); } catch { return 0; }
  for (const d of fs.readdirSync(root)) { const p = path.join(root, d); try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { recursive: true, force: true }); n++; } } catch { /* raced */ } }
  return n;
}
const safeBase = (file) => path.basename(file).replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';
// fn(pathToPlainCopy); a plain (not yet encrypted) file is used where it is, no copy is made
function withPlainSync(file, fn) {
  if (!isEncrypted(file)) return fn(file);
  const dir = tmpDir('p-'); const p = path.join(dir, safeBase(file));
  try { fs.writeFileSync(p, readFile(file), { mode: 0o600 }); return fn(p); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function withPlain(file, fn) {
  if (!isEncrypted(file)) return fn(file);
  const dir = tmpDir('p-'); const p = path.join(dir, safeBase(file));
  try { await pipeline(createReadStream(file), fs.createWriteStream(p, { mode: 0o600 })); return await fn(p); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// a copy the assistant may open with its Read tool (named like the original so the extension tells the type); kept until sweepViews() / the end of the run
function viewRoot() { const d = path.join(tmpRoot(), 'view'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
function viewCopy(file, name) {
  if (!isEncrypted(file)) return file;
  const dir = fs.mkdtempSync(path.join(viewRoot(), 'v-')); const p = path.join(dir, safeBase(name || file));
  fs.writeFileSync(p, readFile(file), { mode: 0o600 }); return p;
}
function sweepViews(maxAgeMs = 0) { let n = 0; try { const r = viewRoot(); for (const d of fs.readdirSync(r)) { const p = path.join(r, d); try { if (!maxAgeMs || Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { recursive: true, force: true }); n++; } } catch { /* raced */ } } } catch { /* none */ } return n; }

module.exports = { isEncrypted, plainSize, createReadStream, readFile, writeFile, writeStream, sha256, seal, reseal, shred, encryptStream, decryptStream, withPlain, withPlainSync, viewCopy, viewRoot, sweepViews, sweepTmp, tmpRoot, tmpDir, MAGIC, HEADER, CHUNK, Readable };
