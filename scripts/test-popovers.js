'use strict';
// Every popover, picker and dialog must be at least 300px wide and fully inside the viewport, at 1024 / 1440 / 1920 and with narrow and wide panes.
// Also the inline controls (filter panel, density control) must stay inside their pane. TEST instance only.
// Usage: NODE_PATH=... node scripts/test-popovers.js [before|after]   (screenshots of the project settings dialog go to screenshots/resize/)
const { chromium } = require('playwright');
const path = require('path');
const root = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:8111';
const tag = process.argv[2] || 'after';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const PANES = { narrow: { chat: 300, card: 360, page: 360 }, wide: { chat: 640, card: 900, page: 900 } };
async function login(p) { await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(900); }
const bbox = (p, sel) => p.evaluate((s) => { const e = [...document.querySelectorAll(s)].find((x) => x.offsetParent !== null || getComputedStyle(x).position === 'fixed'); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; }, sel);
const inside = (b) => b && b.l >= 0 && b.r <= b.vw && b.t >= 0 && b.b <= b.vh;
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const errors = [];
  for (const vw of [1024, 1440, 1920]) {
    for (const [pname, widths] of Object.entries(PANES)) {
      const ctx = await b.newContext({ viewport: { width: vw, height: 900 } });
      await ctx.addInitScript(([key, w]) => { try { localStorage.setItem(key, JSON.stringify(w)); } catch (e) { /* none */ } }, [`mesimot.layout.v1.${vw >= 1600 ? 'xl' : vw >= 1280 ? 'lg' : 'md'}`, widths]);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
      await login(p);
      const label = `${vw}px/${pname} panes`;

      // project page: the settings dialog
      const pid = await p.evaluate(async () => (await (await fetch('/api/projects')).json()).find((x) => !x.is_default).id);
      await p.goto(`${BASE}/projects/${pid}`); await p.waitForSelector('.proj-page', { timeout: 8000 }); await p.waitForTimeout(500);
      await p.click('button[aria-label="תפריט פרויקט"]'); await p.waitForTimeout(350);
      let bx = await bbox(p, '.sheet');
      ok(bx && bx.w >= 300 && inside(bx), `${label}: project settings dialog ${bx ? Math.round(bx.w) + 'x' + Math.round(bx.h) : 'missing'} inside the viewport`);
      const labelsFit = await p.evaluate(() => [...document.querySelectorAll('.sheet .field > span')].every((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().width > 100));
      ok(labelsFit, `${label}: the dialog's labels are not clipped`);
      const inputsFull = await p.evaluate(() => { const s = document.querySelector('.sheet').getBoundingClientRect(); return [...document.querySelectorAll('.sheet input[type=text], .sheet select')].every((i) => i.getBoundingClientRect().width > s.width - 60); });
      ok(inputsFull, `${label}: the fields are full width`);
      const overlapsDivider = await p.evaluate(() => { const s = document.querySelector('.sheet').getBoundingClientRect(); const bg = document.querySelector('.sheet-bg'); return getComputedStyle(bg).position === 'fixed' && getComputedStyle(bg).zIndex >= 90; });
      ok(overlapsDivider, `${label}: a fixed backdrop above the panes`);
      if (vw === 1440 && pname === 'narrow') await p.screenshot({ path: path.join(root, 'screenshots', 'resize', `${tag}-1440-project-menu.png`) });
      // focus: inside the dialog; Tab stays in it; Esc closes and returns the focus
      const f0 = await p.evaluate(() => document.activeElement.closest('.sheet') !== null);
      for (let i = 0; i < 14; i++) await p.keyboard.press('Tab');
      const f1 = await p.evaluate(() => document.activeElement.closest('.sheet') !== null);
      ok(f0 && f1, `${label}: focus is trapped in the dialog`);
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      ok(!(await bbox(p, '.sheet')) || !(await p.evaluate(() => document.querySelector('.sheet').offsetParent !== null)), `${label}: Esc closes the dialog`);
      ok(await p.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label') === 'תפריט פרויקט'), `${label}: focus returns to the ⋯ button`);
      await p.click('button[aria-label="תפריט פרויקט"]'); await p.waitForTimeout(250);
      await p.click('.sheet-head button[aria-label="סגירה"]'); await p.waitForTimeout(250);
      ok(!(await p.evaluate(() => document.querySelector('.sheet').offsetParent !== null)), `${label}: the ✕ closes it`);
      await p.click('button[aria-label="תפריט פרויקט"]'); await p.waitForTimeout(250);
      await p.mouse.click(5, 450); await p.waitForTimeout(250);
      ok(!(await p.evaluate(() => document.querySelector('.sheet').offsetParent !== null)), `${label}: the backdrop closes it`);

      // task card: every meta picker
      await p.goto(BASE + '/'); await p.waitForSelector('.row .body'); await p.click('.row .body'); await p.waitForSelector('.split.has-task .pane-card'); await p.waitForTimeout(500);
      const titles = await p.$$eval('.pane-card .metaline .mi', (els) => els.map((e) => e.getAttribute('title')).filter(Boolean));
      ok(titles.length >= 3, `${label}: the card has ${titles.length} meta pickers`);
      for (const title of titles) {
        await p.click(`.pane-card .metaline .mi[title="${title}"]`); await p.waitForTimeout(300);
        const pk = await bbox(p, '.picker');
        ok(pk && pk.w >= 300 && inside(pk), `${label}: picker "${title}" ${pk ? Math.round(pk.w) + 'x' + Math.round(pk.h) + ' at ' + Math.round(pk.l) + ',' + Math.round(pk.t) : 'missing'} (>= 300 wide, inside the viewport)`);
        await p.keyboard.press('Escape'); await p.waitForTimeout(200);
        if (await p.evaluate(() => { const e = document.querySelector('.picker-bg'); return e && getComputedStyle(e).display !== 'none'; })) { await p.mouse.click(2, 2); await p.waitForTimeout(200); }
      }
      // the filter panel and the density control stay inside their pane
      await p.click('.filter-btn'); await p.waitForTimeout(300);
      const fp = await p.evaluate(() => { const pane = document.querySelector('.home-split .pane-list').getBoundingClientRect(); const e = document.querySelector('.filter-panel').getBoundingClientRect(); const d = document.querySelector('.density').getBoundingClientRect(); return { fl: e.left >= pane.left - 1 && e.right <= pane.right + 1 && e.width > 0, fw: Math.round(e.width), dl: d.left >= pane.left - 1 && d.right <= pane.right + 1, dw: Math.round(d.width) }; });
      ok(fp.fl, `${label}: the filter panel (${fp.fw}px) stays inside the list pane`);
      ok(fp.dl, `${label}: the density control (${fp.dw}px) stays inside the list pane`);
      await ctx.close();
    }
  }
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''));
  console.log(fails ? `\n${fails} FAILED` : '\nall popover checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(2); });
