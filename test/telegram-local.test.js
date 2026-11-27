'use strict';
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_NO_BG = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-botapi-'));
process.env.TELEGRAM_LOCAL_DIR = LOCAL_DIR;
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-tgl-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createTelegram } = require('../lib/telegram');

const OWNER = 5550002;
function setup({ apiBase = 'http://127.0.0.1:8081', localUp = true } = {}) {
  const db = open(':memory:');
  const store = createStore(db);
  const knowledge = createKnowledge(db, store);
  const chat = createChat(db, store, knowledge);
  const calls = [];
  const files = {};
  const fetchImpl = async (url, o = {}) => {
    const local = url.startsWith('http://127.0.0.1:8081');
    if (local && !localUp) throw new TypeError('fetch failed');
    const m = /\/bot[^/]+\/(\w+)$/.exec(url);
    if (m) {
      const body = JSON.parse(o.body || '{}');
      calls.push({ method: m[1], body, local });
      let result = true;
      if (m[1] === 'sendMessage') result = { message_id: 1000 + calls.length };
      if (m[1] === 'getFile') { const f = files[body.file_id]; result = { file_path: local ? f.localPath : f.path, file_size: f.size ?? 10 }; }
      return { ok: true, json: async () => ({ ok: true, result }) };
    }
    const f = Object.values(files).find((x) => url.endsWith(x.path));
    return { ok: true, arrayBuffer: async () => f.data };
  };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'TEST', fetchImpl, whisper: { transcribe: async () => ({ text: 'x' }) }, filesDir: process.env.MESIMOT_FILES, apiBase, log: () => {} });
  const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  const bind = async () => { const code = tg.createBindCode(); await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: OWNER }, text: '/start ' + code } }); };
  const doc = (id, name, n) => tg.handleUpdate({ update_id: n, message: { message_id: n, chat: { id: OWNER }, document: { file_id: id, file_name: name, file_size: files[id].size } } });
  return { db, tg, files, calls, sent, bind, doc };
}
const hostFile = (rel, content) => { const f = path.join(LOCAL_DIR, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return '/var/lib/telegram-bot-api/' + rel; };

test('local Bot API: a 1.5 GB document is taken straight from the volume path (no download, no buffer) and archived', async () => {
  const { db, tg, files, bind, doc, calls } = setup();
  await bind();
  assert.equal(tg.maxFile(), 2000 * 1024 * 1024);
  files.big = { localPath: hostFile('TEST/documents/file_7.txt', 'תוכן של קובץ גדול מאוד'), path: 'documents/file_7.txt', size: 1500 * 1024 * 1024, data: Buffer.alloc(1) };
  await doc('big', 'דוח ענק.txt', 50);
  assert.ok(calls.some((c) => c.method === 'getFile' && c.local));
  const f = db.prepare('SELECT * FROM files').get();
  assert.equal(f.source, 'telegram'); assert.equal(f.original_name, 'דוח ענק.txt');
  assert.ok(require('../lib/vault').isEncrypted(f.path), 'stored encrypted'); assert.equal(require('../lib/vault').readFile(f.path).toString('utf8'), 'תוכן של קובץ גדול מאוד');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_id=?').get(f.id).c, 1);
});

test('local Bot API: over 2 GB is refused with the Hebrew message that names the site limit', async () => {
  const { db, files, bind, doc, sent } = setup();
  await bind();
  files.huge = { localPath: '/var/lib/telegram-bot-api/x', path: 'x', size: 2100 * 1024 * 1024, data: Buffer.alloc(1) };
  await doc('huge', 'עצום.mp4', 51);
  assert.match(sent().pop().text, /גדול מ־2 ג״ב.*עד 1 ג״ב/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 0);
});

test('when the local server is down the bot falls back to the public API with the 20 MB limit', async () => {
  const { db, tg, files, bind, doc, sent } = setup({ localUp: false });
  await bind(); // the first call finds the local server down and switches to the public API
  assert.equal(tg.localActive(), false);
  assert.equal(tg.maxFile(), 20 * 1024 * 1024);
  files.mid = { localPath: '', path: 'documents/file_9.txt', size: 100 * 1024 * 1024, data: Buffer.alloc(1) };
  await doc('mid', 'בינוני.txt', 52);
  assert.match(sent().pop().text, /גדול מ־20 מ״ב/);
  files.small = { localPath: '', path: 'documents/file_10.txt', data: Buffer.from('קטן') };
  await doc('small', 'קטן.txt', 53);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 1);
});

test('without apiBase nothing changes: the public API and the 20 MB limit', async () => {
  const { tg } = setup({ apiBase: '' });
  assert.equal(tg.localActive(), false); assert.equal(tg.maxFile(), 20 * 1024 * 1024);
});
