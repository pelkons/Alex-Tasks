'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { readable } = require('../lib/textclean');

function lib() { const db = open(':memory:'); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); return { db, store, chat, a: store.assistantId(), owner: store.ownerId() }; }
const run = (L, nMsgs) => { const id = L.chat.startRun('chat', nMsgs); for (let i = 0; i < nMsgs; i++) { const m = L.chat.sendChat(L.owner, { text: 'שאלה ' + i }); L.db.prepare('INSERT INTO run_messages (run_id, msg_id) VALUES (?,?)').run(id, m.id); } return id; };

test('a run posts ONE reply per owner message: a second message inside the same run (a gate re-prompt, a retry) edits the first; Telegram follows with an edit', () => {
  const L = lib(); const id = run(L, 1); L.db.prepare("UPDATE claude_runs SET trigger='chat' WHERE id=?").run(id);
  const first = L.chat.sendChat(L.a, { text: 'הכנתי טיוטה' }, { agent: true }); L.db.prepare('UPDATE chat_messages SET tg_sent=1, telegram_message_id=555 WHERE id=?').run(first.id);
  const second = L.chat.sendChat(L.a, { text: 'תיקון לתשובה הקודמת: ...' }, { agent: true }); const third = L.chat.sendChat(L.a, { text: 'הנוסח הסופי' }, { agent: true });
  assert.equal(second.id, first.id); assert.equal(third.id, first.id); assert.equal(L.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE author='claude'").get().c, 1);
  const row = L.db.prepare('SELECT text, tg_edit FROM chat_messages WHERE id=?').get(first.id); assert.equal(row.text, 'הנוסח הסופי'); assert.equal(row.tg_edit, 1);
});

test('a run that answers several owner messages, and system code, still post separate messages', () => {
  const L = lib(); const id = run(L, 2); L.chat.sendChat(L.a, { text: 'תשובה לראשונה' }, { agent: true }); L.chat.sendChat(L.a, { text: 'תשובה לשנייה' }, { agent: true });
  assert.equal(L.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE author='claude'").get().c, 2); assert.ok(id);
  const L2 = lib(); run(L2, 1); L2.chat.sendChat(L2.a, { text: 'א' }, { agent: true }); L2.chat.sendChat(L2.a, { text: 'התראת מערכת' }); assert.equal(L2.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE author='claude'").get().c, 2, 'system code is not the agent');
});

test('the readable email preview: whitespace collapsed, blank-line runs squeezed, a short signature dropped, the text kept', () => {
  const body = 'שלום רב,\nמצורף העדכון לגבי התכנון, נא לאשר עד סוף השבוע.\nבברכה,\n\n\n\n\nאמיר\n\n\n\n\n\nדוגמה\n\n\n\nסמנכ"ל הנדסה';
  const r = readable(body); assert.ok(!/\n\s*\n\s*\n/.test(r), 'no big gaps'); assert.match(r, /מצורף העדכון/); assert.ok(!/סמנכ"ל הנדסה/.test(r), 'the signature block is gone');
  assert.equal(readable('שורה ראשונה\n\n\n\nשורה שנייה'), 'שורה ראשונה\n\nשורה שנייה'); assert.equal(readable('  a   b  '), 'a b');
});
