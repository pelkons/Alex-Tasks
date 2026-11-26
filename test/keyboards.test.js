'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-kb-'));
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
const { createTelegram, fitKeyboard, taskKeyboard, rowWidth, ROW_BUDGET, ROW_MAX } = require('../lib/telegram');

const inBudget = (kb) => { for (const row of kb) { assert.ok(row.length >= 1 && row.length <= ROW_MAX, `at most ${ROW_MAX} buttons per row: ${row.map((b) => b.text).join(' | ')}`); assert.ok(rowWidth(row) <= ROW_BUDGET || row.length === 1, `row too wide (${rowWidth(row)} > ${ROW_BUDGET}): ${row.map((b) => b.text).join(' | ')}`); } };

test('re-flow: more than 3 buttons or too wide a row is split, order kept, a single long button stays alone', () => {
  const b = (t) => ({ text: t, callback_data: 'x' });
  const out = fitKeyboard([[b('א'), b('ב'), b('ג'), b('ד'), b('ה')]]); inBudget(out); assert.deepEqual(out.map((r) => r.length), [2, 2, 1]); assert.deepEqual(out.flat().map((x) => x.text), ['א', 'ב', 'ג', 'ד', 'ה']);
  const wide = fitKeyboard([[b('כן, צריך משימה'), b('לא, רק מידע (אין משימה)')]]); inBudget(wide); assert.equal(wide.length, 2); assert.equal(wide[0][0].text, 'כן, צריך משימה');
  const card = fitKeyboard([[b('✅ שלח'), b('✏️ ערוך'), b('❌ בטל')]]); assert.deepEqual(card.map((r) => r.map((x) => x.text)), [['✅ שלח', '✏️ ערוך'], ['❌ בטל']], 'the card keyboard: two per row, the primary action first');
  assert.equal(fitKeyboard([[b('x'.repeat(60))]]).length, 1);
});

test('task buttons: one task = three short rows (2 + 2 + 1); several = one short row each (at most 3) and "עוד באתר" for the rest', () => {
  const site = 'https://s.example'; const t = (id, title) => ({ id, title });
  const one = taskKeyboard([t(1, 'משימה עם כותרת ארוכה מאוד מאוד')], site); inBudget(one); assert.deepEqual(one.map((r) => r.map((b) => b.text)), [['✔ הושלם', '⏰ למחר'], ['🔗 באתר', '👍'], ['👎']]);
  const three = taskKeyboard([t(1, 'להכין דוח התקדמות חודשי'), t(2, 'לתאם סיור מדידות באתר'), t(3, 'לשלוח הצעת מחיר ליועץ')], site); inBudget(three); assert.equal(three.length, 3); assert.ok(three.every((r) => r.length === 2 && r[0].text.startsWith('✔ ') && r[0].text.length <= 10));
  const six = taskKeyboard([1, 2, 3, 4, 5, 6].map((i) => t(i, 'משימה ' + i)), site); inBudget(six); assert.equal(six.length, 4); assert.match(six[3][0].text, /עוד 3 באתר/); assert.ok(six.flat().filter((b) => b.callback_data).length <= 6 && !six.flat().some((b) => /^fb/.test(b.callback_data || '')), 'no feedback buttons multiplied');
});

test('EVERY keyboard the bot sends fits the width budget: task replies, outbox cards, question cards, confirmations', async () => {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge); const proposals = createProposals({ db, store, chat }); const outbox = createOutbox({ db, store }); store.hooks.outboxView = outbox.cardView;
  const calls = []; const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); calls.push({ method: m[1], body: JSON.parse(o.body || '{}') }); return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 100 + calls.length } : m[1] === 'getMe' ? { username: 'b' } : true }) }; };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'T', fetchImpl, proposals, outbox, filesDir: TMP }); await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7 }, text: '/start ' + tg.createBindCode() } });
  const a = store.assistantId(), owner = store.ownerId(); const ids = [1, 2, 3, 4].map((i) => String(store.createTask(a, { title: `משימה מספר ${i} עם כותרת ארוכה`, requester: owner }).id));
  chat.sendChat(a, { text: 'עדכנתי משימה אחת', task: ids[0] }); chat.sendChat(a, { text: 'עדכנתי שלוש', task: ids.slice(0, 3).join(',') }); chat.sendChat(a, { text: 'עדכנתי ארבע', task: ids.join(',') });
  outbox.create(a, { to: 'a@b.co', subject: 'שלום', body: 'גוף' });
  const eid = db.prepare("INSERT INTO emails (message_id, from_addr, subject, received_at, body_text) VALUES ('k1','R <r@v.example>','נושא',?, 'גוף המייל')").run(new Date().toISOString()).lastInsertRowid;
  proposals.createBatch('bench', 'ש', [{ kind: 'bench_question', target_id: eid, text: 'x', payload: JSON.stringify({ email_id: eid, ask: 'שאלה?', left: 'א', right: 'ב', approve_label: 'כן, צריך משימה', reject_label: 'לא, רק מידע (אין משימה)' }) }]);
  for (let i = 0; i < 4; i++) await tg.deliverPending();
  const kbs = calls.filter((c) => c.method === 'sendMessage' && c.body.reply_markup).map((c) => c.body.reply_markup.inline_keyboard); assert.ok(kbs.length >= 5, 'the keyboards were sent: ' + kbs.length);
  for (const kb of kbs) inBudget(kb);
  assert.ok(kbs.some((kb) => kb.flat().some((b) => b.text === '✅ שלח')) && kbs.some((kb) => kb.flat().some((b) => b.text === 'כן, צריך משימה')));
});
