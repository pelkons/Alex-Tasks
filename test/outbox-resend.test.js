'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-resend-'));
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ owner: { name_he: 'דנה', name_en: 'Dana', emails: ['dana@x.example'], work_email: 'dana@x.example' } }));
process.env.MESIMOT_CONFIG = path.join(TMP, 'config.json'); process.env.MESIMOT_FILES = path.join(TMP, 'files'); process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(TMP, 'k');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createOutbox } = require('../lib/outbox');
const { createTelegram } = require('../lib/telegram');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const chat = createChat(db, store, createKnowledge(db, store)); const outbox = createOutbox({ db, store }); store.hooks.outboxView = outbox.cardView; outbox.setSettings({ enabled: true });
  const mail = (id, msgid, from = 'Ron <ron@v.example>') => db.prepare("INSERT INTO emails (id, message_id, msgid, from_addr, to_addr, subject, received_at, body_text) VALUES (?,?,?,?,?,?,?,?)").run(id, 'upload:' + id, msgid, from, 'dana@x.example', 'הצעת מחיר', '2026-11-24T08:00:00Z', 'גוף');
  return { db, store, chat, outbox, a: store.assistantId(), owner: store.ownerId(), mail };
}
const reply = (S, id) => S.outbox.create(S.a, { kind: 'reply', reply_email: id, body: 'תודה, מאשרים.' });

test('a reply always carries reply_to: the EntryID when ANY ingest row knows it (even a duplicate row), the Message-ID whenever we know it, both null only when unknown; the card says which way it goes', () => {
  const S = setup(); S.mail(1, '<abc@v.example>'); S.mail(2, null); S.mail(3, 'only-msgid@v.example');
  S.db.prepare("INSERT INTO ingest_mail (entry_id, internet_message_id, folder, email_id, status, created_at) VALUES ('ENTRY-1','abc@v.example','inbox',1,'duplicate',?)").run(new Date().toISOString()); // the connector pushed a mail that was imported by hand earlier
  const enable = (d) => { S.outbox.approve(S.owner, d.id, d.hash_short, 'web'); return S.outbox.approvedList().items.find((x) => x.id === d.id); };
  const d1 = reply(S, 1), p1 = enable(d1); assert.deepEqual(p1.reply_to, { entry_id: 'ENTRY-1', internet_message_id: '<abc@v.example>' }); assert.equal(d1.reply_mode, 'thread');
  assert.match(S.db.prepare('SELECT text FROM chat_messages WHERE outbox_id=?').get(d1.id).text, /אופן השליחה: תשובה בשרשור המקורי/);
  const d3 = reply(S, 3), p3 = enable(d3); assert.deepEqual(p3.reply_to, { entry_id: null, internet_message_id: '<only-msgid@v.example>' }); assert.equal(d3.reply_mode, 'thread', 'found by Message-ID');
  const d2 = reply(S, 2), p2 = enable(d2); assert.deepEqual(p2.reply_to, { entry_id: null, internet_message_id: null }); assert.equal(d2.reply_mode, 'new_mail'); assert.match(S.db.prepare('SELECT text FROM chat_messages WHERE outbox_id=?').get(d2.id).text, /אופן השליחה: יישלח כמייל חדש/);
  const dn = S.outbox.create(S.a, { to: 'x@y.co', subject: 'חדש', body: 'ש' }); assert.equal(enable(dn).reply_to, null, 'a new mail has no reply_to'); assert.ok(!/אופן השליחה/.test(S.db.prepare('SELECT text FROM chat_messages WHERE outbox_id=?').get(dn.id).text));
});

test('re-send: a failed (or expired) mail becomes a NEW pending draft with a new card; never auto-approved; once; the old id stays failed and is never listed', () => {
  const S = setup(); S.mail(1, 'abc@v.example'); const d = S.outbox.create(S.a, { to: 'x@y.co', subject: 'שלום', body: 'גוף' });
  assert.throws(() => S.outbox.resend(S.a, d.id), /שנכשל|פג/, 'only failed or expired');
  S.outbox.approve(S.owner, d.id, d.hash_short, 'web'); S.outbox.claim(d.id); S.outbox.result(d.id, { ok: false, error: 'com_error' }); assert.equal(S.outbox.get(d.id).status, 'failed');
  const n = S.outbox.resend(S.owner, d.id); assert.notEqual(n.id, d.id); assert.equal(n.status, 'pending'); assert.equal(n.approved_at, null); assert.equal(n.subject, 'שלום'); assert.deepEqual(n.to.map((x) => x.email), ['x@y.co']);
  const cards = S.db.prepare('SELECT * FROM chat_messages WHERE outbox_id=? ORDER BY id').all(n.id); assert.equal(cards.length, 1, 'a new card');
  const old = S.outbox.get(d.id); assert.equal(old.status, 'failed'); assert.equal(old.resent_as, n.id); assert.equal(S.outbox.get(n.id).resend_of, d.id);
  assert.throws(() => S.outbox.resend(S.owner, d.id), /כבר נוצרה טיוטה חדשה/); assert.equal(S.outbox.approvedList().items.length, 0, 'nothing is approved or listed');
  S.outbox.approve(S.owner, n.id, n.hash_short, 'web'); assert.deepEqual(S.outbox.approvedList().items.map((x) => x.id), [n.id], 'only after the owner approves the new draft');
});

test('a re-sent reply re-resolves its original (the EntryID that was missing may be known now)', () => {
  const S = setup(); S.mail(1, 'abc@v.example'); const d = reply(S, 1); assert.equal(d.reply_mode, 'thread');
  S.outbox.approve(S.owner, d.id, d.hash_short, 'web'); S.outbox.claim(d.id); S.outbox.result(d.id, { ok: false, error: 'x' });
  S.db.prepare("INSERT INTO ingest_mail (entry_id, internet_message_id, folder, email_id, status, created_at) VALUES ('LATE-ENTRY','abc@v.example','inbox',1,'stored',?)").run(new Date().toISOString());
  const n = S.outbox.resend(S.owner, d.id); S.outbox.approve(S.owner, n.id, n.hash_short, 'web'); assert.equal(S.outbox.approvedList().items[0].reply_to.entry_id, 'LATE-ENTRY');
});

test('a failure note is a small card with a re-send button (web data and Telegram); the button creates the draft, not an approval', async () => {
  const S = setup();
  const calls = []; const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); calls.push({ method: m[1], body: JSON.parse(o.body || '{}') }); return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 50 + calls.length } : m[1] === 'getMe' ? { username: 'b' } : true }) }; };
  const tg = createTelegram({ db: S.db, store: S.store, knowledge: createKnowledge(S.db, S.store), chat: S.chat, token: 'T', fetchImpl, outbox: S.outbox, filesDir: TMP }); await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7 }, text: '/start ' + tg.createBindCode() } });
  const d = S.outbox.create(S.a, { to: 'x@y.co', subject: 'שלום', body: 'גוף' }); S.outbox.approve(S.owner, d.id, d.hash_short, 'web'); S.outbox.claim(d.id); S.outbox.result(d.id, { ok: false, error: 'com_error' });
  const fail = S.db.prepare("SELECT * FROM chat_messages WHERE text LIKE 'השליחה נכשלה%'").get(); const v = S.chat.decorate(fail); assert.equal(v.outbox.status, 'failed'); assert.equal(v.outbox.resent_as, null);
  await tg.deliverPending(); const sent = calls.filter((c) => c.method === 'sendMessage').pop().body; const kb = sent.reply_markup.inline_keyboard; assert.deepEqual(kb.map((r) => r.map((b) => b.text)), [['🔁 שלח שוב']]);
  await tg.handleUpdate({ update_id: 2, callback_query: { id: 'c', data: kb[0][0].callback_data, message: { chat: { id: 7 }, message_id: 9 } } });
  const n = S.outbox.list({ status: 'pending' }); assert.equal(n.length, 1); assert.equal(n[0].approved_at, null); assert.equal(S.outbox.get(d.id).resent_as, n[0].id);
  await tg.handleUpdate({ update_id: 3, callback_query: { id: 'd', data: kb[0][0].callback_data, message: { chat: { id: 7 }, message_id: 9 } } }); assert.equal(S.outbox.list({ status: 'pending' }).length, 1, 'a second tap makes no second draft');
});
