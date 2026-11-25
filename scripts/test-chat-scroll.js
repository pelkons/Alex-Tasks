'use strict';
// Chat auto-scroll on the TEST instance: live messages, scrolled-up button, collapse/expand, phone sheet.
const { chromium } = require('playwright');
process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createChat } = require('../lib/chat'); const { createKnowledge } = require('../lib/knowledge');
const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); const a = store.assistantId();
const BASE = 'http://127.0.0.1:8111'; let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const RUN = Date.now().toString(36); let n = 0; const say = (t) => chat.sendChat(a, { text: `${t} ${++n} ${Date.now()}` });
const lastVisible1 = (p) => p.evaluate(() => { const f = document.querySelector('.chat-panel .feed'); return f.clientHeight > 0 && f.scrollHeight - f.scrollTop - f.clientHeight < 6; });
const lastVisible = async (p) => { for (let i = 0; i < 8; i++) { if (await lastVisible1(p)) return true; await p.waitForTimeout(250); } return false; };
const waitMsg = async (p, txt) => { try { await p.waitForFunction((t) => document.querySelector('.chat-panel .feed').textContent.includes(t), txt, { timeout: 12000 }); await p.waitForTimeout(500); return true; } catch { return false; } };
(async () => {
  for (let i = 0; i < 15; i++) say('הודעת רקע ארוכה כדי למלא את הצ׳אט ' + 'מילים '.repeat(10));
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const login = async (ctx) => { const p = await ctx.newPage(); await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(2000); return p; };
  // desktop
  let ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); let p = await login(ctx);
  await p.goto(BASE + '/'); await p.waitForTimeout(1500);
  ok(await lastVisible(p), 'desktop: initial render shows the latest message');
  say('חי1-' + RUN); ok(await waitMsg(p, 'חי1-' + RUN) && await lastVisible(p), 'desktop: live message appears and is visible without action');
  // scrolled up: not yanked
  await p.evaluate(() => { document.querySelector('.chat-panel .feed').scrollTop = 0; }); await p.waitForTimeout(300);
  say('חי2-' + RUN); await waitMsg(p, 'חי2-' + RUN);
  const st = await p.evaluate(() => ({ top: document.querySelector('.chat-panel .feed').scrollTop, btn: getComputedStyle(document.querySelector('.newmsg-btn')).display !== 'none', cnt: document.querySelector('.newmsg-btn b').textContent }));
  ok(st.top < 50 && st.btn && st.cnt >= '1', 'desktop: scrolled-up owner is not yanked, button shows ' + JSON.stringify(st));
  await p.click('.newmsg-btn'); await p.waitForTimeout(500); ok(await lastVisible(p), 'desktop: button scrolls to the bottom');
  // collapsed -> expanded
  await p.evaluate(() => MesimotLayout.setCollapsed(true)); await p.waitForTimeout(300);
  say('חי3-' + RUN); await p.waitForTimeout(4000);
  await p.evaluate(() => MesimotLayout.setCollapsed(false)); await p.waitForTimeout(800);
  const w3 = await waitMsg(p, 'חי3-' + RUN); const lv = await lastVisible(p); const dbg = await p.evaluate(() => { const f = document.querySelector('.chat-panel .feed'); return [f.scrollTop, f.scrollHeight, f.clientHeight, Alpine.$data(document.body)._stick]; });
  ok(w3 && lv, 'desktop: collapsed -> expanded shows the latest ' + JSON.stringify([w3, lv, dbg, await p.evaluate(() => { const d = Alpine.$data(document.body); return [d.chatMsgs.slice(-3).map((m) => m.text.slice(0, 22)), d.lastMsgId]; })]));
  // sending
  await p.fill('.chat-panel .comp-input', 'שלום בדיקה'); await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
  ok(await lastVisible(p), 'desktop: after sending the own message is visible');
  await ctx.close();
  // phone
  ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }); p = await login(ctx);
  await p.goto(BASE + '/'); await p.waitForTimeout(1500);
  await p.click('.chat-pin'); await p.waitForTimeout(800); ok(await lastVisible(p), 'phone: sheet opens at the latest message');
  say('חי4-' + RUN); ok(await waitMsg(p, 'חי4-' + RUN) && await lastVisible(p), 'phone: live message visible in the open sheet');
  await p.click('.cp-close'); await p.waitForTimeout(300); say('חי5-' + RUN); await p.waitForTimeout(4000);
  await p.click('.chat-pin, .tabbar button:has-text("צ׳אט")').catch(() => {}); await p.waitForTimeout(900);
  ok(await waitMsg(p, 'חי5-' + RUN) && await lastVisible(p), 'phone: reopened sheet shows the latest');
  await ctx.close(); await b.close(); console.log(fail ? fail + ' FAILED' : 'ALL OK'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
