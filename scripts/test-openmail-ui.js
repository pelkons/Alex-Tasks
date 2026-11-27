'use strict';
// TEST instance: the task card shows a designed "פתיחת המייל" button for a task with a source email, none for a chat task. Needs an email-linked task: made through the store.
const { chromium } = require('playwright');
(async () => {
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge');
  const db = open(process.env.MESIMOT_DB); const store = createStore(db); const knowledge = createKnowledge(db, store); const a = store.assistantId();
  const mk = async (n) => { const eml = `From: ר <r@x.example>\r\nTo: a@x.example\r\nSubject: נושא ${n}\r\nDate: Thu, 0${n} Nov 2026 10:00:00 +0200\r\nMessage-ID: <o${n}@x.example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nגוף ${n}\r\n`; const f = await knowledge.saveUpload(store.ownerId(), { name: `o${n}.eml`, mime: 'message/rfc822', buffer: Buffer.from(eml), source: 'email', quiet: true, stage: true }); return f.email_id || db.prepare('SELECT email_id FROM files WHERE id=?').get(f.id).email_id; };
  const e1 = await mk(1), e2 = await mk(2); const proj = db.prepare('SELECT id FROM projects WHERE is_default=0').get() || db.prepare('SELECT id FROM projects').get();
  const t = store.createTask(a, { title: 'משימה מהמייל', project: proj.id, requester: store.ownerId(), source_email_id: e1 }); store.linkTaskEmail(a, t.id, e2, 'updated');
  const t2 = store.createTask(a, { title: 'משימה מהצ׳אט', project: proj.id });
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
  await page.goto('http://127.0.0.1:8111/task/' + t.id); await page.waitForTimeout(2000);
  ok(await page.locator('.open-mail .mail-btn').first().isVisible(), 'the open-email button is visible'); ok(await page.locator('.open-mail .caret').isVisible(), 'the ▾ list shows (two linked emails)');
  await page.screenshot({ path: '/tmp/ui-shots/open-mail-btn.png' });
  await page.click('.open-mail .caret'); ok((await page.locator('.mail-menu-item').count()) === 2, 'both emails are listed');
  await page.click('.mail-menu-item >> nth=1'); await page.waitForTimeout(1500); ok(/\/email\/\d+/.test(page.url()), 'a list item opens the email page');
  await page.goto('http://127.0.0.1:8111/task/' + t2.id); await page.waitForTimeout(2000); ok(!(await page.locator('.open-mail').isVisible()), 'no button for a chat-created task');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
