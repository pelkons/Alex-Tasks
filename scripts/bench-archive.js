#!/usr/bin/env node
'use strict';
// Benchmark of the archive pipeline on THIS machine: synthetic Hebrew mail (fictional words), a realistic mix of attachments (text, csv, Word, Excel, PDF with text, one scanned image for OCR),
// pushed through the real code (enqueue -> worker steps -> body and attachment text -> own search index -> vectors with the real e5 model) in a throw-away encrypted database.
//   node scripts/bench-archive.js [--n 300] [--full 0.3] [--dir /tmp/mesimot-bench] [--keep]
// Prints emails per minute (whole pipeline), the split between parsing/extraction and embedding, and the database growth per mail.
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const REAL = +arg('real', 0); // --real N: N mails each carrying a REAL attachment sampled from this server's own stored files (only timings are printed; everything is deleted at the end)
let realFiles = [];
if (REAL) { const out = execFileSync('node', [path.join(__dirname, '..', 'bin', 'mesimot'), 'sql', `select id, original_name, path, size from files where discarded=0 and archived=0 and path<>'' and original_name not like '%.msg' and size between 20000 and 40000000 order by random() limit ${REAL}`, '--format', 'json'], { encoding: 'utf8', maxBuffer: 1 << 28 }); realFiles = JSON.parse(out); const vlt = require('../lib/vault'); for (const f of realFiles) { try { f.data = vlt.readFile(f.path); } catch { f.data = null; } } realFiles = realFiles.filter((f) => f.data); } // read NOW, with the live key
const N = REAL ? realFiles.length : +arg('n', 300), FULL = +arg('full', 0.3), DIR = path.resolve(String(arg('dir', path.join(os.tmpdir(), 'mesimot-bench'))));
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
Object.assign(process.env, { MESIMOT_DB: path.join(DIR, 'bench.db'), MESIMOT_DB_KEY_FILE: path.join(DIR, 'db.key'), MESIMOT_FILES: path.join(DIR, 'files'), MESIMOT_ARCHIVE_QUEUE: path.join(DIR, 'queue'), MESIMOT_ARCHIVE_IGNORE_LIVE: '1', MESIMOT_ARCHIVE_FREE_BYTES: String(500 * 1024 ** 3), MESIMOT_ARCHIVE_QUEUE_MAX_MB: '100000' });
process.env.MESIMOT_CONFIG = process.env.MESIMOT_CONFIG || path.join(__dirname, '..', 'test', 'fixtures', 'config.json');
const root = path.join(__dirname, '..');
const { open } = require(path.join(root, 'lib/db')); const { createStore } = require(path.join(root, 'lib/store')); const { createKnowledge } = require(path.join(root, 'lib/knowledge'));
const { createSemantic } = require(path.join(root, 'lib/semantic')); const { createArchive } = require(path.join(root, 'lib/archive'));
const { buildMsg } = require(path.join(root, 'test/helpers/msg-builder')); const docs = require(path.join(root, 'lib/docs'));
process.env.OMP_THREAD_LIMIT = process.env.OMP_THREAD_LIMIT || '1'; docs.LIMITS.pdf_pages = 120; docs.LIMITS.ocr_pdf_max_pages = 10; docs.LIMITS.ocr_pages_read = 4; docs.LIMITS.ocr_image_ms = 45000; docs.LIMITS.convert_ms = 20000;
const XLSX = require(path.join(root, 'node_modules/xlsx')); const JSZip = require(path.join(root, 'node_modules/jszip'));

// ---- fictional corpus
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const pick = (a) => a[Math.floor(rnd() * a.length)];
const W = 'פרויקט מגדל קומה מרתף חניון יסודות בטון שלד איטום חשמל אינסטלציה מעלית חזית אלומיניום זכוכית קבלן יועץ מהנדס אדריכל תוכנית היתר אישור ביקורת פיקוח לוח זמנים תשלום חשבונית הצעה מחיר כמות סעיף כתב כמויות שינוי הזמנה עבודה אתר ישיבה פרוטוקול דחוף השבוע מחר אתמול נא לאשר לעדכן לשלוח לבדוק להשלים מסמך נספח טבלה חישוב סטטי קונסטרוקציה רצפה תקרה קיר עמוד קורה מרפסת גג ניקוז צנרת מים ביוב כיבוי אש גילוי עשן מיזוג אוורור תאורה לוח חשמל שנאי גנרטור'.split(' ');
const para = (n) => Array.from({ length: n }, () => pick(W)).join(' ');
const bodyOf = () => { const k = 3 + Math.floor(rnd() * 14); return Array.from({ length: k }, () => para(8 + Math.floor(rnd() * 25)) + '.').join('\n') + '\n\nבברכה,\n' + para(2); };
async function makeAttachments() {
  const d = path.join(DIR, 'att'); fs.mkdirSync(d, { recursive: true }); const out = {};
  out.txt = Buffer.from(Array.from({ length: 40 }, () => para(14)).join('\n'));
  out.csv = Buffer.from('סעיף,תיאור,כמות,מחיר\n' + Array.from({ length: 120 }, (_, i) => `${i + 1},${para(3)},${Math.floor(rnd() * 900)},${Math.floor(rnd() * 5000)}`).join('\n'));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['סעיף', 'תיאור', 'כמות'], ...Array.from({ length: 200 }, (_, i) => [i + 1, para(3), Math.floor(rnd() * 900)])]), 'גיליון1'); out.xlsx = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const z = new JSZip(); z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${Array.from({ length: 60 }, () => `<w:p><w:r><w:t>${para(16)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`); out.docx = await z.generateAsync({ type: 'nodebuffer' });
  const html = path.join(d, 'p.html'); fs.writeFileSync(html, `<html dir="rtl"><meta charset="utf-8"><body style="font:14px Arial">${Array.from({ length: 120 }, () => `<p>${para(18)}</p>`).join('')}</body></html>`);
  try { execFileSync('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--print-to-pdf=${path.join(d, 'p.pdf')}`, '--no-pdf-header-footer', 'file://' + html], { stdio: 'ignore', timeout: 60000 }); out.pdf = fs.readFileSync(path.join(d, 'p.pdf')); } catch { out.pdf = out.txt; }
  const scan = path.join(root, 'test', 'fixtures', 'hebrew-scan.png'); out.png = fs.existsSync(scan) ? fs.readFileSync(scan) : null;
  return out;
}

(async () => {
  const db = open(process.env.MESIMOT_DB); const store = createStore(db); const knowledge = createKnowledge(db, store);
  const semantic = createSemantic(db); const archive = createArchive({ db, store, knowledge, semantic });
  const att = await makeAttachments(); const sizeOf = () => { let s = fs.statSync(process.env.MESIMOT_DB).size; try { s += fs.statSync(process.env.MESIMOT_DB + '-wal').size; } catch { /* none */ } return s; };
  const mixes = [['none', 0.55], ['txt', 0.08], ['csv', 0.05], ['docx', 0.08], ['xlsx', 0.06], ['pdf', 0.14], ['png', 0.04]];
  const kindOf = () => { let r = rnd(), a = 0; for (const [k, p] of mixes) { a += p; if (r < a) return k; } return 'none'; };
  const NAMES = { txt: 'הערות.txt', csv: 'כתב כמויות.csv', docx: 'מסמך.docx', xlsx: 'טבלה.xlsx', pdf: 'הצעה.pdf', png: 'סריקה.png' };
  const counts = { none: 0 }; let rawBytes = 0; const extByCount = {}; const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const kind = kindOf(); counts[kind] = (counts[kind] || 0) + 1; const full = rnd() < FULL;
    let atts = kind !== 'none' && att[kind] ? [{ name: NAMES[kind], data: att[kind] }] : [];
    if (REAL) { const f = realFiles[i]; atts = [{ name: f.original_name, data: f.data }]; }
    const buf = buildMsg({ from_name: `שולח ${i % 97}`, from_addr: `sender${i % 97}@bench${i % 11}.example`, to: [{ name: 'דנה', addr: 'dana@exconstruct.example' }], subject: `${para(4)} ${100 + (i % 50)}.${2000 + (i % 7)}`, body: bodyOf(), date: Date.parse(full ? '2026-03-01T08:00:00Z' : '2024-06-01T08:00:00Z') + i * 60000, attachments: atts });
    rawBytes += buf.length; if (REAL) { const e = path.extname(atts[0].name).toLowerCase() || 'none'; extByCount[e] = (extByCount[e] || 0) + 1; }
    await archive.enqueue({ entry_id: `B${i}`, folder: i % 5 ? 'inbox' : 'sent', received_or_sent_at: new Date(Date.parse(full ? '2026-03-01T08:00:00Z' : '2024-06-01T08:00:00Z') + i * 60000).toISOString(), internet_message_id: `<b${i}@bench.example>`, archive: true }, buf);
  }
  const tGen = Date.now() - t0; const db0 = sizeOf();
  const tw = Date.now(); let parse = 0, emb = 0;
  for (;;) { const a = Date.now(); const r = await archive.step(); const dt = Date.now() - a; if (r === 'idle') break; if (r === 'embedded') emb += dt; else parse += dt; }
  const wall = Date.now() - tw; const st = archive.status();
  const per = (x) => +(x / N).toFixed(1);
  const res = { n: N, mix: counts, full_share: FULL, generated_in_s: +(tGen / 1000).toFixed(1), worker_wall_s: +(wall / 1000).toFixed(1), emails_per_minute: +(N / (wall / 60000)).toFixed(1), ms_per_email: { total: per(wall), parse_store_extract: per(parse), embedding: per(emb) },
    real_attachment_types: REAL ? extByCount : undefined, vectors: st.vectors, vectors_per_email: +(st.vectors / N).toFixed(2), failed: st.failed, avg_raw_msg_kb: +(rawBytes / N / 1024).toFixed(1), db_growth_kb_per_email: +((sizeOf() - db0) / N / 1024).toFixed(1), full_files_mb: +(st.full_files_bytes / 1048576).toFixed(1), est_20000_emails_hours: +((20000 / (N / (wall / 3600000)))).toFixed(1) };
  console.log(JSON.stringify(res, null, 1));
  if (!arg('keep', false)) fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
