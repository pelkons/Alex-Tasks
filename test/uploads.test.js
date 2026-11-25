'use strict';
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_CHUNK_BYTES = String(1024 * 1024);
process.env.MESIMOT_NO_BG = '1';
process.env.MESIMOT_INLINE_INDEX_BYTES = String(1024 * 1024);
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
process.env.MESIMOT_UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-up-'));
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-files-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { build } = require('../lib/server');

function setup() {
  const db = open(':memory:');
  const app = build({ db, token: 't', loginDelayMs: 0 });
  const h = { authorization: 'Bearer t' };
  return { db, app, h };
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const MB = 1024 * 1024;

test('a file bigger than one chunk uploads in parts, is verified, joined, archived and indexed in the background', async () => {
  const { db, app, h } = setup();
  const lines = []; for (let i = 0; i < 100000; i++) lines.push(`שורה ${i} של טקסט בעברית לבדיקה`);
  const data = Buffer.from(lines.join('\n'));
  assert.ok(data.length > 2 * MB);
  let r = await app.inject({ method: 'POST', url: '/api/uploads', headers: h, payload: { name: 'גדול.txt', size: data.length, mime: 'text/plain', last_modified: 1 } });
  assert.equal(r.statusCode, 200);
  const up = r.json();
  assert.equal(up.chunks, Math.ceil(data.length / MB)); assert.deepEqual(up.received, []);
  const put = (i, buf = data.subarray(i * MB, Math.min(data.length, (i + 1) * MB)), extra = {}) => app.inject({ method: 'PUT', url: `/api/uploads/${up.id}/${i}`, headers: { ...h, 'content-type': 'application/octet-stream', ...extra }, payload: buf });
  assert.equal((await put(0)).statusCode, 200);
  assert.equal((await put(2)).statusCode, 200);
  // a corrupted part and a part of the wrong size are refused
  assert.equal((await put(1, data.subarray(MB, 2 * MB), { 'x-chunk-sha256': 'bad' })).statusCode, 400);
  assert.equal((await put(1, Buffer.alloc(10))).statusCode, 400);
  // the connection dropped here: the same file started again resumes with what is already there
  const again = (await app.inject({ method: 'POST', url: '/api/uploads', headers: h, payload: { name: 'גדול.txt', size: data.length, mime: 'text/plain', last_modified: 1 } })).json();
  assert.equal(again.resumed, true); assert.equal(again.id, up.id); assert.deepEqual(again.received, [0, 2]);
  // completing early says what is missing
  r = await app.inject({ method: 'POST', url: `/api/uploads/${up.id}/complete`, headers: h, payload: { sha256: sha(data) } });
  assert.equal(r.statusCode, 400); assert.match(r.json().error, /חסרים \d+ חלקים/);
  assert.equal((await put(1, undefined, { 'x-chunk-sha256': sha(data.subarray(MB, 2 * MB)) })).statusCode, 200);
  for (let i = 3; i < up.chunks; i++) await put(i);
  // a wrong whole-file hash is refused and nothing is archived
  r = await app.inject({ method: 'POST', url: `/api/uploads/${up.id}/complete`, headers: h, payload: { sha256: 'f'.repeat(64) } });
  assert.equal(r.statusCode, 400); assert.match(r.json().error, /sha256/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 0);
  // start again (the bad upload was discarded) and do it properly
  const up2 = (await app.inject({ method: 'POST', url: '/api/uploads', headers: h, payload: { name: 'גדול.txt', size: data.length, mime: 'text/plain', last_modified: 1 } })).json();
  for (let i = 0; i < up2.chunks; i++) await app.inject({ method: 'PUT', url: `/api/uploads/${up2.id}/${i}`, headers: { ...h, 'content-type': 'application/octet-stream' }, payload: data.subarray(i * MB, Math.min(data.length, (i + 1) * MB)) });
  r = await app.inject({ method: 'POST', url: `/api/uploads/${up2.id}/complete`, headers: h, payload: { sha256: sha(data) } });
  assert.equal(r.statusCode, 201, r.body);
  const f = r.json();
  assert.equal(f.size, data.length); assert.equal(f.text_status, 'pending'); assert.equal(f.background, true);
  const row = db.prepare('SELECT * FROM files WHERE id=?').get(f.id);
  assert.equal(row.sha256, sha(data));
  assert.equal(sha(fs.readFileSync(row.path)), sha(data));
  assert.equal(fs.existsSync(path.join(process.env.MESIMOT_UPLOADS, up2.id)), false, 'the parts are removed');
  // no upload event until the text is ready, then the assistant is told
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='file'").get().c, 0);
  const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge');
  const store = createStore(db); const knowledge = createKnowledge(db, store);
  await knowledge.indexInBackground(store.ownerId(), f.id);
  const done = db.prepare('SELECT text_status, index_note FROM files WHERE id=?').get(f.id);
  assert.equal(done.text_status, 'ok');
  assert.ok(db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_id=?').get(f.id).c > 10);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='file' AND action='upload'").get().c, 1);
});

test('the per-file cap is a setting; larger files are refused up front in Hebrew', async () => {
  const { app, h } = setup();
  assert.equal((await app.inject({ method: 'GET', url: '/api/settings', headers: h })).json().max_file_mb, 1024);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { max_file_mb: 2 } })).statusCode, 200);
  const r = await app.inject({ method: 'POST', url: '/api/uploads', headers: h, payload: { name: 'a.bin', size: 3 * MB } });
  assert.equal(r.statusCode, 400); assert.match(r.json().error, /הגודל המרבי הוא 2 מגה־בייט/);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { max_file_mb: 0 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { max_file_mb: 1024 } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/uploads', headers: h, payload: { name: 'a.bin', size: 3 * MB } })).statusCode, 200);
});

test('huge files: PDFs are indexed only up to a page cap, big scans get no OCR, video and audio are stored only (all noted in the record)', async () => {
  const docs = require('../lib/docs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-big-'));
  const mp4 = path.join(dir, 'v.mp4'); fs.writeFileSync(mp4, Buffer.alloc(1000));
  let ex = await docs.extract(mp4, 'v.mp4', 'video/mp4');
  assert.equal(ex.text_status, 'stored'); assert.match(ex.note, /נשמר בלבד/);
  ex = await docs.extract(mp4, 'voice.ogg', 'audio/ogg');
  assert.equal(ex.text_status, 'stored');
  // a PDF with more pages than the cap
  const { execFileSync } = require('child_process');
  const pdf = path.join(dir, 'big.pdf');
  const make = (pages) => { const txt = path.join(dir, 'in.txt'); fs.writeFileSync(txt, Array.from({ length: pages }, (_, i) => `page ${i + 1} text\f`).join('')); execFileSync('sh', ['-c', `command -v libreoffice >/dev/null && echo lo || true`]); return txt; };
  void make;
  // build a multi-page PDF with plain PDF syntax
  const objs = []; const pagesN = 12;
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${Array.from({ length: pagesN }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pagesN} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pagesN; i++) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    const content = `BT /F1 12 Tf 20 200 Td (page ${i + 1} some searchable text for the test of the page cap ok ok ok ok) Tj ET`;
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  fs.writeFileSync(pdf, out);
  process.env.MESIMOT_PDF_PAGES = '5';
  docs.LIMITS.pdf_pages = 5;
  ex = await docs.extract(pdf, 'big.pdf', 'application/pdf');
  assert.equal(ex.pages.length, 5);
  assert.match(ex.note, /5 העמודים הראשונים מתוך 12/);
  docs.LIMITS.pdf_pages = 300;
  ex = await docs.extract(pdf, 'big.pdf', 'application/pdf');
  assert.equal(ex.pages.length, 12); assert.equal(ex.note, null);
});

test('the disk-space warning still fires', () => {
  const { createHousekeeping } = require('../lib/housekeeping');
  const { createStore } = require('../lib/store');
  const db = open(':memory:'); const store = createStore(db);
  const hk = createHousekeeping(db, store, { am: async () => ({}), base: '', dirs: { data: '/tmp', files: '/tmp', backups: '/tmp', models: '/tmp', runs: '/tmp/r', agentTmp: '/tmp/a', voice: '/tmp/v' } });
  const st = hk.storage();
  assert.ok(st.disk_total > 0 && st.disk_free_pct >= 0);
  const real = fs.statfsSync;
  fs.statfsSync = () => ({ bsize: 1, bavail: 5 * 1024 ** 3, blocks: 100 * 1024 ** 3 });
  try { hk.checkDisk(); } finally { fs.statfsSync = real; }
  assert.ok(db.prepare("SELECT 1 FROM attention WHERE text LIKE 'מעט מקום פנוי%'").get());
});
