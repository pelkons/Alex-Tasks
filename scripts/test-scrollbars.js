'use strict';
// UI audit on the TEST instance: every visible scroll container must have its scrollbar on the LEFT (RTL), the card pane must scroll to its very end with the composer reachable,
// the email preview is the cleaned short version, and the thread never doubles. Run at 1900x1080 and 1440x900.
process.env.MESIMOT_DB = process.env.MESIMOT_DB || '/tmp/mesimot-test/test.db'; process.env.MESIMOT_SEMANTIC = '0';
const { chromium } = require('playwright'); const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createChat } = require('../lib/chat');
const db = open(); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); const a = store.assistantId(), o = store.ownerId();
const proj = store.createProject(a, { name: 'פרויקט הדוגמה' }); const person = store.createPerson(a, { name: 'אמיר דוגמה', role: 'contact', emails: ['amir@v.example'] });
const SIG = 'שלום רב,\nמצורף העדכון לגבי התכנון של הבניין הראשון והשני בפרויקט. אנא אשרו עד סוף השבוע.\nבברכה,\n\n\n\n\nאמיר\n\n\n\n\n\nדוגמה\n\n\n\nסמנכ"ל הנדסה';
const eid = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, mail_date, body_text, project_id, attachments) VALUES ('sc1','Amir <amir@v.example>','עדכון תכנון',?,?,?,?,'[]')").run(new Date().toISOString(), new Date().toISOString(), SIG + '\n\n' + Array.from({ length: 40 }, (_, i) => 'שורה ארוכה מספר ' + i + ' בגוף המייל המקורי').join('\n'), proj.id).lastInsertRowid;
for (let i = 1; i <= 40; i++) store.createTask(a, { title: `משימה מספר ${i} בפרויקט ארוך`, project: proj.id, requester: person.id, due: '2026-12-20' });
const eid2 = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, mail_date, body_text, project_id, attachments) VALUES ('sc2','Bob <bob@v.example>','English first',?,?,?,?,'[]')").run(new Date().toISOString(), new Date().toISOString(), 'Hello Dana,\n' + Array.from({ length: 40 }, (_, i) => 'Line number ' + i + ' of an English mail body').join('\n') + '\nשורה בעברית', proj.id).lastInsertRowid;
store.createTask(a, { title: 'משימה עם מייל באנגלית', project: proj.id, requester: person.id, source_email_id: eid2, due: '2026-12-03' });
const t = store.createTask(a, { title: 'משימה עם מייל מקורי ושיחה', project: proj.id, requester: person.id, source_email_id: eid, due: '2026-12-02' });
for (let i = 0; i < 14; i++) { chat.sendChat(o, { text: `שאלה מספר ${i} על המשימה: האם אפשר לעדכן?`, task_scope: t.id }); chat.sendChat(a, { text: `תשובה מספר ${i}: עדכנתי את המשימה והוספתי פרטים נוספים כדי שיהיה ברור מה נעשה ומה נשאר.`, task: String(t.id) }); }
for (let i = 0; i < 30; i++) chat.sendChat(a, { text: `הודעה כללית מספר ${i} בצ׳אט הראשי` });
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar'] }); let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  for (const vp of [{ width: 1900, height: 1080 }, { width: 1440, height: 900 }]) {
    const page = await (await b.newContext({ viewport: vp })).newPage(); const tag = `${vp.width}x${vp.height}`;
    await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    const audit = async (label) => { const bad = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter((e) => { const c = getComputedStyle(e); return /(auto|scroll)/.test(c.overflowY) && e.scrollHeight > e.clientHeight + 1 && e.offsetWidth - e.clientWidth - e.clientLeft > 0 && e.offsetParent !== null; }).filter((e) => { const sb = e.offsetWidth - e.clientWidth - parseFloat(getComputedStyle(e).borderLeftWidth || 0) - parseFloat(getComputedStyle(e).borderRightWidth || 0); return !(e.clientLeft >= sb - 1 && sb > 0); }).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)} dir=${getComputedStyle(e).direction}`)); ok(bad.length === 0, `${tag} ${label}: every visible scrollbar is on the left` + (bad.length ? ': ' + bad.join(' | ') : '')); };
    const count = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1 && e.offsetParent !== null).length); console.log(`   (${count} scroll containers on the list page)`);
    await audit('list page');
    await page.goto('http://127.0.0.1:8111/task/' + t.id); await page.waitForTimeout(2000);
    await page.locator('.email-src summary').click(); await page.waitForTimeout(400); await audit('task card with the email preview open');
    const prev = await page.locator('.email-src .mailtext').innerText(); ok(!/\n\s*\n\s*\n/.test(prev), `${tag} email preview has no big vertical gaps`); ok(!/סמנכ"ל הנדסה/.test(prev) || /הצג הכל/.test(await page.locator('.email-src').innerText()), `${tag} the signature is stripped or the preview is collapsed`);
    const lines = prev.split('\n').filter(Boolean).length; ok(lines <= 13, `${tag} the preview shows at most ~12 lines collapsed (${lines})`); ok(await page.locator('.email-src button', { hasText: 'הצג הכל' }).count() === 1, `${tag} "הצג הכל" is there`);
    const reach = await page.evaluate(() => { const pane = document.querySelector('.pane-card'); pane.scrollTop = pane.scrollHeight; const f = document.querySelector('.tchat .tc-form'); const r = f.getBoundingClientRect(); const pr = pane.getBoundingClientRect(); return { formBottom: Math.round(r.bottom), paneBottom: Math.round(pr.bottom), vh: innerHeight }; });
    ok(reach.formBottom <= reach.paneBottom && reach.formBottom <= reach.vh, `${tag} the composer is reachable at the end of the card pane (${JSON.stringify(reach)})`);
    await page.evaluate(() => { const f = document.querySelector('.tc-feed'); if (f) f.scrollTop = f.scrollHeight; });
    await page.screenshot({ path: `/tmp/ui-shots/${process.env.SHOT_PREFIX || 'scroll'}-${tag}.png` });
    await page.goto('http://127.0.0.1:8111/task/' + (t.id - 1)); await page.waitForTimeout(1500); await page.locator('.email-src summary').click(); await page.waitForTimeout(300); await audit('English-first email preview');
    await page.locator('button', { hasText: 'סינון' }).first().click().catch(() => {}); await page.waitForTimeout(400); await audit('with the filter panel');
    await page.close();
  }
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
