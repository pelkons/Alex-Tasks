'use strict';
// Attachments in the task card (התכתבות) and the project page (מסמכים), TEST instance only. Seeds via scripts/seed-contract.js.
const { chromium } = require('playwright');
process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
const { open } = require('../lib/db'); const { createStore } = require('../lib/store');
const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db); const a = store.assistantId();
const f = db.prepare("SELECT id, email_id FROM files WHERE original_name LIKE 'חוזה מכר חדר שנאים%'").get();
const proj = store.listProjects().find((p) => p.name_he === 'מגדל הנוף');
db.prepare("UPDATE files SET summary=?, project_id=?, facts_checked=1 WHERE id=?").run('חוזה מכר חדר שנאים בין חברת החשמל למגדל הנוף יזמות.\nהתמורה 182,643.30 ש"ח + מע"מ (סעיף 9.1).', proj.id, f.id);
let t = db.prepare('SELECT id FROM tasks WHERE source_email_id=?').get(f.email_id);
if (!t) { t = store.createTask(a, { title: 'לטפל בחוזה חדר השנאים', project: proj.id, requester: store.ownerId(), due: '2026-12-10', email: f.email_id }); }
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:8111/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(2000);
  await p.goto(`http://127.0.0.1:8111/task/${t.id}`); await p.waitForTimeout(2000);
  const row = await p.evaluate(() => { const r = document.querySelector('.corr .att-row'); return r ? { txt: r.textContent.replace(/\s+/g, ' '), href: r.querySelector('a')?.getAttribute('href') } : null; });
  ok(row && /חוזה מכר חדר שנאים/.test(row.txt) && /182,643/.test(row.txt) && /download/.test(row.href || ''), 'task card: attachment with name, summary and open link ' + JSON.stringify(row).slice(0, 160));
  await p.screenshot({ path: 'screenshots/resize/attach-task.png' });
  await p.goto(`http://127.0.0.1:8111/projects/${proj.id}`); await p.waitForTimeout(2000);
  const pr = await p.evaluate(() => { const r = [...document.querySelectorAll('.filecard')].find((x) => /חוזה מכר/.test(x.textContent)); return r ? { txt: r.textContent.replace(/\s+/g, ' '), open: [...r.querySelectorAll('a')].some((a) => /פתיחה/.test(a.textContent)) } : null; });
  ok(pr && /182,643/.test(pr.txt) && pr.open, 'project page: document with summary and an open link');
  await p.screenshot({ path: 'screenshots/resize/attach-project.png', fullPage: false });
  await p.goto('http://127.0.0.1:8111/search'); await p.waitForTimeout(800);
  const sr = await p.evaluate(async () => (await (await fetch('/api/search?q=' + encodeURIComponent('שנאי תמורה') + '&kind=chunk')).json()).results.map((r) => r.title));
  ok(sr.some((x) => /חוזה מכר.*עמוד \d+/.test(x)), 'search chunk hit shows file name and page: ' + JSON.stringify(sr));
  await b.close(); console.log(fail ? fail + ' FAILED' : 'ALL OK'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
