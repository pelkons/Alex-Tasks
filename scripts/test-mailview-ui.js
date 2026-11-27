'use strict';
// UI check on the TEST instance: an HTML email with a cid picture, a remote picture and a script. Run: scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; node scripts/test-mailview-ui.js
const { chromium } = require('playwright');
(async () => {
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge');
  const db = open(process.env.MESIMOT_DB); const store = createStore(db); const knowledge = createKnowledge(db, store);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');
  const eml = ['From: רון לוי <ron@x.example>', 'To: a@x.example, b@x.example, c@x.example', 'Cc: d@x.example', 'Subject: סיכום פגישה', 'Date: Thu, 05 Nov 2026 10:00:00 +0200', 'Message-ID: <t1@x.example>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=M', '', '--M', 'Content-Type: multipart/related; boundary=B', '', '--B', 'Content-Type: text/html; charset=utf-8', '', '<div dir="rtl"><p>שלום, הנה הסיכום.</p><script>document.title="PWNED"</script><img src="https://track.example/p.gif"><br><img src="cid:logo1" width="40"><a href="https://ok.example">קישור</a></div>', '--B', 'Content-Type: image/png; name=image001.png', 'Content-ID: <logo1>', 'Content-Transfer-Encoding: base64', 'Content-Disposition: inline; filename=image001.png', '', png, '--B--', '--M', 'Content-Type: application/pdf; name=doc.pdf', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename=doc.pdf', '', Buffer.from('%PDF-1.4 test').toString('base64'), '--M--', ''].join('\r\n');
  const f = await knowledge.saveUpload(store.ownerId(), { name: 'mv1.eml', mime: 'message/rfc822', buffer: Buffer.from(eml), source: 'email', quiet: true, stage: true });
  const emailId = f.email_id || db.prepare('SELECT email_id FROM files WHERE id=?').get(f.id).email_id; console.log('email', emailId);
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const ctx = await b.newContext({ viewport: { width: 1900, height: 1000 } }); const page = await ctx.newPage(); const reqs = []; ctx.on('request', (r) => reqs.push(r.url()));
  await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
  await page.goto('http://127.0.0.1:8111/email/' + emailId); await page.waitForTimeout(2500);
  const fr = page.frames().find((x) => /\/view/.test(x.url())); ok(!!fr, 'the original view is an iframe');
  if (fr) { const t = await fr.evaluate(() => ({ text: document.body.innerText, imgs: [...document.images].map((i) => (i.src || '').slice(0, 20) + '|' + getComputedStyle(i).display), title: document.title })); ok(/הנה הסיכום/.test(t.text), 'the HTML text is shown'); ok(t.title !== 'PWNED', 'no script ran'); ok(t.imgs.some((x) => /^data:image\/png/.test(x)), 'the cid picture is shown from the stored inline image'); }
  ok(!reqs.some((u) => /track\.example/.test(u)), 'the remote picture was NOT requested');
  ok(await page.locator('.mv-remote').isVisible(), 'the "external pictures blocked" bar shows');
  const side = await page.evaluate(() => { const a = document.querySelector('.em-aside'), m = document.querySelector('.em-main'); if (!a || !m) return null; const ra = a.getBoundingClientRect(), rm = m.getBoundingClientRect(); return { aRight: ra.left > rm.left, w: Math.round(ra.width), names: [...a.querySelectorAll('.ef-top b')].map((e) => e.textContent) }; });
  ok(side && side.aRight && side.w <= 320, 'the attachments column is at the right, ~300px: ' + JSON.stringify(side)); ok(side && side.names.length === 1 && side.names[0] === 'doc.pdf', 'only the real attachment is listed (no image001.png)');
  ok(!(await page.evaluate(() => document.body.innerText.includes('image001.png'))), 'image001.png is not listed anywhere');
  const sum = await page.locator('.mh-msg.main > summary').innerText(); ok(/מאת/.test(sum) && /אל/.test(sum) && /עותק 1/.test(sum), 'participants collapsed to a line: ' + sum.replace(/\n/g, ' '));
  ok(!(await page.locator('.mh-msg.main .mh-row').first().isVisible()), 'participants grid is collapsed by default');
  await page.screenshot({ path: '/tmp/ui-shots/email-view-1900.png' });
  await page.click('.mh-remote a, .mv-remote a'); await page.waitForTimeout(1200); ok(reqs.some((u) => /track\.example/.test(u)), 'the picture loads after "הצג"');
  await page.setViewportSize({ width: 420, height: 900 }); await page.waitForTimeout(500); ok(await page.evaluate(() => { const a = document.querySelector('.em-aside'), m = document.querySelector('.em-main'); return a.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 2; }), 'phone: attachments below the body');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
