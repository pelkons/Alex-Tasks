'use strict';
// End to end on the TEST instance (with the runner): type in the main chat, send, the message appears, a reply comes, no error text, no JS errors.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await (await b.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const errors = []; let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/login'); await page.fill('input[type=password]', process.env.MESIMOT_WEB_PASSWORD || 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
  const input = page.locator('.chat-panel .comp-input').first(); await input.fill('מה השעה עכשיו? תענה במשפט אחד'); await input.press('Enter');
  await page.waitForSelector('.bubble.owner:has-text("מה השעה עכשיו")', { timeout: 10000 }); ok(true, 'the owner message appears in the chat');
  ok((await input.inputValue()) === '', 'the composer is cleared');
  const t0 = Date.now(); let reply = null;
  while (Date.now() - t0 < 120000) { reply = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.bubble.claude')).filter((x) => !x.classList.contains('thinking-b')); return b.length ? b[b.length - 1].innerText : null; }); if (reply) break; await page.waitForTimeout(1500); }
  ok(!!reply, 'a reply arrives (' + Math.round((Date.now() - t0) / 1000) + 's)'); ok(!/אירעה שגיאה|לא הצלחתי לנסח/.test(reply || ''), 'the reply is not an error message: ' + String(reply).replace(/\s+/g, ' ').slice(0, 80));
  const stored = await page.evaluate(async () => (await (await fetch('/api/chat?limit=10')).json()).filter((m) => m.author === 'owner').length); ok(stored === 1, 'the message is stored once (' + stored + ')');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
