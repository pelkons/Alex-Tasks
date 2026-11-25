'use strict';
// Stage 2 end-to-end: chat, document upload through chat, questions answered from the document, screenshots.
const fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8110';
const OUT = path.join(__dirname, '..', 'screenshots', 'stage2');
const DOCS = process.env.DOCS_DIR;
const PW = process.env.MESIMOT_WEB_PASSWORD || fs.readFileSync(path.join(os.homedir(), '.config/mesimot/web-password.txt'), 'utf8').trim();
const EXE = process.env.CHROMIUM_PATH || undefined; // optional Chromium binary (Playwright's own browser otherwise)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const page = await ctx.newPage();
  const api = (u) => page.evaluate(async (u) => (await fetch(u, { headers: { 'X-Mesimot': '1' } })).json(), u);
  await page.goto(BASE + '/login'); await page.fill('#pw', PW);
  await Promise.all([page.waitForURL((u) => new URL(u).pathname === '/'), page.click('#go')]);
  await page.waitForSelector('.comp-input');

  async function ask(text, files) {
    await page.goto(BASE + '/chat'); await page.waitForSelector('.comp-input');
    const before = (await api('/api/chat?limit=1')).slice(-1)[0]?.id || 0;
    if (files) { await page.setInputFiles('input[type=file]', files); await page.waitForSelector('.chips-files .fchip', { timeout: 120000 }); }
    await page.fill('.comp-input', text);
    const t0 = Date.now();
    await page.click('.comp-row .send');
    let reply = null;
    while (Date.now() - t0 < 240000) {
      const msgs = await api('/api/chat?after=' + before);
      reply = msgs.find((m) => m.author === 'claude');
      if (reply) break;
      await sleep(1000);
    }
    const ms = Date.now() - t0;
    console.log(`\n>> ${text}\n<< (${(ms / 1000).toFixed(1)}s) ${reply ? reply.text : 'NO REPLY'}${reply && reply.tasks.length ? '\n   tasks: ' + reply.tasks.map((t) => `#${t.id} ${t.title}`).join(' | ') : ''}`);
    return { reply, ms };
  }

  const which = process.argv[2] || 'all';
  if (which === 'reminder' || which === 'all') await ask('תזכיר לי לבדוק עם רון את לוח הזמנים של מגדל הנוף עד יום חמישי');
  if ((which === 'doc' || which === 'all') && DOCS) {
    await ask('צירפתי את המפרט של פרויקט מגדל הנוף. זה מידע ולא משימה, תשמור אותו בבקשה.', [path.join(DOCS, 'מגדל-הים-מפרט.pdf')]);
  }
  if (which === 'msg' && DOCS) await ask('צירפתי מייל מאבי, תטפל בו בבקשה', [path.join(DOCS, 'לוח-זמנים.msg')]);
  if (which === 'q' || which === 'all') {
    await ask('מי הקבלן של החשמל במגדל הנוף?');
    await ask('מה התקציב של סעיף החזיתות ומתי מועד המסירה המתוכנן?');
    await ask('מה הזמן אספקה של החזית ומי הספק שלה?');
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
