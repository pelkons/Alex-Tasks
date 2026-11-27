'use strict';
// Screenshots of the task list at 1440 px (compact and regular, light and dark) on the TEST instance with realistic (fictional) data.
//   node scripts/ui-shots.js <prefix> [--seed]      -> /tmp/ui-shots/<prefix>-<density>-<theme>.png
process.env.MESIMOT_DB = process.env.MESIMOT_DB || '/tmp/mesimot-test/test.db'; process.env.MESIMOT_SEMANTIC = '0';
const fs = require('fs'); const prefix = process.argv[2] || 'shot'; fs.mkdirSync('/tmp/ui-shots', { recursive: true });
const { chromium } = require('playwright');
if (process.argv.includes('--seed')) {
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const db = open(); const store = createStore(db); const a = store.assistantId(), owner = store.ownerId();
  const P = ['מגדל הרצל', 'פארק הדוגמה', 'רחוב הים 12', 'שכונת הגפן', 'מרכז מסחרי הצפון'].map((n) => store.createProject(store.ownerId(), { name: n }));
  const people = ['רון לוי', 'דנה אברהם', 'יעל כהן', 'משה דיין', 'אורי שדה'].map((n) => store.createPerson(a, { name: n, role: 'contact' }));
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const T = [
    ['להכין דוח התקדמות חודשי למזמין כולל מצב היציקות והתקדמות הגמרים', 0, 0, -3, 'דחוף', 'explicit', null, 'בטיפול'], ['לתאם סיור מדידות באתר עם היועץ וקבלן הגמרים', 1, 1, 2, 'רגיל', 'explicit', null, 'חדש'],
    ['לאשר חשבון חלקי מספר 7 של קבלן השלד', 0, 2, 0, 'דחוף', 'explicit', null, 'חדש'], ['לשלוח הצעת מחיר ליועץ התנועה לפני סוף השבוע', 2, 3, 5, 'רגיל', 'estimated', null, 'ממתין'],
    ['לבדוק את נוסח הערבות הבנקאית ולהחזיר הערות', 3, 4, -1, 'רגיל', 'explicit', owner, 'בטיפול'], ['לעדכן את לוח הזמנים של הפרויקט לפי הישיבה האחרונה', 0, 0, 9, 'נמוך', 'estimated', owner, 'חדש'],
    ['להשיב ליועץ האקוסטיקה לגבי תוכנית הקירות', 1, 1, 1, 'דחוף', 'explicit', null, 'חדש'], ['לקבל תוכנית סופית למספור ומידות חניות לסימון', 2, 2, 14, 'רגיל', 'estimated', null, 'ממתין'],
    ['לתאם פגישת תיאום תכנון עם האדריכל והמהנדסים', 3, 3, 3, 'רגיל', 'explicit', null, 'חדש'], ['להעביר לקבלן את פרטי הזיון של קומה 5', 4, 4, -6, 'דחוף', 'explicit', null, 'בטיפול'],
    ['לברר סטטוס היתר בנייה מול הוועדה המקומית', 4, 0, null, 'רגיל', null, null, 'חדש'], ['לאסוף חתימות על כתב הכמויות המעודכן', 0, 1, 6, 'רגיל', 'explicit', null, 'חדש'],
  ];
  for (const [title, p, who, due, prio, src, assignee, status] of T) { try { const t = store.createTask(a, { title, project: P[p].id, requester: people[who].id, assignee: assignee || undefined, due: due == null ? undefined : day(due), priority: prio, due_source: src || undefined }); if (status !== 'חדש') store.updateTask(a, t.id, { status }); } catch (e) { console.log('seed', e.message); } }
}
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  for (const theme of ['light', 'dark']) { const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    for (const density of ['compact', 'regular']) { await page.evaluate((d) => { document.body.dataset.density = d; try { window.MesimotLayout.setDensity(d); } catch (e) {} }, density); await page.waitForTimeout(700);
      await page.screenshot({ path: `/tmp/ui-shots/${prefix}-${density}-${theme}.png` }); } }
  await b.close(); console.log('shots written');
})().catch((e) => { console.error(e); process.exit(1); });
