'use strict';
// UI check on the TEST instance: a quiet archive link at the end of the task list (with the count), in the phone "עוד" menu, and /archive opens directly.
process.env.MESIMOT_DB = process.env.MESIMOT_DB || '/tmp/mesimot-test/test.db'; process.env.MESIMOT_SEMANTIC = '0';
const { chromium } = require('playwright'); const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const db = open(); const store = createStore(db); const a = store.assistantId(), o = store.ownerId();
const done = db.prepare("SELECT id FROM statuses WHERE is_done=1").get().id;
for (let i = 1; i <= 3; i++) { const t = store.createTask(a, { title: `משימה סגורה ${i}`, requester: o }); store.updateTask(a, t.id, { status: done }); } store.createTask(a, { title: 'משימה פתוחה', requester: o });
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const login = async (page) => { await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); };
  let page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); await login(page);
  const link = page.locator('.arc-foot a'); ok(/📦 ארכיון \(3 משימות שהושלמו\)/.test(await link.innerText()), 'the link at the end of the list shows the count');
  await link.click(); await page.waitForSelector('.arc-filters', { timeout: 5000 }); ok(page.url().endsWith('/archive'), 'it opens /archive');
  await page.goto('http://127.0.0.1:8111/archive'); ok(await page.waitForSelector('.arc-filters', { timeout: 5000 }).then(() => true).catch(() => false), 'a /archive deep link works');
  page = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await login(page);
  await page.locator('.bottomnav button, nav button').filter({ hasText: 'עוד' }).first().click().catch(() => {}); await page.waitForTimeout(300);
  ok(await page.locator('.more-menu button, .more-bg button').filter({ hasText: 'ארכיון' }).first().isVisible().catch(() => false), 'the phone "עוד" menu has the archive');
  await page.locator('.more-bg button', { hasText: 'ארכיון' }).first().click().catch(() => {}); await page.waitForTimeout(800); ok(page.url().endsWith('/archive'), 'and it opens it');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
