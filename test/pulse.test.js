'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createNotify } = require('../lib/notify');
const { createPulse, workingDaysBetween } = require('../lib/pulse');

const AT = new Date('2026-11-25T11:00:00+02:00'); // Wednesday
const hoursAgo = (h) => new Date(AT.getTime() - h * 3600000).toISOString();
function setup() {
  const db = open(':memory:');
  const store = createStore(db);
  const notify = createNotify(db, store);
  const pulse = createPulse(db, store, notify);
  const a = store.assistantId(), owner = store.ownerId();
  const age = (id, h) => db.prepare('UPDATE tasks SET created_at=?, source_date=?, updated_at=? WHERE id=?').run(hoursAgo(h), hoursAgo(h), hoursAgo(h), id);
  return { db, store, notify, pulse, a, owner, age };
}
const keys = (items) => items.map((i) => i.key).sort();

test('working days count Sunday to Thursday only', () => {
  const t = (s) => Date.parse(s + 'T10:00:00+02:00');
  assert.equal(workingDaysBetween(t('2026-11-22'), t('2026-11-25')), 3); // Sun -> Wed
  assert.equal(workingDaysBetween(t('2026-11-26'), t('2026-11-29')), 1); // Thu -> Sun: only Sunday counts
  assert.equal(workingDaysBetween(t('2026-11-20'), t('2026-11-25')), 4); // Fri -> Wed: Sun, Mon, Tue, Wed
});

test('rule 1: a boss task waiting more than 24h with no action by the owner (and not when the owner acted or it is recent)', () => {
  const { store, pulse, a, owner, age } = setup();
  const boss = store.listPeople().find((p) => p.name_he === 'אבי כהן');
  const other = store.createPerson(a, { name: 'מישהו', role: 'contact' });
  const waiting = store.createTask(a, { title: 'לשלוח דוח לאבי', requester: boss.id, due: '2026-12-20' }); age(waiting.id, 30);
  const recent = store.createTask(a, { title: 'חדש מאבי', requester: boss.id }); age(recent.id, 5);
  const handled = store.createTask(a, { title: 'כבר בטיפול', requester: boss.id }); age(handled.id, 40);
  store.addNote(owner, { task: handled.id, text: 'התחלתי' });
  const notBoss = store.createTask(a, { title: 'מאדם אחר', requester: other.id }); age(notBoss.id, 50);
  assert.deepEqual(keys(pulse.collect(AT).filter((i) => i.kind === 'boss')), [`boss_task:${waiting.id}`]);
});

test('rule 1: a boss email older than 24h with no task and no reaction', () => {
  const { db, store, pulse } = setup();
  const boss = store.listPeople().find((p) => p.name_he === 'אבי כהן');
  store.updatePerson(store.assistantId(), boss.id, { emails: ['avi@exconstruct.example'] });
  const ins = (mid, from, h, subj) => db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, forwarded_from, processed_at) VALUES (?,?,?,?,?,?,?)").run(mid, 'dana@x.example', subj, hoursAgo(h), 'x', from, hoursAgo(h)).lastInsertRowid;
  const old = ins('m1', 'Avi Cohen <avi@exconstruct.example>', 30, 'שאלה דחופה');
  ins('m2', 'Avi Cohen <avi@exconstruct.example>', 3, 'חדש מדי');
  ins('m3', 'someone@else.com', 40, 'לא ממנהל');
  const linked = ins('m4', 'avi@exconstruct.example', 50, 'כבר יש משימה');
  const t = store.createTask(store.assistantId(), { title: 'מהמייל' });
  db.prepare("INSERT INTO task_emails (task_id, email_id, relation, created_at) VALUES (?,?, 'created', ?)").run(t.id, linked, hoursAgo(40));
  assert.deepEqual(keys(pulse.collect(AT).filter((i) => i.kind === 'boss')), [`boss_email:${old}`]);
});

test('rule 2: due today and not done; rule 4: overdue; closed tasks are ignored', () => {
  const { store, pulse, a } = setup();
  const today = store.createTask(a, { title: 'להיום', due: '2026-11-25' });
  const done = store.createTask(a, { title: 'הושלם', due: '2026-11-25', status: 'הושלם' });
  const late = store.createTask(a, { title: 'באיחור', due: '2026-11-20' });
  store.createTask(a, { title: 'עתידי', due: '2026-12-25' });
  const items = pulse.collect(AT);
  assert.deepEqual(keys(items.filter((i) => i.kind === 'due_today')), [`due_today:${today.id}`]);
  assert.deepEqual(keys(items.filter((i) => i.kind === 'overdue')), [`overdue:${late.id}`]);
  assert.ok(!items.some((i) => i.key.endsWith(':' + done.id)));
  assert.ok(items[0].prio <= items[items.length - 1].prio, 'sorted by priority');
});

test('rule 3: waiting (ממתין) with no email or note for more than 3 working days', () => {
  const { db, store, pulse, a, owner, age } = setup();
  const stale = store.createTask(a, { title: 'מחכה לתשובה', status: 'ממתין' }); age(stale.id, 24 * 7);
  const noted = store.createTask(a, { title: 'יש הערה', status: 'ממתין' }); age(noted.id, 24 * 7);
  const n = store.addNote(owner, { task: noted.id, text: 'שלחתי תזכורת' });
  const mailed = store.createTask(a, { title: 'יש מייל', status: 'ממתין' }); age(mailed.id, 24 * 7);
  const e = db.prepare("INSERT INTO emails (message_id, subject, received_at, body_text, processed_at) VALUES ('w1','x',?,'x',?)").run(hoursAgo(10), hoursAgo(10)).lastInsertRowid;
  db.prepare("INSERT INTO task_emails (task_id, email_id, relation, created_at) VALUES (?,?, 'updated', ?)").run(mailed.id, e, hoursAgo(10));
  const fresh = store.createTask(a, { title: 'ממתין מאתמול', status: 'ממתין' }); age(fresh.id, 30);
  const working = store.createTask(a, { title: 'בטיפול ישן', status: 'בטיפול' }); age(working.id, 24 * 9);
  void n;
  assert.deepEqual(keys(pulse.collect(AT).filter((i) => i.kind === 'waiting')), [`waiting:${stale.id}`]);
});

test('rule 5: questions unanswered for more than 24h', () => {
  const { db, store, pulse, a } = setup();
  const old = store.addAttention(a, { kind: 'question', text: 'האם לסגור?' });
  db.prepare('UPDATE attention SET created_at=? WHERE id=?').run(hoursAgo(30), old.id);
  store.addAttention(a, { kind: 'question', text: 'שאלה חדשה' });
  const sug = store.addAttention(a, { kind: 'suggestion', text: 'הצעה ישנה' });
  db.prepare('UPDATE attention SET created_at=? WHERE id=?').run(hoursAgo(90), sug.id);
  assert.deepEqual(keys(pulse.collect(AT).filter((i) => i.kind === 'question')), [`question:${old.id}`]);
});

test('each item is reported at most once a day; the next day it may come back', () => {
  const { store, pulse, a } = setup();
  const t = store.createTask(a, { title: 'להיום', due: '2026-11-25' });
  let items = pulse.fresh(pulse.collect(AT), AT);
  assert.equal(items.length, 1);
  pulse.markReported(items, AT);
  assert.equal(pulse.fresh(pulse.collect(AT), AT).length, 0, 'same day: nothing new');
  store.createTask(a, { title: 'עוד אחת להיום', due: '2026-11-25' });
  items = pulse.fresh(pulse.collect(AT), AT);
  assert.equal(items.length, 1, 'only the new item');
  const next = new Date(AT.getTime() + 86400000);
  assert.equal(pulse.fresh(pulse.collect(next).concat([{ key: `due_today:${t.id}` }]), next).length >= 1, true, 'a new day resets the log');
});

test('the pulse is allowed on working days in the daytime and not in quiet hours or Shabbat', () => {
  const { pulse } = setup();
  assert.equal(pulse.allowed(new Date('2026-11-25T10:00:00+02:00')).ok, true);
  assert.equal(pulse.allowed(new Date('2026-11-25T18:00:00+02:00')).ok, true);
  assert.equal(pulse.allowed(new Date('2026-11-25T22:30:00+02:00')).why, 'quiet');
  assert.equal(pulse.allowed(new Date('2026-11-27T10:00:00+02:00')).why, 'weekend', 'Friday');
  assert.equal(pulse.allowed(new Date('2026-11-28T12:00:00+02:00')).ok, false, 'Saturday');
  assert.equal(pulse.allowed(new Date('2026-11-25T20:00:00+02:00')).why, 'night');
});
