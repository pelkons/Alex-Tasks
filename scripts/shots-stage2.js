'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8110';
const OUT = path.join(__dirname, '..', 'screenshots', 'stage2');
const PW = process.env.MESIMOT_WEB_PASSWORD || fs.readFileSync(path.join(os.homedir(), '.config/mesimot/web-password.txt'), 'utf8').trim();
const EXE = process.env.CHROMIUM_PATH || undefined; // optional Chromium binary (Playwright's own browser otherwise)
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE });
  for (const [name, vp, mobile] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(BASE + '/login'); await page.fill('#pw', PW);
    await Promise.all([page.waitForURL((u) => new URL(u).pathname === '/'), page.click('#go')]);
    await page.waitForSelector('.comp-input'); await page.waitForTimeout(700);
    const shot = (n, o = {}) => page.screenshot({ path: `${OUT}/${name}-${n}.png`, ...o });
    await shot('1-main');
    await page.goto(BASE + '/chat'); await page.waitForSelector('.bubble'); await page.waitForTimeout(500); await shot('2-chat');
    await page.goto(BASE + '/search'); await page.fill('input[type=search]', 'חזית'); await page.waitForSelector('.sres'); await page.waitForTimeout(600); await shot('3-search');
    await page.goto(BASE + '/task/1'); await page.waitForSelector('.tc-title'); await page.locator('.email-src summary').click(); await page.waitForTimeout(400);
    await shot('4-card-email-task', { fullPage: mobile });
    await page.goto(BASE + '/projects/2'); await page.waitForSelector('.proj-page .ph'); await page.waitForTimeout(700); await shot('5-project-page', { fullPage: mobile });
    if (!mobile) { await page.goto(BASE + '/projects'); await page.waitForSelector('.proj-page .ph'); await page.waitForTimeout(500); await shot('6-projects-restored'); }
    else { await page.goto(BASE + '/projects'); await page.waitForSelector('.prow'); await shot('6-projects-list'); }
    if (errs.length) console.log(name, 'console errors:', errs);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
