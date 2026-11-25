'use strict';
// End-to-end check with Playwright against a running site. Usage: BASE_URL=https://tasks.example.org node scripts/e2e.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8110';
const SHOTS = path.join(__dirname, '..', 'screenshots', 'stage1');
const PW = process.env.MESIMOT_WEB_PASSWORD || fs.readFileSync(path.join(os.homedir(), '.config/mesimot/web-password.txt'), 'utf8').trim();
const EXE = process.env.CHROMIUM_PATH || process.env.CHROME_PATH || undefined; // optional Chromium binary (Playwright's own browser otherwise)
const cli = (...a) => JSON.parse(execFileSync(path.join(__dirname, '..', 'bin', 'mesimot'), a, { encoding: 'utf8', env: process.env }));
const ok = (c, m) => { if (!c) throw new Error('CHECK FAILED: ' + m); console.log('ok  ' + m); };

async function login(page) {
  await page.goto(BASE + '/login');
  await page.fill('#pw', PW);
  await Promise.all([page.waitForURL((u) => new URL(u).pathname === '/'), page.click('#go')]);
  await page.waitForSelector('.quick input');
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

  // sample data through the CLI
  if (process.argv.includes('--seed-sample')) {
    cli('project', 'add', '--name', 'מגדל הנוף', '--aliases', 'המגדל, ים');
    cli('project', 'add', '--name', 'שדרוג תשתיות');
    cli('project', 'add', '--name', 'רחוב הנחל');
    const mk = (title, project, assignee, priority, due, status, desc) => cli('task', 'add', '--title', title, '--project', project, '--assignee', assignee, '--priority', priority, ...(due ? ['--due', due] : []), ...(status ? ['--status', status] : []), ...(desc ? ['--desc', desc] : []));
    mk('לשלוח לאבי תוכנית עבודה מעודכנת', 'מגדל הנוף', 'דנה', 'דחוף', '20/11/2026', 'בטיפול', 'אבי ביקש לקבל את התוכנית עם לוח זמנים מעודכן לפני ישיבת ההנהלה.');
    mk('לבדוק חריגות בתקציב הרבעון', 'שדרוג תשתיות', 'מיכל גלעד', 'דחוף', '30/11/2026', 'חדש');
    mk('לתאם פגישת מדידות באתר', 'רחוב הנחל', 'רון שחר', 'רגיל', '02/12/2026', 'ממתין');
    mk('להכין טיוטת מענה לספק האלומיניום', 'מגדל הנוף', 'Claude', 'רגיל', null, 'חדש');
    mk('לעדכן את רשימת אנשי הקשר של הקבלנים', 'לא משויך', 'דנה', 'נמוך', null, 'חדש');
    mk('לסכם את הישיבה עם יעל', 'שדרוג תשתיות', 'דנה', 'רגיל', '25/11/2026', 'בטיפול');
    mk('אישור חשבון חלקי מספר 4', 'רחוב הנחל', 'רון שחר', 'נמוך', null, 'הושלם');
    cli('note', 'add', '--task', '1', '--text', 'שוחחתי עם אבי, הוא מבקש להוסיף גם את שלב ב׳ ללוח הזמנים.');
    cli('attention', 'add', '--kind', 'question', '--text', 'האם המשימה "בדיקת תקציב" שייכת לפרויקט שדרוג תשתיות או לרחוב הנחל?');
  }

  const sizes = [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]];
  for (const [name, vp, mobile] of sizes) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(BASE + '/login');
    ok((await page.getAttribute('html', 'dir')) === 'rtl' && (await page.getAttribute('html', 'lang')) === 'he', `${name}: login is rtl/he`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${name}-1-login.png` });
    await login(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/${name}-2-main.png` });

    // task card
    await page.locator('.row .body').first().click();
    await page.waitForSelector('.tc-title');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/${name}-3-task.png`, fullPage: mobile });

    await page.goto(BASE + '/#/projects');
    await page.waitForSelector('.grid-list .card');
    await page.locator('.item-h button:has-text("עריכה")').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${name}-4-projects.png` });

    await page.goto(BASE + '/#/people');
    await page.waitForSelector('.grid-list .card');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${name}-5-people.png`, fullPage: mobile });

    if (name === 'desktop') {
      // dark theme
      await page.goto(BASE + '/#/');
      await page.waitForSelector('.row');
      await page.click('button[aria-label="החלפת מצב תצוגה"]');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/${name}-6-main-dark.png` });
      await page.click('button[aria-label="החלפת מצב תצוגה"]');
    }

    // visible text must have no Latin letters except the name Claude
    await page.goto(BASE + '/#/');
    await page.waitForSelector('.row');
    const txt = await page.evaluate(() => document.body.innerText);
    const latin = (txt.replace(/Claude/g, '').match(/[A-Za-z]{2,}/g) || []);
    ok(latin.length === 0, `${name}: no Latin words in UI text ${latin.join(',')}`);
    ok(errors.length === 0, `${name}: no console errors ${errors.join(' | ')}`);
    await ctx.close();
  }

  // functional flow on desktop
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const page = await ctx.newPage();
  await login(page);
  const title = 'משימה מהדפדפן ' + Date.now() % 10000;
  await page.fill('.quick input', title);
  await page.click('.quick button[type=submit]');
  await page.waitForSelector(`.row:has-text("${title}")`);
  ok(true, 'task added from the web UI');
  await page.locator(`.row:has-text("${title}") .body`).click();
  await page.waitForSelector('.tc-title');
  await page.locator('.grid-sm select').first().selectOption({ label: 'בטיפול' });
  await page.waitForSelector('.hist li:has-text("בטיפול")');
  const pill = await page.locator(`.row:has-text("${title}") .sdot`).innerText();
  ok(pill === 'בטיפול', 'status edited in the card shows in the list');
  const hist = await page.locator('.hist').innerText();
  ok(hist.includes('דנה'), 'history shows the owner as actor');

  const cliTitle = 'משימה מה־CLI ' + Date.now() % 10000;
  cli('task', 'add', '--title', cliTitle, '--priority', 'דחוף');
  await page.reload();
  await page.waitForSelector(`.row:has-text("${cliTitle}")`);
  ok(true, 'task added with `mesimot task add` is visible on the site');
  await page.locator(`.row:has-text("${cliTitle}") .body`).click();
  await page.waitForSelector('.hist li');
  ok((await page.locator('.hist').innerText()).includes('Claude'), 'history shows Claude as actor for the CLI task');

  // clean up the two functional tasks
  for (const t of cli('task', 'list', '--q', 'משימה מ')) cli('task', 'update', String(t.id), '--status', 'בוטל');
  await ctx.close();
  await browser.close();
  console.log('E2E DONE against ' + BASE);
})().catch((e) => { console.error(e); process.exit(1); });
