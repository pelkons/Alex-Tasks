'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-reply-'));
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ owner: { name_he: 'דנה', name_en: 'Dana', emails: ['dana@x.example'], work_email: 'dana@x.example' } }));
process.env.MESIMOT_CONFIG = path.join(TMP, 'config.json'); process.env.MESIMOT_FILES = path.join(TMP, 'files'); process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(TMP, 'k');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createProposals } = require('../lib/proposals');
const { createOutbox } = require('../lib/outbox');
const { createReply, matchOption, optionsOf } = require('../lib/replyto');
const { createTelegram } = require('../lib/telegram');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge); const proposals = createProposals({ db, store, chat });
  const outbox = createOutbox({ db, store }); store.hooks.outboxView = outbox.cardView; store.hooks.outbox = outbox; outbox.setSettings({ enabled: true });
  const reply = createReply({ db, store, chat, proposals, outbox }); store.hooks.reply = reply;
  const calls = []; const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); calls.push({ method: m[1], body: JSON.parse(o.body || '{}') }); return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 500 + calls.length } : m[1] === 'getMe' ? { username: 'b' } : true }) }; };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'T', fetchImpl, proposals, outbox, filesDir: TMP });
  const a = store.assistantId(), owner = store.ownerId();
  const say = (text, replyTo) => tg.handleUpdate({ update_id: Math.floor(Math.random() * 1e6) + 10, message: { message_id: Math.floor(Math.random() * 1e6) + 1000, chat: { id: 7 }, text, ...(replyTo ? { reply_to_message: replyTo } : {}) } });
  const pending = (id) => db.prepare("SELECT COUNT(*) c FROM events WHERE entity='chat' AND entity_id=? AND processed_at IS NULL").get(id).c;
  const lastOwner = () => db.prepare("SELECT * FROM chat_messages WHERE author='owner' ORDER BY id DESC").get();
  const email = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, mail_date, body_text) VALUES ('e1','Ron <ron@v.example>','הצעת מחיר',?,?,'שלום, מצורפת הצעה. נשמח לאישור עד חמישי.')").run('2026-11-24T08:00:00Z', '2026-11-24T08:00:00Z').lastInsertRowid;
  return { db, store, chat, proposals, outbox, reply, tg, calls, say, pending, lastOwner, a, owner, email, bind: async () => tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7 }, text: '/start ' + tg.createBindCode() } }) };
}
const bench = (S, o = {}) => S.proposals.createBatch('bench', 'ש', [{ kind: 'bench_question', target_id: S.email, text: 'x', payload: JSON.stringify({ email_id: S.email, field: 'needs_task', ask: 'האם נדרשת משימה?', left: 'המערכת: אין משימה', right: 'המודל: כן', approve_label: 'כן, צריך משימה', reject_label: 'לא, רק מידע (אין משימה)', ...o }) }]);

test('free text matches the card options in code (and not ambiguous words)', () => {
  const o = optionsOf({ approve_label: 'כן, צריך משימה', reject_label: 'לא, רק מידע (אין משימה)' });
  for (const [t, id] of [['כן צריך משימה', 'approve'], ['כן', 'approve'], ['לא, רק מידע', 'reject'], ['לא', 'reject'], ['אין משימה', 'reject'], ['לא צריך משימה', 'reject']]) assert.equal(matchOption(t, o)?.id, id, t);
  for (const t of ['אולי', 'שלום', 'משימה']) assert.equal(matchOption(t, o), null, t);
  const p = optionsOf({ approve_label: 'הפרויקט: נווה הדוגמה מגרש 7', reject_label: 'הפרויקט: עיר הדוגמה' }); assert.equal(matchOption('הפרויקט הוא נווה', p).id, 'approve'); assert.equal(matchOption('עיר הדוגמה', p).id, 'reject');
});

test('Telegram: reply_to_message is mapped to our message, a question card, or kept as a quote; stored on the owner message', async () => {
  const S = setup(); await S.bind();
  const m = S.chat.sendChat(S.a, { text: 'הנה סיכום המשימה', task: String(S.store.createTask(S.a, { title: 'משימה א', requester: S.owner }).id) }); S.db.prepare('UPDATE chat_messages SET telegram_message_id=777, tg_sent=1 WHERE id=?').run(m.id);
  await S.say('תדחה בשבוע', { message_id: 777, text: 'הנה סיכום המשימה' }); const r1 = S.lastOwner(); assert.equal(r1.reply_to_id, m.id); assert.equal(r1.reply_quote, 'הנה סיכום המשימה'); assert.equal(S.pending(r1.id), 1, 'a plain reply goes to the assistant');
  const bid = bench(S); const pid = S.proposals.batch(bid).items[0].id; S.db.prepare('UPDATE proposals SET tg_message_id=888 WHERE id=?').run(pid);
  await S.say('מה זה', { message_id: 888, text: 'שאלה' }); assert.equal(S.lastOwner().reply_proposal_id, pid);
  await S.say('הערה', { message_id: 424242, text: 'הודעה שלא שלנו' }); const r3 = S.lastOwner(); assert.equal(r3.reply_to_id, null); assert.equal(r3.reply_quote, 'הודעה שלא שלנו');
  await S.say('בלי ציטוט'); assert.equal(S.lastOwner().reply_to_id, null);
  const c = S.reply.contextFor(r1.id); assert.match(c, /^הבעלים משיב להודעה הזאת:\n> הנה סיכום המשימה/); assert.match(c, /tasks mentioned in it: #\d+ "משימה א"/); assert.match(c, /NEVER about the latest message/);
});

test('a text reply to a question card is the answer to THAT card; ambiguous: ask once, then the assistant takes over', async () => {
  const S = setup(); await S.bind(); const bid = S.proposals.createBatch('bench', 'ש', [1, 2].map(() => ({ kind: 'bench_question', target_id: S.email, text: 'x', payload: JSON.stringify({ email_id: S.email, ask: 'האם נדרשת משימה?', left: 'א', right: 'ב', approve_label: 'כן, צריך משימה', reject_label: 'לא, רק מידע (אין משימה)' }) })));
  const [p1, p2] = S.proposals.batch(bid).items; S.db.prepare('UPDATE proposals SET tg_message_id=? WHERE id=?').run(901, p1.id); S.db.prepare('UPDATE proposals SET tg_message_id=? WHERE id=?').run(902, p2.id);
  await S.say('לא, רק מידע', { message_id: 901, text: 'שאלה 1' }); let st = (id) => S.db.prepare('SELECT status FROM proposals WHERE id=?').get(id).status;
  assert.equal(st(p1.id), 'rejected'); assert.equal(st(p2.id), 'open', 'only the card he replied to'); assert.equal(S.pending(S.lastOwner().id), 0, 'handled in code: no assistant run');
  assert.ok(S.db.prepare("SELECT 1 FROM chat_messages WHERE author='claude' AND text='נרשם: לא, רק מידע (אין משימה)'").get());
  await S.say('אולי', { message_id: 902, text: 'שאלה 2' }); assert.equal(st(p2.id), 'open'); assert.equal(S.pending(S.lastOwner().id), 0); assert.ok(S.db.prepare("SELECT 1 FROM chat_messages WHERE author='claude' AND text LIKE 'לא הבנתי איזו תשובה%'").get(), 'asks once');
  await S.say('תבדוק שוב בבקשה', { message_id: 902, text: 'שאלה 2' }); assert.equal(S.pending(S.lastOwner().id), 1, 'the second ambiguity goes to the assistant with the context'); assert.match(S.reply.contextFor(S.lastOwner().id), /question card #\d+/);
  await S.say('כן צריך משימה', { message_id: 902, text: 'שאלה 2' }); assert.equal(st(p2.id), 'applied');
});

test('OUTBOX: a typed reply is never approval; approval-like words get "press the button"; anything else is an edit instruction for the assistant', async () => {
  const S = setup(); await S.bind(); const d = S.outbox.create(S.a, { to: 'x@y.co', subject: 'שלום', body: 'גוף המייל' });
  const card = S.db.prepare('SELECT * FROM chat_messages WHERE outbox_id=?').get(d.id); S.db.prepare('UPDATE chat_messages SET telegram_message_id=555 WHERE id=?').run(card.id);
  for (const t of ['כן', 'שלח', 'אשר', 'כן שלח']) { await S.say(t, { message_id: 555, text: card.text }); assert.equal(S.outbox.get(d.id).status, 'pending', t); assert.equal(S.pending(S.lastOwner().id), 0, 'answered in code'); }
  assert.ok(S.db.prepare("SELECT 1 FROM chat_messages WHERE author='claude' AND text LIKE 'הודעה מוקלדת אינה אישור שליחה%'").get());
  await S.say('תקצר ותוסיף את דנה בעותק', { message_id: 555, text: card.text }); const r = S.lastOwner(); assert.equal(S.outbox.get(d.id).status, 'pending'); assert.equal(S.pending(r.id), 1, 'an edit instruction reaches the assistant');
  const c = S.reply.contextFor(r.id); assert.match(c, new RegExp(`outgoing email draft #${d.id}`)); assert.match(c, /EDIT instruction/); assert.match(c, /NEVER an approval/);
  assert.equal(S.outbox.get(d.id).approved_at, null);
});

test('web chat: reply_to is stored and shown as a quote; a web reply to an outbox card is treated the same way', () => {
  const S = setup(); const d = S.outbox.create(S.a, { to: 'x@y.co', subject: 'שלום', body: 'גוף' }); const card = S.db.prepare('SELECT * FROM chat_messages WHERE outbox_id=?').get(d.id);
  const m = S.chat.sendChat(S.owner, { text: 'כן', reply_to: card.id }); assert.equal(m.reply_to_id, card.id); assert.match(m.reply.text, /טיוטת מייל/); assert.equal(S.outbox.get(d.id).status, 'pending'); assert.equal(S.pending(m.id), 0);
  const plain = S.chat.sendChat(S.a, { text: 'הודעה רגילה' }); const m2 = S.chat.sendChat(S.owner, { text: 'מה זה אומר?', reply_to: plain.id }); assert.equal(S.pending(m2.id), 1); assert.equal(m2.reply.text, 'הודעה רגילה');
});
