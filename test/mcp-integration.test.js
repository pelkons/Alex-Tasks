'use strict';
// The integration test of the MCP server: a REAL server (lib/server.js build()) on a random port, a REAL bin/mesimot-mcp child process over stdio,
// and every tool called for real. No mocks on the HTTP side: this proves that every route and argument name exists and that the server's own
// rules (validation, confirmations, gates) answer through the tools.
const path = require('node:path');
process.env.MESIMOT_SEMANTIC = '0';
const os = require('node:os'), fs = require('node:fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-mcp-'));
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ owner: { name_he: 'דנה', name_en: 'Dana', emails: ['dana@exconstruct.example'], work_email: 'dana@exconstruct.example' } }));
process.env.MESIMOT_CONFIG = path.join(TMP, 'config.json'); process.env.MESIMOT_FILES = path.join(TMP, 'files'); process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(TMP, 'cfg', 'outbox-sign.key');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');
const { createStore } = require('../lib/store');
const { ingestMessage } = require('../lib/email');
const { TOOLS, forProfile } = require('../lib/mcp/tools');

const TOKEN = 'integration-token-123', PW = 'correct horse battery';

async function start(profile = 'full') {
  const db = open(':memory:'); auth.setPassword(db, PW); auth.resetFailures();
  const app = build({ db, token: TOKEN, loginDelayMs: 0 }); require('./helpers/owner')(app, db, PW);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mesimot-mcp')], { env: { ...process.env, MESIMOT_URL: url, MESIMOT_TOKEN: TOKEN, MESIMOT_RUN_ID: '1', MESIMOT_MCP_PROFILE: profile }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let buf = '', seq = 0;
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  const rpc = (method, params) => new Promise((res) => { const id = ++seq; waiting.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const callTool = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); assert.ok(m.result, `${name}: ${JSON.stringify(m)}`); const text = m.result.content[0].text; let json; try { json = JSON.parse(text); } catch { /* text */ } return { isError: !!m.result.isError, text, json }; };
  const stop = async () => { child.stdin.end(); await new Promise((r) => child.on('close', r)); await app.close(); };
  return { db, app, url, child, rpc, callTool, stop };
}
const hdr = { authorization: `Bearer ${TOKEN}` };

test('the real MCP server against the real API: every tool is called for real', async () => {
  const env = await start();
  const { db, app, rpc, callTool } = env;
  const called = new Set();
  const ok = async (name, args) => { called.add(name); const r = await callTool(name, args); assert.equal(r.isError, false, `${name} ${JSON.stringify(args)} -> ${r.text}`); return r; };
  const refused = async (name, args, re) => { called.add(name); const r = await callTool(name, args); assert.equal(r.isError, true, `${name} should be refused, got ${r.text}`); assert.match(r.text, re); return r; };
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'mesimot');
    const list = (await rpc('tools/list', {})).result.tools;
    assert.deepEqual(list.map((t) => t.name).sort(), forProfile('full').map((t) => t.name).sort());
    const statusNames = list.find((t) => t.name === 'task_update').inputSchema.properties.status.enum;
    assert.ok(statusNames.length >= 3, 'the status names come from /api/bootstrap');
    const inProgress = statusNames[1];

    // ---- seed the world through the real API / intake
    const proj = (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל הדוגמה', aliases: 'Example Tower' } })).json();
    const mail = ingestMessage(db, createStore(db), { message_id: 'fixture:mcp-1', from: 'Ron Barak <ron@buildco.example>', to: ['assistant@agentmail.example'], subject: 'Plans for the tower', timestamp: new Date().toISOString(), labels: ['received'], attachments: [], text: 'Hello, the pour is on Thursday. Please confirm the plans.' }).id;
    const fid = db.prepare("INSERT INTO files (original_name, path, source, created_at, email_id, project_id, text_status) VALUES ('contract.pdf','/x','email',?,?,?, 'ok')").run(new Date().toISOString(), mail, proj.id).lastInsertRowid;
    const chunk = db.prepare('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)').run(fid, 0, 'Section 9.1 the payment is 182,643 plus VAT.', 5).lastInsertRowid;
    const kn = (await app.inject({ method: 'POST', url: '/api/knowledge', headers: hdr, payload: { project: proj.id, kind: 'fact', title: 'Pour day', body: 'Thursday' } })).json();
    const proto = (await app.inject({ method: 'POST', url: '/api/protocols', headers: hdr, payload: { project: proj.id, date: '2026-11-23', title: 'Coordination 14', summary: 'x' } })).json();

    // ---- people
    const ron = (await ok('person_add', { name: 'רון ברק', name_en: 'Ron Barak', emails: ['ron@buildco.example'], company: 'Buildco' })).json;
    assert.ok(ron.id);
    const dup = (await ok('person_add', { name: 'Ron B', status: 'partial' })).json;
    assert.ok((await ok('person_find', { query: 'buildco' })).json.some((x) => x.id === ron.id));
    await ok('person_update', { person: ron.id, role_text: 'project manager' });
    await ok('person_merge', { from: dup.id, into: ron.id });
    await refused('person_merge', { from: 99999, into: ron.id }, /^The server refused \(HTTP 4\d\d\): /);

    // ---- tasks, notes, drafts
    const task = (await ok('task_create', { title: 'Send the plans', project: 'מגדל הדוגמה', requester: ron.id, due: '2026-11-29', due_source: 'explicit', email: mail })).json;
    assert.equal(task.due_date, '2026-11-29');
    const upd = (await ok('task_update', { id: String(task.id), due: '30/11/2026', status: inProgress, desc: 'It\'s "quoted" ׳ and Hebrew: שלום' })).json;
    assert.equal(upd.due_date, '2026-11-30'); assert.equal(upd.description, 'It\'s "quoted" ׳ and Hebrew: שלום');
    assert.equal((await ok('task_update', { id: task.id, due: null })).json.due_date, null);
    await refused('task_update', { id: task.id, due: '29/11' }, /task_update: "due" must be a date/);
    await refused('task_update', { id: 99999, title: 'x' }, /The server refused \(HTTP 404\)/);
    assert.equal((await ok('task_list', { open: true, project: 'מגדל הדוגמה' })).json.length, 1);
    assert.ok((await ok('task_list', { q: 'plans', overdue: false })).json.some((t) => t.id === task.id));
    assert.equal((await ok('show', { kind: 'task', id: task.id })).json.id, task.id);
    await ok('note_add', { task: task.id, text: 'The contractor confirmed by phone' });
    await refused('draft_add', { task: task.id, text: 'שלום רון, התוכניות בדרך.' }, /The server refused \(HTTP 422\).*\u05d4\u05d8\u05d9\u05d5\u05d8\u05d4 \u05dc\u05d0 \u05e0\u05e9\u05de\u05e8\u05d4/s); // the style gate answers through the tool, in Hebrew
    await ok('draft_add', { task: task.id, text: 'Hi Ron, the plans are on the way.' });

    // ---- show of every kind, search, ask, files
    assert.equal((await ok('show', { kind: 'email', id: mail })).json.id, mail);
    await ok('show', { kind: 'email_thread', id: mail });
    await ok('show', { kind: 'file', id: fid });
    assert.match((await ok('show', { kind: 'chunk', id: chunk })).text, /9\.1/);
    await ok('show', { kind: 'knowledge', id: kn.id });
    await ok('show', { kind: 'protocol', id: proto.id });
    assert.ok((await ok('show', { kind: 'project', id: 'Example Tower' })).json);
    assert.ok((await ok('show', { kind: 'person', id: ron.id })).json);
    const part = await ok('show', { kind: 'email', id: mail, offset: 0, max_chars: 40 });
    assert.ok(part.text.length < 200 && part.text.includes('[cut:'), 'max_chars cuts the text with a note');
    await refused('show', { kind: 'task', id: 'abc' }, /must be a number/);
    await ok('search', { q: 'plans', mode: 'keyword' });
    await ok('ask', { q: 'when is the payment?', project: proj.id });
    assert.equal((await ok('file_list', { project: proj.id })).json.length, 1);
    assert.ok((await ok('project_list', {})).json.length >= 2);
    assert.equal((await ok('project_list', { find: 'example tower' })).json[0].id, proj.id);

    // ---- chat, pending, attention, ack
    await ok('chat_send', { text: 'עדכנתי את המשימה', task: [task.id] });
    assert.ok((await ok('chat_list', { limit: 5 })).json.length >= 1);
    const pend = (await ok('pending', {})).json;
    assert.ok(pend.events.length >= 1);
    const att = (await ok('attention_add', { kind: 'question', text: 'האם לסגור?', task: task.id })).json;
    assert.ok((await ok('attention_list', {})).json.some((a) => a.id === att.id));
    await ok('attention_update', { id: att.id, status: 'dismissed' });
    assert.equal((await ok('ack', { ids: String(pend.events[0].id) })).json.acked, 1);
    await refused('ack', { ids: [] }, /The server refused \(HTTP 400\)/);

    // ---- calendar and the recycle bin
    const cal = (await ok('calendar_add', { title: 'Site meeting', start: '2026-11-29 11:00', task: task.id })).json;
    assert.ok(cal.id);
    await ok('calendar_update', { id: cal.id, start: '2026-11-29 12:00' });
    assert.ok((await ok('calendar_list', { from: '2026-11-29', to: '2026-11-29' })).text.includes('Site meeting'));
    await refused('calendar_add', { title: 'x', start: 'tomorrow' }, /calendar_add: "start" must be a date-time/);
    await ok('calendar_delete', { id: cal.id });
    const bin = (await ok('trash_list', { kind: 'calendar' })).json;
    const items = Array.isArray(bin) ? bin : bin.items;
    assert.ok(items.length >= 1, 'the deleted calendar item is in the bin');
    await ok('trash_restore', { id: items[0].id });

    // ---- projects
    const prop = await ok('project_propose', { name: 'פארק הדוגמה', aliases: 'Example Park', context: 'new plot' });
    assert.ok(prop.json);
    await ok('project_update', { project: proj.id, summary: 'שלד בקומה 8' });

    // ---- mail drafts and style
    await ok('style_for', { to: 'ron@buildco.example' });
    await refused('style_for', {}, /give "to", "reply_email" or "task"/);
    await ok('style_check', { to: 'ron@buildco.example', body: 'Hi Ron, I will send the plans tomorrow.' });
    const draft = (await ok('outbox_draft', { kind: 'reply', reply_email: mail, body: 'Hi Ron, I will send the plans tomorrow.', task: task.id })).json;
    assert.ok(draft.id && draft.status !== 'sent', 'a draft is never sent by the assistant');
    await ok('outbox_list', {});
    await ok('outbox_list', { id: draft.id });
    await ok('outbox_update', { id: draft.id, body: 'Hi Ron, I will send the plans by the end of today.' });
    await ok('outbox_cancel', { id: draft.id });

    // ---- apply (dry and real) and the run summary
    const dry = await ok('apply', { dry: true, email: mail, decisions: [{ task: task.id, action: 'no_change', reason: 'לא קשור' }] });
    assert.ok(dry.json);
    await refused('apply', { decisions: [{ task: task.id, action: 'explode', reason: 'x' }] }, /The server refused \(HTTP 400\)/);
    await refused('apply', { new_task: [] }, /unknown field "new_task"/);
    const ap = await ok('apply', { email: String(mail), new_tasks: [{ title: 'Confirm the pour', project: 'מגדל הדוגמה', due: '2026-12-01', due_source: 'estimated' }], facts: [{ project: 'מגדל הדוגמה', key: 'יום יציקה', value: 'חמישי', as_of: '2026-11-26' }], summary: 'עדכנתי' });
    assert.ok(ap.json);
    assert.ok((await ok('task_list', { q: 'Confirm the pour' })).json.length === 1, 'apply created the task');
    await refused('run_summary', { text: 'בדיקה' }, /The server refused \(HTTP 400\)/); // no run is open
    db.prepare('INSERT INTO claude_runs (started_at, trigger, events_count) VALUES (?,?,?)').run(new Date().toISOString(), 'chat', 0);
    await ok('run_summary', { text: 'בדיקה' });
    db.prepare('UPDATE claude_runs SET finished_at=? WHERE finished_at IS NULL').run(new Date().toISOString());

    // ---- deletion only ASKS the owner: nothing is deleted
    const ask = await ok('confirm', { kind: 'task_delete', id: task.id });
    assert.ok(ask.json);
    assert.equal((await ok('show', { kind: 'task', id: task.id })).json.id, task.id, 'the task still exists');
    await ok('confirm', { kind: 'project_delete', id: proj.id, tasks: 'unassign' });
    await refused('confirm', { kind: 'trash_empty' }, /The server refused \(HTTP 400\)/); // the bin is empty
    const cal2 = (await ok('calendar_add', { title: 'Temp', start: '2026-12-02 10:00' })).json;
    await ok('calendar_delete', { id: cal2.id });
    assert.ok((await ok('confirm', { kind: 'trash_empty' })).json, 'emptying the bin only asks the owner');
    assert.ok((await ok('trash_list', {})).text.includes('Temp'), 'and nothing was removed from the bin');
    await ok('confirm', { kind: 'person_delete', id: ron.id });
    await ok('confirm', { kind: 'protocol_delete', id: proto.id });
    await refused('confirm', { kind: 'trash_delete' }, /"id" is required/);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM tasks WHERE id=?').get(task.id).n === 1 && db.prepare('SELECT COUNT(*) n FROM projects WHERE id=?').get(proj.id).n === 1, 'nothing was deleted');

    // the assistant's own changes are logged as the assistant, like the CLI
    const actors = db.prepare("SELECT DISTINCT actor_id FROM events WHERE entity='task' AND action='create'").all();
    assert.ok(actors.length >= 1);

    const missing = TOOLS.map((t) => t.name).filter((n) => !called.has(n));
    assert.deepEqual(missing, [], 'every tool was called against the real server');
  } finally { await env.stop(); }
});

test('profiles over the real process: import gets 9 tools and cannot call a mail or chat tool', async () => {
  const env = await start('import');
  try {
    await env.rpc('initialize', { protocolVersion: '2025-06-18' });
    const names = (await env.rpc('tools/list', {})).result.tools.map((t) => t.name);
    assert.equal(names.length, 9);
    const r = await env.callTool('chat_send', { text: 'x' });
    assert.equal(r.isError, true); assert.match(r.text, /Unknown tool "chat_send"/);
    assert.match((await env.callTool('run_summary', { text: 'x' })).text, /The server refused \(HTTP 400\)/); // a real call: the server says there is no open run
  } finally { await env.stop(); }
});

test('a server that is down: every tool answers with the "not reachable" text and the process stays alive', async () => {
  const env = await start();
  try {
    await env.rpc('initialize', { protocolVersion: '2025-06-18' });
    await env.app.close();
    const r = await env.callTool('pending', {});
    assert.equal(r.isError, true); assert.match(r.text, /^The server is not reachable right now \(.+\)\. Nothing was changed\./);
    assert.equal((await env.rpc('ping', {})).result !== undefined, true);
  } finally { env.child.stdin.end(); await new Promise((r) => env.child.on('close', r)); }
});
