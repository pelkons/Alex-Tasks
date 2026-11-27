'use strict';
// TEST instance (scripts/testenv.sh start): the main chat shows only unscoped messages; the toggle adds scoped ones with chips; project and task chats keep theirs. Screenshots in $SHOTS.
const { chromium } = require('playwright'); const { execFileSync } = require('child_process'); const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111'; const SHOTS = process.env.SHOTS || '/tmp/mainchat-shots'; fs.mkdirSync(SHOTS, { recursive: true });
const cli = (...a) => execFileSync('node', [__dirname + '/../bin/mesimot', ...a], { encoding: 'utf8' });
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const ctx0 = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p0 = await ctx0.newPage();
  await p0.goto(BASE + '/login'); await p0.fill('input[type=password]', process.env.MESIMOT_WEB_PASSWORD || 'test-password-1234'); await p0.keyboard.press('Enter'); await p0.waitForTimeout(1500);
  const api = (m, u, body) => p0.evaluate(async ([m, u, body]) => (await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-mesimot': '1' }, body: body ? JSON.stringify(body) : undefined })).json(), [m, u, body]);
  const proj = await api('POST', '/api/projects', { name: 'מגדל הדוגמה' }); const task = await api('POST', '/api/tasks', { title: 'משימת בדיקה', project: proj.id });
  await api('POST', '/api/chat', { text: 'שאלה כללית של הבעלים' });
  await api('POST', '/api/chat', { text: 'שאלה בתוך המשימה', task_scope: task.id });
  await api('POST', '/api/chat', { text: 'שאלה בתוך הפרויקט', entity_scope: 'project:' + proj.id });
  cli('chat', 'send', '--text', 'תשובה כללית של אלכס', '--main');
  cli('chat', 'send', '--text', 'תשובה בתוך המשימה', '--task-scope', String(task.id));
  cli('chat', 'send', '--text', 'תשובה בתוך הפרויקט', '--entity-scope', 'project:' + proj.id);
  await ctx0.storageState({ path: SHOTS + '/state.json' });
  for (const w of [412, 1280]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 }, storageState: SHOTS + '/state.json' }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE + '/chat'); await page.waitForTimeout(1500);
    const txt = () => page.locator('.feed').first().innerText();
    let t = await txt();
    ok(t.includes('שאלה כללית') && t.includes('תשובה כללית'), w + ': main messages shown');
    ok(!/בתוך המשימה|בתוך הפרויקט/.test(t), w + ': scoped messages hidden by default');
    await page.screenshot({ path: `${SHOTS}/main-${w}-off.png` });
    await page.locator('.cp-tog input').first().check({ force: true }); await page.waitForTimeout(500); t = await txt();
    ok(/תשובה בתוך המשימה/.test(t) && /תשובה בתוך הפרויקט/.test(t), w + ': toggle shows scoped messages');
    ok(await page.locator('.tchip-top:visible').count() >= 2, w + ': chips shown'); ok(await page.locator('[data-test=scope-chip]:visible').count() >= 1, w + ': project chip links');
    await page.screenshot({ path: `${SHOTS}/main-${w}-on.png` });
    await page.goto(BASE + '/task/' + task.id); await page.waitForTimeout(1500);
    ok((await page.locator('body').innerText()).includes('תשובה בתוך המשימה'), w + ': task card chat keeps its conversation'); await page.screenshot({ path: `${SHOTS}/task-${w}.png` });
    await page.goto(BASE + '/projects/' + proj.id); await page.waitForTimeout(1500);
    ok((await page.locator('body').innerText()).includes('תשובה בתוך הפרויקט'), w + ': project chat keeps its conversation'); await page.screenshot({ path: `${SHOTS}/project-${w}.png` });
    ok(errs.length === 0, w + ': no page errors ' + errs.join('|')); await ctx.close();
  }
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
