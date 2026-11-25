'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createHousekeeping } = require('../lib/housekeeping');

const OLD = new Date(Date.now() - 45 * 86400000).toISOString();
const NEW = new Date(Date.now() - 5 * 86400000).toISOString();

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-hk-'));
  const dirs = { data: path.join(tmp, 'data'), files: path.join(tmp, 'files'), backups: path.join(tmp, 'backups'), models: path.join(tmp, 'models'), runs: path.join(tmp, 'data', 'runs'), agentTmp: path.join(tmp, 'agent-tmp'), voice: path.join(tmp, 'files', 'voice') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const db = open(':memory:');
  const store = createStore(db);
  const mailbox = []; const calls = [];
  const am = async (method, url) => {
    calls.push([method, url]);
    if (method === 'GET') return { messages: mailbox.map((m) => ({ message_id: m.id, labels: m.labels, timestamp: m.ts, subject: m.subject })) };
    if (method === 'DELETE') { const id = decodeURIComponent(url.split('/messages/')[1]); const i = mailbox.findIndex((m) => m.id === id); if (i < 0) throw new Error('404'); mailbox.splice(i, 1); return {}; }
    throw new Error('unexpected ' + method);
  };
  const hk = createHousekeeping(db, store, { am, base: 'https://x/v0/inboxes/i/messages', dirs });
  // a stored email with one attachment on disk
  const addEmail = (id, { att = true, hashOk = true, processed = true, body = 'גוף המייל' } = {}) => {
    let atts = [{ filename: 'image001.png', size: 100, skipped: 'inline' }];
    let fileId = null;
    if (att) {
      const content = Buffer.from('תוכן הקובץ המצורף');
      const p = path.join(dirs.files, id.replace(/\W/g, '') + '.txt');
      fs.writeFileSync(p, content);
      fileId = db.prepare("INSERT INTO files (original_name, path, mime, size, source, created_at, sha256) VALUES ('a.txt',?,?,?,'email',?,?)").run(p, 'text/plain', content.length, NEW, hashOk ? crypto.createHash('sha256').update(content).digest('hex') : 'bad').lastInsertRowid;
      atts.push({ filename: 'a.txt', size: content.length, file_id: Number(fileId) });
    }
    db.prepare('INSERT INTO emails (message_id, subject, received_at, body_text, attachments, processed_at) VALUES (?,?,?,?,?,?)').run(id, 'נושא ' + id, OLD, body, JSON.stringify(atts), processed ? NEW : null);
  };
  return { db, hk, mailbox, calls, addEmail, dirs, tmp };
}

test('mailbox cleanup deletes only old, labelled messages whose local copy is complete and verified', async () => {
  const { hk, mailbox, calls, addEmail } = setup();
  addEmail('<ok@x>');
  mailbox.push({ id: '<ok@x>', labels: ['received', 'mesimot', 'mesimot-done'], ts: OLD, subject: 'ok' });
  const r = await hk.mailboxCleanup();
  assert.deepEqual(r.deleted.map((d) => d.id), ['<ok@x>']);
  assert.equal(mailbox.length, 0);
  assert.ok(calls.some((c) => c[0] === 'DELETE'));
});

test('an incomplete local copy is never deleted: missing file, bad hash, failed attachment, unprocessed, empty body, no email row', async () => {
  const { hk, mailbox, addEmail, db, dirs } = setup();
  const cases = {
    '<hash@x>': () => addEmail('<hash@x>', { hashOk: false }),
    '<unprocessed@x>': () => addEmail('<unprocessed@x>', { processed: false }),
    '<empty@x>': () => addEmail('<empty@x>', { body: '' }),
    '<nofile@x>': () => { addEmail('<nofile@x>'); fs.unlinkSync(path.join(dirs.files, 'nofilex.txt')); },
    '<failed@x>': () => { addEmail('<failed@x>', { att: false }); db.prepare("UPDATE emails SET attachments=? WHERE message_id='<failed@x>'").run(JSON.stringify([{ filename: 'big.pdf', size: 5, error: 'download 500' }])); },
    '<never@x>': () => { addEmail('<never@x>', { att: false }); db.prepare("UPDATE emails SET attachments=? WHERE message_id='<never@x>'").run(JSON.stringify([{ filename: 'big.pdf', size: 5 }])); },
    '<norow@x>': () => {},
  };
  for (const [id, mk] of Object.entries(cases)) { mk(); mailbox.push({ id, labels: ['mesimot-done'], ts: OLD, subject: id }); }
  const r = await hk.mailboxCleanup();
  assert.equal(r.deleted.length, 0, 'nothing is deleted');
  assert.equal(r.kept.length, Object.keys(cases).length);
  assert.equal(mailbox.length, Object.keys(cases).length);
  assert.ok(r.kept.every((k) => k.why));
  assert.ok(db.prepare("SELECT COUNT(*) c FROM housekeeping_log WHERE action='mailbox-kept'").get().c === Object.keys(cases).length);
});

test('mail that is not ours, recent mail and sent mail are never touched; dry run deletes nothing', async () => {
  const { hk, mailbox, addEmail, calls } = setup();
  addEmail('<ours@x>'); addEmail('<recent@x>'); addEmail('<personal@x>'); addEmail('<sent@x>');
  mailbox.push({ id: '<ours@x>', labels: ['mesimot-done'], ts: OLD, subject: 'ours' });
  mailbox.push({ id: '<recent@x>', labels: ['mesimot-done'], ts: NEW, subject: 'recent' });
  mailbox.push({ id: '<personal@x>', labels: ['received', 'unread'], ts: OLD, subject: 'personal mail for mail-check' });
  mailbox.push({ id: '<labelled-only@x>', labels: ['received', 'mesimot'], ts: OLD, subject: 'taken but not done' });
  mailbox.push({ id: '<sent@x>', labels: ['sent', 'mesimot-done'], ts: OLD, subject: 'sent digest' });
  let r = await hk.mailboxCleanup({ dryRun: true });
  assert.deepEqual(r.deleted.map((d) => d.id), ['<ours@x>']); assert.ok(r.deleted[0].dry);
  assert.equal(mailbox.length, 5); assert.ok(!calls.some((c) => c[0] === 'DELETE'));
  r = await hk.mailboxCleanup();
  assert.deepEqual(r.deleted.map((d) => d.id), ['<ours@x>']);
  assert.deepEqual(mailbox.map((m) => m.id).sort(), ['<labelled-only@x>', '<personal@x>', '<recent@x>', '<sent@x>']);
});

test('the keep-days setting changes the cutoff', async () => {
  const { hk, mailbox, addEmail, db } = setup();
  addEmail('<mid@x>');
  mailbox.push({ id: '<mid@x>', labels: ['mesimot-done'], ts: new Date(Date.now() - 10 * 86400000).toISOString(), subject: 'ten days old' });
  assert.equal((await hk.mailboxCleanup({ dryRun: true })).candidates, 0);
  db.prepare("INSERT INTO settings (key,value) VALUES ('mailbox_keep_days','7')").run();
  assert.equal((await hk.mailboxCleanup({ dryRun: true })).candidates, 1);
});

test('rotation: run logs after 30 days, agent tmp after a day, voice after 90 days; files are never deleted; hashes are backfilled', async () => {
  const { hk, dirs, db } = setup();
  const age = (p, days) => { const t = new Date(Date.now() - days * 86400000); fs.utimesSync(p, t, t); };
  const mk = (p, days) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); age(p, days); return p; };
  const oldRun = mk(path.join(dirs.runs, '1.prompt.txt'), 40), newRun = mk(path.join(dirs.runs, '9.prompt.txt'), 2);
  const oldTmp = mk(path.join(dirs.agentTmp, 'apply.json'), 3), newTmp = mk(path.join(dirs.agentTmp, 'now.json'), 0);
  const oldVoice = mk(path.join(dirs.voice, '1.oga'), 100), newVoice = mk(path.join(dirs.voice, '2.oga'), 10);
  const oldFile = mk(path.join(dirs.files, '2020', '01', '1-old.pdf'), 900);
  db.prepare("INSERT INTO files (original_name, path, source, created_at) VALUES ('old.pdf',?,'web','2020-01-01')").run(oldFile);
  hk.rotate();
  assert.ok(!fs.existsSync(oldRun) && fs.existsSync(newRun));
  assert.ok(!fs.existsSync(oldTmp) && fs.existsSync(newTmp));
  assert.ok(!fs.existsSync(oldVoice) && fs.existsSync(newVoice));
  assert.ok(fs.existsSync(oldFile), 'archived files are never deleted');
  assert.equal(hk.backfillHashes(), 1);
  assert.ok(db.prepare('SELECT sha256 FROM files').get().sha256);
  const m = hk.maintainDb();
  assert.equal(m.vacuumed, true);
  assert.equal(hk.maintainDb().vacuumed, false, 'vacuum runs weekly');
});

test('disk warning and the weekly archive report go to attention', () => {
  const { hk, db, dirs } = setup();
  fs.writeFileSync(path.join(dirs.files, 'a.bin'), Buffer.alloc(2048));
  const rep = hk.weeklyFilesReport();
  assert.equal(rep.size, 2048);
  assert.equal(hk.weeklyFilesReport(), null, 'only once a week');
  assert.ok(db.prepare("SELECT 1 FROM attention WHERE text LIKE 'ארכיון הקבצים%'").get());
  const st = hk.storage();
  assert.ok(st.files >= 2048 && st.disk_total > 0);
});
