'use strict';
// UI check on the TEST instance: marking done animates and the row leaves the list, an "ביטול" toast brings it back, scroll position is kept, reduced motion = instant.
process.env.MESIMOT_DB = process.env.MESIMOT_DB || '/tmp/mesimot-test/test.db'; process.env.MESIMOT_SEMANTIC = '0';
const { chromium } = require('playwright');
const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const db = open(); const store = createStore(db); const a = store.assistantId(), owner = store.ownerId();
const proj = store.createProject(a, { name: 'פרויקט הדוגמה' }); const ids = [];
for (let i = 1; i <= 30; i++) ids.push(store.createTask(a, { title: `משימה מספר ${i} לבדיקת האנימציה`, project: proj.id, requester: owner, due: '2026-12-20' }).id);
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  for (const [label, reduced, vp] of [['desktop', false, { width: 1440, height: 900 }], ['phone', false, { width: 390, height: 844 }], ['reduced motion', true, { width: 1440, height: 900 }]]) {
    const ctx = await b.newContext({ viewport: vp, reducedMotion: reduced ? 'reduce' : 'no-preference' }); const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    const n0 = await page.locator('.rows .row').count(); await page.evaluate(() => window.scrollTo(0, 300)); const y0 = await page.evaluate(() => window.scrollY);
    const first = page.locator('.rows .row').nth(2); const title = await first.locator('.title').innerText(); const t0 = Date.now();
    await first.locator('.check').click();
    if (!reduced) { await page.waitForTimeout(150); ok(await first.evaluate((e) => e.classList.contains('done-anim')).catch(() => false), `${label}: the animation class is on while it plays`); }
    await page.waitForFunction((t) => !Array.from(document.querySelectorAll('.rows .row .title')).some((e) => e.innerText === t), title, { timeout: 5000 }); const took = Date.now() - t0;
    ok(reduced ? took < 800 : took > 600, `${label}: row leaves the list after ${took} ms (${reduced ? 'instant' : 'animated'})`);
    ok(await page.locator('.rows .row').count() === n0 - 1, `${label}: one row fewer`);
    ok(Math.abs((await page.evaluate(() => window.scrollY)) - y0) < 5, `${label}: scroll position kept (${y0})`);
    ok(await page.locator('.done-toast').isVisible(), `${label}: the "✔ הושלם · ביטול" toast shows`);
    const closed = await page.evaluate(async (t) => (await (await fetch('/api/tasks?open=1')).json()).some((x) => x.title === t), title); ok(!closed, `${label}: the task is closed on the server`);
    await page.locator('.done-toast .dt-undo').click(); await page.waitForTimeout(1200);
    ok(await page.locator('.rows .row .title', { hasText: title }).count() === 1, `${label}: undo brings the row back`); ok(errors.length === 0, `${label}: no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();
  }
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
