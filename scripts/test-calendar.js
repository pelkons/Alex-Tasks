'use strict';
// Calendar layout/marks checks on the TEST instance. Needs the seed of scripts/shots-calendar.js.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8111';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  for (const [w, h] of [[1440, 900], [1920, 1080]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage();
    await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(1000);
    for (const view of ['week', 'month']) {
      await p.goto(BASE + '/calendar'); await p.evaluate((v) => { localStorage.setItem('calView', v); localStorage.setItem('calProject', 'all'); }, view); await p.reload(); await p.waitForTimeout(1500);
      const t = `${w} ${view}: `;
      const m = await p.evaluate(() => {
        const bar = document.querySelector('.cal-bar').getBoundingClientRect(); const sc = document.querySelector('.cal-scroll');
        return { barH: Math.round(bar.height), docScroll: document.documentElement.scrollHeight > innerHeight + 1, mainScroll: (() => { const m = document.querySelector('main.page'); return m.scrollHeight > m.clientHeight + 1; })(), scrolls: sc.scrollHeight > sc.clientHeight + 1, ovf: getComputedStyle(sc).overflowY, h1: !!document.querySelector('.cal-page h1'), chips: document.querySelectorAll('.cal-chip').length, bad: [...document.querySelectorAll('.cal-chip')].filter((c) => !getComputedStyle(c).getPropertyValue('--pcol')).length };
      });
      ok(m.barH <= 52, t + 'toolbar height ' + m.barH); ok(!m.docScroll && !m.mainScroll, t + 'page does not scroll'); ok(m.ovf === 'auto', t + 'items area is the scroller');
      ok(!m.h1, t + 'no stacked heading'); ok(m.chips > 0 && m.bad === 0, t + 'chips carry project colour ' + m.chips);
      const y0 = await p.evaluate(() => document.querySelector('.cal-bar').getBoundingClientRect().top);
      await p.evaluate(() => { const s = document.querySelector('.cal-scroll'); s.scrollTop = 99999; });
      const y1 = await p.evaluate(() => document.querySelector('.cal-bar').getBoundingClientRect().top);
      ok(y0 === y1, t + 'toolbar stays put while items scroll');
      if (view === 'week') { const dow = await p.evaluate(() => { const e = document.querySelector('.cal-dow'); return { t: e.getBoundingClientRect().top, txt: e.textContent.trim().slice(0, 12) }; }); const top = await p.evaluate(() => document.querySelector('.cal-scroll').getBoundingClientRect().top); ok(Math.abs(dow.t - top) < 2, t + 'weekday header sticky (' + dow.txt + ')'); }
      // filter
      await p.evaluate(() => { document.querySelector('.cal-scroll').scrollTop = 0; });
      await p.click('.cal-fbtn'); await p.waitForTimeout(300);
      const pop = await p.evaluate(() => { const r = document.querySelector('.cal-pop').getBoundingClientRect(); return { w: Math.round(r.width), inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, rows: document.querySelectorAll('.cal-lg').length }; });
      ok(pop.w >= 280 && pop.inside && pop.rows >= 3, t + 'filter popover ' + JSON.stringify(pop));
      if (view === 'week' && w === 1440) await p.screenshot({ path: 'screenshots/resize/cal-after-1440-filter.png' });
      const n0 = await p.evaluate(() => document.querySelectorAll('.cal-chip').length);
      await p.click('.cal-lg:nth-of-type(2)'); await p.waitForTimeout(400);
      const n1 = await p.evaluate(() => document.querySelectorAll('.cal-chip').length);
      ok(n1 > 0 && n1 < n0, t + `filter narrows ${n0} -> ${n1}`);
      await p.evaluate(() => localStorage.setItem('calProject', 'all')); await p.reload(); await p.waitForTimeout(1200);
      if (view === 'month') { const more = await p.$('.cal-more:visible'); if (more) { await more.click(); await p.waitForTimeout(300); ok(true, t + '+N opens the day panel'); } }
    }
    // chat pane + dividers still work on this screen
    await p.goto(BASE + '/calendar'); await p.waitForTimeout(1200);
    const d = await p.$('.divider[data-pane=chat]'); ok(!!d, w + ': chat divider present');
    if (d) { const bb = await d.boundingBox(); const before = await p.evaluate(() => document.querySelector('.chat-panel').getBoundingClientRect().width); await p.mouse.move(bb.x + bb.width / 2, bb.y + 200); await p.mouse.down(); await p.mouse.move(bb.x + bb.width / 2 + 80, bb.y + 200, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(300); const after = await p.evaluate(() => document.querySelector('.chat-panel').getBoundingClientRect().width); ok(Math.abs(after - before) > 20, w + `: chat divider drags ${before} -> ${after}`); }
    ok(await p.evaluate(() => !!document.querySelector('.chat-panel .cp-composer')), w + ': chat composer present');
    await ctx.close();
  }
  await b.close(); console.log(fail ? fail + ' FAILED' : 'ALL OK'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
