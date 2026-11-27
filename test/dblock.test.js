'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs'); const { spawn } = require('child_process');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-lock-'));
process.env.MESIMOT_FILES = path.join(TMP, 'files');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createTelegram } = require('../lib/telegram');

// another process holds the write lock for ~1.8 s
function holdLock(file, ms) {
  const code = `const d=require('./lib/dbkey').openRaw(process.argv[1]);d.pragma('journal_mode=WAL');d.exec('BEGIN IMMEDIATE');d.prepare("INSERT INTO settings (key,value) VALUES ('x','1') ON CONFLICT(key) DO UPDATE SET value='2'").run();console.log('locked');setTimeout(()=>{d.exec('COMMIT');process.exit(0)},${ms});`;
  const p = spawn(process.execPath, ['-e', code, file], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res) => p.stdout.once('data', () => res(p)));
}

test('connection settings: WAL, 15 s busy timeout, synchronous NORMAL', () => {
  const db = open(path.join(TMP, 'a.db'));
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal'); assert.equal(db.pragma('busy_timeout', { simple: true }), 15000); assert.equal(db.pragma('synchronous', { simple: true }), 1);
});

test('a write that hits a lock is retried with backoff until it succeeds (chat reply, heartbeat, transaction), and every BUSY is counted', async () => {
  const file = path.join(TMP, 'b.db'); const db = open(file); db.pragma('busy_timeout = 100'); // short, so the app-level retry is what carries it
  const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store));
  const p = await holdLock(file, 1800);
  const t0 = Date.now(); const m = chat.sendChat(store.assistantId(), { text: 'התשובה לא אובדת' }); // goes through the retry wrapper
  assert.ok(Date.now() - t0 >= 1000, 'it waited for the lock'); assert.ok(m.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE text='התשובה לא אובדת'").get().c, 1);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM db_lock_events').get().c >= 1, 'the BUSY events are recorded');
  await new Promise((r) => p.on('exit', r));
  const p2 = await holdLock(file, 1200); require('../lib/heartbeat').beat(db, 'x_beat'); db.transaction(() => db.prepare("INSERT INTO settings (key,value) VALUES ('after','1')").run())();
  assert.ok(db.prepare("SELECT 1 FROM heartbeat WHERE key='x_beat'").get()); assert.ok(db.prepare("SELECT 1 FROM settings WHERE key='after'").get()); await new Promise((r) => p2.on('exit', r));
});

test('a lock that never clears still raises (the caller must not pretend it worked)', async () => {
  const file = path.join(TMP, 'c.db'); const db = open(file); db.pragma('busy_timeout = 50');
  const p = await holdLock(file, 9000);
  assert.throws(() => db.prepare("INSERT INTO settings (key,value) VALUES ('z','1')").run(), /locked|busy/i); p.kill();
});

test('Telegram: a database lock while delivering leaves the message queued (tg_sent stays 0); another error marks it failed', async () => {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge); let mode = 'lock';
  const fetchImpl = async (url) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); if (m[1] === 'sendMessage') { if (mode === 'lock') throw new Error('database is locked'); if (mode === 'bad') throw new Error('chat not found'); } return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 7 } : m[1] === 'getMe' ? { username: 'b' } : true }) }; };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'T', fetchImpl, filesDir: TMP }); await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 9 }, text: '/start ' + tg.createBindCode() } });
  const m = chat.sendChat(store.assistantId(), { text: 'שלום' });
  await tg.deliverPending(); assert.equal(db.prepare('SELECT tg_sent FROM chat_messages WHERE id=?').get(m.id).tg_sent, 0);
  mode = 'ok'; await tg.deliverPending(); assert.equal(db.prepare('SELECT tg_sent FROM chat_messages WHERE id=?').get(m.id).tg_sent, 1);
  const m2 = chat.sendChat(store.assistantId(), { text: 'עוד אחת' }); mode = 'bad'; await tg.deliverPending(); assert.equal(db.prepare('SELECT tg_sent FROM chat_messages WHERE id=?').get(m2.id).tg_sent, 2);
});

test('sending files to the owner: chat send with a file id (web chip data), Telegram sendDocument, a big file becomes a link', async () => {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const calls = []; const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); calls.push({ method: m[1], body: o.body instanceof FormData ? Object.fromEntries([...o.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${v.name}:${v.size}`])) : JSON.parse(o.body || '{}') }); return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 5 } : m[1] === 'getMe' ? { username: 'b' } : { message_id: 6 } }) }; };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'T', fetchImpl, filesDir: TMP }); await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 9 }, text: '/start ' + tg.createBindCode() } });
  const up = await knowledge.saveUpload(store.ownerId(), { name: 'נספח תנועה ארבר.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake'), source: 'web' });
  const m = chat.sendChat(store.assistantId(), { text: 'הנה נספח התנועה (גרסה מ-12/11)', file: String(up.id) });
  assert.deepEqual(m.files.map((f) => f.name), ['נספח תנועה ארבר.pdf'], 'the web chat gets the file chip data');
  const viaApply = chat.sendChat(store.assistantId(), { text: 'שוב', file_ids: [up.id] }); assert.equal(viaApply.files.length, 1);
  await tg.deliverPending(); const docs = calls.filter((c) => c.method === 'sendDocument'); assert.equal(docs.length, 2); assert.equal(docs[0].body.caption, 'נספח תנועה ארבר.pdf'); assert.match(docs[0].body.document, /^file:נספח תנועה ארבר\.pdf:\d+/);
  const big = knowledge.getFile(up.id); fs.writeFileSync(big.path, Buffer.alloc(51 * 1024 * 1024)); calls.length = 0; chat.sendChat(store.assistantId(), { text: 'גדול', file: String(up.id) });
  await tg.deliverPending(); assert.equal(calls.filter((c) => c.method === 'sendDocument').length, 0); assert.ok(calls.some((c) => c.method === 'sendMessage' && /גדול מדי לטלגרם.*\/api\/files\/\d+\/download/.test(c.body.text)));
});
