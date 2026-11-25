'use strict';
// Screenshots against the TEST instance (port 8111, test database). Usage: eval "$(scripts/testenv.sh env)"; node scripts/shots-stage3.js
const fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
if (!/8111|test/.test(BASE)) throw new Error('screenshots must be taken from the test instance');
const OUT = path.join(__dirname, '..', 'screenshots', 'stage3');
const EXE = process.env.CHROMIUM_PATH || undefined; // optional Chromium binary (Playwright's own browser otherwise)
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: EXE });
  const protoId = process.env.PROTO_ID || '1';
  for (const [name, vp, mob] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: mob, hasTouch: mob, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(BASE + '/login'); await page.fill('#pw', 'test-password-1234');
    await Promise.all([page.waitForURL((u) => new URL(u).pathname === '/'), page.click('#go')]);
    await page.waitForSelector('.row'); await page.waitForTimeout(700);
    const shot = (n, o = {}) => page.screenshot({ path: `${OUT}/${name}-${n}.png`, ...o });
    await shot('1-main');
    if (mob) { await page.click('.chat-pin'); await page.waitForTimeout(500); await shot('2-chat-sheet-open'); await page.click('.cp-close'); await page.waitForTimeout(300); }
    await page.locator('.row .body').first().click(); await page.waitForSelector('.metaline'); await page.waitForTimeout(500); await shot('3-card');
    await page.goto(BASE + '/activity'); await page.waitForSelector('.run'); await page.waitForTimeout(500); await shot('4-activity', { fullPage: false });
    await page.goto(BASE + '/protocols/' + protoId); await page.waitForSelector('.proto-page .pitem, .proto-page .tc-title'); await page.waitForTimeout(600); await shot('5-protocol');
    if (mob) { await page.goto(BASE + '/protocols'); await page.waitForSelector('.prot-row'); await shot('6-protocols-list'); }
    const pid = await page.evaluate(async () => { const r = await (await fetch('/api/projects')).json(); return (r.find((p) => /מגדל הדוגמה/.test(p.name_he)) || r[0]).id; });
    await page.goto(BASE + '/projects/' + pid); await page.waitForSelector('.pcard'); await page.waitForTimeout(600); await shot('7-project-card');
    await page.goto(BASE + '/search'); await page.fill('input[type=search]', 'כמה קומות יש'); await page.waitForTimeout(2500); await shot('8-semantic-search');
    if (errs.length) console.log(name, 'console errors:', errs);
    await ctx.close();
  }
  await b.close();
  console.log('shots done');
})().catch((e) => { console.error(e); process.exit(1); });
