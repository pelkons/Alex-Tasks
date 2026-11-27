'use strict';
const vault = require('./vault');
// Chunked, resumable uploads. The site sits behind a tunnel that caps one request body (~100 MB), so the browser sends a big file in
// chunks (PUT /api/uploads/:id/:index); the server keeps the parts, and on completion joins them, checks the size and the sha256 the
// browser computed, and registers the file. A dropped connection resumes: GET /api/uploads/:id says which parts are already there.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now } = require('./db');
const { bad, missing } = require('./store');

const CHUNK = +process.env.MESIMOT_CHUNK_BYTES || 32 * 1024 * 1024;
const MIN_FREE = 2 * 1024 * 1024 * 1024; // keep at least this much free after the file

function createUploads(db, store, knowledge, { dir, root }) {
  const base = dir || path.join(root, 'data', 'uploads');
  const metaFile = (id) => path.join(base, id, 'meta.json');
  const readMeta = (id) => { try { return JSON.parse(vault.readFile(metaFile(String(id).replace(/[^a-f0-9]/g, ''))).toString('utf8')); } catch { throw missing('ההעלאה לא נמצאה'); } };
  const writeMeta = (m) => vault.writeFile(metaFile(m.id), Buffer.from(JSON.stringify(m))); // parts and metadata are encrypted too
  const partFile = (id, i) => path.join(base, id, `part-${String(i).padStart(5, '0')}`);
  const received = (m) => Array.from({ length: m.chunks }, (_, i) => i).filter((i) => { try { return vault.plainSize(partFile(m.id, i)) === expected(m, i); } catch { return false; } });
  const expected = (m, i) => (i < m.chunks - 1 ? m.chunk_size : m.size - m.chunk_size * (m.chunks - 1));

  function freeBytes() { try { const s = fs.statfsSync(base); return s.bavail * s.bsize; } catch { return Infinity; } }

  function start(actor, b) {
    const size = +b.size;
    if (!Number.isFinite(size) || size <= 0) throw bad('הקובץ ריק');
    if (size > knowledge.maxFileBytes()) throw bad(`הקובץ גדול מדי. הגודל המרבי הוא ${Math.round(knowledge.maxFileBytes() / 1048576).toLocaleString('he-IL')} מגה־בייט`);
    fs.mkdirSync(base, { recursive: true });
    // the same file started again (same name, size and modification time) resumes the earlier upload
    const key = crypto.createHash('sha1').update(`${actor}|${b.name}|${size}|${b.last_modified || ''}`).digest('hex');
    const old = fs.existsSync(path.join(base, key)) ? (() => { try { return readMeta(key); } catch { return null; } })() : null;
    if (old && !old.done) return { id: old.id, chunk_size: old.chunk_size, chunks: old.chunks, received: received(old), resumed: true };
    if (freeBytes() < size + MIN_FREE) throw bad('אין מספיק מקום פנוי בשרת להעלאת הקובץ. יש לפנות מקום ולנסות שוב');
    const m = { id: key, actor, name: String(b.name || 'file'), mime: b.mime || null, size, chunk_size: CHUNK, chunks: Math.ceil(size / CHUNK), project: b.project || null, task: b.task || null, created_at: now(), done: false };
    fs.mkdirSync(path.join(base, m.id), { recursive: true });
    writeMeta(m);
    return { id: m.id, chunk_size: m.chunk_size, chunks: m.chunks, received: [], resumed: false };
  }
  function status(id) { const m = readMeta(id); return { id: m.id, size: m.size, chunks: m.chunks, chunk_size: m.chunk_size, received: received(m), done: m.done }; }

  function putChunk(id, index, buffer, chunkSha) {
    const m = readMeta(id);
    const i = +index;
    if (!Number.isInteger(i) || i < 0 || i >= m.chunks) throw bad('מספר חלק לא תקין');
    if (buffer.length !== expected(m, i)) throw bad(`גודל החלק לא תקין (${buffer.length} במקום ${expected(m, i)})`);
    if (chunkSha && crypto.createHash('sha256').update(buffer).digest('hex') !== String(chunkSha).toLowerCase()) throw bad('החלק התקבל פגום, נסו שוב');
    vault.writeFile(partFile(m.id, i), buffer); // atomic (temp file + rename): a part is either complete or absent
    return { index: i, received: received(m).length, chunks: m.chunks };
  }

  // join the parts, check size and sha256, register the file (indexing of big files happens in the background)
  async function complete(actor, id, clientSha) {
    const m = readMeta(id);
    const have = received(m);
    if (have.length !== m.chunks) throw bad(`חסרים ${m.chunks - have.length} חלקים. ההעלאה תמשיך מהמקום שבו נעצרה`);
    const joined = path.join(base, m.id, 'joined');
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const out = vault.encryptStream(); const sink = fs.createWriteStream(joined, { mode: 0o600 }); out.pipe(sink);
      sink.on('error', reject).on('finish', resolve); out.on('error', reject);
      (async () => {
        for (let i = 0; i < m.chunks; i++) {
          await new Promise((res, rej) => { const r = vault.createReadStream(partFile(m.id, i)); r.on('data', (c) => { h.update(c); if (!out.write(c)) { r.pause(); out.once('drain', () => r.resume()); } }); r.on('end', res).on('error', rej); });
        }
        out.end();
      })().catch(reject);
    });
    const sha = h.digest('hex');
    const size = vault.plainSize(joined);
    if (size !== m.size) { fs.rmSync(joined, { force: true }); throw bad('גודל הקובץ שהתקבל שונה מהמקור. נסו להעלות שוב'); }
    if (clientSha && String(clientSha).toLowerCase() !== sha) {
      fs.rmSync(path.join(base, m.id), { recursive: true, force: true });
      throw bad('הקובץ שהתקבל שונה מהמקור (בדיקת sha256 נכשלה). נסו להעלות שוב');
    }
    const saved = await knowledge.saveUploadFromPath(actor, { name: m.name, mime: m.mime, file: joined, move: true, sha256: sha, project: m.project || undefined, task: m.task || undefined, source: 'web' });
    fs.rmSync(path.join(base, m.id), { recursive: true, force: true });
    return saved;
  }
  // half-finished uploads nobody continued
  function cleanup(maxAgeMs = 3 * 86400000) {
    let n = 0;
    try { for (const d of fs.readdirSync(base)) { const st = fs.statSync(path.join(base, d)); if (Date.now() - st.mtimeMs > maxAgeMs) { fs.rmSync(path.join(base, d), { recursive: true, force: true }); n++; } } } catch { /* none */ }
    return n;
  }
  return { start, status, putChunk, complete, cleanup, CHUNK, base };
}

module.exports = { createUploads, CHUNK };
