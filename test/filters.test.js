'use strict';
process.env.MESIMOT_SEMANTIC = '0'; process.env.MESIMOT_NO_BG = '1';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-flt-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createFilters } = require('../lib/filters');
const { createImporter } = require('../lib/importer');
const { ingestMessage } = require('../lib/email');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store);
  return { db, store, knowledge, f: createFilters({ db, store }), a: store.assistantId(), owner: store.ownerId() };
}
const mail = (db, o) => db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, forwarded_from, mail_date, import_state) VALUES (?,?,?,?,?,?,?,?)")
  .run(o.id, o.from, o.subject, o.date || new Date().toISOString(), o.body || 'גוף', o.from, o.date || new Date().toISOString(), o.state ?? null).lastInsertRowid;

test('rules: sender, domain, phrase and regex match in code; "relevant" beats skip; a project scope limits a rule; bad input is refused', () => {
  const { db, store, f, a, owner } = setup();
  const proj = store.createProject(store.ownerId(), { name: 'מגדל הדוגמה' });
  f.add(owner, { kind: 'domain', pattern: '@vendor.example', action: 'skip' });
  f.add(owner, { kind: 'sender', pattern: 'boss@vendor.example', action: 'relevant' });
  f.add(owner, { kind: 'text', pattern: 'out of office', field: 'subject', action: 'skip' });
  f.add(owner, { kind: 'regex', pattern: '^(RE|FW): weekly', action: 'fyi' });
  f.add(owner, { kind: 'text', pattern: 'חשבונית', action: 'fyi', project: proj.id });
  assert.equal(f.add(owner, { kind: 'domain', pattern: 'vendor.example', action: 'skip' }).kind, 'domain', 'a duplicate is not added twice'); assert.equal(f.list().length, 5);
  const m = (o) => f.match({ from_addr: o.from, subject: o.subject, body_text: o.body || '' });
  assert.equal(m({ from: 'Sales <sales@vendor.example>', subject: 'מבצע' }).action, 'skip');
  assert.equal(m({ from: 'boss@vendor.example', subject: 'מבצע' }).action, 'relevant', 'relevant beats skip');
  assert.equal(m({ from: 'x@y.example', subject: 'Out of Office: back Sunday' }).action, 'skip');
  assert.equal(m({ from: 'x@y.example', subject: 'FW: weekly report' }).action, 'fyi');
  assert.equal(m({ from: 'x@y.example', subject: 'חשבונית', body: 'שלום' }), null, 'the project-scoped rule needs the project in the mail');
  assert.equal(m({ from: 'x@y.example', subject: 'חשבונית', body: 'בפרויקט מגדל הדוגמה' }).action, 'fyi');
  assert.equal(m({ from: 'x@y.example', subject: 'רגיל' }), null);
  assert.throws(() => f.add(owner, { kind: 'regex', pattern: '(', action: 'skip' }), /אינו תקין/); assert.throws(() => f.add(owner, { kind: 'sender', pattern: 'a@b', action: 'nuke' }), /פעולה/);
  const off = f.list()[0]; f.update(owner, off.id, { enabled: false }); assert.equal(m({ from: 'sales@vendor.example', subject: 'x' }), null, 'a disabled rule does nothing');
  void db;
});

test('preview: how many mails of the last 30 days a rule would catch', () => {
  const { db, f } = setup(); const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  mail(db, { id: 'p1', from: 'news@vendor.example', subject: 'a', date: day(2) }); mail(db, { id: 'p2', from: 'news@vendor.example', subject: 'b', date: day(10) });
  mail(db, { id: 'p3', from: 'news@vendor.example', subject: 'old', date: day(60) }); mail(db, { id: 'p4', from: 'x@y.example', subject: 'c', date: day(1) });
  const p = f.preview({ kind: 'domain', pattern: 'vendor.example', action: 'skip' });
  assert.equal(p.matches, 2); assert.equal(p.total, 3); assert.equal(p.examples.length, 2);
});

test('live mail: a skip rule finishes the mail in code (stored, never queued for a model); an fyi rule stamps it', () => {
  const { db, store, f, owner } = setup();
  f.add(owner, { kind: 'domain', pattern: 'vendor.example', action: 'skip' }); f.add(owner, { kind: 'sender', pattern: 'status@site.example', action: 'fyi' });
  const msg = (id, from) => ({ message_id: id, from, to: ['x@y'], subject: 'נושא ' + id, text: 'גוף', timestamp: new Date().toISOString(), labels: ['received'] });
  const s = ingestMessage(db, store, msg('<s1>', 'Sales <sales@vendor.example>')); f.apply(s.id);
  const y = ingestMessage(db, store, msg('<s2>', 'status@site.example')); f.apply(y.id);
  const row = (id) => db.prepare('SELECT processed_at, import_state, filter_action, noise_reason FROM emails WHERE id=?').get(id);
  assert.ok(row(s.id).processed_at); assert.equal(row(s.id).import_state, 'noise'); assert.match(row(s.id).noise_reason, /כלל שלך/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='email' AND entity_id=? AND processed_at IS NULL").get(s.id).c, 0);
  assert.equal(row(y.id).filter_action, 'fyi'); assert.equal(row(y.id).processed_at, null, 'fyi mails are still processed (facts only)');
  assert.equal(db.prepare('SELECT hits FROM mail_filters WHERE pattern=?').get('vendor.example').hits, 1);
});

test('daily import: rules run before the code noise filter and the model triage; the digest reports how many were filtered', () => {
  const { db, store, knowledge, f, owner } = setup();
  const imp = createImporter({ db, store, knowledge, chat: null });
  f.add(owner, { kind: 'domain', pattern: 'vendor.example', action: 'skip' }); f.add(owner, { kind: 'sender', pattern: 'site@x.example', action: 'fyi' }); f.add(owner, { kind: 'sender', pattern: 'rescue@news.example', action: 'relevant' });
  const id = db.prepare("INSERT INTO imports (created_at, status, stats) VALUES (?, 'parsed', '{}')").run(new Date().toISOString()).lastInsertRowid;
  const mk = (mid, from, subj, noise) => { const e = mail(db, { id: mid, from, subject: subj, state: 'parsed' }); db.prepare('UPDATE emails SET import_id=?, direction=\'received\', thread_key=?, noise_reason=? WHERE id=?').run(id, subj, noise || null, e); return e; };
  const e1 = mk('i1', 'a@vendor.example', 'מבצע'); const e2 = mk('i2', 'site@x.example', 'סטטוס שבועי'); const e3 = mk('i3', 'rescue@news.example', 'חשוב', 'ידיעון (List-Unsubscribe)'); const e4 = mk('i4', 'p@q.example', 'ענייני');
  imp.applyNoise(id); imp.buildThreads(id);
  const st = (e) => db.prepare('SELECT import_state s FROM emails WHERE id=?').get(e).s;
  assert.equal(st(e1), 'noise', 'skipped by the owner rule'); assert.equal(st(e3), 'parsed', 'a relevant rule rescues a mail the code filter would drop');
  const items = imp.triageItems(id); assert.deepEqual(items.map((t) => t.subject).sort(), ['ענייני'], 'forced threads are not sent to the triage model');
  imp.applyTriage(id, {});
  assert.equal(st(e2), 'fyi'); assert.equal(st(e3), 'relevant'); assert.equal(st(e4), 'relevant');
  assert.match(imp.digest(id), /סוננו 2 לפי כללים שלך \(1 דולגו, 1 לידיעה בלבד, 1 סומנו תמיד-רלוונטי\)/);
});

test('meeting invitations in an imported mail become calendar items in code (no model): UTC converted to Jerusalem time, cancellations ignored', async () => {
  const { parse } = require('../lib/ics');
  const ics = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:abc', 'SUMMARY:ישיבת תיאום\\, קומה 9', 'LOCATION:חדר ישיבות', 'DTSTART:20261217T100000Z', 'DTEND:20261217T110000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const r = parse(ics); assert.equal(r.method, 'REQUEST'); assert.equal(r.events[0].title, 'ישיבת תיאום, קומה 9'); assert.deepEqual(r.events[0].start, { date: '2026-12-17', time: '12:00' });
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store);
  const eml = Buffer.from(['From: Boss <boss@example.com>', 'To: dana@exconstruct.example', 'Subject: הזמנה: ישיבת תיאום', 'Date: Tue, 24 Nov 2026 10:00:00 +0200', 'Message-ID: <inv1@x>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain; charset=utf-8', '', 'מוזמנים לישיבה', '--B', 'Content-Type: text/calendar; method=REQUEST; charset=utf-8', 'Content-Disposition: attachment; filename="invite.ics"', '', ics, '--B--', ''].join('\r\n'));
  const files = []; for (let i = 0; i < 4; i++) files.push((await knowledge.saveUpload(store.ownerId(), { name: `m${i}.eml`, mime: 'message/rfc822', buffer: i === 0 ? eml : Buffer.from(`From: x@y.example\r\nTo: dana@exconstruct.example\r\nSubject: s${i}\r\nDate: Tue, 24 Nov 2026 11:0${i}:00 +0200\r\nMessage-ID: <m${i}@x>\r\n\r\nגוף`), source: 'web' })).id);
  const imp = createImporter({ db, store, knowledge, chat: require('../lib/chat').createChat(db, store, knowledge) }); store.hooks.importIntake = imp.intake;
  const card = require('../lib/chat').createChat(db, store, knowledge).sendChat(store.ownerId(), { text: '', file_ids: files });
  await imp.stage(card.import_id); imp.applyNoise(card.import_id);
  const cal = db.prepare('SELECT title, start FROM calendar_items').all(); assert.equal(cal.length, 1); assert.match(cal[0].start, /2026-12-17T10:00/, 'stored in UTC = 12:00 Jerusalem');
  assert.equal(db.prepare("SELECT import_state s FROM emails WHERE msgid='inv1@x'").get().s, 'noise', 'the invitation needs no model');
});
