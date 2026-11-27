'use strict';
// UI check of the mail tab ("דואר") on the TEST instance, 412 px and 1280 px, light and dark:
//   scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; node scripts/seed-mail.js; NODE_PATH=<a node_modules with playwright> node scripts/test-mail-ui.js
// BASE_URL / MAIL_PASSWORD (and SHOTS=<dir>) point it at another instance (the live site after a deploy: read-only checks).
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111', PW = process.env.MAIL_PASSWORD || 'test-password-1234', SHOTS = process.env.SHOTS || '/tmp/ui-shots/mail';
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  // the owner's last visit to the tab is 3 hours ago: the mail that arrived since then is highlighted (test instance only: it writes the marker directly)
  const local = /127\.0\.0\.1|localhost/.test(BASE) && process.env.MESIMOT_DB;
  if (local) { const { open } = require('../lib/db'); const db = open(process.env.MESIMOT_DB); const t = new Date(Date.now() - 3 * 3600e3).toISOString(); db.prepare("DELETE FROM settings WHERE key IN ('mail_visit_last','mail_visit_prev')").run(); db.prepare("INSERT INTO settings (key, value) VALUES ('mail_visit_last', ?)").run(t); db.close && db.close(); }
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [w, h, tag] of [[1280, 900, 'desktop'], [412, 860, 'phone']]) for (const theme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: theme }); const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE + '/login'); await page.fill('input[type=password]', PW); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
    await page.evaluate((t) => { try { localStorage.setItem('theme', t); } catch (e) {} document.documentElement.dataset.theme = t; }, theme);
    const T = `${tag}/${theme}`;
    const noOverflow = async (what) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${T}: ${what}: no horizontal scroll`);
    // ---- navigation
    await page.goto(BASE + '/'); await page.waitForTimeout(1200);
    if (w >= 1024) { ok(await page.locator('.tabs .tab', { hasText: 'דואר' }).isVisible(), `${T}: desktop tab "דואר"`); await page.locator('.tabs .tab', { hasText: 'דואר' }).click(); }
    else {
      const items = await page.locator('.bottomnav button').allInnerTexts(); ok(items.length === 5 && items.some((t) => /דואר/.test(t)), `${T}: bottom bar has 5 items incl. דואר: ${items.map((x) => x.trim()).join(' | ')}`);
      await page.locator('.bottomnav button', { hasText: 'עוד' }).click(); await page.waitForTimeout(300);
      const more = await page.locator('.more-sheet button').allInnerTexts(); ok(['חיפוש', 'פרוטוקולים'].every((x) => more.some((m) => m.includes(x))), `${T}: search and protocols moved to עוד: ${more.join(' | ')}`);
      await page.screenshot({ path: `${SHOTS}/more-${T.replace('/', '-')}.png` }); await page.mouse.click(200, 200); await page.waitForTimeout(200);
      await page.locator('.bottomnav button', { hasText: 'דואר' }).click();
    }
    await page.waitForSelector('.mrow', { timeout: 8000 }); await page.waitForTimeout(600);
    ok(page.url().includes('/mail'), `${T}: route /mail`);
    const rows = await page.locator('.mail-rows > .mrow-wrap').count(); ok(rows >= 30, `${T}: list rendered (${rows} rows)`);
    ok(await page.locator('.mrow .mdir.sent').count() > 0 && await page.locator('.mrow .mdir.received').count() > 0, `${T}: incoming and sent icons`);
    ok(await page.locator('.mrow .plabel:visible').count() > 0, `${T}: project chip`);
    ok(await page.locator('.mrow .mclip:visible').count() > 0, `${T}: attachment clip`);
    ok(await page.locator('.mrow .mtask:visible').count() > 0, `${T}: task badge`);
    ok(await page.locator('.mrow .mcount:visible').count() > 0, `${T}: conversation count`);
    if (local) { ok(await page.locator('.mrow.new .mnew:visible').count() > 0 && await page.locator('[data-test=mail-new-note]').isVisible(), `${T}: mail received since the last visit is highlighted (${await page.locator('.mrow.new').count()})`); ok(await page.locator('.mrow.new.arch, .mrow.new .mdir.sent').count() === 0, `${T}: archive and sent mail are never "new"`); }
    await noOverflow('list'); await page.screenshot({ path: `${SHOTS}/list-${T.replace('/', '-')}.png` });
    // ---- conversation expand
    await page.locator('.mcount').first().click(); await page.waitForTimeout(600);
    ok(await page.locator('.msub .mrow.sub:visible').count() >= 1, `${T}: conversation expands`);
    await page.screenshot({ path: `${SHOTS}/thread-${T.replace('/', '-')}.png` });
    await page.locator('.mcount').first().click();
    // ---- all mails / folders
    await page.locator('[data-test=mode-all]').click(); await page.waitForTimeout(700);
    const allRows = await page.locator('.mail-rows > .mrow-wrap').count(); ok(page.url().includes('mode=all') && allRows >= 30, `${T}: "כל המיילים" mode in the URL, ${allRows} rows`);
    await page.locator('[data-test=folder-out]').click(); await page.waitForTimeout(700);
    ok(await page.locator('.mrow .mdir.received').count() === 0 && await page.locator('.mrow .mdir.sent').count() > 0, `${T}: folder יוצא shows only sent mail`);
    await page.locator('[data-test=mode-threads]').click(); await page.locator('.seg2 button', { hasText: 'הכל' }).first().click(); await page.waitForTimeout(500);
    // ---- infinite scroll
    const before = await page.locator('.mail-rows > .mrow-wrap').count();
    if (w >= 1024) await page.evaluate(() => { const l = document.querySelector('.mail-list'); l.scrollTop = l.scrollHeight; }); else await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200); const after = await page.locator('.mail-rows > .mrow-wrap').count(); ok(after > before, `${T}: next page appended on scroll (${before} -> ${after})`);
    ok(await page.locator('.mail-rows .arch-chip:visible').count() > 0, `${T}: archive chip on older mail`);
    if (w >= 1024) await page.evaluate(() => { document.querySelector('.mail-list').scrollTop = 0; }); else await page.evaluate(() => window.scrollTo(0, 0));
    // ---- filters
    await page.locator('[data-test=mail-filters-btn]').click(); await page.waitForTimeout(200);
    await page.locator('[data-test=f-att]').check(); await page.waitForTimeout(700);
    ok(await page.locator('.mrow:visible:not(.sub)').count() > 0 && await page.locator('.mail-rows > .mrow-wrap .mclip:visible').count() === await page.locator('.mail-rows > .mrow-wrap').count(), `${T}: "עם קבצים מצורפים" filter`);
    ok(page.url().includes('att=1'), `${T}: filter in the URL`);
    await page.locator('[data-test=f-range]').selectOption('week'); await page.waitForTimeout(700);
    ok(/from=2026-11-2[0-9]/.test(page.url()), `${T}: quick range השבוע -> ${page.url().replace(BASE, '')}`);
    await page.screenshot({ path: `${SHOTS}/filters-${T.replace('/', '-')}.png`, fullPage: w < 1024 });
    await page.locator('.mail-filters .btn', { hasText: 'נקה סינון' }).click(); await page.waitForTimeout(600);
    await page.locator('[data-test=f-person]').fill('דנה'); await page.waitForTimeout(700);
    ok(await page.locator('.mf-sug button').count() > 0, `${T}: person autocomplete`);
    await page.locator('.mf-sug button').first().click(); await page.waitForTimeout(800);
    ok(page.url().includes('person=') && await page.locator('.mf-chip').isVisible(), `${T}: person filter chosen`);
    await page.locator('.mf-chip button').click(); await page.waitForTimeout(500);
    await page.locator('[data-test=mail-filters-btn]').click();
    // ---- search
    await page.locator('[data-test=mail-q]').fill('פלדת זיון'); await page.waitForTimeout(2200);
    const hits = await page.locator('.mail-rows > .mrow-wrap').count(); ok(hits >= 3 && await page.locator('.msnip mark').count() > 0, `${T}: search "פלדת זיון": ${hits} hits, highlighted`);
    ok(await page.locator('.mrow .arch-chip:visible').count() > 0, `${T}: search includes archive mail`);
    await page.locator('[data-test=mail-filters-btn]').click(); await page.locator('[data-test=f-archive]').uncheck(); await page.waitForTimeout(1200);
    ok(await page.locator('.mrow .arch-chip:visible').count() === 0, `${T}: "כולל ארכיון" off removes archive hits`);
    await page.screenshot({ path: `${SHOTS}/search-${T.replace('/', '-')}.png` });
    await page.locator('[data-test=f-archive]').check(); await page.waitForTimeout(500); await page.locator('[data-test=mail-q]').fill(''); await page.waitForTimeout(1000);
    // ---- deep link
    await page.goto(BASE + '/mail?q=' + encodeURIComponent('פלדת זיון') + '&folder=in&att=1'); await page.waitForTimeout(2500);
    ok(await page.locator('[data-test=mail-q]').inputValue() === 'פלדת זיון' && await page.locator('.mrow .mdir.sent').count() === 0, `${T}: deep link restores the filters`);
    await page.goto(BASE + '/mail'); await page.waitForSelector('.mrow'); await page.waitForTimeout(500);
    // ---- opening a mail
    if (w >= 1024) {
      ok(await page.locator('.mail-pane').isVisible(), `${T}: reading pane visible`);
      await page.locator('.mail-rows .mrow').nth(1).click(); await page.waitForSelector('.mail-pane .em-main', { timeout: 6000 }); await page.waitForTimeout(800);
      ok(page.url().includes('m='), `${T}: opened mail in the pane (URL keeps m=)`);
      ok(await page.locator('.mail-pane [data-test=mail-actions]').isVisible() && await page.locator('.mail-pane .mv-frame:visible, .mail-pane .mailtext:visible').count() > 0, `${T}: pane shows actions and the body`);
      ok(await page.locator('.mail-pane .mv-frame').count() === 0 || (await page.locator('.mail-pane .mv-frame').first().getAttribute('sandbox')) !== null, `${T}: body iframe is sandboxed`);
      await page.locator('[data-test=act-create-task]').click(); await page.waitForTimeout(700);
      ok((await page.locator('.mail-pane .email-chat textarea').inputValue()).includes('צור משימה'), `${T}: "צור משימה מהמייל" fills the scoped chat`);
      await page.locator('[data-test=act-ask]').click(); await page.waitForTimeout(300);
      ok(await page.evaluate(() => document.activeElement && document.activeElement.closest && !!document.activeElement.closest('.email-chat')), `${T}: "שאל את אלכס" focuses the scoped chat`);
      if (await page.locator('[data-test=act-thread]').isVisible()) { await page.locator('[data-test=act-thread]').click(); await page.waitForTimeout(900); ok(await page.locator('.mail-pane .mt-row').count() >= 1, `${T}: "הצג את כל השיחה"`); }
      await page.locator('.mail-pane .em-main').evaluate((el) => el.scrollIntoView()); await page.screenshot({ path: `${SHOTS}/pane-${T.replace('/', '-')}.png` });
      // resizable divider
      const w0 = await page.locator('.mail-list').evaluate((e) => e.getBoundingClientRect().width); const d = await page.locator('.divider[data-pane=mlist]').boundingBox();
      await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2); await page.mouse.down(); await page.mouse.move(d.x + d.width / 2 - 80, d.y + d.height / 2, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(300);
      const w1 = await page.locator('.mail-list').evaluate((e) => e.getBoundingClientRect().width); ok(Math.abs(w1 - w0) > 40, `${T}: divider resizes the list (${Math.round(w0)} -> ${Math.round(w1)})`);
    } else {
      await page.evaluate(() => window.scrollTo(0, 900)); await page.waitForTimeout(300);
      const y0 = await page.evaluate(() => window.scrollY); const firstId = await page.locator('.mail-rows .mrow:not(.sub)').first().getAttribute('data-id');
      void firstId; const target = page.locator('.mail-rows .mrow:not(.sub)').nth(8); const idx = await target.getAttribute('data-id'); await target.scrollIntoViewIfNeeded(); const y1 = await page.evaluate(() => window.scrollY);
      await target.click(); await page.waitForSelector('.email-page .em-main', { timeout: 6000 }); await page.waitForTimeout(600);
      ok(page.url().includes('/email/' + idx), `${T}: tap opens /email/${idx}`);
      await page.screenshot({ path: `${SHOTS}/email-${T.replace('/', '-')}.png` });
      await page.locator('.email-page .btn', { hasText: 'חזרה' }).click(); await page.waitForSelector('.mrow'); await page.waitForTimeout(900);
      const y2 = await page.evaluate(() => window.scrollY); ok(Math.abs(y2 - y1) < 40 && y2 > 100, `${T}: back returns to the same scroll position (${Math.round(y1)} -> ${Math.round(y2)}; was ${Math.round(y0)})`);
      ok(await page.locator('.mail-rows .mrow:not(.sub)').count() >= 40, `${T}: the list state is kept after coming back`);
    }
    await noOverflow('end'); ok(errs.length === 0, `${T}: no page errors ${errs.join('; ')}`);
    await ctx.close();
  }
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL OK'); process.exit(fails ? 1 : 0);
})();
