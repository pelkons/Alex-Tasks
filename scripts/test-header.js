'use strict';
// UI check on the TEST instance: at every desktop width the header icon group is flush with the LEFT edge (about 16 px) and the logo with the RIGHT edge.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  for (const w of [1280, 1440, 1900, 2560]) {
    const page = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage();
    await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2200);
    const g = await page.evaluate(() => { const els = Array.from(document.querySelectorAll('.topbar-in > *')).filter((e) => e.getBoundingClientRect().width > 0); const left = Math.min(...els.map((e) => e.getBoundingClientRect().left)); const right = Math.max(...els.map((e) => e.getBoundingClientRect().right)); return { left: Math.round(left), right: Math.round(innerWidth - right) }; });
    ok(g.left >= 8 && g.left <= 24, `${w}: the left-most header item is ${g.left}px from the left edge`); ok(g.right >= 8 && g.right <= 24, `${w}: the logo is ${g.right}px from the right edge`);
    if (w === 1900) await page.screenshot({ path: '/tmp/ui-shots/header-1900.png', clip: { x: 0, y: 0, width: 1900, height: 200 } });
    await page.close();
  }
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
