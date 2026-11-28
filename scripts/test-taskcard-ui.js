'use strict';
// The lower part of the task card on the TEST instance: the source email card, the notes timeline, the conversation (day separators, bubbles) and the footer.
// Seeds its own realistic task (an email with attachments, notes, a 10-message conversation). On phones the conversation must grow with the page (no nested scroll box)
// and nothing may overflow sideways. Run: scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; node scripts/test-taskcard-ui.js   (SHOTS=dir to keep screenshots)
const fs = require('fs');
process.env.MESIMOT_DB = process.env.MESIMOT_DB || '/tmp/mesimot-test/test.db'; process.env.MESIMOT_SEMANTIC = '0';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
const SHOTS = process.env.SHOTS || '/tmp/ui-shots'; fs.mkdirSync(SHOTS, { recursive: true });
const { chromium } = require('playwright');
const { open, now } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createChat } = require('../lib/chat');
const db = open(process.env.MESIMOT_DB); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); const a = store.assistantId(), o = store.ownerId();

// ---- seed
const day = (n, hh, mm) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); d.setUTCHours(hh - 2, mm, 0, 0); return d.toISOString(); };
const proj = store.listProjects().find((p) => p.name_he === 'מגדל הנוף') || store.createProject(o, { name: 'מגדל הנוף' });
const walid = store.listPeople().find((p) => p.name_he === 'סמיר חדד') || store.createPerson(a, { name: 'סמיר חדד', role: 'contact', emails: ['samir@hadad.example'] });
const thread = (from, date) => JSON.stringify([{ index: 0, from_name: from, from_email: 'samir@hadad.example', date, to: [{ name: 'עמית לב', email: 'amit@x.example' }, { name: 'רון שחר', email: 'ron@x.example' }], cc: [{ name: 'אורי', email: 'ori@x.example' }] }]);
const body1 = 'וסמיר ועמית שלום,\n\nמצורפים הגוונים שנבחרו למסתורי הכביסה בבניין B.\nאבקש לאשר עד יום חמישי כדי שנוכל להזמין את הפרופילים מהספק.\n\n- גוון ראשי: RAL 9006 white aluminium\n- גוון משני: RAL 7016 anthracite\n\nבברכה,\nסמיר חדד\nמנהל פרויקט';
const insEmail = (mid, subj, date, body, files) => {
  const id = db.prepare("INSERT INTO emails (message_id, from_addr, to_addr, subject, received_at, body_text, forwarded_from, attachments, labels, participants, thread, thread_key, project_numbers, mail_provider, forwarded_date, original_subject) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(mid, 'owner@test', 'alex@test', 'FW: ' + subj, date, body, 'סמיר חדד <samir@hadad.example>', JSON.stringify(files.map((f) => ({ filename: f[0], content_type: f[1], size: 20480 }))), '[]', '[]', thread('סמיר חדד', date), 'tc-' + mid, '[]', 'test', date, subj).lastInsertRowid;
  for (const [name, mime, summary, chunks] of files) {
    const fid = db.prepare("INSERT INTO files (original_name, path, mime, size, source, created_at, email_id, text_status, summary) VALUES (?,?,?,?,?,?,?,?,?)").run(name, '/tmp/none', mime, 20480, 'email', now(), id, chunks ? 'ok' : 'none', summary).lastInsertRowid;
    for (let i = 0; i < chunks; i++) db.prepare('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)').run(fid, i, 'טקסט ' + i, 1);
  }
  return id;
};
const e1 = insEmail('<tc-1-' + Date.now() + '@test>', 'גוונים למסתורי כביסה - בניין B', day(3, 7, 52), body1, [
  ['F14182EC0004C55084D30000.msg', 'application/vnd.ms-outlook', null, 0],
  ['מפרט גוונים למסתורים RAL.pdf', 'application/pdf', 'מפרט הגוונים למסתורי הכביסה: RAL 9006 לגוון הראשי ו-RAL 7016 לגוון המשני.\nכולל דוגמאות צבע ופרופיל טמבור.', 2],
  ['כתב כמויות מסתורים בניין B.xlsx', 'application/vnd.ms-excel', null, 1],
]);
const e2 = insEmail('<tc-2-' + Date.now() + '@test>', 'RE: גוונים למסתורי כביסה - בניין B', day(1, 9, 15), 'אורי שלום,\nעמית עדיין בודק את המסתורים מול הספק, נחזור עד מחר.\nסמיר', []);
const t = store.createTask(a, { title: 'לאשר גוונים למסתורי כביסה בבניין B', description: 'סמיר ביקש לאשר את הגוונים למסתורי הכביסה לפני הזמנת הפרופילים.', project: proj.id, requester: walid.id, due: '2026-12-03', source_email_id: e1 });
store.linkTaskEmail(a, t.id, e2, 'updated', true);
const notes = [
  [3, 8, 5, 'נוצרה מהמייל של סמיר חדד'],
  [2, 1, 55, 'עודכנה: המייל נשלח במקור על ידי סמיר חדד, ולכן הוא המבקש; רון שחר ביקש את הגוונים במייל המקורי מ-15/11'],
  [1, 9, 20, 'סמיר עדכן שעמית עדיין בודק את המסתורים מול הספק'],
  [1, 17, 9, 'עודכנה: סמיר השיב ב-16/11 RAL 9006 white aluminium (מניפת טמבור); רון שאל אם זה הכל ועמית בוחן את מסתורי הכביסה - עדיין ממתינים להשלמה'],
  [0, 8, 30, 'תאריך היעד הוזז ל-03/12 לפי בקשת אורי'],
];
for (const [d, h, m, text] of notes) { const n = store.addNote(a, { task: t.id, text }); const nid = n && n.id ? n.id : db.prepare('SELECT MAX(id) id FROM notes').get().id; db.prepare('UPDATE notes SET created_at=? WHERE id=?').run(day(d, h, m), nid); }
const conv = [
  [2, 10, 2, o, 'מה המצב עם הגוונים? סמיר כבר קיבל תשובה?'],
  [2, 10, 3, a, 'בדקתי את ההתכתבות: סמיר שלח את הגוונים ב-16/11 וביקש אישור עד יום חמישי.\n\nמה שידוע כרגע:\n- הגוון הראשי RAL 9006 white aluminium אושר על ידי רון.\n- הגוון המשני RAL 7016 עדיין לא אושר.\n- עמית בודק את מסתורי הכביסה מול הספק.\n\nאני ממליץ לחכות לתשובה של עמית עד מחר ורק אז להזמין את הפרופילים.'],
  [2, 10, 9, o, 'תזכיר לי מחר בבוקר'],
  [2, 10, 10, a, 'בסדר, אזכיר לך מחר בשמונה בבוקר.'],
  [1, 9, 30, o, 'עמית ענה משהו?'],
  [1, 9, 31, a, 'עדיין לא. סמיר כתב הבוקר ב-09:15 שעמית עדיין בודק את המסתורים מול הספק ושהם יחזרו עד מחר.\nרשמתי את זה כהערה במשימה.'],
  [1, 9, 40, o, 'אוקיי. תכין לי טיוטת מייל קצרה לסמיר שמבקשת תשובה סופית עד יום חמישי'],
  [1, 9, 41, a, 'הנה טיוטה:\n\nסמיר שלום,\nכדי שנספיק להזמין את הפרופילים בזמן, נבקש תשובה סופית על שני הגוונים עד יום חמישי.\n1. גוון ראשי: RAL 9006\n2. גוון משני: RAL 7016\n\nתודה,\nאורי\n\nאם תרצה, אשלח אותה בשמך מתיבת הדואר.'],
  [0, 9, 48, o, 'עדיין לא התקבלה התייחסות על זה?'],
  [0, 9, 49, a, 'בדקתי שוב (חיפוש במיילים, בקבצים, בכרטיס הפרויקט ובצ׳אט): נכון להיום עדיין אין התייחסות של עמית או סמיר על מסתורי הכביסה. המייל האחרון בנושא הוא מאתמול, שם סמיר כתב שעמית עדיין בודק.\n\nהצעות להמשך:\n- לשלוח את הטיוטה שהכנתי אתמול.\n- להתקשר לעמית ישירות, כי הוא זה שמעכב.\n- להזיז את תאריך היעד ביומיים אם הספק מאפשר.\n\nרשמתי הערה במשימה.'],
];
for (const [d, h, m, who, text] of conv) {
  const msg = who === o ? chat.sendChat(o, { text, task_scope: t.id }) : chat.sendChat(a, { text, task: String(t.id), task_scope: t.id });
  const id = msg && msg.id ? msg.id : db.prepare('SELECT MAX(id) id FROM chat_messages').get().id;
  db.prepare("UPDATE chat_messages SET created_at=?, task_id=?, scope='task' WHERE id=?").run(day(d, h, m), t.id, id);
}
const lastId = db.prepare("SELECT MAX(id) id FROM chat_messages WHERE task_id=? AND author='claude'").get(t.id).id;
try { db.prepare('UPDATE chat_messages SET edited_at=? WHERE id=?').run(now(), lastId); } catch { /* no edited marker column */ }
console.log('task', t.id);

// ---- checks
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  for (const [w, h] of [[412, 915], [360, 780], [1440, 900]]) {
    for (const scheme of ['light', 'dark']) {
      const tag = `${w}-${scheme}`; const phone = w < 900;
      const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone }); const p = await ctx.newPage();
      await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(1800);
      await p.goto(`${BASE}/task/${t.id}`); await p.waitForSelector('.tc-title'); await p.waitForTimeout(1200);
      // structure and order
      const order = await p.$$eval('.tcard .cs', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.dataset.sec));
      ok(JSON.stringify(order.filter((x) => ['mail', 'notes', 'chat'].includes(x))) === '["mail","notes","chat"]', `${tag}: sections in order email, notes, conversation ${JSON.stringify(order)}`);
      const heads = await p.$$eval('.tcard .cs-h', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      ok(heads.length >= 3 && heads.every((x) => /\d/.test(x) || /שיחה/.test(x)), `${tag}: section headings with counts ${JSON.stringify(heads)}`);
      // the notes are a separate timeline, not inside the conversation
      ok(await p.$$eval('.tc-notes .tl-item', (els) => els.length) === 1, `${tag}: only the latest note shows at first`);
      await p.click('.tc-notes .tc-more'); await p.waitForTimeout(250);
      ok(await p.$$eval('.tc-notes .tl-item', (els) => els.length) >= 3, `${tag}: notes are a timeline once unfolded`);
      await p.click('.tc-notes .tc-more:has-text("הסתר")'); await p.waitForTimeout(250);
      ok(await p.$$eval('.tc-notes .tl-item', (els) => els.length) === 1, `${tag}: the notes fold back to one`);
      ok(!/עודכנה: המייל נשלח/.test(await p.textContent('.tchat')), `${tag}: no notes inside the conversation`);
      // email card: collapsed original, attachments, expands in place
      ok(!(await p.isVisible('.email-src .es-body')), `${tag}: the original email is collapsed`);
      ok((await p.$$('.mail-card .att-row')).length === 3, `${tag}: three attachment tiles`);
      // conversation: day separators, bubbles, no nested scroll on phones
      const seps = await p.$$eval('.tchat .day-sep', (els) => els.map((e) => e.textContent.trim()));
      ok(seps.length >= 2 && seps.includes('היום') && seps.includes('אתמול'), `${tag}: day separators ${JSON.stringify(seps)}`);
      const feed = await p.evaluate(() => { const f = document.querySelector('.tchat .tc-feed'); const c = getComputedStyle(f); return { oy: c.overflowY, mh: c.maxHeight, sh: f.scrollHeight, ch: f.clientHeight }; });
      if (phone) ok(!/(auto|scroll)/.test(feed.oy) && feed.mh === 'none' && feed.sh <= feed.ch + 1, `${tag}: the conversation is not a nested scroll box ${JSON.stringify(feed)}`);
      const nested = await p.evaluate(() => [...document.querySelectorAll('.tcard *')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1 && e.offsetParent !== null && !e.matches('textarea, iframe, pre')).map((e) => e.className));
      if (phone) ok(nested.length === 0, `${tag}: no inner scroll containers in the card ${JSON.stringify(nested)}`);
      const over = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide: [...document.querySelectorAll('.tcard *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1) && e.offsetParent !== null; }).slice(0, 4).map((e) => e.className || e.tagName) }));
      ok(over.doc <= 0 && over.wide.length === 0, `${tag}: no horizontal overflow ${JSON.stringify(over)}`);
      const sides = await p.evaluate(() => { const o = document.querySelector('.tchat .bubble.owner'), c = document.querySelector('.tchat .bubble.claude'); return o && c ? { o: Math.round(o.getBoundingClientRect().right), c: Math.round(c.getBoundingClientRect().right), ob: getComputedStyle(o).backgroundColor, cb: getComputedStyle(c).backgroundColor } : null; });
      ok(sides && sides.o !== sides.c && sides.ob !== sides.cb, `${tag}: owner and assistant bubbles differ in side and colour ${JSON.stringify(sides)}`);
      ok(await p.isVisible('.tchat .tc-more'), `${tag}: older messages are folded behind a button`);
      // the composer stays reachable while reading the conversation
      if (phone) {
        await p.evaluate(() => document.querySelector('.tchat .tc-feed').scrollIntoView({ block: 'start' })); await p.waitForTimeout(200);
        const comp = await p.evaluate(() => { const f = document.querySelector('.tchat .tc-form').getBoundingClientRect(); const nav = document.querySelector('nav.bottomnav'); const nb = nav ? nav.getBoundingClientRect().top : innerHeight; return { bottom: Math.round(f.bottom), top: Math.round(f.top), navTop: Math.round(nb) }; });
        ok(comp.bottom <= comp.navTop + 1 && comp.top > 0, `${tag}: the composer is on screen above the bottom bar ${JSON.stringify(comp)}`);
      }
      await p.screenshot({ path: `${SHOTS}/taskcard-${tag}-a.png`, fullPage: false });
      // expand the original email and the older messages
      await p.click('.email-src summary'); await p.waitForTimeout(300);
      ok(await p.isVisible('.email-src .es-body'), `${tag}: "המייל המקורי" expands in place`);
      await p.click('.tchat .tc-more'); await p.waitForTimeout(300);
      ok((await p.$$('.tchat .bubble.tc-b')).length >= 10, `${tag}: all ten messages after "earlier messages"`);
      ok(!(await p.isVisible('.tchat .tc-more')), `${tag}: the fold button is gone`);
      // the message menu still works
      const dots = p.locator('.tchat .bubble.owner .msg-dots').last(); await dots.click(); await p.waitForTimeout(200);
      ok(await p.locator('.tchat .msg-menu:visible button', { hasText: 'ערוך' }).count() === 1 && await p.locator('.tchat .msg-menu:visible button', { hasText: 'מחק' }).count() === 1, `${tag}: message menu has edit and delete`);
      await p.click('.tchat .cs-h'); await p.waitForTimeout(150); ok(!(await p.isVisible('.tchat .msg-menu')), `${tag}: the menu closes on an outside click`);
      if (phone) { await p.screenshot({ path: `${SHOTS}/taskcard-${tag}-full.png`, fullPage: true }); } else {
        await p.evaluate(() => { document.querySelector('.tc-notes').scrollIntoView({ block: 'start' }); }); await p.waitForTimeout(200); await p.screenshot({ path: `${SHOTS}/taskcard-${tag}-b.png` });
        await p.evaluate(() => { const pane = document.querySelector('.pane-card'); pane.scrollTop = pane.scrollHeight; }); await p.waitForTimeout(200); await p.screenshot({ path: `${SHOTS}/taskcard-${tag}-c.png` });
      }
      ok(await p.locator('.purge-row .linkbtn').innerText().then((x) => x.trim()) === 'העבר לסל', `${tag}: "העבר לסל" is still there`);
      await ctx.close();
    }
  }
  await b.close(); console.log(fail ? fail + ' FAILED' : 'ALL OK'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
