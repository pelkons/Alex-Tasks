'use strict';
// Calendar screenshots on the TEST instance (never the real data). Usage: node scripts/shots-calendar.js before|after [--seed]
const { chromium } = require('playwright');
const path = require('path');
const root = path.join(__dirname, '..');
process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
const BASE = 'http://127.0.0.1:8111';
const tag = process.argv[2] || 'after';
(async () => {
  if (process.argv.includes('--seed')) {
    const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createCalendar } = require('../lib/calendar');
    const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db); const cal = createCalendar(db, store); const a = store.assistantId(), owner = store.ownerId();
    if (!db.prepare('SELECT COUNT(*) c FROM calendar_items').get().c) {
      let ps = store.listProjects().filter((p) => !p.is_default);
      if (ps.length < 3) ps = ['מגדל הנוף', 'שדרוג תשתיות', 'מרכז מסחרי הנחל'].map((n) => store.createProject(store.ownerId(), { name: n }));
      const mk = (title, start, i, extra = {}) => cal.addItem(a, { title, start, project: i == null ? null : ps[i % ps.length].id, ...extra });
      const days = ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'];
      days.forEach((d, k) => { mk('סיור באתר עם יועץ הבטיחות והקבלן הראשי', `${d} 09:00`, k); mk('ישיבת תיאום שבועית', `${d} 11:30`, k + 1); mk('פגישה כללית ללא פרויקט', `${d} 14:00`, null); if (k % 2) { mk('בדיקת תוכניות', `${d} 15:00`, k + 2); mk('שיחה עם אבי', `${d} 16:00`, null); } });
      store.listTasks({}).slice(0, 8).forEach((t, k) => { try { db.prepare('UPDATE tasks SET due_date=? WHERE id=?').run(days[k % days.length], t.id); } catch (e) {} });
    }
  }
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const out = [];
  for (const [w, h] of [[1440, 900], [1920, 1080], [390, 844]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    await p.goto(BASE + '/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
    for (const view of ['week', 'month']) {
      await p.goto(BASE + '/calendar'); await p.evaluate((v) => localStorage.setItem('calView', v), view); await p.reload(); await p.waitForTimeout(1500);
      await p.screenshot({ path: path.join(root, 'screenshots', 'resize', `cal-${tag}-${w}-${view}.png`) });
    }
    await ctx.close();
  }
  await b.close(); console.log('ok');
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
