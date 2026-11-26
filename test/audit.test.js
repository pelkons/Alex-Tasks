'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createAudit } = require('../lib/audit');
const { createProposals } = require('../lib/proposals');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store));
  const a = store.assistantId(), owner = store.ownerId();
  const proj = store.createProject(a, { name: 'מגדל הדוגמה' }), proj2 = store.createProject(a, { name: 'פארק הדוגמה' });
  return { db, store, chat, a, owner, proj, proj2, audit: createAudit({ db, store }), proposals: createProposals({ db, store, chat }) };
}
const hidden = (db) => db.prepare('SELECT id FROM statuses WHERE hidden_default=1').get().id;

test('audit: near-duplicate tasks in the same project are proposed as merges (the newer into the older); other projects are left alone', () => {
  const { store, owner, proj, proj2, audit } = setup();
  const t1 = store.createTask(owner, { title: 'לאשר חשבון חלקי מספר 5 של הקבלן', project: proj.id, due: '2026-12-01', requester: owner });
  const t2 = store.createTask(owner, { title: 'לאשר את חשבון חלקי מספר 5 של הקבלן', project: proj.id, due: '2026-12-02', requester: owner });
  const t3 = store.createTask(owner, { title: 'לאשר חשבון חלקי מספר 5 של הקבלן', project: proj2.id, due: '2026-12-02', requester: owner });
  const d = audit.duplicates([store.getTask(t1.id), store.getTask(t2.id), store.getTask(t3.id)]);
  assert.equal(d.length, 1); assert.equal(d[0].target_id, t2.id); assert.equal(d[0].other_id, t1.id); assert.equal(d[0].kind, 'task_merge');
});

test('audit: people duplicates (same address / same name) and system senders become proposals; referenced people are kept', () => {
  const { store, a, owner, proj, audit } = setup();
  const p1 = store.createPerson(a, { name: 'דנה כהן', role: 'contact', emails: ['dana@firm.example'] });
  const p2 = store.createPerson(a, { name: 'Dana C', role: 'contact', emails: ['dana@firm.example'] });
  const n1 = store.createPerson(a, { name: 'גיל בר', role: 'contact', emails: ['gil@x.example'] }); const n2 = store.createPerson(a, { name: 'גיל בר', role: 'contact', emails: ['gil2@x.example'] });
  const sys = store.createPerson(a, { name: '3d', role: 'contact', emails: ['3d@render.example'] });
  const nr = store.createPerson(a, { name: 'Billing', role: 'contact', emails: ['no-reply@vendor.example'] });
  const used = store.createPerson(a, { name: 'מערכת', role: 'contact', emails: ['system@x.example'] });
  store.createTask(owner, { title: 'משימה שקשורה למערכת', project: proj.id, requester: used.id, due: '2026-12-01' });
  const items = audit.people();
  const has = (kind, id) => items.some((i) => i.kind === kind && i.target_id === id);
  assert.ok(has('person_merge', p1.id) || has('person_merge', p2.id), 'same address');
  assert.ok(has('person_merge', n1.id) || has('person_merge', n2.id), 'same name');
  assert.ok(has('person_remove', sys.id), '"3d"'); assert.ok(has('person_remove', nr.id), 'no-reply sender');
  assert.ok(!items.some((i) => i.target_id === used.id), 'a person with a task is never proposed for removal');
});

test('proposals: a batch is a chat card; approving applies through the store (undoable events), rejecting changes nothing; a removal of a used person fails safely', () => {
  const { db, store, chat, a, owner, proj, proposals } = setup();
  const keep = store.createTask(owner, { title: 'משימה ראשית', project: proj.id, due: '2026-12-01', requester: owner });
  const dup = store.createTask(owner, { title: 'כפילות', project: proj.id, due: '2026-12-01', requester: owner });
  const info = store.createTask(owner, { title: 'עדכון לידיעה', project: proj.id, due: '2026-12-01', requester: owner });
  const resolved = store.createTask(owner, { title: 'כבר טופל', project: proj.id, due: '2026-12-01', requester: owner });
  const contact = store.createPerson(a, { name: 'איש בשימוש', role: 'contact', emails: ['u@x.example'] });
  store.createTask(owner, { title: 'משימה של איש קשר', project: proj.id, requester: contact.id, due: '2026-12-01' });
  const bid = proposals.createBatch('tasks', 'בדיקה', [
    { kind: 'task_merge', target_id: dup.id, other_id: keep.id, text: 'כפילות' }, { kind: 'task_info', target_id: info.id, text: 'לידיעה', reason: 'עדכון סטטוס' },
    { kind: 'task_close', target_id: resolved.id, text: 'טופל', reason: 'הבעלים ענה' }, { kind: 'person_remove', target_id: contact.id, text: 'איש בשימוש' }]);
  const card = db.prepare('SELECT * FROM chat_messages WHERE proposal_batch=?').get(bid); assert.ok(card); assert.equal(chat.decorate(card).proposal_batch, bid);
  const items = proposals.batch(bid).items; const byKind = (k) => items.find((i) => i.kind === k);
  proposals.decide(byKind('task_info').id, 'reject');
  assert.notEqual(db.prepare('SELECT status_id FROM tasks WHERE id=?').get(info.id).status_id, hidden(db), 'rejected: untouched');
  proposals.approveBatch(bid);
  assert.equal(db.prepare('SELECT status_id FROM tasks WHERE id=?').get(dup.id).status_id, hidden(db), 'duplicate closed');
  assert.ok(db.prepare("SELECT 1 FROM notes WHERE task_id=? AND text LIKE '%כפילות%'").get(keep.id), 'the kept task got a note');
  assert.equal(db.prepare('SELECT is_done FROM statuses WHERE id=(SELECT status_id FROM tasks WHERE id=?)').get(resolved.id).is_done, 1, 'resolved task completed');
  const after = proposals.batch(bid);
  assert.equal(after.rejected, 1); assert.ok(after.applied >= 2);
  assert.equal(after.items.find((i) => i.kind === 'person_remove').status, 'failed', 'a person with tasks is not removed');
  assert.ok(store.findPerson(contact.id));
  assert.ok(db.prepare("SELECT 1 FROM events WHERE entity='task' AND entity_id=? AND actor_id=?").get(dup.id, a), 'logged as the assistant: undoable');
});
