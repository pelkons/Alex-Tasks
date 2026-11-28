'use strict';
// UI check of the SETTINGS screen on the TEST instance (1440, 1024, 412 and 360 px; light and dark):
// wide screens: a centred container, the categories on the right and the chosen category beside them, the last category remembered;
// phones: the list of categories, a category opens as its own screen, the back arrow and the browser's back return to the list;
// every category opens, has no empty group and no horizontal overflow; a dropdown (trash days, quiet hours, a job's model) and a switch save and show the toast.
//   scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; NODE_PATH=<a node_modules directory that has playwright> node scripts/test-settings-ui.js [shots-dir]
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
const OUT = process.argv[2] || process.env.SHOTS || '';
const CATS = ['notify', 'outlook', 'mail', 'calendar', 'ai', 'tasks', 'trash', 'backup', 'account', 'system'];

(async () => {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome' });
  const api = (page, method, url, body) => page.evaluate(async ([method, url, body]) => {
    const r = await fetch(url, { method, headers: { 'X-Mesimot': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }, [method, url, body]);
  const noOverflow = (page) => page.evaluate(() => {
    const m = document.querySelector('main.page');
    return document.documentElement.scrollWidth <= window.innerWidth + 1 && (!m || m.scrollWidth <= m.clientWidth + 1);
  });
  const emptyGroups = (page) => page.evaluate(() => [...document.querySelectorAll('.set-panel .set-group')].filter((g) => g.offsetParent && g.offsetHeight < 30).length);
  const toastSeen = (page) => page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => getComputedStyle(t).display !== 'none' && /נשמר/.test(t.textContent)), null, { timeout: 3000 }).then(() => true, () => false);

  for (const theme of ['light', 'dark']) for (const [w, h] of [[1440, 900], [1024, 800], [412, 915], [360, 780]]) {
    const T = `${w}-${theme}`; const wide = w >= 900;
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: theme }); const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/login'); await page.fill('input[type=password]', process.env.MESIMOT_WEB_PASSWORD || 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(1200);
    await page.evaluate(() => { try { localStorage.removeItem('mesimot.set.cat'); } catch (e) { /* none */ } });
    await page.goto(BASE + '/settings'); await page.waitForTimeout(1500);
    if (wide) {
      ok(/[?&]c=notify/.test(page.url()), `${T}: /settings opens the first category (${page.url()})`);
      ok(await page.locator('.set-nav').isVisible() && await page.locator('.set-panel').isVisible(), `${T}: categories and panel side by side`);
      const g = await page.evaluate(() => { const s = document.querySelector('.settings-page').getBoundingClientRect(); const m = document.querySelector('main.page'); const mr = m.getBoundingClientRect(); const cs = getComputedStyle(m);
        return { w: s.width, left: s.left - mr.left - parseFloat(cs.paddingLeft), right: mr.right - parseFloat(cs.paddingRight) - (m.offsetWidth - m.clientWidth) - s.right, nav: document.querySelector('.set-nav').getBoundingClientRect().right, panel: document.querySelector('.set-panel').getBoundingClientRect().right }; });
      ok(g.w <= 1100 && Math.abs(g.left - g.right) <= 3, `${T}: the container is centred (width ${Math.round(g.w)}, gaps ${Math.round(g.left)}/${Math.round(g.right)})`);
      ok(g.nav > g.panel, `${T}: the categories are on the right of the panel`);
    } else {
      ok(await page.locator('.set-nav').isVisible() && !(await page.locator('.set-panel').isVisible()), `${T}: phone landing is the list of categories only`);
      ok(await page.locator('.set-cat small').first().isVisible(), `${T}: each category shows a short summary`);
    }
    if (OUT) await page.screenshot({ path: `${OUT}/settings-landing-${T}.png` });
    ok(await noOverflow(page), `${T}: landing has no horizontal overflow`);

    for (const c of CATS) {
      if (!wide) { await page.goto(BASE + '/settings'); await page.waitForTimeout(700); }
      await page.locator(`.set-cat[data-cat=${c}]`).click(); await page.waitForTimeout(900);
      const shown = await page.locator('.set-panel').getAttribute('data-cat');
      ok(shown === c && page.url().includes('c=' + c) && await page.locator('.set-panel .set-body').first().isVisible(), `${T}: category ${c} opens`);
      if (!wide) ok(!(await page.locator('.set-nav').isVisible()) && await page.locator('.set-back').isVisible(), `${T}: ${c} is its own screen with a back arrow`);
      ok(await noOverflow(page), `${T}: ${c} has no horizontal overflow`);
      ok(await emptyGroups(page) === 0, `${T}: ${c} has no empty group`);
      if (OUT) await page.screenshot({ path: `${OUT}/settings-${c}-${T}.png`, fullPage: !wide });
    }

    // phones: the back arrow and the browser's back return to the list
    if (!wide) {
      await page.goto(BASE + '/settings'); await page.waitForTimeout(700);
      await page.locator('.set-cat[data-cat=mail]').click(); await page.waitForTimeout(700);
      await page.locator('.set-back').click(); await page.waitForTimeout(700);
      ok(!page.url().includes('c=') && await page.locator('.set-nav').isVisible(), `${T}: the back arrow returns to the list`);
      await page.locator('.set-cat[data-cat=trash]').click(); await page.waitForTimeout(700);
      await page.goBack(); await page.waitForTimeout(700);
      ok(!page.url().includes('c=') && await page.locator('.set-nav').isVisible(), `${T}: the browser's back returns to the list`);
      await page.goto(BASE + '/settings?c=backup'); await page.waitForTimeout(900);
      ok(await page.locator('.set-panel[data-cat=backup]').isVisible(), `${T}: a deep link opens its category`);
    } else {
      // the last category is remembered
      await page.locator('.set-cat[data-cat=trash]').click(); await page.waitForTimeout(600);
      await page.goto(BASE + '/settings'); await page.waitForTimeout(1200);
      ok(page.url().includes('c=trash'), `${T}: the last category is remembered (${page.url()})`);
    }

    // saving (once per theme on a wide and on a phone screen)
    if (theme === 'light' && (w === 1440 || w === 412)) {
      await page.goto(BASE + '/settings?c=trash'); await page.waitForTimeout(1200);
      const sel = page.locator('[data-test=trash-days]');
      ok(await sel.evaluate((e) => e.tagName) === 'SELECT' && await sel.inputValue() === '60', `${T}: trash days is a dropdown showing 60`);
      await sel.selectOption('30'); ok(await toastSeen(page), `${T}: trash days: toast`); await page.waitForTimeout(500);
      ok((await api(page, 'GET', '/api/settings')).trash_days === 30, `${T}: trash days saved (30)`);
      await page.locator('[data-test=trash-days]').selectOption('60'); await page.waitForTimeout(900);
      ok((await api(page, 'GET', '/api/settings')).trash_days === 60, `${T}: trash days back to 60`);

      await page.goto(BASE + '/settings?c=notify'); await page.waitForTimeout(1200);
      const before = (await api(page, 'GET', '/api/settings')).notify_email;
      const tgl = page.locator('[data-test=set-notify-email]');
      ok(await tgl.evaluate((e) => getComputedStyle(e).appearance === 'none' && e.offsetWidth > e.offsetHeight), `${T}: on/off is a switch`);
      await tgl.click(); ok(await toastSeen(page), `${T}: switch: toast`); await page.waitForTimeout(500);
      ok((await api(page, 'GET', '/api/settings')).notify_email === !before, `${T}: switch saved`);
      await page.locator('[data-test=set-notify-email]').click(); await page.waitForTimeout(900);
      ok((await api(page, 'GET', '/api/settings')).notify_email === before, `${T}: switch back`);
      const qs = (await api(page, 'GET', '/api/settings')).quiet_start;
      await page.locator('[data-test=set-quiet-start]').selectOption('21:30'); await page.waitForTimeout(900);
      ok((await api(page, 'GET', '/api/settings')).quiet_start === '21:30', `${T}: quiet hours dropdown saved`);
      await page.locator('[data-test=set-quiet-start]').selectOption(qs); await page.waitForTimeout(900);

      await page.goto(BASE + '/settings?c=ai'); await page.waitForTimeout(1200);
      const row = page.locator('.model-row[data-job=pulse] select').first(); const was = await row.inputValue();
      await row.selectOption('opus'); ok(await toastSeen(page), `${T}: model dropdown: toast`); await page.waitForTimeout(600);
      ok((await api(page, 'GET', '/api/settings')).agent.models.find((m) => m.job === 'pulse').model === 'opus', `${T}: a job's model saved`);
      await page.locator('.model-row[data-job=pulse] select').first().selectOption(was); await page.waitForTimeout(900);
      ok((await api(page, 'GET', '/api/settings')).agent.models.find((m) => m.job === 'pulse').model === was, `${T}: model back to ${was}`);
      // the built-in tools switch (MCP): a dropdown with four values; a change is saved and shown
      const mcp = page.locator('[data-test=set-mcp]'); const mcpWas = await mcp.inputValue();
      ok(await mcp.isVisible() && (await mcp.locator('option').allTextContents()).join('|') === 'כבוי|צ׳אט בלבד|הכול|כלים בלבד', `${T}: the MCP dropdown shows the four values`);
      const mcpTo = mcpWas === 'only' ? 'chat' : 'only';
      await mcp.selectOption(mcpTo); ok(await toastSeen(page), `${T}: MCP dropdown: toast`); await page.waitForTimeout(600);
      ok((await api(page, 'GET', '/api/settings')).agent.mcp.value === mcpTo, `${T}: the MCP switch saved (${mcpTo})`);
      await page.locator('[data-test=set-mcp]').selectOption(mcpWas); await page.waitForTimeout(900);
      ok((await api(page, 'GET', '/api/settings')).agent.mcp.value === mcpWas, `${T}: the MCP switch back to ${mcpWas}`);
      await page.locator('.model-row[data-job=pulse] select').first().selectOption('__other'); await page.waitForTimeout(300);
      ok(await page.locator('[data-other="m:pulse"]').isVisible(), `${T}: "אחר…" opens a free text field`);
    }
    ok(!errors.length, `${T}: no JS errors ${errors.join(' | ')}`);
    await ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
