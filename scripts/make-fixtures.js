'use strict';
// Regenerates the binary test fixtures (Hebrew image, scanned PDF, pptx, xlsx, docx).
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const OUT = path.join(__dirname, '..', 'test', 'fixtures');
const EXE = process.env.CHROMIUM_PATH || undefined; // optional: path to a Chromium binary (Playwright's own is used otherwise)
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require('playwright');
  const b = await chromium.launch({ executablePath: EXE });
  const pg = await b.newPage({ viewport: { width: 900, height: 360 } });
  await pg.setContent(`<html dir="rtl"><meta charset="utf-8"><style>@font-face{font-family:H;src:url(file://${path.join(__dirname, '..', 'public/assets/vendor/heebo-500.ttf')})}body{font-family:H;font-size:34px;padding:30px;background:#fff;color:#000;line-height:1.7}</style><body>קבלן החשמל הוא אור הדוגמה מערכות חשמל.<br>התקציב הכולל של הפרויקט הוא 412 מיליון שקל.<br>מסירה מתוכננת ביוני 2028.</body></html>`);
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(OUT, 'hebrew-scan.png') });
  await b.close();
  execFileSync('convert', [path.join(OUT, 'hebrew-scan.png'), '-density', '150', path.join(OUT, 'hebrew-scan.pdf')]); // image-only PDF
  execFileSync('convert', [path.join(OUT, 'hebrew-scan.png'), '-quality', '85', path.join(OUT, 'hebrew-scan.webp')]);
  // pptx: two slides
  const zip = new JSZip();
  const slide = (t) => `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${t.map((x) => `<p:sp><p:txBody><a:p><a:r><a:t>${x}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/slides/slide1.xml', slide(['מצגת סיכום רבעון', 'יועץ הקונסטרוקציה הוא יורם קפלן']));
  zip.file('ppt/slides/slide2.xml', slide(['אבני דרך', 'סיום שלד המגדל בנובמבר 2027']));
  fs.writeFileSync(path.join(OUT, 'summary.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  // xlsx
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['סעיף', 'סכום'], ['חשמל', 36000000], ['אינסטלציה', 24000000]]), 'תקציב');
  XLSX.writeFile(wb, path.join(OUT, 'budget.xlsx'));
})();
