'use strict';
// Edit / delete chat messages in the UI (TEST instance, no agent): ⋯ menu, inline edit (Enter saves, Esc cancels), "נערך" marker, superseded reply, delete dialog.
const { chromium } = require('playwright');
process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createChat } = require('../lib/chat');
const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); const a = store.assistantId(), owner = store.ownerId();
const tag = Date.now().toString(36);
const mine = chat.sendChat(owner, { text: 'הודעה לעריכה ' + tag });
const run = db.prepare("INSERT INTO claude_runs (started_at, trigger, finished_at) VALUES (?, 'chat', ?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
db.prepare('INSERT INTO run_messages (run_id, msg_id) VALUES (?,?)').run(run, mine.id);
const reply = chat.sendChat(a, { text: 'תשובה ישנה ' + tag }); db.prepare('UPDATE chat_messages SET run_id=? WHERE id=?').run(run, reply.id);
const mine2 = chat.sendChat(owner, { text: 'הודעה למחיקה ' + tag });
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:8111/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(2000);
  await p.goto('http://127.0.0.1:8111/'); await p.waitForTimeout(2000);
  const bubble = (t) => p.locator('.chat-panel .bubble', { hasText: t }).first();
  // owner message: both actions; assistant message: delete only
  await bubble('הודעה לעריכה ' + tag).hover(); await bubble('הודעה לעריכה ' + tag).locator('.msg-dots').click();
  const items = await bubble('הודעה לעריכה ' + tag).locator('.msg-menu button').allTextContents(); ok(items.join('|') === 'ערוך|מחק', 'owner message menu: ' + items.join('|'));
  await p.keyboard.press('Escape'); await p.locator('.chat-panel .cp-head').click(); await p.waitForTimeout(200);
  await bubble('תשובה ישנה ' + tag).hover(); await bubble('תשובה ישנה ' + tag).locator('.msg-dots').click();
  await p.waitForTimeout(300); const items2 = await bubble('תשובה ישנה ' + tag).locator('.msg-menu button:visible').allTextContents(); ok(items2.join('|') === 'מחק', 'assistant message menu: ' + items2.join('|'));
  await p.locator('.chat-panel .cp-head').click(); await p.waitForTimeout(200);
  // Esc cancels, Enter saves
  await bubble('הודעה לעריכה ' + tag).hover(); await bubble('הודעה לעריכה ' + tag).locator('.msg-dots').click(); await bubble('הודעה לעריכה ' + tag).locator('.msg-menu button', { hasText: 'ערוך' }).click();
  await p.fill('.edit-in', 'לא נשמר'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  ok(await p.locator('.edit-in').count() === 0 && db.prepare('SELECT text FROM chat_messages WHERE id=?').get(mine.id).text.startsWith('הודעה לעריכה'), 'Esc cancels the edit');
  await bubble('הודעה לעריכה ' + tag).hover(); await bubble('הודעה לעריכה ' + tag).locator('.msg-dots').click(); await bubble('הודעה לעריכה ' + tag).locator('.msg-menu button', { hasText: 'ערוך' }).click();
  await p.fill('.edit-in', 'הודעה ערוכה ' + tag); await p.keyboard.press('Enter'); await p.waitForTimeout(1800);
  const row = db.prepare('SELECT text, edited_from FROM chat_messages WHERE id=?').get(mine.id); ok(row.text === 'הודעה ערוכה ' + tag && row.edited_from === 'הודעה לעריכה ' + tag, 'Enter saves; original kept: ' + JSON.stringify(row));
  ok(await bubble('הודעה ערוכה ' + tag).locator('.edited-mark').isVisible(), 'the "נערך" marker is shown');
  ok(db.prepare('SELECT superseded FROM chat_messages WHERE id=?').get(reply.id).superseded === 1, 'the old reply is superseded');
  const sup = p.locator('.chat-panel .sup-reply:visible', { hasText: 'תשובה קודמת (הוחלפה)' }).first(); ok(await sup.isVisible(), 'the old reply is collapsed under "תשובה קודמת (הוחלפה)"');
  await sup.locator('summary').click(); await p.waitForTimeout(200); ok(/תשובה ישנה/.test(await sup.textContent()), 'and expandable');
  // delete with the dialog
  await bubble('הודעה למחיקה ' + tag).hover(); await bubble('הודעה למחיקה ' + tag).locator('.msg-dots').click(); await bubble('הודעה למחיקה ' + tag).locator('.msg-menu button', { hasText: 'מחק' }).click(); await p.waitForTimeout(300);
  ok(await p.locator('.del-dlg').isVisible(), 'delete dialog'); ok(await p.locator('.del-dlg input[type=checkbox]').isChecked(), 'the undo checkbox is ON by default');
  ok(/בטל גם את מה שאלכס עשה/.test(await p.textContent('.del-dlg')), 'checkbox label');
  await p.locator('.del-dlg .btn.danger').click(); await p.waitForTimeout(1500);
  ok(db.prepare('SELECT deleted_at FROM chat_messages WHERE id=?').get(mine2.id).deleted_at, 'soft-deleted (audit kept)'); ok(await p.locator('.chat-panel .bubble', { hasText: 'הודעה למחיקה ' + tag }).count() === 0, 'gone from the chat');
  await b.close(); console.log(fail ? fail + ' FAILED' : 'ALL OK'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
