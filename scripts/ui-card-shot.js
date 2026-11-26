'use strict';
// Screenshot of a task card with a realistic (fictional) history on the TEST instance: node scripts/ui-card-shot.js <name> [--seed]
process.env.MESIMOT_DB = process.env.MESIMOT_DB || '/tmp/mesimot-test/test.db'; process.env.MESIMOT_SEMANTIC = '0';
const fs = require('fs'); fs.mkdirSync('/tmp/ui-shots', { recursive: true });
const { chromium } = require('playwright'); const name = process.argv[2] || 'card';
let taskId = 1;
if (process.argv.includes('--seed')) {
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createChat } = require('../lib/chat'); const db = open(); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); const a = store.assistantId(), owner = store.ownerId();
  const p = store.createProject(a, { name: 'פרויקט הדוגמה' }); const ppl = store.createPerson(a, { name: 'יעל כהן', role: 'contact' });
  const t = store.createTask(a, { title: 'לבדוק את נוסח הערבות הבנקאית ולהחזיר הערות', project: p.id, requester: ppl.id, assignee: owner, due: '2026-11-29', due_source: 'estimated', priority: 'רגיל' }); taskId = t.id;
  store.updateTask(a, t.id, { due: '2026-11-25' }); store.updateTask(a, t.id, { due_source: 'explicit' }); store.updateTask(a, t.id, { priority: 'דחוף' }); store.updateTask(a, t.id, { description: 'נוסח טיוטה מצורף, להחזיר עם הערות' }); store.updateTask(a, t.id, { status: 'בטיפול' }); store.updateTask(a, t.id, { title: 'לבדוק את נוסח הערבות הבנקאית ולהחזיר הערות עד מחר' });
  store.addNote(owner, { task: t.id, text: 'לבדוק גם את סעיף התנאים המתלים' });
  if (process.argv.includes('--chat')) { chat.sendChat(owner, { text: 'תדחה בשבוע', task_scope: t.id }); chat.sendChat(a, { text: 'דחיתי את היעד בשבוע: 25/11 ← 02/12.', task: String(t.id) }); }
}
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); const page = await (await b.newContext({ viewport: { width: 1440, height: 1300 } })).newPage();
  await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
  await page.goto('http://127.0.0.1:8111/task/' + taskId); await page.waitForTimeout(2000);
  if (process.argv.includes('--open-history')) await page.locator('.hist-d summary').click().catch(() => {});
  await page.screenshot({ path: `/tmp/ui-shots/${name}.png`, fullPage: false }); await b.close(); console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
