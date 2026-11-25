'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-web-'));
process.env.MESIMOT_SEMANTIC = '0';
process.env.MESIMOT_LOCK = path.join(tmp, 'runner.lock');
process.env.MESIMOT_RUN_LOG = path.join(tmp, 'runs');
process.env.MESIMOT_CLAUDE_BIN = path.join(__dirname, 'fixtures', 'fake-claude-seq.sh');
process.env.FAKE_ARGS_PREFIX = path.join(tmp, 'args');
process.env.FAKE_COUNTER = path.join(tmp, 'counter');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat, webQuestion, WEB_HINT } = require('../lib/chat');
const { createTelegram } = require('../lib/telegram');
const { buildArgs, toolList } = require('../lib/agents/claude-code');
const { createRunner } = require('../lib/runner');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  fs.rmSync(process.env.FAKE_COUNTER, { force: true });
  return { db, store, knowledge, chat, owner: store.ownerId(), a: store.assistantId() };
}
const args = (n) => fs.readFileSync(`${process.env.FAKE_ARGS_PREFIX}.${n}`, 'utf8');
const LINKS = '\n[אתר ממשלתי](https://www.gov.il/he/x)\n[ויקיפדיה](https://he.wikipedia.org/wiki/y)';

test('the /s command is recognised in a message (any case, with a bot suffix) and only at the start', () => {
  assert.equal(webQuestion('/s מה שעון הקיץ?'), 'מה שעון הקיץ?');
  assert.equal(webQuestion('/S מחיר הדלק'), 'מחיר הדלק');
  assert.equal(webQuestion('/s@Alex_mesimot_bot מחיר'), 'מחיר');
  assert.equal(webQuestion('/s'), '');
  assert.equal(webQuestion('  /s   '), '');
  assert.equal(webQuestion('/s\nשורה שנייה'), 'שורה שנייה');
  for (const no of ['/sx שאלה', 'שלום /s שאלה', '/start', 'מה זה /s', '/status', '']) assert.equal(webQuestion(no), null, no);
});

test('chat: an owner /s message becomes a websearch event (not a chat event); /s alone gets a one-line hint and no run; assistant messages never trigger it', () => {
  const { db, chat, owner, a } = setup();
  chat.sendChat(owner, { text: '/s מה שעון הקיץ בישראל 2027' });
  const ev = db.prepare('SELECT entity, new_value FROM events WHERE processed_at IS NULL').all().filter((e) => ['chat', 'websearch'].includes(e.entity));
  assert.deepEqual(ev, [{ entity: 'websearch', new_value: 'מה שעון הקיץ בישראל 2027' }]);
  chat.sendChat(owner, { text: '/s' });
  const hint = db.prepare("SELECT text, kind, author FROM chat_messages WHERE author='claude'").get();
  assert.equal(hint.text, WEB_HINT); assert.equal(hint.kind, 'web');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='websearch'").get().c, 1, 'no event for an empty /s');
  chat.sendChat(owner, { text: 'הודעה רגילה' });
  chat.sendChat(a, { text: '/s זה לא פקודה כשהעוזר כותב' });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='chat' AND processed_at IS NULL").get().c, 1, 'only the ordinary owner message');
  assert.equal(chat.status().pending_web, 1);
});

test('Telegram: /s and /s@botname go through the chat as the same /s message; the bot registers /s with a Hebrew description and marks web answers', async () => {
  const { db, store, knowledge, chat } = setup();
  const calls = [];
  const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); const body = JSON.parse(o.body || '{}'); calls.push({ method: m[1], body }); return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 900 + calls.length } : true }) }; };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'T', fetchImpl, whisper: {}, log: () => {} });
  const code = tg.createBindCode();
  await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 77 }, text: '/start ' + code } });
  await tg.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 77 }, text: '/s@Alex_mesimot_bot מה המחיר שלו?' } });
  await tg.handleUpdate({ update_id: 3, message: { message_id: 3, chat: { id: 77 }, text: '/s מחיר הדלק' } });
  const msgs = db.prepare("SELECT text, channel FROM chat_messages WHERE author='owner' ORDER BY id").all();
  assert.deepEqual(msgs.map((m) => m.text), ['/s מה המחיר שלו?', '/s מחיר הדלק']);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE entity='websearch'").get().c, 2);
  // web answers are marked with the globe in Telegram
  chat.sendChat(store.assistantId(), { text: 'התשובה\n[אתר](https://x.y/z)' }, { kind: 'web' });
  await tg.deliverPending();
  assert.match(calls.filter((c) => c.method === 'sendMessage').pop().body.text, /^🌐 התשובה/);
  // the command menu
  await tg.setCommands();
  const cmds = calls.find((c) => c.method === 'setMyCommands');
  assert.ok(cmds && cmds.body.commands.some((c) => c.command === 's' && c.description === 'חיפוש באינטרנט'));
});

test('tool allowlist of the web run: WebSearch and WebFetch only: no Bash, no Read/Edit/Write, no mesimot command, no database, email or file tools', () => {
  const web = buildArgs({ prompt: 'p', web: true, allowedCommands: [], readPaths: [], writePaths: [], model: 'sonnet', effort: 'medium' });
  const j = web.join(' ');
  assert.deepEqual(toolList({ allowedCommands: [], readPaths: [], writePaths: [], web: true }), ['WebSearch', 'WebFetch']);
  assert.equal(web[web.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  const allowed = web.slice(web.indexOf('--allowedTools') + 1, web.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['WebSearch', 'WebFetch']);
  for (const bad of ['mesimot', 'Bash(', 'Read(', 'Edit(', 'Write(']) assert.ok(!j.slice(0, j.indexOf('--disallowedTools')).includes(bad), `${bad} must not be allowed`);
  const denied = web.slice(web.indexOf('--disallowedTools') + 1, web.indexOf('--permission-mode'));
  for (const t of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']) assert.ok(denied.includes(t), t + ' is denied');
  assert.ok(web.includes('dontAsk'), 'anything not allowed is refused, never asked');
  // the normal run is unchanged
  const normal = buildArgs({ prompt: 'p', allowedCommands: ['mesimot'], readPaths: ['/a'], writePaths: ['/a/m'] });
  assert.equal(normal[normal.indexOf('--tools') + 1], 'Bash,Read,Edit,Write');
  assert.ok(!normal.join(' ').includes('WebSearch'), 'the normal agent has no web access');
});

test('web run: answered in the chat as a web message (with sources), isolated context, logged as trigger web with sonnet/medium; the event is closed', async () => {
  const { db, chat, owner, a } = setup();
  chat.sendChat(owner, { text: 'מה המחיר של האייפון?' }); chat.sendChat(a, { text: 'לא ידוע לי, רוצה שאחפש?' });
  chat.sendChat(owner, { text: '/s מה המחיר שלו?' });
  process.env.FAKE_REPLIES = 'המחיר נכון ל-25/11/2026 הוא כ-4,000 ש״ח, אך המקורות חלוקים.' + LINKS;
  const runner = createRunner(db);
  assert.equal(runner.decide(), 'chat', 'the normal chat message is handled first');
  db.prepare("UPDATE events SET processed_at=datetime('now') WHERE entity='chat'").run();
  assert.equal(runner.decide(), 'web');
  assert.equal(await runner.runOnce('web'), true);
  const msgs = db.prepare("SELECT text, kind FROM chat_messages WHERE author='claude' ORDER BY id").all();
  assert.equal(msgs.length, 2); assert.equal(msgs[1].kind, 'web'); assert.match(msgs[1].text, /https:\/\/www\.gov\.il/);
  assert.equal(db.prepare("SELECT processed_at FROM events WHERE entity='websearch'").get().processed_at !== null, true);
  const run = db.prepare("SELECT trigger, model, effort, summary_he, error FROM claude_runs WHERE trigger='web'").get();
  assert.deepEqual({ t: run.trigger, m: run.model, e: run.effort, err: run.error }, { t: 'web', m: 'sonnet', e: 'medium', err: null });
  assert.match(run.summary_he, /חיפוש באינטרנט/);
  // what the run was given: the question, the last chat messages, the date; nothing else; and no tool but the two web tools
  const a1 = args(1);
  assert.ok(a1.includes('WebSearch,WebFetch') && !/--tools [^ ]*(Bash|Read|Edit|Write)/.test(a1));
  const prompt = fs.readFileSync(path.join(process.env.MESIMOT_RUN_LOG, `${run.id || 1}.prompt.txt`), 'utf8');
  assert.match(prompt, /מה המחיר שלו\?/); assert.match(prompt, /מה המחיר של האייפון/); assert.match(prompt, /TODAY \(Asia\/Jerusalem\)/);
  for (const secret of ['PERMANENT MEMORY', 'OPEN TASKS', 'PROJECTS', 'mesimot apply']) assert.ok(!prompt.includes(secret), `the prompt has no ${secret}`);
});

test('web run gate: a reply without a source link is re-prompted once; still none: posted with a caveat; not Hebrew: refused; an agent error: a short failure message', async () => {
  let { db, chat, owner } = setup();
  chat.sendChat(owner, { text: '/s שאלה ראשונה' });
  process.env.FAKE_REPLIES = 'תשובה בלי מקורות||תשובה עם מקורות' + LINKS;
  await createRunner(db).runOnce('web');
  let msgs = db.prepare("SELECT text FROM chat_messages WHERE author='claude'").all();
  assert.equal(msgs.length, 1, 'only the corrected answer is posted'); assert.match(msgs[0].text, /gov\.il/);
  assert.equal(fs.existsSync(`${process.env.FAKE_ARGS_PREFIX}.2`), true);
  assert.ok(db.prepare("SELECT 1 FROM gate_log WHERE code='message' AND outcome='resolved'").get());
  ({ db, chat, owner } = setup());
  chat.sendChat(owner, { text: '/s שאלה שנייה' });
  process.env.FAKE_REPLIES = 'עדיין בלי מקורות';
  await createRunner(db).runOnce('web');
  msgs = db.prepare("SELECT text FROM chat_messages WHERE author='claude'").all();
  assert.match(msgs[0].text, /עדיין בלי מקורות/); assert.match(msgs[0].text, /כדאי לאמת/);
  ({ db, chat, owner } = setup());
  chat.sendChat(owner, { text: '/s שאלה שלישית' });
  process.env.FAKE_REPLIES = 'Это не иврит https://x.y';
  await createRunner(db).runOnce('web');
  msgs = db.prepare("SELECT text FROM chat_messages WHERE author='claude'").all();
  assert.match(msgs[0].text, /לא הצליח/);
  ({ db, chat, owner } = setup());
  chat.sendChat(owner, { text: '/s שאלה רביעית' });
  process.env.FAKE_ERROR = '1'; process.env.FAKE_REPLIES = 'boom';
  try { await createRunner(db).runOnce('web'); } finally { delete process.env.FAKE_ERROR; }
  assert.match(db.prepare("SELECT text FROM chat_messages WHERE author='claude'").get().text, /לא הצליח/);
  assert.equal(db.prepare("SELECT processed_at FROM events WHERE entity='websearch'").get().processed_at !== null, true, 'the event is closed even after a failure');
});
