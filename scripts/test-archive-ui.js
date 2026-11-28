'use strict';
// UI check of the Outlook mail ARCHIVE on the TEST instance (412 px and 1280 px): the chip and date in search, the "כולל ארכיון" filter, the text-only email page ("הקובץ נמצא רק ב-Outlook"), the one chat card, the Settings line.
//   scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; NODE_PATH=<a node_modules directory that has playwright> node scripts/test-archive-ui.js
const fs = require('fs');
const { chromium } = require('playwright');
process.env.MESIMOT_ARCHIVE_QUEUE = process.env.MESIMOT_ARCHIVE_QUEUE || '/tmp/mesimot-test/archive-queue';
process.env.MESIMOT_ARCHIVE_IGNORE_LIVE = '1'; process.env.MESIMOT_ARCHIVE_FREE_BYTES = String(500 * 1024 ** 3);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
(async () => {
  fs.mkdirSync('/tmp/ui-shots', { recursive: true });
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createArchive } = require('../lib/archive');
  const { buildMsg } = require('../test/helpers/msg-builder');
  const db = open(process.env.MESIMOT_DB); const store = createStore(db); const knowledge = createKnowledge(db, store); const archive = createArchive({ db, store, knowledge });
  const mk = (n, subject, body, date, atts) => buildMsg({ from_name: `ספק ${n}`, from_addr: `vendor${n}@supplier.example`, to: [{ name: 'דנה', addr: 'dana@exconstruct.example' }], subject, body, date: Date.parse(date), attachments: atts });
  const csv = Buffer.from('סעיף,תיאור,כמות\n1,איטום יסודות בציפוי צמנטי,420\n2,בידוד תרמי לגג,310\n');
  const stamp = Date.now().toString(36);
  await archive.enqueue({ entry_id: `UI-OLD-${stamp}`, archive: true, folder: 'inbox', received_or_sent_at: '2024-05-12T09:30:00+03:00', internet_message_id: `<ui-old-${stamp}@s.example>` },
    mk(1, 'הצעת מחיר לאיטום גג המגדל', 'שלום, מצורפת הצעת המחיר לאיטום הגג של המגדל, כולל כתב כמויות.', '2024-05-12T06:30:00Z', [{ name: 'כתב כמויות איטום.csv', data: csv, mime: 'text/csv' }, { name: 'שרטוט גג.pdf', data: Buffer.from('%PDF-1.4 not really a pdf'), mime: 'application/pdf' }]));
  await archive.enqueue({ entry_id: `UI-NEW-${stamp}`, archive: true, folder: 'inbox', received_or_sent_at: '2026-04-02T09:30:00+03:00', internet_message_id: `<ui-new-${stamp}@s.example>` },
    mk(2, 'איטום גג המגדל: עדכון שנה אחרונה', 'עדכון על איטום הגג של המגדל מהשנה האחרונה (מייל שמור במלואו).', '2026-04-02T06:30:00Z', [{ name: 'פרוטוקול.csv', data: csv, mime: 'text/csv' }]));
  for (let i = 0; i < 20; i++) if ((await archive.step()) === 'idle') break;
  const oldId = db.prepare("SELECT id FROM emails WHERE msgid=?").get(`ui-old-${stamp}@s.example`).id;
  const newId = db.prepare("SELECT id FROM emails WHERE msgid=?").get(`ui-new-${stamp}@s.example`).id;
  // a live (normal) mail on the same subject, to show the chip only on archive results
  const f = await knowledge.saveUpload(store.ownerId(), { name: 'live.msg', mime: 'application/vnd.ms-outlook', buffer: mk(3, 'איטום גג המגדל: סיכום ישיבה חי', 'סיכום הישיבה על איטום הגג של המגדל', '2026-11-25T08:00:00Z'), source: 'email', quiet: true, stage: true });
  db.prepare("UPDATE emails SET import_state=NULL, processed_at=? WHERE id=?").run(new Date().toISOString(), f.email_id);
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [w, h, tag] of [[1280, 900, 'desktop'], [412, 860, 'phone']]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage();
    await page.goto(BASE + '/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
    const noOverflow = async (what) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: ${what}: no horizontal scroll`);
    // ---- search
    await page.goto(BASE + '/search?q=' + encodeURIComponent('איטום גג')); await page.waitForTimeout(2500);
    const chips = await page.locator('.sres .arch-chip:visible').count(); const results = await page.locator('.sres').count();
    const liveRow = page.locator('.sres', { hasText: 'סיכום ישיבה חי' }); const oldRow = page.locator('.sres', { hasText: 'הצעת מחיר לאיטום גג המגדל' });
    ok(results >= 3 && chips >= 2 && await liveRow.locator('.arch-chip:visible').count() === 0 && await oldRow.locator('.arch-chip:visible').count() === 1, `${tag}: search shows ${results} results, ${chips} with the "ארכיון" chip (archive mails and their attachment text); the live mail has none`);
    const metas = await page.locator('.sres .s-meta').allInnerTexts(); ok(metas.some((t) => /12\/05\/2024/.test(t)) && metas.some((t) => /02\/04\/2026/.test(t)), `${tag}: archive results show the mail date with the year: ${JSON.stringify(metas)}`);
    ok((await page.locator('.sres .arch-chip').first().innerText()).trim() === 'ארכיון', `${tag}: chip text`);
    await noOverflow('search'); await page.screenshot({ path: `/tmp/ui-shots/archive-search-${tag}.png`, fullPage: true });
    const cb = page.locator('[data-test=sq-mail-archive]'); ok(await cb.isChecked(), `${tag}: "כולל ארכיון" is ON by default`);
    await cb.uncheck(); await page.waitForTimeout(1800); ok(await page.locator('.sres .arch-chip:visible').count() === 0 && await page.locator('.sres').count() >= 1, `${tag}: with the filter off the archive results are gone, live ones stay`);
    await cb.check(); await page.waitForTimeout(1800);
    // ---- the text-only email
    await page.goto(BASE + '/email/' + oldId); await page.waitForTimeout(2000);
    ok(await page.locator('[data-test=arch-note]').isVisible() && /הקבצים עצמם נמצאים רק ב-Outlook/.test(await page.locator('[data-test=arch-note]').innerText()), `${tag}: text-only banner`);
    ok((await page.locator('.em-file').count()) === 2 && (await page.locator('[data-test=only-outlook]:visible').count()) === 2, `${tag}: both attachments listed with "הקובץ נמצא רק ב-Outlook"`);
    ok(await page.locator('.em-file .ef-act a:visible').count() === 0, `${tag}: no open/download buttons for discarded files`);
    ok(/איטום הגג של המגדל/.test(await page.locator('.mailtext').innerText()), `${tag}: the body text is shown`);
    await noOverflow('text-only email'); await page.screenshot({ path: `/tmp/ui-shots/archive-email-textonly-${tag}.png`, fullPage: true });
    // ---- the complete archive mail still opens its file
    await page.goto(BASE + '/email/' + newId); await page.waitForTimeout(2000);
    ok(await page.locator('.em-file .ef-act a:visible').count() === 2 && await page.locator('[data-test=only-outlook]:visible').count() === 0, `${tag}: a complete archive mail keeps open/download`);
    ok(/השנה האחרונה|ארכיון/.test(await page.locator('[data-test=arch-note]').innerText()) && /שמורים במלואם/.test(await page.locator('[data-test=arch-note]').innerText()), `${tag}: complete banner`);
    await noOverflow('complete email');
    // ---- the chat card (one, updated in place) and the Settings line
    await page.goto(BASE + '/chat'); await page.waitForTimeout(2500);
    const cards = await page.locator('[data-test=archive-card]').count(); ok(cards === 1, `${tag}: ONE archive card in the chat (${cards})`);
    if (cards) { ok(/ארכיון Outlook: 2\/2 נקלטו/.test(await page.locator('[data-test=archive-card]').first().innerText()), `${tag}: card text`); await page.locator('[data-test=archive-card]').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: `/tmp/ui-shots/archive-card-${tag}.png` }); }
    await page.goto(BASE + '/settings?c=outlook'); await page.waitForTimeout(2500);
    const line = page.locator('[data-test=archive-line]'); ok(await line.isVisible() && /ארכיון: 2 מיילים, 1 טקסט בלבד/.test(await line.innerText()), `${tag}: Settings line: ${await line.innerText().catch(() => '?')}`);
    await line.scrollIntoViewIfNeeded(); await page.screenshot({ path: `/tmp/ui-shots/archive-settings-${tag}.png` }); await noOverflow('settings');
    await ctx.close();
  }
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL OK'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
