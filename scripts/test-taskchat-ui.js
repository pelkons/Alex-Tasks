'use strict';
// Task-scoped chat in the card (TEST instance, no agent needed): composer, Enter / Shift+Enter, thread, main-chat chip and the hide toggle.
const { chromium } = require('playwright');
process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
const { open } = require('../lib/db'); const { createStore } = require('../lib/store');
const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db); const a = store.assistantId(), owner = store.ownerId();
const proj = store.listProjects().find((p) => !p.is_default) || store.createProject(a, { name: 'מגדל הדוגמה' });
const t = store.createTask(a, { title: 'לתאם סיור בטיחות', project: proj.id, due: '2026-12-02', requester: owner, assignee: owner });
store.addNote(owner, { task: t.id, text: 'הערה ישנה להיסטוריה' });
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const ctx = await b.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage();
    await p.goto('http://127.0.0.1:8111/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(2000);
    await p.goto(`http://127.0.0.1:8111/task/${t.id}`); await p.waitForTimeout(1800);
    ok(await p.isVisible('.tchat h3'), tag + ': "שיחה על המשימה" block');
    ok(!(await p.$('.note-form')), tag + ': the add-note box is gone');
    ok(/הערה ישנה/.test(await p.textContent('.tchat')), tag + ': old notes are read-only history in the conversation');
    const ph = await p.getAttribute('.tc-in', 'placeholder'); ok(/על המשימה/.test(ph), tag + ': placeholder ' + ph);
    ok(await p.isVisible('.tc-form button[aria-label="הקלטה קולית"]') && await p.isVisible('.tc-form button[aria-label="צירוף קובץ"]'), tag + ': mic and paperclip');
    await p.fill('.tc-in', 'שורה ראשונה ' + tag); await p.keyboard.press('Shift+Enter'); await p.keyboard.type('שורה שנייה'); await p.waitForTimeout(300);
    ok((await p.inputValue('.tc-in')).includes('\n'), tag + ': Shift+Enter makes a new line');
    ok(!new RegExp('שורה ראשונה ' + tag).test(await p.textContent('.tc-feed')), tag + ': ... and did not send');
    await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
    ok(new RegExp('שורה ראשונה ' + tag).test(await p.textContent('.tc-feed')), tag + ': Enter sends; the message is in the thread');
    const row = db.prepare("SELECT scope, task_id FROM chat_messages WHERE text LIKE 'שורה ראשונה ' || ? || '%' AND task_id=?").get(tag, t.id); ok(row && row.scope === 'task' && row.task_id === t.id, tag + ': stored as scope task ' + JSON.stringify(row));
    // an assistant reply appears in the card without user action
    db.prepare("INSERT INTO claude_runs (started_at, trigger, pinned_task_id) VALUES (?, 'chat', ?)").run(new Date().toISOString(), t.id);
    require('../lib/chat').createChat(db, store, require('../lib/knowledge').createKnowledge(db, store)).sendChat(a, { text: 'סידרתי: הסיור נקבע ליום חמישי.' });
    db.prepare('UPDATE claude_runs SET finished_at=? WHERE finished_at IS NULL').run(new Date().toISOString());
    await p.waitForFunction(() => /הסיור נקבע/.test(document.querySelector('.tc-feed').textContent), null, { timeout: 15000 }).then(() => ok(true, tag + ': the assistant reply shows in the card thread live'), () => ok(false, tag + ': reply did not appear'));
    const scrolled = await p.evaluate(() => { const f = document.querySelector('.tc-feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 8; }); ok(scrolled, tag + ': the thread auto-scrolls');
    await p.screenshot({ path: `screenshots/resize/taskchat-${tag}.png` });
    if (tag === 'desktop') {
      await p.goto('http://127.0.0.1:8111/'); await p.waitForTimeout(2000);
      const chip = await p.$$eval('.tchip-top', (els) => els.map((e) => e.textContent.trim())); ok(chip.some((x) => x.includes('לתאם סיור בטיחות')), 'main chat: task chip ' + JSON.stringify(chip));
      await p.click('.cp-tog input'); await p.waitForTimeout(400);
      ok((await p.$$('.tchip-top:visible')).length === 0, 'main chat: the toggle hides task messages');
      await p.reload(); await p.waitForTimeout(1800); ok((await p.$$('.tchip-top:visible')).length === 0, 'main chat: the choice is remembered');
      await p.click('.cp-tog input'); await p.waitForTimeout(300);
    }
    await b.close();
  }
  console.log(fail ? fail + ' FAILED' : 'ALL OK'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
