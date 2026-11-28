'use strict';
// UI check of the RECYCLE BIN and of the floating notification bars on the TEST instance (412x915 phone and 1440 desktop, light and dark):
// "העבר לסל" in the task card -> the centred "הועבר לסל · בטל" bar (fully on screen, above the bottom nav and the chat bar) -> undo; toasts with a very long
// Hebrew text stay centred and wrap; the /trash page (reached from "עוד" on the phone and the bin icon on the desktop) lists, filters, restores, deletes for good, empties;
// the Settings field "ימים בסל המחזור" changes the days left.
//   scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; NODE_PATH=<a node_modules directory that has playwright> node scripts/test-trash-ui.js
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
const OUT = process.env.SHOTS || '/tmp/ui-shots';
const LONG = 'לבדוק עם הקבלן את לוח הזמנים המעודכן של יציקת התקרה בקומה השביעית ואת ההשפעה על מסירת הדירות בבניין הצפוני, כולל תיאום עם המפקח ועם מחלקת השיווק לפני ישיבת ההנהלה הקרובה';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createTrash } = require('../lib/trash');
  const { createKnowledge } = require('../lib/knowledge'); const { createChat } = require('../lib/chat'); const { createCalendar } = require('../lib/calendar'); const { createFilters } = require('../lib/filters');
  const db = open(process.env.MESIMOT_DB); const store = createStore(db); const trash = createTrash({ db, store }); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const owner = store.ownerId(), a = store.assistantId();
  const seed = () => {
    trash.empty(owner);
    const p = store.createProject(owner, { name: `מגדל הים ${Date.now().toString(36).slice(-4)}` });
    for (const t of ['לאשר את כתב הכמויות של האיטום', 'לשלוח לקבלן את התוכניות המעודכנות']) store.createTask(owner, { title: t, project: p.id, requester: owner });
    trash.trashProject(owner, p.id, { tasks: 'delete' });
    const per = store.createPerson(a, { name: 'רונית לוי (בדיקה)' }); trash.trashPerson(owner, per.id);
    const cal = createCalendar(db, store).addItem(owner, { title: 'סיור באתר עם המפקח', start: '2026-12-03 09:00' }); trash.trashCalendar(owner, cal.id);
    const m = chat.sendChat(owner, { text: 'הודעה ישנה שנמחקה מהצ׳אט' }); db.prepare('UPDATE chat_messages SET deleted_at=? WHERE id=?').run(new Date().toISOString(), m.id); trash.trashChat(owner, db.prepare('SELECT * FROM chat_messages WHERE id=?').get(m.id));
    const f = createFilters({ db, store }).add(owner, { kind: 'domain', pattern: 'newsletter.example', action: 'skip' }); trash.trashFilter(owner, f.id);
    const old = store.createTask(owner, { title: LONG + ' (ישנה)' }); const r = trash.trashTask(owner, old.id); db.prepare('UPDATE trash SET deleted_at=? WHERE id=?').run(new Date(Date.now() - 58 * 86400000).toISOString(), r.trash_id);
    return store.createTask(owner, { title: LONG, requester: owner });
  };
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [w, h, tag, scheme] of [[412, 915, 'phone', 'light'], [412, 915, 'phone', 'dark'], [1440, 900, 'desktop', 'light'], [1440, 900, 'desktop', 'dark'], [360, 740, 'phone360', 'light']]) {
    const T = `${tag}-${scheme}`;
    const task = seed();
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: tag === 'desktop' ? 1 : 2 }); const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
    const noOverflow = async (what) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${T}: ${what}: no horizontal scroll`);
    // a floating bar must be centred, inside the screen with a 16px margin, and on phones above the bottom nav and the chat bar
    const barOk = async (sel, what) => {
      const g = await page.evaluate((s) => {
        const el = [...document.querySelectorAll(s)].find((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed'); if (!el) return null;
        const r = el.getBoundingClientRect(); const top = (q) => { const n = document.querySelector(q); if (!n || getComputedStyle(n).display === 'none' || !n.offsetWidth) return Infinity; return n.getBoundingClientRect().top; };
        const inner = [...el.querySelectorAll('span,button')].map((x) => x.getBoundingClientRect()); const clipped = inner.some((x) => x.left < -0.5 || x.right > innerWidth + 0.5);
        return { l: r.left, r: r.right, b: r.bottom, w: innerWidth, nav: top('.bottomnav'), pin: top('.chat-pin'), clipped, sw: el.scrollWidth, cw: el.clientWidth };
      }, sel);
      if (!g) return ok(false, `${T}: ${what}: visible`);
      ok(Math.abs((g.l + g.r) / 2 - g.w / 2) <= 2, `${T}: ${what}: centred (${Math.round(g.l)}..${Math.round(g.r)} of ${g.w})`);
      ok(g.l >= 15.5 && g.r <= g.w - 15.5 && !g.clipped && g.sw <= g.cw + 1, `${T}: ${what}: fully on screen, nothing cut`);
      if (tag !== 'desktop') ok(g.b <= Math.min(g.nav, g.pin) - 4, `${T}: ${what}: above the bottom nav and the chat bar (bottom ${Math.round(g.b)}, nav ${Math.round(g.nav)}, chat ${Math.round(g.pin)})`);
    };
    // ---- 1. task card: "העבר לסל" -> dialog -> the bar -> undo
    await page.goto(BASE + '/task/' + task.id); await page.waitForTimeout(1800);
    const link = page.locator('.purge-row .linkbtn'); ok((await link.innerText()).trim() === 'העבר לסל', `${T}: the task card offers "העבר לסל"`);
    await link.click(); await page.waitForTimeout(400);
    const dlg = page.locator('.del-dlg:visible'); ok(/אפשר לשחזר מהסל במשך 60 ימים/.test(await dlg.innerText()), `${T}: the dialog says it can be restored for 60 days`);
    await page.screenshot({ path: `${OUT}/trash-dialog-${T}.png` });
    await dlg.locator('.btn.danger').click(); await page.waitForTimeout(1500);
    ok(db.prepare('SELECT COUNT(*) c FROM tasks WHERE id=?').get(task.id).c === 0, `${T}: the task left the board`);
    ok(/^הועבר לסל:/.test(await page.locator('.purge-undo span').innerText()), `${T}: the bar says "הועבר לסל"`);
    await barOk('.purge-undo', 'the "moved to the bin" bar (very long title)');
    await page.screenshot({ path: `${OUT}/trash-bar-${T}.png` });
    await page.locator('.purge-undo .btn').click(); await page.waitForTimeout(1500);
    ok(db.prepare('SELECT COUNT(*) c FROM tasks WHERE id=?').get(task.id).c === 1, `${T}: "בטל" restored the task from the bin`);
    // ---- 2. toasts with a very long Hebrew text
    await page.goto(BASE + '/'); await page.waitForTimeout(1500);
    await page.evaluate((t) => { const d = window.Alpine ? Alpine.$data(document.body) : document.body._x_dataStack[0]; d.toast('אלכס: ' + t); }, LONG);
    await page.waitForTimeout(400); await barOk('.toast:not(.done-toast)', 'a long toast'); await page.screenshot({ path: `${OUT}/trash-toast-${T}.png` });
    await page.evaluate(() => { const d = window.Alpine ? Alpine.$data(document.body) : document.body._x_dataStack[0]; d.toastMsg = ''; d.doneUndo = { id: 0, prev: null, title: 'x' }; });
    await page.waitForTimeout(400); await barOk('.done-toast', 'the "done" bar'); await page.screenshot({ path: `${OUT}/trash-donebar-${T}.png` });
    await page.evaluate(() => { const d = window.Alpine ? Alpine.$data(document.body) : document.body._x_dataStack[0]; d.doneUndo = null; });
    // ---- 3. the bin page, reached the way the owner reaches it
    if (tag === 'desktop') { await page.locator('[data-test=top-trash]').click(); }
    else { await page.locator('.bottomnav button').last().click(); await page.waitForTimeout(300); ok(/סל מחזור \(6\)/.test(await page.locator('[data-test=more-trash]').innerText()), `${T}: "עוד" shows the bin with its count`); await page.locator('[data-test=more-trash]').click(); }
    await page.waitForTimeout(1500);
    ok(new URL(page.url()).pathname === '/trash', `${T}: the bin page opens`);
    const rows = page.locator('[data-test=bin-row]'); ok(await rows.count() === 6, `${T}: 6 items in the bin (${await rows.count()})`);
    const txt = await page.locator('.bin-page').innerText();
    ok(/יימחק סופית בעוד 60 ימים/.test(txt) && /יימחק סופית בעוד 2 ימים/.test(txt), `${T}: days left per item`);
    for (const k of ['משימה', 'פרויקט', 'איש קשר', 'יומן', 'הודעה', 'כלל דואר']) ok(txt.includes(k), `${T}: kind badge ${k}`);
    await noOverflow('bin page'); await page.screenshot({ path: `${OUT}/trash-page-${T}.png`, fullPage: true });
    await page.locator('.bin-kinds .chip', { hasText: 'פרויקטים' }).click(); await page.waitForTimeout(200); ok(await rows.count() === 1, `${T}: the kind filter shows the project only`);
    await page.locator('.bin-kinds .chip').first().click(); await page.waitForTimeout(200);
    // restore the project: it and its two tasks are back
    await page.locator('[data-test=bin-row]', { hasText: 'מגדל הים' }).locator('[data-test=bin-restore]').click(); await page.waitForTimeout(1200);
    const pr = db.prepare("SELECT id FROM projects WHERE name_he LIKE 'מגדל הים%' ORDER BY id DESC LIMIT 1").get();
    ok(pr && db.prepare('SELECT COUNT(*) c FROM tasks WHERE project_id=?').get(pr.id).c === 2, `${T}: the project came back with its 2 tasks`);
    ok(await rows.count() === 5, `${T}: 5 left in the bin`);
    // delete one item for good (confirm dialog)
    await page.locator('[data-test=bin-row]', { hasText: 'newsletter.example' }).locator('[data-test=bin-destroy]').click(); await page.waitForTimeout(300);
    ok(/אי אפשר לשחזר/.test(await page.locator('.modal-bg').innerText()), `${T}: permanent delete asks first`);
    await page.screenshot({ path: `${OUT}/trash-confirm-${T}.png` });
    await page.locator('.modal-bg .btn.primary').click(); await page.waitForTimeout(1200); ok(await rows.count() === 4, `${T}: deleted for good`);
    // ---- 4. the setting
    await page.goto(BASE + '/settings?c=trash'); await page.waitForTimeout(1800);
    const fld = page.locator('[data-test=trash-days]'); ok(await fld.inputValue() === '60', `${T}: Settings shows 60 days`);
    await fld.selectOption('30'); await page.waitForTimeout(1200);
    await page.goto(BASE + '/trash'); await page.waitForTimeout(1500);
    ok(/יימחק סופית בעוד 30 ימים/.test(await page.locator('.bin-page').innerText()), `${T}: a changed setting applies to what is already in the bin`);
    // ---- 5. empty the bin
    await page.locator('[data-test=bin-empty]').click(); await page.waitForTimeout(300); await page.locator('.modal-bg .btn.primary').click(); await page.waitForTimeout(1200);
    ok(/הסל ריק/.test(await page.locator('.bin-page').innerText()), `${T}: empty state`);
    await page.screenshot({ path: `${OUT}/trash-empty-${T}.png` });
    trash.setDays(60);
    ok(!errors.length, `${T}: no JS errors ${errors.join(' | ')}`);
    await ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
