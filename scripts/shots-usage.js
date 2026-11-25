'use strict';
// Screenshot of the usage panel and the import card on the TEST instance (own DB).
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  for (const [w, h, tag] of [[1440, 1000, '1440'], [390, 900, 'phone']]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage();
    await p.goto('http://127.0.0.1:8111/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(2000);
    await p.goto('http://127.0.0.1:8111/activity'); await p.waitForTimeout(2500);
    await p.evaluate(() => { const e = document.querySelector('.usage-panel'); if (e) e.scrollIntoView(); });
    await p.waitForTimeout(500);
    const el = await p.$('.usage-panel');
    if (el) await el.screenshot({ path: `screenshots/resize/usage-panel-${tag}.png` }); else console.log('no panel');
    if (tag === '1440') { await p.goto('http://127.0.0.1:8111/'); await p.waitForTimeout(2000); await p.screenshot({ path: 'screenshots/resize/import-card-1440.png' }); }
    await ctx.close();
  }
  await b.close(); console.log('ok');
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
