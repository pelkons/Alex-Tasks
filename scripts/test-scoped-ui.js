'use strict';
// UI check of the entity-scoped chat (needs the test instance on 8111): the composer is on the project page, a message posts into its own thread and stays out of the main chat.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await (await b.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const fails = []; const ok = (c, m) => { if (!c) fails.push(m); console.log(c ? 'ok  ' : 'FAIL', m); };
  await page.goto(BASE + '/login'); await page.fill('input[type=password]', process.env.MESIMOT_WEB_PASSWORD || 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
  const projects = await page.evaluate(async () => (await (await fetch('/api/projects')).json()));
  const p = (Array.isArray(projects) ? projects : projects.projects).find((x) => !x.is_default);
  await page.goto(`${BASE}/projects/${p.id}`); await page.waitForSelector('.sc-chat', { timeout: 8000 });
  ok(await page.locator('.sc-chat textarea').isVisible(), 'the project page has the scoped composer');
  await page.fill('.sc-chat textarea', 'מה המצב בפרויקט?'); await page.click('.sc-chat button[type=submit]');
  await page.waitForSelector('.sc-chat .bubble.owner', { timeout: 8000 });
  ok(await page.locator('.sc-chat .bubble.owner').count() === 1, 'the message appears in the project thread');
  const msgs = await page.evaluate(async () => (await (await fetch('/api/chat/scope/project/' + location.pathname.split('/').pop())).json()));
  ok(msgs.length === 1 && msgs[0].scope === 'entity', 'it is stored with the project scope');
  await page.goto(BASE + '/'); await page.waitForTimeout(800);
  const inMain = await page.evaluate(() => Array.from(document.querySelectorAll('.bubble')).filter((e) => e.textContent.includes('מה המצב בפרויקט?')).length);
  ok(inMain === 0, 'the message stays out of the main chat (' + inMain + ')');
  await page.goto(BASE + '/people'); await page.waitForTimeout(800);
  const btn = page.locator('button:has-text("אזכורים ומשימות")').first();
  if (await btn.count()) { await btn.click(); await page.waitForSelector('.sc-chat', { timeout: 5000 }); ok(true, 'the person card has the scoped composer'); }
  await page.goto(BASE + '/calendar'); await page.waitForTimeout(1000);
  await page.locator('.cal-cell').nth(10).click(); await page.waitForSelector('.cal-day .sc-chat', { timeout: 5000 });
  ok(true, 'the calendar day panel has the scoped composer');
  await page.screenshot({ path: '/tmp/scoped-ui.png' });
  await b.close(); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
