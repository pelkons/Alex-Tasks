'use strict';
// UI regression (needs the test instance on 8111): the main list renders its rows, with ZERO console/page errors, even when rows are malformed
// (null title / description / project / requester / dates, a row that is not an object), and after visiting Settings (which loads the mail-filter rules).
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await (await b.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const errors = []; let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/bad task row/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(BASE + '/login'); await page.fill('input[type=password]', process.env.MESIMOT_WEB_PASSWORD || 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
  ok(await page.locator('.rows .row').count() >= 2, 'the list renders its rows (' + await page.locator('.rows .row').count() + ')');
  ok(await page.locator('text=אין משימות להצגה').count() === 0, 'no empty-state message');
  await page.goto(BASE + '/settings'); await page.waitForTimeout(1500); await page.goto(BASE + '/'); await page.waitForTimeout(2000);
  ok(await page.locator('.rows .row').count() >= 2, 'the list still renders after visiting Settings');
  // malformed rows from the API
  const real = await page.evaluate(async () => (await (await fetch('/api/tasks?open=1')).json()));
  const bad = [{ ...real[0], title: null, description: null, project: null, requester: null, assignee: null, due_date: 12345, created_at: null, source_date: null, status: null, priority_color: null },
    null, 'garbage', { id: 99991, title: undefined }, { ...real[1] }];
  await page.route('**/api/tasks?*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bad) }));
  await page.route('**/api/tasks', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bad) }));
  await page.goto(BASE + '/'); await page.waitForTimeout(2500);
  const n = await page.locator('.rows .row').count();
  ok(n >= 3, 'malformed rows: the list still renders (' + n + ' rows)'); ok(await page.locator('text=אין משימות להצגה').count() === 0, 'malformed rows: no empty-state message');
  ok(await page.locator('.rows .row', { hasText: 'פריט פגום' }).count() >= 2, 'non-object rows show the "פריט פגום" placeholder');
  ok(errors.length === 0, 'zero console and page errors' + (errors.length ? ': ' + errors.join(' | ').slice(0, 400) : ''));
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
