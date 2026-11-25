'use strict';
// Sample tasks + screenshots for the task-first layout. Usage: node scripts/shots-stage1b.js [--keep]
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8110';
const OUT = path.join(__dirname, '..', 'screenshots', 'stage1b');
const PW = process.env.MESIMOT_WEB_PASSWORD || fs.readFileSync(path.join(os.homedir(), '.config/mesimot/web-password.txt'), 'utf8').trim();
const EXE = process.env.CHROMIUM_PATH || undefined; // optional Chromium binary (Playwright's own browser otherwise)
const cli = (...a) => JSON.parse(execFileSync(path.join(__dirname, '..', 'bin', 'mesimot'), a, { encoding: 'utf8', env: process.env }));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  cli('project', 'add', '--name', 'מגדל הנוף');
  cli('project', 'add', '--name', 'שדרוג תשתיות');
  cli('project', 'add', '--name', 'רחוב הנחל');
  const mk = (title, o) => cli('task', 'add', '--title', title, ...Object.entries(o).flatMap(([k, v]) => ['--' + k, v]));
  mk('לשלוח תוכנית עבודה מעודכנת לישיבת ההנהלה', { requester: 'אבי כהן', 'source-date': '16/11/2026 08:40', due: '20/11/2026', 'due-source': 'explicit', project: 'מגדל הנוף', assignee: 'דנה', priority: 'דחוף', status: 'בטיפול' });
  mk('לבדוק חריגות בתקציב הרבעון ולהחזיר תשובה', { requester: 'יעל רוזן', 'source-date': '23/11/2026 14:05', due: '26/11/2026', 'due-source': 'explicit', project: 'שדרוג תשתיות', assignee: 'מיכל גלעד', priority: 'דחוף' });
  mk('לתאם פגישת מדידות באתר עם הקבלן', { requester: 'אבי כהן', 'source-date': '22/11/2026 10:15', due: '01/12/2026', 'due-source': 'estimated', project: 'רחוב הנחל', assignee: 'רון שחר', status: 'ממתין' });
  mk('להכין טיוטת מענה לספק האלומיניום', { requester: 'יעל רוזן', 'source-date': '24/11/2026 07:50', project: 'מגדל הנוף', assignee: 'Claude' });
  mk('לעדכן את רשימת אנשי הקשר של הקבלנים', { 'source-date': '20/11/2026 12:00', due: '10/12/2026', 'due-source': 'estimated', project: 'לא משויך', assignee: 'דנה', priority: 'נמוך' });
  mk('אישור חשבון חלקי מספר 4', { requester: 'אבי כהן', 'source-date': '10/11/2026 09:00', due: '15/11/2026', project: 'רחוב הנחל', assignee: 'רון שחר', status: 'הושלם' });
  cli('attention', 'add', '--kind', 'question', '--text', 'מתי צריך לסיים את בדיקת התקציב?');

  const browser = await chromium.launch({ executablePath: EXE });
  for (const [name, vp, mobile] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(BASE + '/login'); await page.fill('#pw', PW);
    await Promise.all([page.waitForURL((u) => new URL(u).pathname === '/'), page.click('#go')]);
    await page.waitForSelector('.row'); await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}-1-main.png` });
    await page.click('.attn-line'); await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${name}-2-main-attention-open.png` });
    await page.click('.attn-line');
    await page.click('.filter-btn'); await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${name}-3-filter-open.png` });
    await page.locator('.filter-panel select').nth(3).selectOption({ label: 'אבי כהן' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}-4-filter-active.png` });
    await page.click('.achip'); await page.click('.filter-btn'); await page.waitForTimeout(300);
    await page.locator('.row .body').first().click(); await page.waitForSelector('.tc-title'); await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}-5-card.png`, fullPage: mobile });
    if (errs.length) console.log(name, 'console errors:', errs);
    await ctx.close();
  }
  await browser.close();
  console.log('shots done');
})().catch((e) => { console.error(e); process.exit(1); });
