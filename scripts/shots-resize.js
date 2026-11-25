'use strict';
// Screenshots and checks of the desktop split-pane layout on the TEST instance (never the real data). Usage:
//   NODE_PATH=... node scripts/shots-resize.js before|after [--seed]
const { chromium } = require('playwright');
const path = require('path');
const root = path.join(__dirname, '..');
process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
const BASE = 'http://127.0.0.1:8111';
const tag = process.argv[2] || 'after';
(async () => {
  if (process.argv.includes('--seed')) {
    const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createChat } = require('../lib/chat'); const { createKnowledge } = require('../lib/knowledge');
    const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db); const a = store.assistantId(), owner = store.ownerId();
    if (db.prepare('SELECT COUNT(*) c FROM tasks').get().c < 5) {
      const projects = ['מגדל הנוף', 'שדרוג תשתיות', 'מרכז מסחרי הנחל'].map((n) => store.createProject(a, { name: n }));
      const people = ['דנה כהן', 'רונית לוי', 'משה דיין'].map((n) => store.createPerson(a, { name: n, role: 'contact' }));
      const titles = ['להגיש לאישור תוכנית פיגומים מעודכנת לקומות 9-10 עד סוף החודש', 'לבדוק את חוזה המכר בנושא סדרת השיש בדירות הגן', 'לתאם סיור בטיחות שבועי עם יועץ הבטיחות', 'להעביר תוכניות חשמל מעודכנות לקומה 9', 'לאשר בכתב את שינוי לוח היציקות', 'לעדכן את המזמין בלוח הזמנים המעודכן', 'להשלים את בדיקת העומסים של תקרת קומה 8', 'לדווח על כמות בטון שנותרה להזמנה', 'להחליף שני עגורנים פגומים באתר', 'לספק אישור בדיקת הארקה לקומות 1-6', 'לתאם פגישה עם יועץ הקונסטרוקציה לגבי קורות', 'לשלוח לאבי טיוטת תשובה על חריגות התקציב'];
      titles.forEach((t, i) => store.createTask(i % 2 ? owner : a, { title: t, project: projects[i % 3].id, requester: people[i % 3].id, due: `2026-12-${String(1 + i).padStart(2, '0')}`, priority: i % 4 === 0 ? 'דחוף' : 'רגיל', description: 'תיאור ארוך של המשימה כדי לבדוק גלישת שורות ברוחבים שונים של הכרטיס. '.repeat(3) }));
      const t1 = store.listTasks({})[0]; store.addNote(owner, { task: t1.id, text: 'דיברתי עם הקבלן, הוא יחזור אלינו עד יום חמישי.' });
      const chat = createChat(db, store, createKnowledge(db, store));
      chat.sendChat(owner, { text: 'מה המצב של משימת הפיגומים? ' + 'וגם לבדוק את הנושא של החוזה '.repeat(4) });
      chat.sendChat(a, { text: `פתחתי משימה: להגיש תוכנית פיגומים. https://tasks.example.org/task/${t1.id} הקבלן מחכה לתשובה מאבי ${'ועוד פרטים ארוכים '.repeat(6)}` });
      for (let i = 0; i < 6; i++) { chat.sendChat(owner, { text: 'הודעה ' + i }); chat.sendChat(a, { text: 'אישרתי ' + i }); }
    }
  }
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const out = [];
  for (const w of [1280, 1440, 1920]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
    await p.goto(BASE + '/'); await p.waitForTimeout(1200);
    const first = await p.$('.row .title, .row .t, .row'); await first.click(); await p.waitForTimeout(1200);
    await p.screenshot({ path: path.join(root, 'screenshots', 'resize', `${tag}-${w}-task.png`) });
    const m = await p.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.width)]; };
      return { vw: innerWidth, docScrollX: document.documentElement.scrollWidth > innerWidth, list: r('.home-split .pane-list'), card: r('.home-split .pane-card'), chat: r('.chat-panel') };
    });
    out.push({ w, ...m });
    await ctx.close();
  }
  console.log(JSON.stringify(out));
  await b.close();
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
