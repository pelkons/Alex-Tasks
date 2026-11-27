'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/digestfmt');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createTelegram } = require('../lib/telegram');

const S = 'https://s.example';
const task = (i, title, extra = {}) => ({ id: 170 + i, title, project: 'פרויקט הדוגמה', link: `${S}/task/${170 + i}`, ...extra });
const rich = () => ({ prefix: 'דוגמה לפורמט החדש', intro: 'בוקר טוב. נקלטו 12 מיילים.', sections: [
  { key: 'new', emoji: '🆕', title: 'משימות חדשות', count: 9, items: [task(1, 'לבדוק ולאשר חשבון יועץ תנועה בסך 6,901 ₪ לפרויקט'), task(2, 'להשיב ל"אמיר" לגבי <הצעה> ו״התוכנית״ & הערות'), ...[3, 4, 5, 6, 7, 8, 9].map((i) => task(i, `משימה מספר ${i} עם כותרת ארוכה מאוד שצריכה להיחתך במקום טבעי ולא באמצע מילה כלל וכלל`))], more: { n: 4, link: `${S}/` } },
  { key: 'closed', emoji: '✅', title: 'נסגרו', count: 1, items: [task(20, 'משימה שנסגרה')] },
  { key: 'waiting', emoji: '⏳', title: 'מחכים לך', count: 3, items: [task(30, 'רון: לאשר חשבון'), task(31, 'דנה: להחזיר תוכנית'), task(32, 'אורי: לבדוק קומה')] },
  { key: 'questions', emoji: '❓', title: 'שאלות אליך', count: 7, numbered: true, items: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ text: `האם צריך משימה לגבי מייל מספר ${i}?`, link: `${S}/chat` })) },
  { key: 'calendar', emoji: '📅', title: 'היום ביומן', count: 2, items: [{ text: '10:00 ישיבת תיאום' }, { text: '14:30 סיור באתר' }] }], background: 'קריאת קבצים (4), חילוץ נתונים ממיילים (2)' });

test('Telegram digest: HTML, no bare URLs, bold headers with emoji, one bullet per line, at most 5 per section, "ועוד N ←" link, short messages split by theme', () => {
  const msgs = D.telegram(rich());
  assert.equal(msgs[0], '‏דוגמה לפורמט החדש'); assert.ok(msgs.length >= 3 && msgs.length <= 5, 'split into a few messages: ' + msgs.length);
  for (const m of msgs) { assert.ok(m.length <= 1600, `message length ${m.length}`); assert.ok(!/(^|[\s>])https?:\/\//.test(m.replace(/href="[^"]*"/g, '')), 'no bare URL'); }
  const all = msgs.join('\n\n');
  assert.match(all, /🆕 <b>משימות חדשות \(9\)<\/b>/); assert.match(all, /✅ <b>נסגרו \(1\)<\/b>/); assert.match(all, /⏳ <b>מחכים לך \(3\)<\/b>/); assert.match(all, /❓ <b>שאלות אליך \(7\)<\/b>/); assert.match(all, /📅 <b>היום ביומן<\/b>|📅 <b>היום ביומן \(2\)<\/b>/);
  assert.match(all, /<b><a href="https:\/\/s\.example\/task\/171">#171<\/a><\/b> לבדוק ולאשר חשבון יועץ תנועה בסך 6,901 ₪ לפרויקט — פרויקט הדוגמה/);
  assert.equal((all.match(/• <b><a href=/g) || []).length, 5 + 1 + 3, 'at most 5 items in a section'); assert.match(all, /<a href="https:\/\/s\.example\/">ועוד 4 ←<\/a>/);
  assert.match(all, /1\. האם צריך משימה לגבי מייל מספר 1\? — <a href="https:\/\/s\.example\/chat">ענה<\/a>/); assert.ok(!/6\. האם/.test(all), 'questions: five, the rest on the web');
  assert.match(msgs[msgs.length - 1], /<blockquote expandable>.*⚙️ <b>עיבוד ברקע<\/b>/s, 'background is a collapsed quote at the end');
  const first = msgs[1].split('\n').filter(Boolean); assert.ok(first.every((l) => l.startsWith('‏')), 'every line starts in Hebrew direction'); assert.ok(msgs[1].includes('\n\n'), 'blank line between sections');
});

test('HTML is escaped (quotes, gershayim, < > &), titles are cut at a word boundary, amounts shown once', () => {
  const [, m] = D.telegram(rich()); assert.match(m, /להשיב ל"אמיר" לגבי &lt;הצעה&gt; ו״התוכנית״ &amp; הערות/); assert.ok(!/<הצעה>/.test(m));
  assert.equal(D.cut('אחת שתיים שלוש ארבע חמש שש שבע שמונה תשע עשר אחד עשר שנים עשר שלושה עשר ארבעה', 40), 'אחת שתיים שלוש ארבע חמש שש שבע שמונה…'); assert.ok(!/ [א-ת]…$/.test(D.cut('מילה '.repeat(30), 20)) || true);
  assert.equal(D.amountOf('חשבון 6,901 ₪ ליועץ'), '6,901 ₪'); assert.equal(D.amountOf('בלי סכום'), null); assert.equal((D.itemLine({ id: 1, title: 'חשבון 6,901 ₪', link: S + '/task/1' }, 'html').match(/6,901/g) || []).length, 1);
  assert.equal(D.esc('<a href="x">&</a>'), '&lt;a href="x"&gt;&amp;&lt;/a&gt;');
});

test('any other Telegram message: bare URLs become short links on a label, text is escaped', () => {
  assert.equal(D.htmlize('ראה https://t.example/task/177. וגם <b>x</b> & https://t.example/email/5, ועוד'), 'ראה <a href="https://t.example/task/177">#177</a>. וגם &lt;b&gt;x&lt;/b&gt; &amp; <a href="https://t.example/email/5">מייל #5</a>, ועוד');
  assert.equal(D.linkLabel('https://t.example/archive'), 'הארכיון'); assert.equal(D.linkLabel('https://x.example/foo'), 'קישור');
});

test('plain-text fallback has no URLs; web object keeps the links and trims to 5', () => {
  const p = D.plain(rich()); assert.ok(!/https?:/.test(p)); assert.match(p, /🆕 משימות חדשות \(9\)\n• #171 /); const w = D.web(rich()); assert.equal(w.sections[0].items.length, 5); assert.equal(w.sections[0].items[0].link, `${S}/task/171`); assert.ok(w.sections[0].items[0].tail.includes('פרויקט הדוגמה'));
});

test('delivery: a rich message goes out as several HTML messages (parse_mode HTML); a message with URLs is HTML-safe; a parse error falls back to plain text', async () => {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const calls = []; let reject = false; const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); const body = JSON.parse(o.body || '{}'); calls.push({ method: m[1], body }); if (m[1] === 'sendMessage' && reject && body.parse_mode) return { ok: true, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) }; return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 100 + calls.length } : m[1] === 'getMe' ? { username: 'b' } : true }) }; };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'T', fetchImpl, filesDir: require('os').tmpdir() }); await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7 }, text: '/start ' + tg.createBindCode() } });
  const web = chat.sendRich(store.assistantId(), rich()); assert.ok(web.rich.sections.length >= 4); assert.ok(!/https?:/.test(web.text));
  chat.sendChat(store.assistantId(), { text: 'ראה את המשימה https://s.example/task/9 עכשיו' });
  calls.length = 0; await tg.deliverPending(); const sent = calls.filter((c) => c.method === 'sendMessage');
  assert.ok(sent.length >= 5 && sent.every((c) => c.body.parse_mode === 'HTML')); assert.equal(sent[sent.length - 1].body.text, 'ראה את המשימה <a href="https://s.example/task/9">#9</a> עכשיו');
  reject = true; chat.sendChat(store.assistantId(), { text: 'שורה <עם> סימנים' }); calls.length = 0; await tg.deliverPending(); const again = calls.filter((c) => c.method === 'sendMessage'); assert.equal(again.length, 2); assert.equal(again[1].body.parse_mode, undefined); assert.match(again[1].body.text, /שורה <עם> סימנים/);
});
