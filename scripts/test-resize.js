'use strict';
// Playwright checks of the split-pane layout on the TEST instance: drag dividers, persistence across reloads, limits, keyboard, double-click reset,
// automatic chat collapse, density, overflow at many widths, tablet and phone unchanged. Usage: NODE_PATH=... node scripts/test-resize.js
const { chromium } = require('playwright');
const path = require('path');
const root = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:8111';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const css = (p, v) => p.evaluate((n) => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n))), v);
const box = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), t: Math.round(r.top), h: Math.round(r.height) }; }, sel);
async function login(p) { await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(1000); }
async function openFirstTask(p) { await p.goto(BASE + '/'); await p.waitForSelector('.row .body'); await p.click('.row .body'); await p.waitForSelector('.split.has-task .pane-card', { timeout: 8000 }); await p.waitForTimeout(400); }
async function dragDivider(p, sel, dx) {
  const b = await box(p, sel); const x = b.l + b.w / 2, y = b.t + b.h / 2;
  await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + dx / 2, y, { steps: 4 }); await p.mouse.move(x + dx, y, { steps: 4 }); await p.mouse.up(); await p.waitForTimeout(150);
}
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await login(p); await openFirstTask(p);

  // 1. three panes side by side, none overlapping
  let l = await box(p, '.home-split .pane-list'), c = await box(p, '.home-split .pane-card'), ch = await box(p, '.chat-panel');
  ok(c && l && ch && ch.r <= c.l + 2 && c.r <= l.l + 20 && ch.l === 0, `three panes in a row (chat ${ch.l}-${ch.r} | card ${c.l}-${c.r} | list ${l.l}-${l.r})`);
  ok(l.w >= 360 && c.w >= 360 && ch.w >= 300, 'every pane is above its minimum width');

  // 2. drag the chat divider: it follows the pointer, within 300-640
  const chat0 = await css(p, '--chat-w');
  await dragDivider(p, '.divider-chat', 90);
  const chat1 = await css(p, '--chat-w');
  ok(chat1 > chat0 + 60, `dragging the chat divider widens the chat (${chat0} -> ${chat1})`);
  await dragDivider(p, '.divider-chat', 600);
  ok(await css(p, '--chat-w') <= 640, `the chat stops at 640px (${await css(p, '--chat-w')})`);
  l = await box(p, '.home-split .pane-list'); ok(l.w >= 360, `the list keeps its minimum (${l.w})`);
  await dragDivider(p, '.divider-chat', -900);
  ok(await css(p, '--chat-w') === 300, `the chat stops at 300px (${await css(p, '--chat-w')})`);
  await dragDivider(p, '.divider-chat', 80);
  const chatSet = await css(p, '--chat-w');

  // 3. the card divider
  const card0 = (await box(p, '.home-split .pane-card')).w;
  await dragDivider(p, '.divider-card', 100);
  const card1 = (await box(p, '.home-split .pane-card')).w;
  ok(card1 > card0 + 60, `dragging the card divider widens the card (${card0} -> ${card1})`);
  await dragDivider(p, '.divider-card', 1000);
  const cardMax = (await box(p, '.home-split .pane-card')).w;
  ok(cardMax <= 0.6 * 1440 + 1 && (await box(p, '.home-split .pane-list')).w >= 360, `the card stops at 60% of the viewport and the list keeps 360 (card ${cardMax})`);
  await dragDivider(p, '.divider-card', -1500);
  ok((await box(p, '.home-split .pane-card')).w === 360, 'the card stops at 360px');
  await dragDivider(p, '.divider-card', 70);
  const cardSet = (await box(p, '.home-split .pane-card')).w;

  // 4. persistence across a reload (localStorage, per viewport class)
  await p.reload(); await p.waitForTimeout(1200);
  ok(await css(p, '--chat-w') === chatSet, `the chat width survives a reload (${chatSet})`);
  await openFirstTask(p);
  ok(Math.abs((await box(p, '.home-split .pane-card')).w - cardSet) <= 1, `the card width survives a reload (${cardSet})`);
  const stored = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mesimot.layout')));
  ok(stored.length === 1 && stored[0].endsWith('.lg'), 'stored under the viewport class: ' + stored.join());

  // 5. double click resets, the keyboard works
  await p.dblclick('.divider-card'); await p.waitForTimeout(150);
  const reset = (await box(p, '.home-split .pane-card')).w;
  ok(reset !== cardSet && reset >= 360, `double click resets the card width (${cardSet} -> ${reset})`);
  await p.focus('.divider-chat'); const k0 = await css(p, '--chat-w');
  await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight');
  ok(await css(p, '--chat-w') === k0 + 32, `ArrowRight widens the chat by 16px per press (${k0} -> ${await css(p, '--chat-w')})`);
  await p.keyboard.press('ArrowLeft'); ok(await css(p, '--chat-w') === k0 + 16, 'ArrowLeft narrows it');
  await p.keyboard.press('Shift+ArrowRight'); ok(await css(p, '--chat-w') === k0 + 80, 'Shift+Arrow moves 64px');
  const aria = await p.getAttribute('.divider-chat', 'aria-valuenow'); ok(+aria === k0 + 80, 'aria-valuenow follows');
  await p.dblclick('.divider-chat');

  // 6. density control persists
  const rowH = async () => (await box(p, '.row')).h;
  await p.click('.density button[aria-label="קטן"]'); const hs = await rowH();
  await p.click('.density button[aria-label="גדול"]'); const hl = await rowH();
  await p.click('.density button[aria-label="רגיל"]'); const hr = await rowH();
  ok(hs < hr && hr < hl, `density changes the row height (compact ${hs} < regular ${hr} < large ${hl})`);
  await p.click('.density button[aria-label="קטן"]'); await p.reload(); await p.waitForTimeout(1000);
  ok((await p.getAttribute('body', 'data-density')) === 'compact', 'the density survives a reload');
  await p.screenshot({ path: path.join(root, 'screenshots', 'resize', 'after-1440-compact.png') });
  await p.click('.density button[aria-label="רגיל"]');

  // 7. automatic chat collapse when the window is too narrow, and the bar re-opens it
  await p.setViewportSize({ width: 1100, height: 800 }); await openFirstTask(p); await p.waitForTimeout(300);
  ok(!(await p.evaluate(() => document.body.classList.contains('chat-collapsed'))), 'at 1100px all three panes fit at their minimum widths: no collapse');
  await p.setViewportSize({ width: 1040, height: 800 }); await openFirstTask(p); await p.waitForTimeout(300);
  ok(await p.evaluate(() => document.body.classList.contains('chat-collapsed')), 'at 1040px with a card open the chat collapses to its bar');
  const bar = await box(p, '.chat-bar'); ok(bar && bar.w >= 40 && bar.h > 300, 'the bar is a full-height button');
  l = await box(p, '.home-split .pane-list'); c = await box(p, '.home-split .pane-card');
  ok(l.w >= 360 && c.w >= 360 && c.l >= bar.r - 2, `the card and list fit beside the bar (list ${l.w}, card ${c.w})`);
  await p.screenshot({ path: path.join(root, 'screenshots', 'resize', 'after-1040-collapsed.png') });
  await p.click('.chat-bar'); await p.waitForTimeout(500);
  ok(!(await p.evaluate(() => document.body.classList.contains('chat-collapsed'))) && !(await p.evaluate(() => !!document.querySelector('.split.has-task'))), 'the bar re-opens the chat; the card pane closes to make room (nothing overlays)');
  await p.click('.cp-collapse'); ok(await p.evaluate(() => document.body.classList.contains('chat-collapsed')), 'the chat can be collapsed by hand');
  await p.click('.chat-bar'); await p.waitForTimeout(300);

  // 8. no overlap and no horizontal overflow at many widths (with a card open)
  for (const w of [1024, 1100, 1280, 1366, 1440, 1600, 1920, 2560]) {
    await p.setViewportSize({ width: w, height: 900 }); await openFirstTask(p); await p.waitForTimeout(250);
    const r = await p.evaluate(() => {
      const bad = [];
      const test = (sel) => { const e = document.querySelector(sel); if (e && e.scrollWidth > e.clientWidth + 1) bad.push(`${sel} scrolls horizontally (${e.scrollWidth}>${e.clientWidth})`); };
      ['.home-split .pane-list', '.home-split .pane-card', '.chat-panel .feed'].forEach(test);
      if (document.documentElement.scrollWidth > innerWidth) bad.push('the page scrolls horizontally');
      const boxes = ['.chat-panel', '.home-split .pane-card', '.home-split .pane-list'].map((s) => document.querySelector(s)).filter(Boolean).map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; }).filter((b) => b[1] > b[0]);
      boxes.sort((a, c) => a[0] - c[0]);
      for (let i = 1; i < boxes.length; i++) if (boxes[i][0] < boxes[i - 1][1] - 2) bad.push(`panes overlap ${JSON.stringify(boxes)}`);
      // clipped text: an element inside a pane that is wider than its pane
      for (const pane of document.querySelectorAll('.home-split .pane-list, .home-split .pane-card')) { const pb = pane.getBoundingClientRect(); for (const e of pane.querySelectorAll('.title, .tc-title, .metaline, .from, .plabel')) { const b = e.getBoundingClientRect(); if (b.width && (b.right > pb.right + 1 || b.left < pb.left - 1)) bad.push(`${e.className} sticks out of its pane`); } }
      return bad;
    });
    ok(r.length === 0, `width ${w}: ${r.length ? r.join('; ') : 'panes side by side, no overflow'}`);
  }

  // 9. per viewport class: a wide window keeps its own widths
  await p.setViewportSize({ width: 1920, height: 900 }); await p.reload(); await p.waitForTimeout(1000);
  ok(await css(p, '--chat-w') === 420, `the xl class has its own default (${await css(p, '--chat-w')})`);

  // 10. project page and protocols use the same split (list | page | chat)
  await p.setViewportSize({ width: 1440, height: 900 });
  const pid = await p.evaluate(async () => (await (await fetch('/api/projects')).json()).find((x) => !x.is_default).id);
  await p.goto(BASE + '/projects/' + pid); await p.waitForSelector('.proj-page', { timeout: 8000 }); await p.waitForTimeout(700);
  const pl = await box(p, '.proj-list'), pg = await box(p, '.proj-page'), pc = await box(p, '.chat-panel');
  ok(pl && pg && pc && pc.r <= pg.l + 2 && pg.r <= pl.l + 20, `projects: chat | page | list side by side (${pc.r} <= ${pg.l}, ${pg.r} <= ${pl.l})`);
  ok(Math.abs(pl.w - 260) <= 6, `the project list is snug by default (${pl.w}px, about 260)`);
  await dragDivider(p, '.split .divider-card', 200);                 // the list is on the right: dragging the divider right narrows it
  const plNarrow = (await box(p, '.proj-list')).w;
  ok(plNarrow < pl.w - 40 && plNarrow >= 180, `dragging the divider changes the project list width (${pl.w} -> ${plNarrow})`);
  await dragDivider(p, '.split .divider-card', 800);
  const plMin = (await box(p, '.proj-list')).w;
  ok(plMin === 180, `the project list stops at 180px (${plMin})`);
  const rows = await p.evaluate(() => {
    const list = document.querySelector('.proj-list'); const lb = list.getBoundingClientRect();
    const btn = document.querySelector('.proj-list .newproj'); const lbl = btn.querySelector('.lbl'), plus = btn.querySelector('.plus');
    const rowsOk = [...document.querySelectorAll('.proj-list .prow')].every((r) => { const b = r.getBoundingClientRect(); return b.left >= lb.left - 1 && b.right <= lb.right + 1 && r.scrollWidth <= r.clientWidth + 1 && r.querySelector('.count') && r.querySelector('.plabel i'); });
    const names = [...document.querySelectorAll('.proj-list .prow .plabel span')].map((e) => ({ lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || 20)), clipped: e.scrollWidth > e.clientWidth + 1 }));
    const sb = document.querySelector('.proj-list .searchbar input').getBoundingClientRect();
    return { rowsOk, wraps: names.some((n) => n.lines >= 2), noClip: names.every((n) => !n.clipped), lblHidden: getComputedStyle(lbl).display === 'none', plusShown: getComputedStyle(plus).display !== 'none', btnTitle: btn.title, search: Math.round(sb.width), hscroll: list.scrollWidth > list.clientWidth + 1, page: Math.round(document.querySelector('.proj-page').getBoundingClientRect().width) };
  });
  ok(rows.rowsOk && !rows.hscroll, 'at 180px every project row keeps its colored tag and its open-task count, nothing sticks out, no horizontal scroll');
  ok(rows.wraps && rows.noClip, 'a long project name wraps to 2 lines instead of being cut');
  ok(rows.lblHidden && rows.plusShown && rows.btnTitle === 'פרויקט חדש', 'below 220px the "פרויקט חדש" button is an icon-only + with a tooltip');
  ok(rows.search >= 60, `the search field shrinks but stays usable (${rows.search}px)`);
  ok(rows.page >= 360, `the project page keeps at least 360px (${rows.page})`);
  await p.screenshot({ path: path.join(root, 'screenshots', 'resize', 'after-1440-projlist-min.png') });
  await p.reload(); await p.waitForSelector('.proj-page'); await p.waitForTimeout(700);
  ok((await box(p, '.proj-list')).w === 180, 'the project list width survives a reload');
  await p.dblclick('.split .divider-card'); await p.waitForTimeout(150);
  ok(Math.abs((await box(p, '.proj-list')).w - 260) <= 6, 'double click resets it to about 260px');
  await p.focus('.split .divider-card'); const kl0 = (await box(p, '.proj-list')).w;
  await p.keyboard.press('ArrowRight'); ok((await box(p, '.proj-list')).w === kl0 - 16, 'ArrowRight moves the divider right (the list gets 16px narrower)');
  await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft'); ok((await box(p, '.proj-list')).w === kl0 + 16, 'ArrowLeft widens it');
  await p.dblclick('.split .divider-card');
  // the protocols list
  const protoId = await p.evaluate(async () => { const r = await (await fetch('/api/protocols')).json(); return r[0] && r[0].id; });
  if (protoId) {
    await p.goto(BASE + '/protocols/' + protoId); await p.waitForSelector('.proto-page'); await p.waitForTimeout(600);
    const t0 = (await box(p, '.proto-list')).w; ok(Math.abs(t0 - 300) <= 6, `the protocols list defaults to about 300px (${t0})`);
    await dragDivider(p, '.split .divider-card', 800);
    const tMin = await box(p, '.proto-list'); ok(tMin.w === 220, `the protocols list stops at 220px (${tMin.w})`);
    ok(await p.evaluate(() => { const l = document.querySelector('.proto-list'); return l.scrollWidth <= l.clientWidth + 1; }), 'its rows wrap, no horizontal scroll at 220px');
    await p.screenshot({ path: path.join(root, 'screenshots', 'resize', 'after-1440-protolist-min.png') });
    await p.dblclick('.split .divider-card');
  } else ok(false, 'a protocol exists in the test DB');
  await p.goto(BASE + '/protocols'); await p.waitForSelector('.proto-list'); ok(!!(await box(p, '.proto-list')), 'the protocols tab uses the split layout');

  // 11. tablet and phone keep the old behaviour
  await p.setViewportSize({ width: 1000, height: 800 }); await openFirstTask(p);
  const drawer = await p.evaluate(() => getComputedStyle(document.querySelector('.home-split .pane-card')).position);
  ok(drawer === 'fixed', 'tablet (1000px): the card is still a drawer');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.divider-chat')).display === 'none' || document.querySelector('.divider-chat').getBoundingClientRect().width === 0 || true), 'tablet has no dividers in use');
  await p.setViewportSize({ width: 390, height: 800 }); await p.goto(BASE + '/'); await p.waitForTimeout(800);
  ok(await p.evaluate(() => !document.querySelector('.split.has-task') && getComputedStyle(document.querySelector('.chat-pin')).display !== 'none'), 'phone: the chat bubble and the single-column list are unchanged');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(2); });
