'use strict';
// Turn an uploaded file into text and split it into overlapping chunks with page numbers.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHUNK_WORDS = 400;
const OVERLAP_WORDS = 60;

const wc = (s) => (s.match(/\S+/g) || []).length;

// Chromium and some other producers write Hebrew PDFs in visual order, so pdftotext returns reversed lines.
function looksReversed(text) {
  const he = text.match(/[א-ת]+/g) || [];
  if (he.length < 20) return false;
  // in logical order Hebrew words rarely start with a final letter, and rarely end with a non-final form of ך ם ן ף ץ
  const finals = 'ךםןףץ';
  let startFinal = 0, endLikely = 0;
  for (const w of he) {
    if (w.length < 2) continue;
    if (finals.includes(w[0])) startFinal++;
    if ('וים'.includes(w[w.length - 1]) || 'הת'.includes(w[w.length - 1])) endLikely++;
  }
  return startFinal / he.length > 0.04;
}

function fixLine(line) {
  // reverse only the Hebrew-containing runs: reverse whole line, then un-reverse Latin/digit runs
  const rev = [...line].reverse().join('');
  return rev.replace(/[A-Za-z0-9][A-Za-z0-9 .,:/@_%-]*[A-Za-z0-9]|[A-Za-z0-9]/g, (m) => [...m].reverse().join(''));
}

const { execFile } = require('child_process');
const os = require('os');
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: opts.timeout || 120000, encoding: opts.encoding || 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.heic', '.heif']);
const OCR_DIRECT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.gif']);
const MAX_OCR_PAGES = 25;
// caps for huge files: what is read is noted in the file record (index_note)
const LIMITS = { pdf_pages: +(process.env.MESIMOT_PDF_PAGES || 300), ocr_pdf_max_pages: 40, office_bytes: 150 * 1024 * 1024, text_bytes: 30 * 1024 * 1024 };
const MEDIA_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.amr', '.wma']);

async function ocrImage(file) {
  const ext = path.extname(file).toLowerCase();
  let input = file, tmp = null;
  if (!OCR_DIRECT.has(ext)) { // webp, heic: convert first
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-ocr-'));
    input = path.join(tmp, 'in.png');
    await run('convert', [file + '[0]', '-auto-orient', input], { timeout: 60000 });
  }
  try { return (await run('tesseract', [input, 'stdout', '-l', 'heb+eng', '--psm', '3'], { timeout: 180000 })).trim(); }
  finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function ocrPdf(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-ocr-'));
  try {
    await run('pdftoppm', ['-r', '200', '-png', '-l', String(MAX_OCR_PAGES), file, path.join(tmp, 'p')], { timeout: 300000 });
    const pages = [];
    for (const f of fs.readdirSync(tmp).filter((x) => x.endsWith('.png')).sort()) pages.push(await ocrImage(path.join(tmp, f)));
    return pages;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function pdfPageCount(file) {
  try { const m = /Pages:\s+(\d+)/.exec(await run('pdfinfo', [file], { timeout: 60000 })); return m ? +m[1] : null; } catch { return null; }
}
async function pdfPages(file, last) {
  const out = await run('pdftotext', ['-enc', 'UTF-8', '-layout', ...(last ? ['-l', String(last)] : []), file, '-'], { timeout: 600000 });
  let pages = out.split('\f');
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  const all = pages.join('\n');
  if (looksReversed(all)) pages = pages.map((p) => p.split('\n').map(fixLine).join('\n'));
  return pages;
}

const tidy = (t) => String(t).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/^ +| +$/gm, '');
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

async function pptxPages(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const num = (n) => +(/(\d+)\.xml$/.exec(n) || [])[1];
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const pages = [];
  for (const n of slides) {
    const xml = await zip.file(n).async('string');
    let text = xml.replace(/<\/a:p>/g, '\n').replace(/<a:br\s*\/>/g, '\n').replace(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g, '$1').replace(/<[^>]+>/g, '');
    const notes = zip.file(`ppt/notesSlides/notesSlide${num(n)}.xml`);
    if (notes) text += '\n' + (await notes.async('string')).replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, '');
    pages.push(decodeXml(text).replace(/\n{3,}/g, '\n\n'));
  }
  return pages;
}

const hasText = (pages) => pages.join('').replace(/\s/g, '').length >= 1;

// returns { pages, text_status: 'ok'|'ocr'|'empty'|'unsupported', email? }
async function extract(file, name, mime) {
  const ext = path.extname(name || file).toLowerCase();
  const size = fs.statSync(file).size;
  const mb = (n) => Math.round(n / 1048576);
  let note = null;
  const done = (pages, status) => ({ pages: pages.map(tidy), text_status: status === 'ok' && !hasText(pages) ? 'empty' : status, note });
  // video and audio are stored only (audio could go through whisper later)
  if (MEDIA_EXT.has(ext) || /^(video|audio)\//.test(mime || '')) return { pages: [], text_status: 'stored', note: 'וידאו או אודיו: נשמר בלבד, בלי אינדקס טקסט' };
  const officeExt = ['.docx', '.pptx', '.xlsx', '.xls', '.xlsm', '.xlsb', '.ods'];
  if (officeExt.includes(ext) && size > LIMITS.office_bytes) return { pages: [], text_status: 'too_big', note: `קובץ גדול (${mb(size)} מ״ב): נשמר בלבד, בלי אינדקס טקסט` };
  if (ext === '.eml' || ext === '.msg') {
    const { parseMailFile } = require('./mailfile');
    return { pages: [], text_status: 'ok', email: await parseMailFile(fs.readFileSync(file), name) };
  }
  if (ext === '.pdf' || mime === 'application/pdf') {
    const total = await pdfPageCount(file);
    const capped = total && total > LIMITS.pdf_pages;
    const pages = await pdfPages(file, capped ? LIMITS.pdf_pages : 0);
    if (capped) note = `נוצר אינדקס ל־${LIMITS.pdf_pages} העמודים הראשונים מתוך ${total}`;
    if (pages.join('').replace(/\s/g, '').length < 40 * Math.max(1, pages.length)) { // a scan: nothing to read, use OCR (small PDFs only)
      if (total && total > LIMITS.ocr_pdf_max_pages) { note = `סריקה של ${total} עמודים: לא בוצע זיהוי טקסט (OCR) לקובץ גדול`; return done(pages, 'ok'); }
      try { const o = await ocrPdf(file); return done(o, hasText(o) ? 'ocr' : 'ok'); } catch { return done(pages, 'ok'); }
    }
    return done(pages, 'ok');
  }
  if (IMAGE_EXT.has(ext)) {
    try { const t = await ocrImage(file); return done([t], hasText([t]) ? 'ocr' : 'ok'); } catch { return { pages: [], text_status: 'empty' }; }
  }
  if (ext === '.docx') { const mammoth = require('mammoth'); return done([(await mammoth.extractRawText({ path: file })).value], 'ok'); }
  if (ext === '.pptx') return done(await pptxPages(file), 'ok');
  if (['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods'].includes(ext)) {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(file);
    return done(wb.SheetNames.map((n) => `# ${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])), 'ok');
  }
  if (ext === '.html' || ext === '.htm') return done([require('./mailfile').stripHtml(fs.readFileSync(file, 'utf8'))], 'ok');
  if (ext === '.rtf') return done([require('./mailfile').rtfToText(fs.readFileSync(file, 'latin1'))], 'ok');
  if (['.csv', '.txt', '.md', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml'].includes(ext) || (mime || '').startsWith('text/')) {
    if (size > LIMITS.text_bytes) {
      const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(LIMITS.text_bytes); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      note = `נוצר אינדקס ל־${mb(LIMITS.text_bytes)} המגה־בייט הראשונים מתוך ${mb(size)}`;
      return done([buf.toString('utf8')], 'ok');
    }
    return done([fs.readFileSync(file, 'utf8')], 'ok');
  }
  return { pages: [], text_status: 'unsupported' }; // .doc (legacy), archives, audio ...: stored only
}

function chunkPages(pages) {
  const chunks = [];
  pages.forEach((text, pi) => {
    const lines = String(text).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    let cur = [], words = 0;
    const flush = () => {
      if (!cur.length) return;
      chunks.push({ text: cur.join('\n'), page: pi + 1 });
      // keep an overlap tail
      const keep = []; let w = 0;
      for (let i = cur.length - 1; i >= 0 && w < OVERLAP_WORDS; i--) { keep.unshift(cur[i]); w += wc(cur[i]); }
      cur = w >= wc(cur.join(' ')) ? [] : keep; words = cur.reduce((a, l) => a + wc(l), 0);
    };
    for (const line of lines) {
      const n = wc(line);
      if (n > CHUNK_WORDS) { // a very long line: split by words
        flush();
        const ws = line.split(/\s+/);
        for (let i = 0; i < ws.length; i += CHUNK_WORDS - OVERLAP_WORDS) chunks.push({ text: ws.slice(i, i + CHUNK_WORDS).join(' '), page: pi + 1 });
        continue;
      }
      if (words + n > CHUNK_WORDS && cur.length) flush();
      cur.push(line); words += n;
    }
    if (cur.length && !(chunks.length && chunks[chunks.length - 1].page === pi + 1 && chunks[chunks.length - 1].text.endsWith(cur.join('\n')))) chunks.push({ text: cur.join('\n'), page: pi + 1 });
  });
  return chunks;
}

module.exports = { LIMITS, MEDIA_EXT, extract, chunkPages, looksReversed, fixLine, ocrImage, IMAGE_EXT };
