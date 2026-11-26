'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-tc-'));
process.env.MESIMOT_SEMANTIC = '0'; process.env.MESIMOT_LOCK = path.join(tmp, 'runner.lock'); process.env.MESIMOT_RUN_LOG = path.join(tmp, 'runs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createGate } = require('../lib/gate');
const { createEntities } = require('../lib/entities');
const { createRunner } = require('../lib/runner');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const gate = createGate({ db, store, knowledge, entities: createEntities(db, store) });
  const a = store.assistantId(), owner = store.ownerId();
  const proj = store.createProject(a, { name: 'מגדל הדוגמה' });
  const t1 = store.createTask(owner, { title: 'להעביר תוכנית יציקות', project: proj.id, due: '2026-12-01', requester: owner });
  const t2 = store.createTask(owner, { title: 'משימה אחרת של המגדל', project: proj.id, due: '2026-12-05', requester: owner });
  const run = () => db.prepare("INSERT INTO claude_runs (started_at, trigger, pinned_task_id) VALUES (?, 'chat', ?)").run(new Date(Date.now() - 1000).toISOString(), t1.id).lastInsertRowid;
  return { db, store, knowledge, chat, gate, a, owner, proj, t1, t2, run };
}
const codes = (v) => v.filter((x) => x.code === 'task_chat').map((x) => x.key);

test('a task-card message is an ordinary chat message with task_id and scope task; the thread shows both sides; an owner message wakes a chat run', () => {
  const { db, chat, owner, a, t1 } = setup();
  const m = chat.sendChat(owner, { text: 'תדחה בשבוע', task_scope: t1.id });
  assert.equal(m.scope, 'task'); assert.equal(m.task_id, t1.id); assert.equal(m.task_title, t1.title);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE entity='chat' AND entity_id=? AND processed_at IS NULL").get(m.id), 'chat-priority run');
  const r = db.prepare("INSERT INTO claude_runs (started_at, trigger, pinned_task_id) VALUES (?, 'chat', ?)").run(new Date().toISOString(), t1.id);
  const reply = chat.sendChat(a, { text: 'הזזתי את היעד ל-08/12' }); // inside a pinned run: scoped automatically
  assert.equal(reply.scope, 'task'); assert.equal(reply.task_id, t1.id);
  const plain = chat.sendChat(a, { text: 'הודעה כללית', task_scope: 0 });
  assert.equal(plain.scope, null, 'task_scope 0 writes to the main chat');
  const th = chat.taskThread(t1.id); assert.deepEqual(th.map((x) => x.author), ['owner', 'claude']);
  assert.equal(chat.listChat({ limit: 10 }).length, 3, 'the main chat shows them all (the UI can hide the task ones)');
  void r;
});

test('Telegram: the assistant\'s task replies stay on the site unless they ask or matter; then they carry the link to the card', () => {
  const { db, chat, a, t1 } = setup();
  db.prepare("INSERT INTO settings (key,value) VALUES ('telegram_chat_id','1')").run();
  db.prepare("INSERT INTO claude_runs (started_at, trigger, pinned_task_id) VALUES (?, 'chat', ?)").run(new Date().toISOString(), t1.id);
  const quiet = chat.sendChat(a, { text: 'עדכנתי את היעד ל-08/12.' });
  assert.equal(db.prepare('SELECT tg_sent FROM chat_messages WHERE id=?').get(quiet.id).tg_sent, 1, 'not sent to Telegram');
  const ask = chat.sendChat(a, { text: 'לדחות גם את המשימה הקשורה?' });
  const row = db.prepare('SELECT tg_sent, text FROM chat_messages WHERE id=?').get(ask.id);
  assert.equal(row.tg_sent, 0, 'a question goes to Telegram'); assert.match(row.text, new RegExp(`/task/${t1.id}`));
  db.prepare('UPDATE claude_runs SET finished_at=?').run(new Date().toISOString());
  assert.equal(db.prepare('SELECT tg_sent FROM chat_messages WHERE id=?').get(chat.sendChat(a, { text: 'הודעה רגילה' }).id).tg_sent, 0, 'main chat messages are mirrored as before');
});

test('gate: a task-scoped run needs a reply; other tasks may change only when the reply names them; a claimed change needs an action', async () => {
  const { db, store, chat, gate, a, owner, t1, t2, run } = setup();
  const r = run();
  chat.sendChat(owner, { text: 'תדחה בשבוע', task_scope: t1.id });
  const inRun = (fn) => { fn(); db.prepare('UPDATE events SET run_id=? WHERE run_id IS NULL AND actor_id=?').run(r, a); };
  assert.deepEqual(codes(await gate.check(r, {})), ['task_chat:reply'], 'no reply in the thread');
  // a change of task 1 and a reply that says what changed: fine
  inRun(() => store.updateTask(a, t1.id, { due: '2026-12-08' }));
  chat.sendChat(a, { text: 'הזזתי את היעד של המשימה מ-01/12 ל-08/12.' });
  assert.deepEqual(codes(await gate.check(r, {})), []);
  // another task changed without being named
  inRun(() => store.updateTask(a, t2.id, { due: '2026-12-12' }));
  assert.deepEqual(codes(await gate.check(r, {})), ['task_chat:others']);
  chat.sendChat(a, { text: `דחיתי גם את משימה ${t2.id} (משימה אחרת של המגדל) כי ביקשת.` });
  assert.deepEqual(codes(await gate.check(r, {})), [], 'named: allowed');
});

test('gate: "I changed it" without any action is re-prompted', async () => {
  const { db, chat, gate, owner, a, t1, run } = setup();
  const r = run();
  chat.sendChat(owner, { text: 'תשייך את זה למיכל', task_scope: t1.id });
  chat.sendChat(a, { text: 'שייכתי את המשימה למיכל.' });
  assert.deepEqual(codes(await gate.check(r, {})), ['task_chat:claim']);
  void db;
});

test('gate: "send a reminder to everyone" is not enabled: an honest answer and a draft per recipient are required, nothing is sent', async () => {
  const { db, store, chat, gate, owner, a, t1, run } = setup();
  const r = run();
  chat.sendChat(owner, { text: 'תשלח תזכורת לכולם שמוזכרים במיילים של המשימה', task_scope: t1.id });
  chat.sendChat(a, { text: 'שלחתי תזכורת לכולם.' });
  assert.ok(codes(await gate.check(r, {})).includes('task_chat:outward'));
  db.prepare('DELETE FROM chat_messages WHERE author=\'claude\'').run();
  store.addDraft(a, t1.id, 'אל: מיכל <michal@example.com>\nתזכורת: נא לשלוח את התוכנית.'); db.prepare('UPDATE events SET run_id=? WHERE run_id IS NULL AND actor_id=?').run(r, a);
  chat.sendChat(a, { text: 'שליחה לאחרים עדיין לא מופעלת. הכנתי טיוטה לכל נמען, להעתקה.' });
  assert.deepEqual(codes(await gate.check(r, {})).filter((k) => k === 'task_chat:outward'), []);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM emails").get().c, 0);
});

test('the prompt of a task-scoped run pins the task: card, thread, linked emails with attachments, project card, and the rules', () => {
  const { db, store, knowledge, chat, a, owner, proj, t1 } = setup();
  knowledge.setFact(a, { project: proj.id, key: 'מספר היתר', value: '2026-0451', as_of: '2026-11-20' });
  const e = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text, forwarded_from, participants) VALUES ('m1','x@y','תוכנית יציקות',?, 'נא לשלוח את התוכנית', 'Avi <avi@example.com>', ?)").run('2026-11-20T08:00:00Z', JSON.stringify([{ role: 'from', name: 'Avi', email: 'avi@example.com', msg_index: 0 }])).lastInsertRowid;
  store.linkTaskEmail(a, t1.id, e, 'created');
  db.prepare("INSERT INTO files (original_name, path, source, created_at, email_id, summary) VALUES ('plan.pdf','/x','email',?,?, 'תוכנית יציקות קומה 9')").run(new Date().toISOString(), e);
  chat.sendChat(owner, { text: 'מה המצב?', task_scope: t1.id });
  const runner = createRunner(db);
  const prompt = runner.buildPrompt('chat', [], [], null, null, null, { pinned: t1.id });
  assert.match(prompt, new RegExp(`PINNED TASK #${t1.id}`)); assert.match(prompt, /להעביר תוכנית יציקות/); assert.match(prompt, /מה המצב\?/);
  assert.match(prompt, /plan\.pdf/); assert.match(prompt, /2026-0451/); assert.match(prompt, /avi@example\.com/);
  assert.match(prompt, /THIS task/); assert.match(prompt, /NEVER emails anyone except the owner/); assert.match(prompt, /mesimot note add --task/);
});
