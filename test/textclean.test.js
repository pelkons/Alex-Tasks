'use strict';
process.env.MESIMOT_SEMANTIC = '0'; process.env.MESIMOT_NO_BG = '1';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-tc2-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { clean } = require('../lib/textclean');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createUsage } = require('../lib/usage');

test('text reduction: quoted replies, signature, disclaimer and banners go; the new content stays; nothing is reduced to empty', () => {
  const t = 'שלום דנה,\nמצורפת תוכנית היציקות המעודכנת לקומה 9. נא לאשר עד יום חמישי.\n\nבברכה,\nמשה\nטל: 050-1234567\n\nמאת: דנה לוי\nנשלח: ראשון, 22 נובמבר 2026\nנושא: תוכנית\n\nהי משה, אפשר לקבל את התוכנית?\n\nThis message is confidential and intended solely for the addressee.';
  assert.equal(clean(t), 'שלום דנה,\nמצורפת תוכנית היציקות המעודכנת לקומה 9. נא לאשר עד יום חמישי.');
  assert.equal(clean('CAUTION: This email originated from outside the organization.\nהצעת מחיר מצורפת, סכום 12,000 ש"ח + מע"מ.\nBest regards,\nAvi'), 'הצעת מחיר מצורפת, סכום 12,000 ש"ח + מע"מ.');
  assert.equal(clean('קצר'), 'קצר');
  assert.equal(clean('From: x@y.example\nSubject: only a forwarded header'), 'From: x@y.example\nSubject: only a forwarded header', 'an all-quoted mail is kept');
  assert.ok(clean('א'.repeat(9000)).length <= 3501);
});

test('attachments with the same sha256 are processed once: the second copy reuses text, summary and project', async () => {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const a = store.assistantId();
  const proj = store.createProject(a, { name: 'מגדל הדוגמה' });
  const buf = Buffer.from('סעיף 9.1 התמורה 182,643 ש"ח. '.repeat(30));
  const f1 = await knowledge.saveUpload(a, { name: 'חוזה.txt', mime: 'text/plain', buffer: buf, source: 'email', quiet: true });
  knowledge.classifyFile(a, f1.id, { project: proj.id, summary: 'חוזה לדוגמה', facts_checked: true });
  const f2 = await knowledge.saveUpload(a, { name: 'חוזה (2).txt', mime: 'text/plain', buffer: buf, source: 'email', quiet: true });
  const row = db.prepare('SELECT summary, project_id, facts_checked, text_status, index_note FROM files WHERE id=?').get(f2.id);
  assert.equal(row.summary, 'חוזה לדוגמה'); assert.equal(row.project_id, proj.id); assert.equal(row.facts_checked, 1); assert.match(row.index_note, /זהה לקובץ/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_id=?').get(f2.id).c, db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_id=?').get(f1.id).c);
});

test('budget guard (opt-in): only optional work is delayed, never for more than 24 h; tasks, import threads, pulse, reconcile and chat are never touched; 0 = off', () => {
  const db = open(':memory:'); const u = createUsage(db);
  for (const j of ['import', 'import_lite', 'curator', 'chat']) assert.equal(u.blocked(j), false, 'off by default: ' + j);
  db.prepare("INSERT INTO settings (key,value) VALUES ('daily_budget_usd','5')").run();
  u.record({ job: 'import', usage: { cost_usd: 3 } }); assert.equal(u.blocked('curator'), false, 'under the budget');
  u.record({ job: 'import_lite', usage: { cost_usd: 2.5 } });
  for (const j of ['curator', 'facts', 'audit', 'import_fyi']) assert.equal(u.blocked(j), true, 'optional work waits: ' + j);
  for (const j of ['import', 'import_lite', 'triage', 'pulse', 'reconcile', 'chat', 'batch', 'gate']) assert.equal(u.blocked(j), false, 'never delayed by the budget: ' + j);
  assert.ok(u.shouldTellBudget()); assert.equal(u.shouldTellBudget(), null, 'told once a day');
  // after 24 hours of waiting the optional work runs anyway
  db.prepare("UPDATE settings SET value=? WHERE key='budget_deferred:curator'").run(new Date(Date.now() - 25 * 3600e3).toISOString());
  assert.equal(u.blocked('curator'), false, 'at most 24 hours');
  db.prepare("UPDATE settings SET value='0' WHERE key='daily_budget_usd'").run(); assert.equal(u.blocked('facts'), false);
});

test('anomaly alert: today above 2x the 14-day average is reported once, with the top consumers; a rate limit is a different thing and still pauses background jobs', () => {
  const db = open(':memory:'); const u = createUsage(db);
  for (let i = 1; i <= 5; i++) db.prepare("INSERT INTO run_usage (at, job, cost_usd) VALUES (?, 'import', 4)").run(new Date(Date.now() - i * 86400000).toISOString());
  assert.equal(u.anomaly(), null, 'nothing today');
  db.prepare("INSERT INTO run_usage (at, job, cost_usd) VALUES (?, 'import', 12)").run(new Date().toISOString());
  const a = u.anomaly(); assert.ok(a && a.today >= 12 && a.avg >= 3.9 && a.top[0].job === 'import'); assert.equal(u.anomaly(), null, 'only once a day');
  u.record({ job: 'curator', error: 'Claude AI usage limit reached|' + Math.floor((Date.now() + 3600e3) / 1000) });
  assert.equal(u.blocked('import'), true, 'a rate limit still pauses background jobs (chat and live mail first)'); assert.equal(u.blocked('chat'), false);
});
