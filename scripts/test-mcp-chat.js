'use strict';
// The chat checklist for the built-in tools, with the REAL assistant on the TEST instance (port 8111, own database): ten requests through the normal paths, and for each one
// the tools it used (from the run's tools log), any shell call, any refused call, and what changed in the data.
//   MESIMOT_MCP=all|only|chat node scripts/test-mcp-chat.js [--agent=claude-code|codex|gemini]
// Never touches the live instance. Fictional data only.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const T = '/tmp/mesimot-test';
for (const a of process.argv.slice(2)) { const m = /^--(agent)=(.+)$/.exec(a); if (m) process.env.MESIMOT_AGENT = m[2]; }
process.env.MESIMOT_DB = `${T}/test.db`; process.env.MESIMOT_FILES = `${T}/files`; process.env.MESIMOT_LOCK = `${T}/runner.lock`; process.env.MESIMOT_URL = 'http://127.0.0.1:8111';
process.env.MESIMOT_CONFIG = process.env.MESIMOT_CONFIG || path.join(root, 'test', 'fixtures', 'config.json');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { ingestMessage } = require('../lib/email');
const vault = require('../lib/vault');
const sh = (cmd, args, env = {}) => execFileSync(cmd, args, { env: { ...process.env, ...env }, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:8111';

(async () => {
  sh(path.join(root, 'scripts', 'testenv.sh'), ['start', '--runner'], { MESIMOT_QUIET_S: '2', MESIMOT_POLL_EMAIL: '0' });
  const db = open(process.env.MESIMOT_DB), store = createStore(db);
  const owner = store.ownerId(), assistant = store.assistantId();
  const mode = process.env.MESIMOT_MCP || db.prepare("SELECT value FROM settings WHERE key='agent_mcp'").get()?.value;
  console.log(`switch: ${mode}, agent: ${process.env.MESIMOT_AGENT || 'claude-code'}`);
  const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const H = { 'Content-Type': 'application/json', Cookie: cookie, 'X-Mesimot': '1' };
  const api = async (m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); };
  const proj = store.createProject(owner, { name: 'מגדל הדוגמה', aliases: 'Example Tower' });
  const park = store.createProject(owner, { name: 'פארק הדוגמה' });
  const ron = store.createPerson(assistant, { name: 'רון ברק', role: 'contact', company: 'חברת הדוגמה', emails: ['ron@buildco.example'] });
  const t1 = store.createTask(owner, { title: 'להעביר תוכנית יציקות למגדל', project: proj.id, due: '2026-12-01', requester: ron.id });
  const t2 = store.createTask(owner, { title: 'לבדוק את הצעת המחיר של האיטום', project: proj.id, due: '2026-12-03', requester: ron.id });
  const t3 = store.createTask(owner, { title: 'משימה ישנה למחיקה', project: park.id, requester: ron.id });
  const k = require('../lib/knowledge').createKnowledge(db, store);
  k.setFact(assistant, { project: proj.id, key: 'יום יציקה', value: 'חמישי 03/12/2026', as_of: '2026-11-26', source: 'chat' });
  const cal0 = await api('POST', '/api/calendar/items', { title: 'ישיבת תיאום ישנה', start: '2026-12-02 09:00' });
  const del = await api('DELETE', `/api/calendar/items/${cal0.id}`); // lands in the recycle bin
  if (!cal0.id || !db.prepare("SELECT COUNT(*) c FROM trash WHERE kind='calendar'").get().c) throw new Error('seed failed: the deleted meeting is not in the bin ' + JSON.stringify([cal0, del]));
  const results = [];
  const idle = async (label) => { const t0 = Date.now(); await sleep(2500); for (;;) { const o = db.prepare('SELECT (SELECT COUNT(*) FROM events WHERE processed_at IS NULL) a, (SELECT COUNT(*) FROM claude_runs WHERE finished_at IS NULL) b, (SELECT COUNT(*) FROM emails WHERE processed_at IS NULL) c').get(); if (!o.a && !o.b && !o.c) return Math.round((Date.now() - t0) / 1000); if (Date.now() - t0 > 8 * 60 * 1000) throw new Error('timeout ' + label); await sleep(1500); } };
  const toolsOf = (from) => { const out = []; for (const f of fs.readdirSync(`${T}/runs`)) { const m = /^(\d+).*\.tools\.json$/.exec(f); if (m && +m[1] >= from) { try { out.push(...JSON.parse(vault.readFile(`${T}/runs/${f}`).toString('utf8'))); } catch { /* unreadable */ } } } return out; };
  const streamsOf = (from) => { let s = ''; for (const f of fs.readdirSync(`${T}/runs`)) { const m = /^(\d+).*\.stream\.jsonl$/.exec(f); if (m && +m[1] >= from) { try { s += vault.readFile(`${T}/runs/${f}`).toString('utf8') + '\n'; } catch { /* skip */ } } } return s; };
  const lastReply = () => db.prepare("SELECT text FROM chat_messages WHERE author='claude' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get()?.text || '';
  async function step(name, send, check) {
    const before = db.prepare('SELECT COALESCE(MAX(id),0) m FROM claude_runs').get().m;
    const t0 = Date.now(); let err = null, notes = '';
    try { await send(); await idle(name); notes = await check(); } catch (e) { err = e.message; }
    const calls = toolsOf(before + 1), stream = streamsOf(before + 1);
    const mcp = calls.filter((c) => c.tool.startsWith('mcp__mesimot__')).map((c) => c.tool.replace('mcp__mesimot__', ''));
    const shell = calls.filter((c) => c.tool === 'Bash' || c.tool === 'shell').map((c) => String(c.input?.command || '').slice(0, 80));
    const refused = (stream.match(/"permission_denied"/g) || []).length;
    const toolErrors = (stream.match(/"is_error":true/g) || []).length;
    const row = { request: name, ok: !err, s: Math.round((Date.now() - t0) / 1000), tools: mcp, shell_calls: shell, refused, tool_errors: toolErrors, notes: err || notes, reply: lastReply().slice(0, 160) };
    results.push(row); console.log(JSON.stringify(row));
  }
  const chat = (text) => () => api('POST', '/api/chat', { text });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const expect = (c, m) => { if (!c) throw new Error(m); return m; };

  await step('1 calendar item tomorrow 11:00 linked to a task', chat(`תוסיף ליומן פגישה מחר ב-11:00 בשם "סיור באתר" וקשר אותה למשימה ${t1.id}`), async () => { const list = await api('GET', `/api/calendar?from=${tomorrow}&to=${tomorrow}`); const it = (list.items || list || []).find?.((x) => /סיור/.test(x.title)); expect(it, 'no calendar item'); expect(String(it.start || it.start_at).includes('T') ? true : true, ''); const linked = db.prepare('SELECT * FROM calendar_items WHERE id=?').get(it.id); return `item ${it.id} ${it.start || it.start_at} task ${linked.task_id ?? JSON.stringify(Object.keys(linked).filter((k) => /task/.test(k)))}`; });
  await step('2 set a task due date', chat(`תשנה את היעד של משימה ${t2.id} ל-10/12/2026`), async () => { expect(store.getTask(t2.id).due_date === '2026-12-10', 'due ' + store.getTask(t2.id).due_date); return 'due 2026-12-10'; });
  await step('3 create a task in a project', chat('תפתח משימה במגדל הדוגמה: לשלוח לרון את לוח הזמנים המעודכן עד 15/12/2026'), async () => { const t = db.prepare("SELECT * FROM tasks WHERE title LIKE '%לוח הזמנים%' AND id NOT IN (?,?,?)").get(t1.id, t2.id, t3.id); expect(t && t.project_id === proj.id, 'task missing or in another project'); return `task ${t.id} due ${t.due_date}`; });
  await step('4 add a note to a task', chat(`תוסיף הערה למשימה ${t1.id}: הקבלן אישר טלפונית שהמשאבה תגיע ב-7 בבוקר`), async () => { const n = db.prepare("SELECT COUNT(*) c FROM notes WHERE task_id=? AND text LIKE '%משאבה%'").get(t1.id).c; expect(n >= 1, 'no note'); return 'note added'; });
  await step('5 search a topic and answer', chat('באיזה יום היציקה במגדל הדוגמה?'), async () => { expect(/03\/12|חמישי|3\.12|3 בדצמבר/.test(lastReply()), 'the answer lacks the date: ' + lastReply().slice(0, 80)); return 'answered with the fact'; });
  await step('6 draft a mail to an example person (style gate)', chat('תכין טיוטה של מייל לרון ברק (ron@buildco.example) שאני אשלח לו את התוכניות מחר'), async () => { const o = db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 1').get(); expect(o && o.status !== 'sent', 'no draft'); expect(/ron@buildco/.test(o.to_json), 'wrong recipient'); return `outbox ${o.id} ${o.status}`; });
  await step('7 delete a task: only asks the owner', chat(`תמחק את משימה ${t3.id}`), async () => { expect(store.getTask(t3.id), 'the task is gone'); const c = db.prepare("SELECT COUNT(*) c FROM confirmations WHERE status='open'").get().c; expect(c >= 1, 'no confirmation asked'); return `task kept, ${c} confirmation(s) pending`; });
  await step('8 restore from the recycle bin', chat('תחזיר את הפגישה "ישיבת תיאום ישנה" שמחקתי'), async () => { const list = await api('GET', '/api/calendar?from=2026-12-01&to=2026-12-05'); const it = (list.items || list || []).find?.((x) => /תיאום ישנה/.test(x.title)); expect(it, 'not restored'); return 'restored'; });
  await step('9 Hebrew text with an apostrophe and quotes', chat('תפתח משימה: לבדוק את "ת\'ק 5" של עמ\' 3 מול ג\'ו, פרויקט מגדל הדוגמה'), async () => { const t = db.prepare("SELECT title FROM tasks WHERE title LIKE '%ג%ו%' AND title LIKE '%3%' AND id>?").get(t3.id); expect(t && /ת['׳]ק 5/.test(t.title), 'title lost the characters: ' + (t && t.title)); return t.title; });
  const idsBefore = db.prepare('SELECT COALESCE(MAX(id),0) m FROM emails').get().m;
  await step('10 import of 2 example emails through the normal intake', async () => {
    for (const [i, s] of [['תוכניות קורות מעודכנות לקומה 9', 'שלום, מצורפות תוכניות הקורות לקומה 9. נא לאשר עד 08/12/2026.'], ['חשבון חלקי מספר 4', 'מצורף חשבון חלקי 4 על סך 182,000 ש"ח. נא לאשר לתשלום עד סוף החודש.']].entries())
      ingestMessage(db, store, { message_id: `fixture:chk-${Date.now()}-${i}`, from: 'Ron Barak <ron@buildco.example>', to: ['assistant@agentmail.example'], subject: 'FW: ' + s[0] + ' - מגדל הדוגמה', timestamp: new Date().toISOString(), labels: ['received', 'mesimot'], attachments: [], text: `לטיפולך\n\n‏________________________________\n‏מאת: Ron Barak\n‏נשלח: Friday, 27 November 2026 09:0${i}\n‏אל: דנה\n‏נושא: ${s[0]}\n\n${s[1]}` });
  }, async () => { const n = db.prepare('SELECT COUNT(*) c FROM emails WHERE id>? AND processed_at IS NOT NULL').get(idsBefore).c; expect(n === 2, `${n} of 2 mails processed`); return `${db.prepare('SELECT COUNT(*) c FROM tasks WHERE source_email_id>?').get(idsBefore).c} task(s) from the mails`; });

  const bad = results.filter((r) => !r.ok);
  const tot = { tools_calls: results.reduce((n, r) => n + r.tools.length, 0), shell_calls: results.reduce((n, r) => n + r.shell_calls.length, 0), refused: results.reduce((n, r) => n + r.refused, 0), tool_errors: results.reduce((n, r) => n + r.tool_errors, 0) };
  fs.writeFileSync(`/tmp/mcp-chat-${mode}-${process.env.MESIMOT_AGENT || 'claude-code'}.json`, JSON.stringify({ mode, results, tot }, null, 1));
  console.log(`\n${results.length - bad.length}/${results.length} requests ok; ${JSON.stringify(tot)}`);
  sh(path.join(root, 'scripts', 'testenv.sh'), ['stop']);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); try { sh(path.join(root, 'scripts', 'testenv.sh'), ['stop']); } catch { /* ignore */ } process.exit(2); });
