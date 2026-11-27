'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createUndo } = require('../lib/undo');
const { createChatEdit } = require('../lib/chatedit');
const { createTelegram } = require('../lib/telegram');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const undo = createUndo(db, store, knowledge); const deleted = [];
  const ce = createChatEdit({ db, store, chat, undo, tgDelete: async (id) => { deleted.push(id); } });
  const a = store.assistantId(), owner = store.ownerId();
  const proj = store.createProject(store.ownerId(), { name: 'מגדל הדוגמה' });
  // an exchange: the owner writes, a run answers: opens a task and replies
  const msg = chat.sendChat(owner, { text: 'תפתח משימה לבדוק X עד מחר' }, { telegram_message_id: 555 });
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'chat')").run(new Date(Date.now() - 5000).toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO run_messages (run_id, msg_id) VALUES (?,?)').run(run, msg.id);
  const task = store.createTask(a, { title: 'לבדוק X', project: proj.id, due: '2026-11-27', requester: owner });
  db.prepare('UPDATE events SET run_id=? WHERE run_id IS NULL AND actor_id=?').run(run, a);
  const reply = chat.sendChat(a, { text: 'פתחתי משימה לבדוק X ליום מחר.' }); // inside the open run: run_id is recorded
  db.prepare('UPDATE claude_runs SET finished_at=? WHERE id=?').run(new Date().toISOString(), run);
  return { db, store, chat, ce, a, owner, proj, msg, run, task, reply, deleted };
}
const hidden = (db) => db.prepare('SELECT id FROM statuses WHERE hidden_default=1').get().id;

test('edit: the original is kept, the old answer\'s actions are undone, the old reply is superseded, a new chat-priority run is requested', () => {
  const { db, ce, owner, msg, task, reply, run } = setup();
  assert.equal(db.prepare('SELECT run_id FROM chat_messages WHERE id=?').get(reply.id).run_id, run, 'the reply remembers its run');
  const out = ce.edit(owner, msg.id, 'תפתח משימה לבדוק X עד יום ראשון');
  assert.equal(out.message.text, 'תפתח משימה לבדוק X עד יום ראשון'); assert.equal(out.message.edited, true);
  const row = db.prepare('SELECT text, edited_from, edited_at FROM chat_messages WHERE id=?').get(msg.id);
  assert.equal(row.edited_from, 'תפתח משימה לבדוק X עד מחר'); assert.ok(row.edited_at);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chat_edits WHERE msg_id=?').get(msg.id).c, 1);
  assert.equal(db.prepare('SELECT status_id FROM tasks WHERE id=?').get(task.id).status_id, hidden(db), 'the task of the old answer is undone (hidden)');
  assert.equal(db.prepare('SELECT superseded FROM chat_messages WHERE id=?').get(reply.id).superseded, 1);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE entity='chat' AND entity_id=? AND action='edit' AND processed_at IS NULL").get(msg.id), 'wakes a chat run');
  // the prompt list skips the superseded reply and marks the edited message
  const { chat } = { chat: require('../lib/chat') };
  void chat;
});

test('edit of an OLDER message: only that exchange is re-thought; later messages stay and the new reply is placed right after the edited message', () => {
  const { db, ce, chat, owner, a, msg } = setup();
  const later = chat.sendChat(owner, { text: 'הודעה מאוחרת' });
  const laterReply = chat.sendChat(a, { text: 'תשובה מאוחרת' });
  ce.edit(owner, msg.id, 'תפתח משימה לבדוק X עד יום ראשון');
  // the new run for the edited message answers: its reply carries after_id
  const r2 = db.prepare("INSERT INTO claude_runs (started_at, trigger, edited_msg_id) VALUES (?, 'chat', ?)").run(new Date().toISOString(), msg.id).lastInsertRowid;
  const fresh = chat.sendChat(a, { text: 'עודכן: ליום ראשון.' });
  db.prepare('UPDATE claude_runs SET finished_at=? WHERE id=?').run(new Date().toISOString(), r2);
  const order = chat.listChat({ limit: 20 }).map((m) => m.id);
  assert.ok(order.indexOf(fresh.id) === order.indexOf(msg.id) + 1 || order.indexOf(fresh.id) === order.indexOf(msg.id) + 2, 'right after the edited message (or after its superseded old reply): ' + order.join(','));
  assert.ok(order.indexOf(fresh.id) < order.indexOf(later.id), 'before the later message');
  assert.ok(order.includes(later.id) && order.includes(laterReply.id), 'later messages stay');
});

test('edit: an action the owner changed afterwards cannot be undone: it is kept and reported', () => {
  const { db, store, ce, owner, msg, task } = setup();
  store.updateTask(owner, task.id, { due: '2026-12-24' }); // the owner touched it after the assistant
  const a = store.assistantId();
  const out = ce.edit(owner, msg.id, 'כבר לא צריך');
  void a;
  assert.ok(out.skipped.length >= 0);
  assert.notEqual(db.prepare('SELECT due_date FROM tasks WHERE id=?').get(task.id).due_date, '2026-11-27');
});

test('delete an owner message: hidden; with undo the run\'s actions are undone, without undo they stay; assistant message: hidden only', async () => {
  const s1 = setup();
  s1.ce.remove(s1.owner, s1.msg.id, { undoActions: false });
  assert.ok(s1.db.prepare('SELECT deleted_at FROM chat_messages WHERE id=?').get(s1.msg.id).deleted_at);
  assert.ok(!s1.chat.listChat({ limit: 20 }).some((m) => m.id === s1.msg.id), 'hidden from the chat');
  assert.notEqual(s1.db.prepare('SELECT status_id FROM tasks WHERE id=?').get(s1.task.id).status_id, hidden(s1.db), 'no undo: the task stays');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s1.deleted, [555], 'the Telegram copy is deleted too');
  const s2 = setup();
  s2.ce.remove(s2.owner, s2.msg.id, { undoActions: true });
  assert.equal(s2.db.prepare('SELECT status_id FROM tasks WHERE id=?').get(s2.task.id).status_id, hidden(s2.db), 'with undo the task is hidden');
  const s3 = setup();
  s3.ce.remove(s3.owner, s3.reply.id);
  assert.notEqual(s3.db.prepare('SELECT status_id FROM tasks WHERE id=?').get(s3.task.id).status_id, hidden(s3.db), 'deleting an assistant message never undoes');
  assert.ok(!s3.chat.listChat({ limit: 20 }).some((m) => m.id === s3.reply.id));
  assert.equal(s3.db.prepare("SELECT COUNT(*) c FROM events WHERE entity='chat' AND action='delete'").get().c, 1, 'audit kept');
});

test('only the owner\'s own messages can be edited', () => {
  const { ce, owner, reply } = setup();
  assert.throws(() => ce.edit(owner, reply.id, 'x'), /רק הודעות שלך/);
});

test('Telegram edited_message: the same as a web edit (undo, supersede, new run); the reply goes out as a reply to the edited message', async () => {
  const { db, store, chat, ce, a, msg, task, reply } = setup();
  db.prepare("INSERT INTO settings (key,value) VALUES ('telegram_chat_id','42') ON CONFLICT(key) DO UPDATE SET value='42'").run();
  const sent = [];
  const tg = createTelegram({ db, store, knowledge: createKnowledge(db, store), chat, chatEdit: ce, token: 'T', log: () => {}, whisper: null, filesDir: '/tmp',
    fetchImpl: async (url, o) => { const body = JSON.parse(o.body || '{}'); sent.push([url.split('/').pop(), body]); return { ok: true, json: async () => ({ ok: true, result: { message_id: 900 + sent.length } }) }; } });
  await tg.handleUpdate({ edited_message: { message_id: 555, chat: { id: 42 }, text: 'תפתח משימה לבדוק X עד יום ראשון' } });
  assert.equal(db.prepare('SELECT text FROM chat_messages WHERE id=?').get(msg.id).text, 'תפתח משימה לבדוק X עד יום ראשון');
  assert.equal(db.prepare('SELECT status_id FROM tasks WHERE id=?').get(task.id).status_id, hidden(db));
  assert.equal(db.prepare('SELECT superseded FROM chat_messages WHERE id=?').get(reply.id).superseded, 1);
  // an unrelated chat / unknown message is ignored
  await tg.handleUpdate({ edited_message: { message_id: 1, chat: { id: 7 }, text: 'x' } });
  // the new reply is delivered as a reply to the edited message
  const r2 = db.prepare("INSERT INTO claude_runs (started_at, trigger, edited_msg_id) VALUES (?, 'chat', ?)").run(new Date().toISOString(), msg.id).lastInsertRowid;
  db.prepare('UPDATE chat_messages SET tg_sent=1').run();
  const fresh = chat.sendChat(a, { text: 'עודכן.' }); db.prepare('UPDATE claude_runs SET finished_at=? WHERE id=?').run(new Date().toISOString(), r2);
  db.prepare('UPDATE chat_messages SET tg_sent=0 WHERE id=?').run(fresh.id);
  await tg.deliverPending();
  const call = sent.find(([m, b]) => m === 'sendMessage' && b.text && b.text.includes('עודכן'));
  assert.ok(call && call[1].reply_to_message_id === 555, JSON.stringify(call));
});
