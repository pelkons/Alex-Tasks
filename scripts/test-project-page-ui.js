'use strict';
// UI check of the project page (passport, latest status per process, facts by topic, side column, chat at the bottom) at 412 / 1280 / 1440 px, light and dark.
//   test instance: BASE_URL=http://127.0.0.1:8111 PROJECT=<id> node scripts/test-project-page-ui.js [--edit]   (--edit also tries an inline owner edit: test data only)
//   live: BASE_URL=http://127.0.0.1:8110 MESIMOT_WEB_PASSWORD=... PROJECT=<id> node scripts/test-project-page-ui.js   (read-only)
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
const OUT = process.env.SHOT_DIR || '/tmp/ui-shots';
const EDIT = process.argv.includes('--edit');
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome' });
  const fails = []; const ok = (c, m) => { if (!c) fails.push(m); console.log(c ? 'ok  ' : 'FAIL', m); };
  const tag = process.env.SHOT_TAG || (BASE.includes('8111') ? 'test' : 'live');
  for (const [w, h] of [[412, 900], [1280, 900], [1440, 900]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w < 500 ? 2 : 1, isMobile: w < 500, hasTouch: w < 500 });
      const page = await ctx.newPage();
      const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
      await page.goto(BASE + '/login'); await page.fill('input[type=password]', process.env.MESIMOT_WEB_PASSWORD || 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
      const pid = process.env.PROJECT || (await page.evaluate(async () => (await (await fetch('/api/projects')).json()).find((x) => !x.is_default).id));
      await page.goto(`${BASE}/projects/${pid}`); await page.waitForSelector('.pj-pass', { timeout: 10000 }); await page.waitForTimeout(700);
      const L = `${w} ${scheme}`;
      const m = await page.evaluate(() => {
        const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right }; };
        const pane = document.querySelector('.proj-page');
        return { pass: r('.pj-pass'), status: r('.pj-status'), facts: r('.pj-facts'), tasks: r('.pj-tasks'), chat: r('.pj-chat'), people: r('.pj-people'),
          kv: document.querySelectorAll('.pj-kv .kv').length, unknown: [...document.querySelectorAll('.kv.unknown .kv-val')].map((e) => e.textContent.trim()), procs: document.querySelectorAll('.pj-procs .proc').length,
          groups: document.querySelectorAll('.pj-facts .fg').length, headline: (document.querySelector('.pj-headline') || {}).textContent || '', srcs: document.querySelectorAll('.pj-pass .src, .pj-status .src').length,
          docW: document.documentElement.scrollWidth, winW: innerWidth, paneScroll: pane ? pane.scrollWidth - pane.clientWidth : 0, bg: getComputedStyle(document.querySelector('.pj-card')).backgroundColor };
      });
      ok(m.kv === 8, `${L}: the passport has 8 fields (${m.kv})`);
      ok(m.procs >= 1, `${L}: the status block lists the processes (${m.procs})`);
      ok(m.groups >= 1, `${L}: facts are grouped by topic (${m.groups} groups)`);
      ok(m.srcs >= m.procs, `${L}: values carry a source icon (${m.srcs})`);
      ok(m.chat && m.facts && m.chat.y > m.facts.y && m.chat.y > m.tasks.y, `${L}: the project chat is at the bottom`);
      ok(m.docW <= m.winW + 1 && m.paneScroll <= 1, `${L}: no horizontal scroll (doc ${m.docW}/${m.winW}, pane ${m.paneScroll})`);
      if (w >= 1024) ok(m.tasks && m.pass && Math.abs(m.tasks.y - m.pass.y) < 4 && m.tasks.right < m.pass.x + 2, `${L}: two columns, the side column on the left (${JSON.stringify({ tasks: m.tasks, pass: m.pass })})`);
      else ok(m.tasks.y > m.status.y && m.tasks.y < m.facts.y && Math.abs(m.pass.w - m.facts.w) < 2, `${L}: one column: passport, status, tasks, then facts`);
      ok(!errs.length, `${L}: no page errors ${errs.join(' | ')}`);
      if (EDIT && w === 1440 && scheme === 'light') {
        const unknown = page.locator('.kv.unknown .kv-val').first();
        if (await unknown.count()) {
          await unknown.click(); await page.fill('.kv.editing input', 'קומת מסחר 400 מ"ר'); await page.click('.kv.editing button[type=submit]'); await page.waitForTimeout(900);
          ok(await page.locator('.kv.owner .kv-val', { hasText: 'קומת מסחר 400' }).count() === 1, `${L}: an inline owner edit is saved and marked`);
        }
        const st = page.locator('.pj-addproc button').first();
        if (await st.isVisible()) ok(true, `${L}: + תהליך offered for the missing processes`);
        await page.fill('.pj-ftools input', 'שלד'); await page.waitForTimeout(600);
        ok(await page.locator('.pj-facts .fr').count() >= 1, `${L}: the facts filter finds a fact`);
        await page.fill('.pj-ftools input', ''); await page.waitForTimeout(500);
      }
      await page.screenshot({ path: `${OUT}/pj-${tag}-${w}-${scheme}.png` });
      // the whole page in one tall shot
      await page.setViewportSize({ width: w, height: w < 500 ? 3400 : 2000 }); await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/pj-${tag}-${w}-${scheme}-full.png` });
      await ctx.close();
    }
  }
  await b.close();
  console.log(fails.length ? `${fails.length} FAILED` : 'all ok'); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
