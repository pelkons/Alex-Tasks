'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, alterAdd } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createApply } = require('../lib/apply');

const BG = ['import', 'facts-backfill', 'files-backfill', 'curator', 'audit', 'reconcile', 'names', 'triage'];
function lib() { const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge); return { db, store, chat, a: store.assistantId() }; }
const posts = (db) => db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE author='claude'").get().c;

test('background runs have NO voice in the chat: what the agent sends becomes the run summary; system code and chat/pulse runs still post', () => {
  for (const trigger of BG) {
    const L = lib(); const run = L.chat.startRun(trigger, 1);
    const r = L.chat.sendChat(L.a, { text: `עיבדתי את הקובץ (${trigger})` }, { agent: true });
    assert.equal(r.suppressed, true, trigger); assert.equal(posts(L.db), 0, trigger);
    assert.match(L.db.prepare('SELECT summary_he FROM claude_runs WHERE id=?').get(run).summary_he, /עיבדתי את הקובץ/);
    L.chat.sendChat(L.a, { text: 'התראה דחופה מהמערכת' }); assert.equal(posts(L.db), 1, 'system code (urgent mail, digest, alerts) is not the agent');
  }
  for (const trigger of ['chat', 'pulse', 'batch', 'web']) { const L = lib(); L.chat.startRun(trigger, 1); assert.equal(L.chat.sendChat(L.a, { text: 'תשובה' }, { agent: true }).suppressed, undefined, trigger); assert.equal(posts(L.db), 1); }
});

test('the HTTP route (the agent CLI) and apply are covered; the owner\'s own web session is never suppressed', async () => {
  const db = open(':memory:'); auth.setPassword(db, 'correct horse battery'); auth.resetFailures();
  const app = build({ db, token: 'tok', loginDelayMs: 0 }); const bearer = { authorization: 'Bearer tok' };
  const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); const run = chat.startRun('files-backfill', 1);
  let r = await app.inject({ method: 'POST', url: '/api/chat', headers: bearer, payload: { text: 'עיבדתי את החשבונית' } }); assert.equal(r.json().suppressed, true); assert.equal(db.prepare("SELECT COUNT(*) c FROM chat_messages").get().c, 0);
  const ap = await app.inject({ method: 'POST', url: '/api/apply', headers: bearer, payload: { chat_message: 'עיבדתי את הקובץ', summary: 'ס' } }); assert.equal(ap.statusCode, 200, ap.body); assert.equal(db.prepare("SELECT COUNT(*) c FROM chat_messages").get().c, 0);
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'correct horse battery' } }); const c = login.cookies.find((x) => x.name === 'mesimot_session');
  r = await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie: `mesimot_session=${c.value}`, 'x-mesimot': '1' }, payload: { text: 'הודעה שלי' } }); assert.equal(r.statusCode, 201); assert.equal(db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE author='owner'").get().c, 1);
  assert.ok(run);
});

test('migrations are idempotent and race-safe: a second ALTER ADD COLUMN for the same column is harmless; other errors still raise', () => {
  const db = open(':memory:'); alterAdd(db, 'files', 'zz_test_col', 'TEXT'); alterAdd(db, 'files', 'zz_test_col', 'TEXT');
  assert.ok(db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'zz_test_col'));
  assert.throws(() => alterAdd(db, 'no_such_table', 'x', 'TEXT'), /no such table/); open(':memory:'); // opening again runs every migration again
});

test('eight processes opening the same new database at once (site + runner + timers starting together) all succeed', async () => {
  const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
  const file = path.join(os.tmpdir(), `mesimot-race-${process.pid}.db`);
  const run = () => new Promise((res) => { const p = spawn(process.execPath, ['-e', `const {open}=require('./lib/db');open(${JSON.stringify(file)});process.exit(0)`], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('exit', (code) => res({ code, err })); });
  const out = await Promise.all([...Array(8)].map(run)); assert.deepEqual(out.filter((o) => o.code !== 0).map((o) => o.err.slice(0, 200)), []);
});
