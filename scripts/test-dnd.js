'use strict';
// Drag-and-drop / paste of files into the chat and onto a task card, with synthetic DataTransfer events. TEST instance only.
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const BASE = 'http://127.0.0.1:8111';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const db = new Database('/tmp/mesimot-test/test.db', { readonly: true });
// build a DataTransfer with files and fire a drag event on an element; returns whether the default was prevented
const fire = (p, sel, type, files, related = false) => p.evaluate(([sel, type, files, related]) => {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(new File([f.size ? new Uint8Array(f.size) : (f.text || 'x')], f.name, { type: f.type || 'text/plain' }));
  const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, relatedTarget: related ? document.body : null });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}, [sel, type, files, related]);
const chips = (p) => p.$$eval('.cp-composer .fchip.up', (els) => els.map((e) => ({ name: e.querySelector('.fn').textContent, done: e.classList.contains('done'), err: e.classList.contains('err') })));
async function waitDone(p, n) { await p.waitForFunction((n) => document.querySelectorAll('.cp-composer .fchip.up.done').length >= n, n, { timeout: 20000 }); }
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(1000);
  await p.goto(BASE + '/'); await p.waitForSelector('.chat-panel .comp-input'); await p.waitForTimeout(600);

  // 1. the overlay while dragging over the chat (list, input area, panel), dashed border, Hebrew text
  for (const sel of ['.chat-panel .feed', '.chat-panel .comp-input', '.chat-panel .cp-head']) {
    await fire(p, sel, 'dragenter', [{ name: 'a.txt' }]); await fire(p, sel, 'dragover', [{ name: 'a.txt' }]); await p.waitForTimeout(120);
    const o = await p.evaluate(() => { const e = document.querySelector('.chat-panel .drop-overlay'); const cs = getComputedStyle(e); return { vis: e.offsetParent !== null || cs.display !== 'none', text: e.textContent.trim(), border: cs.borderTopStyle }; });
    ok(o.vis && o.text === 'שחרר כאן כדי לשלוח לאלכס' && o.border === 'dashed', `dragging over ${sel}: overlay "${o.text}" with a ${o.border} border`);
    await fire(p, '.chat-panel', 'dragleave', [{ name: 'a.txt' }], true); await p.waitForTimeout(120);
    ok(!(await p.evaluate(() => getComputedStyle(document.querySelector('.chat-panel .drop-overlay')).display !== 'none')), 'the overlay disappears when the drag leaves');
  }
  ok(!(await fire(p, '.chat-panel .feed', 'dragenter', [])), 'a drag without files is ignored');

  // 2. several files at once, each a chip; typed caption; they go out with the message, not before
  const msgsBefore = await p.evaluate(async () => (await (await fetch('/api/chat')).json()).length);
  await fire(p, '.chat-panel .feed', 'drop', [{ name: 'דוח.txt', text: 'תוכן הדוח' }, { name: 'תוכנית.csv', text: 'a,b\n1,2', type: 'text/csv' }]);
  await waitDone(p, 2);
  let c = await chips(p);
  ok(c.length === 2 && c.every((x) => x.done), `two files dropped: ${c.map((x) => x.name).join(', ')} (progress chips, both uploaded)`);
  ok((await p.evaluate(async () => (await (await fetch('/api/chat')).json()).length)) === msgsBefore, 'nothing was sent yet');
  await p.fill('.chat-panel .comp-input', 'מצורפים הדוח והתוכנית');
  await p.keyboard.press('Enter'); await p.waitForTimeout(900);
  const last = await p.evaluate(async () => { const m = await (await fetch('/api/chat')).json(); return m.filter((x) => x.author === 'owner').pop(); });
  ok(last.text === 'מצורפים הדוח והתוכנית' && last.files.length === 2, `one message with the caption and ${last.files.length} files (Enter sends)`);
  ok((await chips(p)).length === 0, 'the chips are cleared after sending');

  // 3. a drop on the input area; paste of an image and of a file; plain text paste is untouched
  await fire(p, '.chat-panel .comp-input', 'drop', [{ name: 'סיכום.txt', text: 'סיכום' }]); await waitDone(p, 1);
  ok((await chips(p))[0].name === 'סיכום.txt', 'a drop on the input area works');
  await p.evaluate(() => { document.querySelector('.chat-panel .comp-input').focus(); });
  const pasted = await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(500)], 'image.png', { type: 'image/png' })); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.querySelector('.chat-panel .comp-input').dispatchEvent(ev); return ev.defaultPrevented; });
  await waitDone(p, 2); c = await chips(p);
  ok(pasted && c.some((x) => /^צילום-\d+-1\.png$/.test(x.name)), `pasting a screenshot becomes a file chip (${c.map((x) => x.name).join(', ')})`);
  const textPaste = await p.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'טקסט'); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.querySelector('.chat-panel .comp-input').dispatchEvent(ev); return ev.defaultPrevented; });
  ok(!textPaste, 'pasting plain text is left to the browser');
  await p.click('.cp-composer .fchip.up button[aria-label="הסרת קובץ"]'); await p.click('.cp-composer .fchip.up button[aria-label="הסרת קובץ"]');
  ok((await chips(p)).length === 0, 'the ✕ removes uploaded chips');

  // 4. cancel an upload in progress (a big file uses the chunked upload; the chunk request is held back so the ✕ can be pressed)
  const filesBefore = db.prepare('SELECT COUNT(*) c FROM files').get().c;
  await p.route('**/api/uploads/*/*', async (route) => { if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 2500)); try { await route.continue(); } catch (e) { /* aborted */ } });
  await fire(p, '.chat-panel .feed', 'drop', [{ name: 'גדול.bin', size: 33 * 1024 * 1024, type: 'application/octet-stream' }]);
  await p.waitForSelector('.cp-composer .fchip.up'); await p.waitForTimeout(600);
  const bar = await p.$eval('.cp-composer .fchip.up', (e) => ({ title: e.title, notDone: !e.classList.contains('done') }));
  ok(bar.notDone, `a big file shows progress while uploading ("${bar.title}")`);
  const sendDisabled = await p.$eval('.cp-composer .btn.send', (e) => e.disabled);
  ok(sendDisabled, 'the send button waits while a file is still uploading');
  await p.click('.cp-composer .fchip.up button[aria-label="ביטול ההעלאה"]'); await p.waitForTimeout(3500);
  ok((await chips(p)).length === 0 && db.prepare('SELECT COUNT(*) c FROM files').get().c === filesBefore, 'cancelling removes the chip and nothing is archived');
  await p.unroute('**/api/uploads/*/*');

  // 5. a drop on a task card: the file goes to the chat with the note "קובץ למשימה #ID", linked to that task
  await p.waitForSelector('.row .body'); await p.click('.row .body'); await p.waitForSelector('.split.has-task .pane-card'); await p.waitForTimeout(500);
  const tid = await p.evaluate(() => +location.pathname.split('/').pop());
  await fire(p, '.pane-card', 'dragenter', [{ name: 'x.txt' }]); await p.waitForTimeout(150);
  const co = await p.evaluate(() => { const e = document.querySelector('.pane-card .drop-overlay'); return e && getComputedStyle(e).display !== 'none' ? e.textContent.trim() : null; });
  ok(co && /שחרר כאן/.test(co), `dragging over a task card shows the overlay ("${co}")`);
  await fire(p, '.pane-card', 'drop', [{ name: 'תמונת-אתר.txt', text: 'x' }]); await waitDone(p, 1);
  ok((await p.inputValue('.chat-panel .comp-input')) === `קובץ למשימה #${tid}`, `the caption is prefilled: "קובץ למשימה #${tid}"`);
  await p.keyboard.press('Enter'); await p.waitForTimeout(900);
  const m2 = await p.evaluate(async () => { const m = await (await fetch('/api/chat')).json(); return m.filter((x) => x.author === 'owner').pop(); });
  ok(m2.files.length === 1 && m2.tasks.length === 1 && m2.tasks[0].id === tid, `the message carries the file and is linked to task ${tid}`);
  ok(db.prepare("SELECT task_id FROM files WHERE original_name='תמונת-אתר.txt'").get().task_id === tid, 'the file record knows its task');

  // 6. the browser never opens a dropped file: a drop anywhere else is prevented
  const url0 = p.url();
  const prevented = await fire(p, 'body', 'drop', [{ name: 'p.pdf', type: 'application/pdf' }]);
  const prevented2 = await fire(p, 'header', 'dragover', [{ name: 'p.pdf' }]);
  ok(prevented && prevented2 && p.url() === url0, 'dropping a file on the page body or header is prevented (no navigation)');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''));
  console.log(fails ? `\n${fails} FAILED` : '\nall drag-and-drop checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(2); });
