'use strict';
// UI check on the TEST instance for the "גיבוי והצפנה" card: wrong password, right password shows the key once, copy button, hidden when leaving the page, no horizontal overflow at 412 and 1280.
// Run:  scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; NODE_PATH=<dir with playwright> node scripts/test-backup-ui.js [shots-dir]
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111'; const key = fs.readFileSync(process.env.MESIMOT_DB_KEY_FILE, 'utf8').trim(); const shots = process.argv[2];
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome' });
  for (const [w, h] of [[412, 900], [1280, 900]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, permissions: ['clipboard-read', 'clipboard-write'] }); const page = await ctx.newPage();
    await page.goto(BASE + '/login'); await page.fill('input[type=password]', process.env.MESIMOT_WEB_PASSWORD); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
    await page.goto(BASE + '/settings'); await page.waitForTimeout(1500);
    const card = page.locator('.bk-card'); await card.scrollIntoViewIfNeeded(); ok(await card.count() === 1, `[${w}] card exists`);
    ok((await card.innerText()).includes('גיבוי והצפנה'), `[${w}] title`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `[${w}] no horizontal overflow`);
    await card.getByRole('button', { name: 'הצג מפתח הצפנה' }).click();
    await page.fill('.bk-card input[type=password]', 'wrong-password-xx'); await page.click('.bk-card button[type=submit]'); await page.waitForTimeout(1200);
    ok(page.url().includes('/settings') && (await card.innerText()).includes('סיסמה'), `[${w}] wrong password: stays on the page with an error`);
    ok(!(await page.content()).includes(key), `[${w}] key not in the page after a wrong password`);
    await page.fill('.bk-card input[type=password]', process.env.MESIMOT_WEB_PASSWORD); await page.click('.bk-card button[type=submit]'); await page.waitForTimeout(1500);
    const shown = await page.locator('.bk-key').innerText().catch(() => ''); ok(shown === key, `[${w}] the key is shown in the monospace box`);
    ok((await card.innerText()).includes('שמרו את המפתח ב-Bitwarden. בלי המפתח אי אפשר לשחזר את הנתונים.'), `[${w}] the Bitwarden note`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `[${w}] no overflow with the key shown`);
    ok(await page.evaluate(() => getComputedStyle(document.querySelector('.bk-key')).fontFamily.includes('mono')), `[${w}] monospace`);
    await card.getByRole('button', { name: 'העתק' }).click(); await page.waitForTimeout(400);
    ok(await page.evaluate(() => navigator.clipboard.readText()) === key, `[${w}] the copy button copies the key`);
    const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })); ok(!ls.includes(key), `[${w}] key not in localStorage/sessionStorage`);
    if (shots) { await card.screenshot({ path: `${shots}/backup-${w}.png` }); }
    await page.goto(BASE + '/'); await page.waitForTimeout(800); await page.goBack(); await page.waitForTimeout(1500);
    ok(!(await page.content()).includes(key), `[${w}] the key is gone after leaving the page and coming back`);
    await page.goto(BASE + '/activity'); await page.waitForTimeout(1500); ok((await page.content()).includes('המפתח הוצג') && !(await page.content()).includes(key), `[${w}] activity shows "המפתח הוצג" only`);
    await ctx.close();
  }
  await b.close(); process.exit(fails ? 1 : 0);
})();
