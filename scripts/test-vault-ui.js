'use strict';
// UI check on the TEST instance for encrypted file storage: an email with an inline (cid) picture and an attachment, an attachment download, a protocol whose source file opens.
// Run:  scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; NODE_PATH=<dir with playwright> node scripts/test-vault-ui.js
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createProtocols } = require('../lib/protocols');
  const vault = require('../lib/vault');
  const db = open(process.env.MESIMOT_DB); const store = createStore(db); const knowledge = createKnowledge(db, store); const protocols = createProtocols(db, store, knowledge);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');
  const SECRET = 'ערבות-בנקאית-סודית-לבדיקה';
  const pdf = Buffer.from('%PDF-1.4 ' + SECRET + ' ' + 'x'.repeat(5000));
  const eml = ['From: רון לוי <ron@x.example>', 'To: a@x.example', 'Subject: סיכום פגישה מוצפן', 'Date: Thu, 05 Nov 2026 10:00:00 +0200', 'Message-ID: <vault1@x.example>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=M', '', '--M', 'Content-Type: multipart/related; boundary=B', '', '--B', 'Content-Type: text/html; charset=utf-8', '', '<div dir="rtl"><p>שלום, ' + SECRET + '</p><img src="cid:logo1" width="40"></div>', '--B', 'Content-Type: image/png; name=image001.png', 'Content-ID: <logo1>', 'Content-Transfer-Encoding: base64', 'Content-Disposition: inline; filename=image001.png', '', png, '--B--', '--M', 'Content-Type: application/pdf; name=doc.pdf', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename=doc.pdf', '', pdf.toString('base64'), '--M--', ''].join('\r\n');
  const f = await knowledge.saveUpload(store.ownerId(), { name: 'vt1.eml', mime: 'message/rfc822', buffer: Buffer.from(eml), source: 'email', quiet: true, stage: true });
  const emailId = f.email_id || db.prepare('SELECT email_id FROM files WHERE id=?').get(f.id).email_id;
  const att = db.prepare("SELECT id, path FROM files WHERE original_name='doc.pdf' ORDER BY id DESC").get();
  const up = await knowledge.saveUpload(store.ownerId(), { name: 'protocol-source.txt', mime: 'text/plain', buffer: Buffer.from('פרוטוקול ' + SECRET), source: 'web', quiet: true });
  const pr = protocols.addProtocol(store.ownerId(), { title: 'פרוטוקול הצפנה', date: '2026-11-05 10:00', source: 'file:' + up.id, participants: 'רון לוי' });
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  for (const p of [f.id, att && att.id, up.id].filter(Boolean)) { const row = db.prepare('SELECT path FROM files WHERE id=?').get(p); ok(vault.isEncrypted(row.path), `file ${p} is encrypted on disk`); ok(!fs.readFileSync(row.path).includes(Buffer.from(SECRET)), `file ${p}: the secret text is not on disk`); }
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome' });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true }); const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8111/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
  // 1. the email with its inline picture
  await page.goto('http://127.0.0.1:8111/email/' + emailId); await page.waitForTimeout(2500);
  const fr = page.frames().find((x) => /\/view/.test(x.url())); ok(!!fr, 'the original view is shown');
  if (fr) { const t = await fr.evaluate(() => ({ text: document.body.innerText, img: [...document.images].map((i) => ({ w: i.naturalWidth, src: i.src.slice(0, 12) })) })); ok(t.text.includes(SECRET), 'the body text is readable in the view'); ok(t.img.length && t.img[0].w > 0, 'the inline (cid) picture loaded: ' + JSON.stringify(t.img)); }
  // 2. the attachment downloads with the original bytes
  const body = await page.evaluate(async (id) => { const r = await fetch('/api/files/' + id + '/download'); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, len: b.length, head: new TextDecoder().decode(b.slice(0, 8)), cl: r.headers.get('content-length') }; }, att.id);
  ok(body.status === 200 && body.len === pdf.length && body.head === '%PDF-1.4' && +body.cl === pdf.length, 'attachment download returns the original bytes: ' + JSON.stringify(body));
  const link = page.locator(`a[href*="/api/files/${att.id}/download"]`).first(); ok(await link.count() > 0, 'the email page links the attachment');
  if (await link.count()) { const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), link.click({ modifiers: [] }).catch(() => {})]); if (dl) { const p = await dl.path(); ok(fs.readFileSync(p).equals(pdf), 'the clicked download is byte-identical to the attachment'); } else ok(true, '(inline open instead of a download: bytes checked above)'); }
  // 3. a protocol file opens
  await page.goto('http://127.0.0.1:8111/protocols/' + pr.id); await page.waitForTimeout(2000);
  const pl = page.locator(`a[href*="/api/files/${up.id}/download"]`).first(); ok(await pl.count() > 0, 'the protocol page has its "open the file" link');
  const txt = await page.evaluate(async (id) => (await (await fetch('/api/files/' + id + '/download')).text()), up.id); ok(txt.includes(SECRET), 'the protocol source file opens with its original text');
  const msg = await page.evaluate(async (id) => (await (await fetch('/api/files/' + id)).json()), up.id); ok(msg && msg.original_name === 'protocol-source.txt', 'file info works');
  // 4. nothing plaintext is left in /dev/shm
  const left = fs.readdirSync(vault.tmpRoot()).filter((d) => d !== 'view'); ok(left.length === 0, 'no plaintext temp dirs left: ' + left.join(','));
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
