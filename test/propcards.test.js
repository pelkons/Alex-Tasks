'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-pq-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createProposals } = require('../lib/proposals');
const { createTelegram } = require('../lib/telegram');

const BODY = 'שלום דנה,\nמצורפת הצעת המחיר המעודכנת לתכנון האדריכלי. נשמח לקבל אישור עד יום חמישי הקרוב כדי שנוכל להתחיל בעבודה.\n\nבברכה,\nרון\n\nמאת: דנה\nנשלח: אתמול\nהודעה קודמת שצריכה להיחתך מהתצוגה';
function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge); const proposals = createProposals({ db, store, chat }); const a = store.assistantId();
  const proj = store.createProject(a, { name: 'מגדל הדוגמה' }); store.createPerson(a, { name: 'רון לוי', role: 'contact', emails: ['ron@vendor.example'] });
  const eid = db.prepare("INSERT INTO emails (message_id, from_addr, to_addr, subject, original_subject, received_at, mail_date, body_text, project_id, attachments) VALUES ('q1','Ron <ron@vendor.example>','dana@x.example','FW: הצעת מחיר לתכנון','הצעת מחיר לתכנון','2026-11-24T08:30:00Z','2026-11-24T08:30:00Z',?,?, '[]')").run(BODY, proj.id).lastInsertRowid;
  db.prepare("INSERT INTO files (original_name, path, mime, size, source, email_id, created_at) VALUES ('הצעה.pdf','/x','application/pdf',1,'email',?,?)").run(eid, new Date().toISOString());
  const payload = JSON.stringify({ bench: 'jev1', email_id: eid, field: 'needs_task', gold: true, pipeline: false, ask: 'האם נדרשת משימה עבורך או עבור הצוות שלך בעקבות המייל הזה?', left: 'המערכת החליטה: אין משימה', right: 'המודל אומר: כן, נדרשת משימה', approve_label: 'כן, צריך משימה', reject_label: 'לא, רק מידע (אין משימה)', suggested_title: 'לאשר את הצעת המחיר לתכנון' });
  return { db, store, chat, proposals, eid, payload };
}

test('a question card carries who/when/project/subject, the CLEANED excerpt, attachments, a link, what is asked, both options and the labelled buttons', () => {
  const S = setup(); const bid = S.proposals.createBatch('bench', 'שאלות', [{ kind: 'bench_question', target_id: S.eid, text: 'x', payload: S.payload }]);
  const it = S.proposals.batch(bid).items[0]; const e = it.email;
  assert.equal(e.sender, 'רון לוי'); assert.match(e.when, /24\.11\.2026|24\/11\/2026/); assert.match(e.when, /\d{2}:\d{2}$/); assert.equal(e.project, 'מגדל הדוגמה'); assert.equal(e.subject, 'הצעת מחיר לתכנון');
  assert.ok(e.excerpt.startsWith('שלום דנה') && e.excerpt.length <= 430 && !/הודעה קודמת/.test(e.excerpt), 'cleaned and short'); assert.ok(!/הודעה קודמת/.test(e.full), 'the quoted reply is cut from the full view too');
  assert.deepEqual(e.attachments, ['הצעה.pdf']); assert.match(e.link, /\/email\/\d+$/);
  assert.equal(it.ask, 'האם נדרשת משימה עבורך או עבור הצוות שלך בעקבות המייל הזה?'); assert.equal(it.left, 'המערכת החליטה: אין משימה'); assert.equal(it.right, 'המודל אומר: כן, נדרשת משימה');
  assert.equal(it.approve_label, 'כן, צריך משימה'); assert.equal(it.reject_label, 'לא, רק מידע (אין משימה)'); assert.equal(it.suggested_title, 'לאשר את הצעת המחיר לתכנון');
});

test('active-learning questions about an email get the same context and plain "כן / לא" labels; task proposals show their source email', () => {
  const S = setup(); const a = S.store.assistantId();
  const bid = S.proposals.createBatch('questions', 'ש', [{ kind: 'question', target_id: 0, other_id: S.eid, text: 'פתחתי משימה עם תאריך יעד משוער. המשימה באמת נדרשת?' }]);
  const it = S.proposals.batch(bid).items[0]; assert.equal(it.email.sender, 'רון לוי'); assert.equal(it.approve_label, 'כן, נכון'); assert.equal(it.reject_label, 'לא, לא נכון'); assert.ok(it.ask.includes('נדרשת'));
  const t = S.store.createTask(a, { title: 'משימה מהמייל', project: S.db.prepare('SELECT id FROM projects WHERE is_default=0').get().id, requester: S.store.ownerId(), source_email_id: S.eid });
  const b2 = S.proposals.createBatch('audit', 'א', [{ kind: 'task_info', target_id: t.id, text: 'להפוך לידיעה' }]); assert.equal(S.proposals.batch(b2).items[0].email.id, S.eid);
});

test('answering a benchmark question records only the choice (no learning feedback); bulk approval is not offered for it', () => {
  const S = setup(); const bid = S.proposals.createBatch('bench', 'ש', [{ kind: 'bench_question', target_id: S.eid, text: 'x', payload: S.payload }]); const id = S.proposals.batch(bid).items[0].id;
  S.proposals.decide(id, 'reject'); assert.equal(S.db.prepare('SELECT status FROM proposals WHERE id=?').get(id).status, 'rejected'); assert.equal(S.db.prepare('SELECT COUNT(*) c FROM feedback').get().c, 0);
  assert.equal(S.proposals.batch(bid).kind, 'bench');
});

test('Telegram: every question is its own message (a few per round) with the excerpt and the content-labelled buttons plus a link to the full email; the buttons answer; legacy questions are not re-sent', async () => {
  const S = setup(); const calls = []; const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); const body = JSON.parse(o.body || '{}'); calls.push({ method: m[1], body }); return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 100 + calls.length } : m[1] === 'getMe' ? { username: 'b' } : true }) }; };
  S.db.prepare("INSERT INTO proposal_batches (kind, title, created_at) VALUES ('questions','old','x')").run(); S.db.prepare("INSERT INTO proposals (batch, kind, target_id, text, created_at) VALUES (1,'question',0,'שאלה ישנה','x')").run(); // a legacy row: tg_sent defaults to 1
  const tg = createTelegram({ db: S.db, store: S.store, knowledge: createKnowledge(S.db, S.store), chat: S.chat, token: 'T', fetchImpl, proposals: S.proposals, filesDir: os.tmpdir() }); await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7 }, text: '/start ' + tg.createBindCode() } });
  const items = []; for (let i = 0; i < 5; i++) items.push({ kind: 'bench_question', target_id: S.eid, text: 'x', payload: S.payload }); S.proposals.createBatch('bench', 'ש', items); S.db.prepare("UPDATE proposals SET payload=json_set(payload,'$.summary','הלקוח מבקש הצעת מחיר') WHERE kind='bench_question'").run();
  calls.length = 0; await tg.deliverPending(); let sent = calls.filter((c) => c.method === 'sendMessage');
  assert.equal(sent.length, 3, 'three per round, each its own message'); const m = sent[0].body;
  for (const part of ['שאלה 1/5', 'בקצרה: הלקוח מבקש הצעת מחיר', '<blockquote>', 'רון לוי', 'הצעת מחיר לתכנון', 'שלום דנה', 'הצעה.pdf', 'האם נדרשת משימה', 'א) המערכת החליטה: אין משימה', 'ב) המודל אומר: כן, נדרשת משימה', 'כותרת משימה מוצעת']) assert.ok(m.text.includes(part), part);
  const kb = m.reply_markup.inline_keyboard; assert.deepEqual(kb.flat().slice(0, 2).map((b) => b.text), ['כן, צריך משימה', 'לא, רק מידע (אין משימה)'], 'the answers, primary first (on separate rows: they are long)'); assert.match(kb[kb.length - 1][0].url, /\/email\/\d+$/);
  assert.ok(S.db.prepare("SELECT COUNT(*) c FROM proposals WHERE kind='bench_question' AND tg_message_id IS NOT NULL").get().c === 3, 'delivery is confirmed by a stored message id');
  await tg.deliverPending(); sent = calls.filter((c) => c.method === 'sendMessage'); assert.equal(sent.length, 3, 'paced: nothing more while three wait for an answer');
  const pid = +kb[0][0].callback_data.split(':')[1];
  await tg.handleUpdate({ update_id: 5, callback_query: { id: 'c', data: `pqy:${pid}`, message: { chat: { id: 7 }, message_id: 55 } } }); assert.equal(S.db.prepare('SELECT status FROM proposals WHERE id=?').get(pid).status, 'applied');
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && /נרשם: כן, צריך משימה/.test(c.body.text)));
  await tg.handleUpdate({ update_id: 6, callback_query: { id: 'd', data: `pqn:${pid + 1}`, message: { chat: { id: 7 }, message_id: 56 } } }); assert.equal(S.db.prepare('SELECT status FROM proposals WHERE id=?').get(pid + 1).status, 'rejected');
  await tg.handleUpdate({ update_id: 7, callback_query: { id: 'e', data: `pqy:${pid + 2}`, message: { chat: { id: 9999 }, message_id: 57 } } }); assert.equal(S.db.prepare('SELECT status FROM proposals WHERE id=?').get(pid + 2).status, 'open', 'only the owner chat answers');
  await tg.deliverPending(); sent = calls.filter((c) => c.method === 'sendMessage'); assert.equal(sent.length, 5, 'two answered, so the next two go out');
});
