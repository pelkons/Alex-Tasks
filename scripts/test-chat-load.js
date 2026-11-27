'use strict';
// The chat list must never render blank: messages (some of them odd) arrive every second while the owner is scrolled up, on the phone sheet,
// collapsed and re-expanded, and at narrow desktop widths. TEST instance only.
const { chromium } = require('playwright');
process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createChat } = require('../lib/chat');
const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); const a = store.assistantId(), owner = store.ownerId();
db.pragma('foreign_keys = OFF'); // the odd messages below reference rows that do not exist
const proj = store.listProjects().find((p) => !p.is_default) || store.createProject(store.ownerId(), { name: 'מגדל הדוגמה' });
const task = store.createTask(a, { title: 'משימה לבדיקת העומס', project: proj.id, due: '2026-12-03', requester: owner });
for (let i = 0; i < 25; i++) chat.sendChat(i % 2 ? owner : a, { text: `הודעת רקע ${i} ` + 'מילים '.repeat(i % 7) });
let n = 0;
const odd = [
  () => db.prepare("INSERT INTO chat_messages (author, channel, text, created_at, file_ids, task_ids, task_id, scope) VALUES ('claude','web','הודעה על משימה שנמחקה','" + new Date().toISOString() + "','[99999]','[99999]',99999,'task')").run(),
  () => db.prepare("INSERT INTO chat_messages (author, channel, text, created_at, import_id) VALUES ('claude','web','ייבוא יומי: 3 קבצים','" + new Date().toISOString() + "', 424242)").run(),
  () => db.prepare("INSERT INTO chat_messages (author, channel, text, created_at) VALUES ('claude','web','','" + new Date().toISOString() + "')").run(),
  () => chat.sendChat(a, { text: 'קישור ' + `/task/${task.id} /projects/${proj.id} /email/999999 ` + '😀'.repeat(30), task_scope: task.id }),
  () => chat.sendChat(a, { text: 'ארוך '.repeat(400) }),
];
const feed = () => { n++; (odd[n % odd.length] || odd[0])(); if (n % 2) chat.sendChat(a, { text: `הודעה חיה ${n}` }); };
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const state = (p) => p.evaluate(() => { const f = document.querySelector('.chat-panel .feed'); const d = Alpine.$data(document.body); return { bubbles: f ? f.querySelectorAll('.bubble:not(.thinking-b)').length : -1, model: d.chatView().length, all: d.chatMsgs.length, h: f ? f.clientHeight : -1, w: f ? f.clientWidth : -1 }; });
async function run(tag, w, h, setup) {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: w < 900 }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message))); p.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errs.push(m.text()); });
  await p.goto('http://127.0.0.1:8111/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(2000);
  await p.goto('http://127.0.0.1:8111/'); await p.waitForTimeout(1800);
  if (setup) await setup(p);
  let minBubbles = 1e9, blank = 0;
  for (let i = 0; i < 12; i++) { feed(); await p.waitForTimeout(1100); const s = await state(p); minBubbles = Math.min(minBubbles, s.bubbles); if (s.bubbles === 0 || s.bubbles < Math.min(s.model, 6)) blank++; }
  const s = await state(p);
  ok(s.bubbles > 0 && blank === 0, `${tag}: never blank under load (min ${minBubbles} bubbles, final ${s.bubbles}/${s.model}, size ${s.w}x${s.h})`);
  ok(errs.length === 0, `${tag}: no page errors ${JSON.stringify(errs.slice(0, 2))}`);
  await b.close();
}
(async () => {
  await run('desktop 1440', 1440, 900);
  await run('desktop 1280', 1280, 800);
  await run('desktop 1024', 1024, 768);
  await run('scrolled up (1280)', 1280, 800, async (p) => { await p.evaluate(() => { document.querySelector('.chat-panel .feed').scrollTop = 0; }); });
  await run('phone sheet', 390, 844, async (p) => { await p.click('.chat-pin'); await p.waitForTimeout(800); });
  await run('collapsed then expanded (1440)', 1440, 900, async (p) => { await p.evaluate(() => MesimotLayout.setCollapsed(true)); await p.waitForTimeout(3500); await p.evaluate(() => MesimotLayout.setCollapsed(false)); await p.waitForTimeout(600); });
  await run('task messages hidden (1440)', 1440, 900, async (p) => { await p.click('.cp-tog input'); await p.waitForTimeout(300); });
  console.log(fail ? fail + ' FAILED' : 'ALL OK'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
