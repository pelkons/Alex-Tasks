'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createTelegram } = require('../lib/telegram');

const OWNER_CHAT = 5550001;

function setup() {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-tg-'));
  process.env.MESIMOT_FILES = filesDir;
  const db = open(':memory:');
  const store = createStore(db);
  const knowledge = createKnowledge(db, store);
  const chat = createChat(db, store, knowledge);
  const calls = [];
  const files = {};
  const fetchImpl = async (url, o = {}) => {
    const m = /\/bot[^/]+\/(\w+)$/.exec(url);
    if (m) {
      const body = JSON.parse(o.body || '{}');
      calls.push({ method: m[1], body });
      let result = true;
      if (m[1] === 'sendMessage') result = { message_id: 1000 + calls.length };
      if (m[1] === 'getMe') result = { username: 'mesimot_test_bot' };
      if (m[1] === 'getFile') { const f = files[body.file_id]; result = { file_path: f.path, file_size: f.size ?? f.data.length }; }
      return { ok: true, json: async () => ({ ok: true, result }) };
    }
    const fm = /\/file\/bot[^/]+\/(.+)$/.exec(url);
    const f = Object.values(files).find((x) => x.path === fm[1]);
    return { ok: true, arrayBuffer: async () => f.data };
  };
  const whisper = { transcribe: async () => ({ text: 'תזכיר לי לבדוק עם רון את לוח הזמנים', language: 'he' }) };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'TEST', fetchImpl, whisper, filesDir }); tg._fetch = fetchImpl;
  const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  const bind = async () => {
    const code = tg.createBindCode();
    await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: OWNER_CHAT }, text: '/start ' + code } });
  };
  const text = (t, id = 10, chat_id = OWNER_CHAT) => tg.handleUpdate({ update_id: id, message: { message_id: id, chat: { id: chat_id }, text: t } });
  return { db, store, chat, tg, calls, files, sent, bind, text };
}

test('binding needs the one-time code; strangers get no answer', async () => {
  const { db, tg, sent, text } = setup();
  await text('/start wrongcode', 2, 777);
  await text('שלום', 3, 777);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM settings WHERE key='telegram_chat_id'").get().c, 0);
  assert.equal(sent().length, 0);
  const code = tg.createBindCode();
  await text('/start ' + code, 4, OWNER_CHAT);
  assert.equal(tg.ownerChat(), String(OWNER_CHAT));
  assert.match(sent()[0].text, /החיבור הושלם/);
  // a stranger after binding is ignored completely
  await text('היי', 5, 999);
  await text('/today', 6, 999);
  assert.equal(sent().length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chat_messages').get().c, 0);
});

test('owner text becomes a shared chat message (telegram channel) and triggers an immediate run event', async () => {
  const { db, bind, text } = setup();
  await bind();
  await text('תוסיף משימה לבדוק חוזה', 11);
  const m = db.prepare('SELECT * FROM chat_messages').get();
  assert.equal(m.author, 'owner'); assert.equal(m.channel, 'telegram'); assert.equal(m.telegram_message_id, 11);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE entity='chat' AND processed_at IS NULL").get());
});

test('commands are answered by code, without the assistant', async () => {
  const { db, store, bind, text, sent } = setup();
  await bind();
  store.createTask(store.assistantId(), { title: 'משימה דחופה', priority: 'דחוף', requester: 'יעל רוזן', due: '2020-01-01', due_source: 'explicit' });
  store.createTask(store.assistantId(), { title: 'משימה רגילה' });
  await text('/today', 12); await text('/urgent', 13); await text('/open', 14);
  const [, today, urgent, open_] = sent().map((s) => s.text);
  assert.match(today, /משימה דחופה/); assert.match(today, /מאת יעל רוזן/); assert.match(today, /01\/01\/2020/);
  assert.match(urgent, /משימה דחופה/); assert.ok(!/משימה רגילה/.test(urgent));
  assert.match(open_, /משימות פתוחות: 2/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chat_messages').get().c, 0);
});

test('assistant messages are delivered with quick buttons; the buttons act like web edits by the owner', async () => {
  const { db, store, chat, tg, bind, calls, sent } = setup();
  const before = chat.sendChat(store.assistantId(), { text: 'הודעה ישנה' });
  await bind();
  assert.equal(await tg.deliverPending(), 0, 'old history is not replayed');
  const t = store.createTask(store.assistantId(), { title: 'לבדוק חוזה', due: '2026-12-01' });
  chat.sendChat(store.assistantId(), { text: 'פתחתי משימה', task: String(t.id) });
  assert.equal(await tg.deliverPending(), 1);
  const msg = sent().pop();
  const rows = msg.reply_markup.inline_keyboard; const kb = [...rows[0], ...rows[1]];
  assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [['✔ הושלם', '⏰ למחר'], ['🔗 באתר', '👍'], ['👎']], 'at most two short buttons per row, primary action first');
  assert.equal(kb[1].callback_data, `snooze:${t.id}`);
  assert.match(kb[2].url, new RegExp(`/task/${t.id}$`));
  assert.equal(await tg.deliverPending(), 0, 'delivered once');
  // snooze
  await tg.handleUpdate({ update_id: 20, callback_query: { id: 'cb1', data: `snooze:${t.id}`, message: { chat: { id: OWNER_CHAT }, message_id: 55 } } });
  const afterSnooze = store.getTask(t.id);
  assert.notEqual(afterSnooze.due_date, '2026-12-01');
  assert.equal(afterSnooze.due_source, 'manual');
  assert.ok(db.prepare("SELECT 1 FROM events e JOIN people p ON p.id=e.actor_id WHERE e.entity='task' AND e.field='due_date' AND p.role='owner' AND e.processed_at IS NULL").get());
  // done
  await tg.handleUpdate({ update_id: 21, callback_query: { id: 'cb2', data: `done:${t.id}`, message: { chat: { id: OWNER_CHAT }, message_id: 55 } } });
  assert.equal(store.getTask(t.id).status, 'הושלם');
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === `✔ סגרתי: ${t.title}`));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.body.text === `✔ סגרתי: ${t.title}`), 'a short confirmation message');
  // a callback from another chat does nothing
  const t2 = store.createTask(store.assistantId(), { title: 'אחרת' });
  await tg.handleUpdate({ update_id: 22, callback_query: { id: 'cb3', data: `done:${t2.id}`, message: { chat: { id: 1 }, message_id: 1 } } });
  assert.equal(store.getTask(t2.id).status, 'חדש');
  void before;
});

test('voice note: transcribed, no "what I heard" message, language kept internally, handled as the owner\'s message', async () => {
  const { db, bind, files, tg, sent, calls } = setup();
  await bind();
  const before = sent().length;
  files.v1 = { path: 'voice/file_1.oga', data: Buffer.from('OggS fake') };
  await tg.handleUpdate({ update_id: 30, message: { message_id: 30, chat: { id: OWNER_CHAT }, voice: { file_id: 'v1', duration: 4 } } });
  assert.equal(sent().length, before, 'nothing is sent back about what was heard');
  const m = db.prepare('SELECT * FROM chat_messages').get();
  assert.equal(m.text, 'תזכיר לי לבדוק עם רון את לוח הזמנים');
  assert.equal(m.transcript, m.text);
  assert.equal(m.lang, 'he');
  assert.ok(m.voice_file && fs.existsSync(m.voice_file));
  assert.equal(m.channel, 'telegram');
  void calls;
});

test('a Russian voice note is stored with its Russian transcript and language; the owner is told nothing about the language', async () => {
  const { db, bind, files, tg, sent, store } = setup();
  await bind();
  const { createTelegram: make } = require('../lib/telegram');
  const fetchImpl = tg._fetch; void fetchImpl;
  const tg2 = make({ db, store, knowledge: require('../lib/knowledge').createKnowledge(db, store), chat: require('../lib/chat').createChat(db, store, require('../lib/knowledge').createKnowledge(db, store)), token: 'TEST', filesDir: process.env.MESIMOT_FILES,
    whisper: { transcribe: async () => ({ text: 'Напомни мне завтра позвонить Гаю насчёт графика по Алтерман', language: 'ru' }) },
    fetchImpl: async (url, o = {}) => {
      const mm = /\/bot[^/]+\/(\w+)$/.exec(url);
      if (mm) { const body = JSON.parse(o.body || '{}'); let result = true; if (mm[1] === 'getFile') result = { file_path: 'voice/ru.oga', file_size: 9 }; if (mm[1] === 'sendMessage') result = { message_id: 1 }; return { ok: true, json: async () => ({ ok: true, result }) }; }
      return { ok: true, arrayBuffer: async () => Buffer.from('OggS') };
    } });
  const n = sent().length;
  await tg2.handleUpdate({ update_id: 31, message: { message_id: 31, chat: { id: OWNER_CHAT }, voice: { file_id: 'rv', duration: 5 } } });
  const m = db.prepare('SELECT * FROM chat_messages ORDER BY id DESC LIMIT 1').get();
  assert.equal(m.lang, 'ru'); assert.match(m.text, /Алтерман/); assert.equal(m.channel, 'telegram');
  assert.equal(sent().length, n);
});

test('files: documents and photos are stored and attached to the chat; files over 20 MB are refused in Hebrew', async () => {
  const { db, bind, files, tg, sent } = setup();
  await bind();
  files.d1 = { path: 'documents/file_2.txt', data: Buffer.from('הקבלן אור הדוגמה איחר באספקה') };
  await tg.handleUpdate({ update_id: 40, message: { message_id: 40, chat: { id: OWNER_CHAT }, caption: 'מידע על הפרויקט', document: { file_id: 'd1', file_name: 'הערות.txt', mime_type: 'text/plain' } } });
  const m = db.prepare('SELECT * FROM chat_messages').get();
  assert.equal(m.text, 'מידע על הפרויקט');
  const f = db.prepare('SELECT * FROM files').get();
  assert.equal(f.source, 'telegram'); assert.equal(f.original_name, 'הערות.txt');
  assert.deepEqual(JSON.parse(m.file_ids), [f.id]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_id=?').get(f.id).c, 1);
  files.p1 = { path: 'photos/file_3.jpg', data: Buffer.from('jpegfake') };
  await tg.handleUpdate({ update_id: 41, message: { message_id: 41, chat: { id: OWNER_CHAT }, photo: [{ file_id: 'p0' }, { file_id: 'p1' }] } });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 2);
  files.big = { path: 'documents/big.pdf', data: Buffer.alloc(10), size: 25 * 1024 * 1024 };
  await tg.handleUpdate({ update_id: 42, message: { message_id: 42, chat: { id: OWNER_CHAT }, document: { file_id: 'big', file_name: 'big.pdf' } } });
  assert.match(sent().pop().text, /גדול מ־20 מ״ב/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 2);
});

test('quiet hours hold back what the assistant writes on its own, not answers to a message just sent', async () => {
  const { db, store, chat, bind, calls } = setup();
  await bind();
  const notify = { settings: () => ({ notify_telegram: true }), isQuiet: () => true };
  const { createTelegram: make } = require('../lib/telegram');
  const tg2 = make({ db, store, knowledge: require('../lib/knowledge').createKnowledge(db, store), chat, token: 'TEST', notify, filesDir: process.env.MESIMOT_FILES,
    fetchImpl: async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); calls.push({ method: m[1], body: JSON.parse(o.body || '{}') }); return { ok: true, json: async () => ({ ok: true, result: { message_id: calls.length } }) }; } });
  chat.sendChat(store.assistantId(), { text: 'הצעה יזומה באמצע הלילה' });
  assert.equal(await tg2.deliverPending(), 0, 'proactive message waits for the morning');
  chat.sendChat(store.ownerId(), { text: 'שאלה מהאתר' }, { channel: 'telegram' });
  chat.sendChat(store.assistantId(), { text: 'תשובה לשאלה' });
  assert.equal(await tg2.deliverPending(), 1, 'the answer goes out');
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.body.text === 'תשובה לשאלה'));
  assert.ok(!calls.some((c) => c.body && c.body.text === 'הצעה יזומה באמצע הלילה'));
});

test('a reply written inside a still-working run waits for the run to end: the owner gets ONE final answer, never one that changes', async () => {
  const { db, store, chat, tg, bind } = setup();
  await bind();
  const runId = db.prepare("INSERT INTO claude_runs (trigger, started_at) VALUES ('chat', ?)").run(new Date().toISOString()).lastInsertRowid;
  const m = chat.sendChat(store.assistantId(), { text: 'טיוטה ראשונה' });
  db.prepare('UPDATE chat_messages SET run_id=? WHERE id=?').run(runId, m.id);
  assert.equal(await tg.deliverPending(), 0, 'held while the run works');
  db.prepare("UPDATE chat_messages SET text='התשובה הסופית' WHERE id=?").run(m.id);
  db.prepare('UPDATE claude_runs SET finished_at=? WHERE id=?').run(new Date().toISOString(), runId);
  assert.equal(await tg.deliverPending(), 1, 'sent once the run ended');
  assert.equal(db.prepare('SELECT text FROM chat_messages WHERE id=?').get(m.id).text, 'התשובה הסופית');
  // a run stuck for over 15 minutes does not hold its messages forever
  const old = db.prepare("INSERT INTO claude_runs (trigger, started_at) VALUES ('chat', ?)").run(new Date(Date.now() - 20 * 60000).toISOString()).lastInsertRowid;
  const m2 = chat.sendChat(store.assistantId(), { text: 'תקוע' }); db.prepare('UPDATE chat_messages SET run_id=? WHERE id=?').run(old, m2.id);
  assert.equal(await tg.deliverPending(), 1);
});
