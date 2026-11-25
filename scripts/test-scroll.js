'use strict';
// Independent scrolling and scrollbar side of every desktop pane. TEST instance only. Usage: NODE_PATH=... node scripts/test-scroll.js before|after
const { chromium } = require('playwright');
const path = require('path');
const root = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:8111';
const tag = process.argv[2] || 'after';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  // seed: a protocol with many items and a task with many notes (test DB only)
  process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createProtocols } = require('../lib/protocols');
  const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db); const owner = store.ownerId();
  const first = store.listTasks({})[0];
  if (db.prepare('SELECT COUNT(*) c FROM notes WHERE task_id=?').get(first.id).c < 20) for (let i = 0; i < 25; i++) store.addNote(owner, { task: first.id, text: `הערה מספר ${i + 1} עם טקסט ארוך כדי לבדוק גלישה וגלילה בכרטיס המשימה ברוחבים שונים` });
  const proj = store.listProjects().find((p) => !p.is_default);
  const protocols = createProtocols(db, store, createKnowledge(db, store));
  if (!db.prepare('SELECT 1 FROM protocols').get()) protocols.addProtocol(owner, { project: proj.id, date: '2026-11-20 10:00', title: 'ישיבת תיאום', summary: 'סיכום', participants: 'דנה כהן (חברה, מנהלת)', items: Array.from({ length: 40 }, (_, i) => ({ kind: 'action', text: `סעיף פעולה מספר ${i + 1} עם תיאור ארוך שמראה גלישה`, owner: 'דנה כהן' })) });
  const proto = db.prepare('SELECT id FROM protocols').get();

  // real (classic) scrollbars: Playwright hides them by default in headless Chrome
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 640 } });
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(900);

  const scrollOf = (sel) => p.evaluate((s) => { const e = document.querySelector(s); return e ? Math.round(e.scrollTop) : null; }, sel);
  const win = () => p.evaluate(() => Math.round(window.scrollY + document.documentElement.scrollTop + document.body.scrollTop));
  // wheel over a pane (real wheel events, so scroll chaining and overscroll behaviour apply); scrolled to the end and beyond
  async function wheelOver(sel, total) {
    const bx = await p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 300) }; }, sel);
    await p.mouse.move(bx.x, bx.y);
    for (let i = 0; i < total / 200; i++) { await p.mouse.wheel(0, 200); await p.waitForTimeout(25); }
    await p.waitForTimeout(250);
  }
  const check = async (name, sel, others, hasScroll = true) => {
    const before = {}; for (const o of others) before[o] = await scrollOf(o); const w0 = await win();
    await wheelOver(sel, 6000);
    const mine = await scrollOf(sel);
    ok(!hasScroll || mine > 0, `${name}: scrolls by itself (scrollTop ${mine})`);
    for (const o of others) { const now = await scrollOf(o); ok(now === before[o], `${name}: ${o} did not move (${before[o]} -> ${now})`); }
    ok((await win()) === w0, `${name}: the window did not scroll (scrollY ${w0} -> ${await win()})`);
  };
  const sbSide = (sel) => p.evaluate((s) => { const e = document.querySelector(s); const cs = getComputedStyle(e); const sb = e.offsetWidth - e.clientWidth - e.clientLeft - parseFloat(cs.borderRightWidth || 0); return { dir: cs.direction, sbw: Math.round(e.offsetWidth - e.clientWidth - parseFloat(cs.borderLeftWidth || 0) - parseFloat(cs.borderRightWidth || 0)), left: Math.round(e.clientLeft - parseFloat(cs.borderLeftWidth || 0)), right: Math.round(sb), overflow: e.scrollHeight > e.clientHeight }; }, sel);
  const onLeft = async (name, sel) => { const s = await sbSide(sel); ok(s.overflow && s.sbw > 0 && s.left > 0 && s.right <= 1 && s.dir === 'rtl', `${name}: the scrollbar (${s.sbw}px) is on the LEFT (rtl, left ${s.left}px, right ${s.right}px)`); };

  // ---- home: list | card | chat
  await p.goto(BASE + '/'); await p.waitForSelector('.row .body'); await p.click('.row .body'); await p.waitForSelector('.split.has-task .pane-card'); await p.waitForTimeout(700);
  ok(await p.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 || getComputedStyle(document.body).overflow === 'hidden'), 'the page itself does not scroll on desktop');
  await check('task list', '.home-split .pane-list', ['.home-split .pane-card', '.chat-panel .feed']);
  await p.evaluate(() => { document.querySelector('.home-split .pane-list').scrollTop = 0; });
  await check('task card', '.home-split .pane-card', ['.home-split .pane-list', '.chat-panel .feed']);
  await p.evaluate(() => { document.querySelector('.home-split .pane-card').scrollTop = 0; });
  await check('chat messages', '.chat-panel .feed', ['.home-split .pane-list', '.home-split .pane-card']);
  const comp = await p.evaluate(() => { const c = document.querySelector('.chat-panel .cp-composer').getBoundingClientRect(); const a = document.querySelector('.chat-panel').getBoundingClientRect(); return Math.round(a.bottom - c.bottom); });
  ok(comp <= 2, `the chat input stays pinned at the bottom of its pane (${comp}px from the bottom) while the messages scroll`);
  await onLeft('task list', '.home-split .pane-list'); await onLeft('task card', '.home-split .pane-card'); await onLeft('chat messages', '.chat-panel .feed');
  await p.screenshot({ path: path.join(root, 'screenshots', 'resize', `${tag}-scroll-1440.png`) });

  // scroll positions are kept when the card opens and closes
  await p.evaluate(() => { document.querySelector('.home-split .pane-list').scrollTop = 220; });
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  const kept = await scrollOf('.home-split .pane-list'); ok(kept === 220, `the list keeps its scroll position when the card closes (${kept})`);
  await p.click('.row:nth-of-type(4) .body'); await p.waitForSelector('.split.has-task .pane-card'); await p.waitForTimeout(500);
  const kept2 = await scrollOf('.home-split .pane-list'); ok(Math.abs(kept2 - 220) <= 4, `... and when a card opens (${kept2})`);

  // ---- projects: list | page | chat
  await p.goto(`${BASE}/projects/${proj.id}`); await p.waitForSelector('.proj-page'); await p.waitForTimeout(700);
  await check('project page', '.proj-page', ['.proj-list', '.chat-panel .feed']);
  await onLeft('project page', '.proj-page');
  await p.evaluate(() => { document.querySelector('.proj-page').scrollTop = 0; });
  const pl = await p.evaluate(() => { const e = document.querySelector('.proj-list'); return e.scrollHeight > e.clientHeight; });
  await check('project list', '.proj-list', ['.proj-page', '.chat-panel .feed'], pl);
  // ---- protocols: list | page | chat
  await p.goto(`${BASE}/protocols/${proto.id}`); await p.waitForSelector('.proto-page'); await p.waitForTimeout(700);
  await check('protocol page', '.proto-page', ['.proto-list', '.chat-panel .feed']);
  await onLeft('protocol page', '.proto-page');
  const ll = await p.evaluate(() => { const e = document.querySelector('.proto-list'); return e.scrollHeight > e.clientHeight; });
  await check('protocols list', '.proto-list', ['.proto-page', '.chat-panel .feed'], ll);
  // a page without panes (settings): the page area scrolls inside the shell, the window never does
  await p.goto(BASE + '/settings'); await p.waitForTimeout(900);
  await wheelOver('main.page', 4000);
  ok((await win()) === 0 && (await scrollOf('main.page')) > 0, `settings: the main area scrolls (${await scrollOf('main.page')}), the window does not`);
  await onLeft('settings page area', 'main.page');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''));
  console.log(fails ? `\n${fails} FAILED` : '\nall scrolling checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(2); });
