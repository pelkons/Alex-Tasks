'use strict';
// UI check of WEB PUSH on the TEST instance (412x915 phone and 1440 desktop): the Settings switch "התראות במכשיר זה" with a STUBBED Notification / PushManager
// (no real push service: the test instance runs with MESIMOT_PUSH_DRYRUN=1): off -> permission granted -> on (the server knows the device) -> test button -> a category
// switch -> off; permission denied -> "חסום בדפדפן" with the hint; no PushManager -> "לא נתמך". Also: a tapped notification while the app is open moves it to the link,
// and an expired session on a deep link returns there after the login.
//   scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; NODE_PATH=<a node_modules directory that has playwright> node scripts/test-push-ui.js
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
const OUT = process.env.SHOTS || '/tmp/ui-shots';

// mode: 'ok' (permission is granted on request), 'denied' (already blocked), 'none' (no PushManager: an old browser or iPhone outside the installed app)
const stub = (mode) => {
  const perm = { v: mode === 'denied' ? 'denied' : 'default' };
  class FakeNotification { static get permission() { return perm.v; } static async requestPermission() { if (perm.v === 'default') perm.v = 'granted'; return perm.v; } }
  window.Notification = FakeNotification;
  if (mode === 'none') { delete window.PushManager; return; }
  if (sessionStorage.getItem('fakePerm')) perm.v = sessionStorage.getItem('fakePerm'); // the browser keeps permission and subscription across page loads
  const save = () => sessionStorage.setItem('fakePerm', perm.v);
  const make = (ep, key) => ({ endpoint: ep, options: { applicationServerKey: key ? new Uint8Array(key).buffer : null },
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'a'.repeat(22) } }; }, async unsubscribe() { sessionStorage.removeItem('fakeSub'); return true; } });
  const stored = () => { const j = sessionStorage.getItem('fakeSub'); if (!j) return null; const o = JSON.parse(j); return make(o.ep, o.key); };
  const origReq = FakeNotification.requestPermission; FakeNotification.requestPermission = async () => { const r = await origReq(); save(); return r; };
  window.PushManager.prototype.getSubscription = async function () { return stored(); };
  window.PushManager.prototype.subscribe = async function (o) { if (perm.v !== 'granted') throw new Error('denied'); const ep = 'https://fcm.googleapis.com/fcm/send/ui-test-' + Math.random().toString(36).slice(2, 14); sessionStorage.setItem('fakeSub', JSON.stringify({ ep, key: [...new Uint8Array(o.applicationServerKey)] })); return stored(); };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store');
  const db = open(process.env.MESIMOT_DB); const store = createStore(db);
  const devices = () => db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n;
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const login = async (page) => { await page.goto(BASE + '/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500); };
  // the push block lives in Settings, in the notifications category (on phones a category is its own screen)
  const openSettings = async (page) => {
    await page.goto(BASE + '/settings'); await page.waitForTimeout(1200);
    const cat = page.locator('[data-cat="notify"]').first();
    if (await cat.count() && !(await page.locator('[data-test=push-set]').isVisible().catch(() => false))) { await cat.click(); await page.waitForTimeout(800); }
    await page.locator('[data-test=push-set]').scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
  };
  const word = (page) => page.locator('[data-test=push-word]').innerText();
  for (const [w, h, tag] of [[412, 915, 'phone'], [1440, 900, 'desktop']]) {
    db.prepare('DELETE FROM push_subscriptions').run(); db.prepare("DELETE FROM settings WHERE key LIKE 'push_cat_%'").run();
    // ---- 1. supported, permission not asked yet
    let ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: tag === 'desktop' ? 1 : 2 }); let page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(stub, 'ok');
    await login(page);
    let asked = await page.evaluate(() => Notification.permission); ok(asked === 'default', `${tag}: no permission prompt on page load`);
    await openSettings(page);
    ok((await word(page)).trim() === 'כבוי', `${tag}: state "כבוי" before`);
    ok(!(await page.locator('[data-test=push-toggle]').isChecked()), `${tag}: the switch is off`);
    ok(await page.locator('[data-test=push-install]').isVisible(), `${tag}: the install hint is shown in the browser (not installed)`);
    await page.screenshot({ path: `${OUT}/push-off-${tag}.png`, fullPage: tag !== 'desktop' });
    // ---- 2. switch on: permission (stub grants) -> subscription -> the server
    await page.locator('[data-test=push-toggle]').click({ force: true }); await page.waitForTimeout(1500);
    ok((await word(page)).trim() === 'מופעל', `${tag}: state "מופעל" after the switch`);
    ok(devices() === 1, `${tag}: the server has the device`);
    ok(await page.locator('[data-test=push-test]').isVisible(), `${tag}: the test button is shown`);
    ok(await page.locator('[data-test=push-cats] .tgl').count() === 6, `${tag}: six category switches`);
    ok(!(await page.locator('[data-test=push-cat-reply]').isChecked()) && await page.locator('[data-test=push-cat-system]').isChecked(), `${tag}: defaults: chat replies off, system alerts on`);
    await page.locator('[data-test=push-test]').click(); await page.waitForTimeout(1500);
    const tst = db.prepare("SELECT sent_at FROM push_queue WHERE tag='push-test' ORDER BY id DESC LIMIT 1").get();
    ok(!!(tst && tst.sent_at), `${tag}: the test notification was sent (dry run, nothing left the server)`);
    await page.locator('[data-test=push-cat-mail]').click({ force: true }); await page.waitForTimeout(800);
    ok(db.prepare("SELECT value FROM settings WHERE key='push_cat_mail'").get()?.value === '0', `${tag}: switching a category off is saved`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: no horizontal scroll`);
    await page.locator('[data-test=push-set]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/push-on-${tag}.png`, fullPage: tag !== 'desktop' });
    // ---- 3. a tapped notification while the app is open: the service worker asks the page to move (no reload) and the page answers
    const t = store.createTask(store.ownerId(), { title: 'בדיקת קישור מהתראה' });
    const acked = await page.evaluate((url) => new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(true); setTimeout(() => res(false), 2000); navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'push-open', url }, ports: [ch.port2] })); }), `/task/${t.id}`);
    await page.waitForTimeout(1200);
    ok(acked && new URL(page.url()).pathname === `/task/${t.id}`, `${tag}: a notification's link opens the task in the open app`);
    // ---- 4. switch off: the device is removed
    await openSettings(page);
    await page.locator('[data-test=push-toggle]').click({ force: true }); await page.waitForTimeout(1500);
    ok((await word(page)).trim() === 'כבוי' && devices() === 0, `${tag}: switched off, the server forgot the device`);
    ok(!errors.length, `${tag}: no JS errors ${errors.join(' | ')}`);
    await ctx.close();
    // ---- 5. blocked in the browser
    ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: tag === 'desktop' ? 1 : 2 }); page = await ctx.newPage();
    await page.addInitScript(stub, 'denied'); await login(page); await openSettings(page);
    ok((await word(page)).trim() === 'חסום בדפדפן', `${tag}: state "חסום בדפדפן"`);
    ok(await page.locator('[data-test=push-toggle]').isDisabled(), `${tag}: the switch is disabled while blocked`);
    ok(await page.locator('[data-test=push-blocked]').isVisible(), `${tag}: the hint how to unblock is shown`);
    await page.locator('[data-test=push-set]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/push-blocked-${tag}.png`, fullPage: tag !== 'desktop' });
    await ctx.close();
    // ---- 6. not supported
    ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: tag === 'desktop' ? 1 : 2 }); page = await ctx.newPage();
    await page.addInitScript(stub, 'none'); await login(page); await openSettings(page);
    ok((await word(page)).trim() === 'לא נתמך', `${tag}: state "לא נתמך"`);
    ok(await page.locator('[data-test=push-unsupported]').isVisible(), `${tag}: the unsupported hint is shown`);
    await ctx.close();
  }
  // ---- 7. an expired session on a notification's link: the login returns there
  const ctx = await b.newContext({ viewport: { width: 412, height: 915 } }); const page = await ctx.newPage();
  const t2 = store.createTask(store.ownerId(), { title: 'קישור אחרי התחברות' });
  await page.goto(`${BASE}/task/${t2.id}`); await page.waitForTimeout(800);
  ok(new URL(page.url()).pathname === '/login', 'logged out: the link goes to the login');
  await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
  ok(new URL(page.url()).pathname === `/task/${t2.id}`, 'after the login: back on the task');
  await ctx.close();
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
