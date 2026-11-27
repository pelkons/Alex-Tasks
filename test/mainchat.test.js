'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-mc-'));
process.env.MESIMOT_SEMANTIC = '0'; process.env.MESIMOT_LOCK = path.join(tmp, 'runner.lock'); process.env.MESIMOT_RUN_LOG = path.join(tmp, 'runs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const a = store.assistantId(), owner = store.ownerId();
  const proj = store.createProject(owner, { name: 'מגדל הדוגמה' });
  const t1 = store.createTask(owner, { title: 'משימה לבדיקה', project: proj.id, due: '2026-12-01', requester: owner });
  db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_chat_id','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  // a chat run answering owner message `mid`, pinned to a task or a ref
  const run = (mid, { task, ref } = {}) => {
    const id = db.prepare("INSERT INTO claude_runs (started_at, trigger, pinned_task_id, pinned_ref) VALUES (?, 'chat', ?, ?)").run(new Date().toISOString(), task || null, ref || null).lastInsertRowid;
    db.prepare('INSERT INTO run_messages (run_id, msg_id) VALUES (?,?)').run(id, mid); return id;
  };
  const end = () => db.prepare('UPDATE claude_runs SET finished_at=? WHERE finished_at IS NULL').run(new Date().toISOString());
  const tg = (id) => db.prepare('SELECT tg_sent FROM chat_messages WHERE id=?').get(id).tg_sent;
  return { db, store, chat, a, owner, proj, t1, run, end, tg };
}

test('main chat listing: only unscoped messages, for every scope kind', () => {
  const { chat, owner, a, proj, t1 } = setup();
  const plain = chat.sendChat(owner, { text: 'שאלה כללית' });
  chat.sendChat(owner, { text: 'על המשימה', task_scope: t1.id });
  chat.sendChat(owner, { text: 'על הפרויקט', entity_scope: `project:${proj.id}` });
  chat.sendChat(owner, { text: 'על יום', entity_scope: 'day:2026-12-01' });
  const all = chat.listChat({ limit: 50 }), main = chat.listChat({ limit: 50, main: '1' });
  assert.equal(all.length, 4); assert.deepEqual(main.map((m) => m.id), [plain.id]);
  assert.equal(chat.listChat({ after: 0, main: '1' }).length, 1);
  assert.ok(all.find((m) => m.scope === 'entity' && m.scope_ref.startsWith('project')).scope_label.includes('מגדל הדוגמה'));
  void a;
});

test('Telegram: an answer to a scoped conversation started on the web is not delivered; one started in Telegram is', () => {
  const { chat, owner, a, t1, proj, run, end, tg } = setup();
  const web = chat.sendChat(owner, { text: 'מה קורה פה?', task_scope: t1.id });
  run(web.id, { task: t1.id });
  const r1 = chat.sendChat(a, { text: 'צריך את האישור שלך? דחוף' }, { agent: true });
  assert.equal(r1.scope, 'task'); assert.equal(tg(r1.id), 1, 'even a question inside a web-started task chat stays out of Telegram'); end();
  const web2 = chat.sendChat(owner, { text: 'ופה?', entity_scope: `project:${proj.id}` });
  run(web2.id, { ref: `project:${proj.id}` });
  const r2 = chat.sendChat(a, { text: 'חשוב: משהו' }, { agent: true });
  assert.equal(r2.scope, 'entity'); assert.equal(tg(r2.id), 1); end();
  // started in Telegram, the assistant pins the reply to a task with --task-scope
  const fromTg = chat.sendChat(owner, { text: 'מה המצב של המשימה?' }, { channel: 'telegram', telegram_message_id: 7 });
  run(fromTg.id);
  const r3 = chat.sendChat(a, { text: 'המשימה פתוחה', task_scope: t1.id }, { agent: true });
  assert.equal(r3.scope, 'task'); assert.equal(tg(r3.id), 0, 'delivered to Telegram'); assert.match(r3.text, /\/task\//); assert.equal(r3.in_main, true);
  assert.ok(chat.listChat({ main: '1', limit: 50 }).some((m) => m.id === r3.id), 'and visible in the main chat'); end();
  // global system message (no run): still delivered
  const sys = chat.sendChat(a, { text: 'דחוף מהמייל' }, { main: true });
  assert.equal(sys.scope, null); assert.equal(tg(sys.id), 0);
});

test('a global system message posted while a scoped run is open does not inherit its scope', () => {
  const { chat, owner, a, t1, run, tg } = setup();
  const m = chat.sendChat(owner, { text: 'x', task_scope: t1.id }); run(m.id, { task: t1.id });
  const sys = chat.sendChat(a, { text: 'בוקר טוב' }, { main: true });
  assert.equal(sys.scope, null); assert.equal(tg(sys.id), 0);
});

test('explicit main post from a scoped run: one short message, scope escape only with the flag', () => {
  const { chat, owner, a, t1, proj, run, tg } = setup();
  const m = chat.sendChat(owner, { text: 'x', entity_scope: `project:${proj.id}` }); run(m.id, { ref: `project:${proj.id}` });
  assert.equal(chat.sendChat(a, { text: 'ברירת מחדל', entity_scope: '0' }, { agent: true }).scope, 'entity', 'entity_scope 0 does not escape');
  const x = chat.sendChat(a, { text: 'סיכון חדש בפרויקט', main: true }, { agent: true });
  assert.equal(x.scope, null); assert.equal(tg(x.id), 0, 'goes to the main chat and Telegram');
  assert.throws(() => chat.sendChat(a, { text: 'עוד אחת', main: true }, { agent: true }), /אחת בלבד/);
  assert.equal(chat.sendChat(a, { text: 'המשך' }, { agent: true }).scope, 'entity', 'the thread reply is not merged into the main post');
  void t1;
});

test('explicit main post is limited to 600 characters in a scoped run', () => {
  const { chat, owner, a, t1, run } = setup();
  const m = chat.sendChat(owner, { text: 'x', task_scope: t1.id }); run(m.id, { task: t1.id });
  assert.throws(() => chat.sendChat(a, { text: 'א'.repeat(601), main: true }, { agent: true }), /קצרה/);
});

test('badge counts: only main-chat assistant messages are unread (UI rule mirrors listChat main=1)', () => {
  const { chat, owner, a, t1, run } = setup();
  const m = chat.sendChat(owner, { text: 'x', task_scope: t1.id }); run(m.id, { task: t1.id });
  chat.sendChat(a, { text: 'תשובה ממוקדת' }, { agent: true });
  chat.sendChat(a, { text: 'הודעה כללית' }, { main: true });
  const unread = (list) => list.filter((x) => x.author === 'claude' && (!x.scope || x.in_main)).length;
  assert.equal(unread(chat.listChat({ limit: 50 })), 1); assert.equal(chat.listChat({ limit: 50, main: '1' }).filter((x) => x.author === 'claude').length, 1);
});
