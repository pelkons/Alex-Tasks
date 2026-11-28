'use strict';
// Every tool: valid arguments make the right HTTP call (method, URL, query, body); invalid ones are refused before any call.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS, forProfile, PROFILES } = require('../lib/mcp/tools');
const { validateArgs } = require('../lib/mcp/validate');
const { createMcpServer, formatResult, CAP } = require('../lib/mcp/server');

function fakeApi(replies = {}) {
  const calls = [];
  const rec = (m) => async (url, body, query) => { calls.push({ m, url, ...(m === 'GET' ? (body ? { query: body } : {}) : { ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) }) }); return replies[m + ' ' + url] ?? { ok: true }; };
  return { calls, get: rec('GET'), post: rec('POST'), patch: rec('PATCH'), del: rec('DELETE') };
}
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
async function run(name, args, replies) {
  const api = fakeApi(replies);
  const v = validateArgs(byName[name], args, {});
  assert.ok(v.ok, v.error);
  await byName[name].call(v.value, api);
  return api.calls;
}

// name -> [valid args, expected calls]. A new tool without a line here fails the coverage test below.
const CASES = {
  show: [{ kind: 'task', id: '104' }, [{ m: 'GET', url: '/api/tasks/104' }]],
  task_list: [{ open: true, project: 'Tower', overdue: true, limit: 5 }, [{ m: 'GET', url: '/api/tasks', query: { open: true, project: 'Tower', overdue: true, limit: 5 } }]],
  search: [{ q: 'pour', project: 'Tower', archive: true, mail_archive: 'only' }, [{ m: 'GET', url: '/api/search', query: { q: 'pour', project: 'Tower', archive: true, mail_archive: 'only' } }]],
  ask: [{ q: 'when?', project: 3 }, [{ m: 'GET', url: '/api/ask', query: { q: 'when?', project: 3 } }]],
  project_list: [{}, [{ m: 'GET', url: '/api/projects' }]],
  person_find: [{ query: 'dana' }, [{ m: 'GET', url: '/api/people' }]],
  file_list: [{ project: 2 }, [{ m: 'GET', url: '/api/files', query: { project: 2 } }]],
  chat_list: [{}, [{ m: 'GET', url: '/api/chat', query: { limit: 20 } }]],
  pending: [{}, [{ m: 'GET', url: '/api/pending' }]],
  attention_list: [{ status: 'all' }, [{ m: 'GET', url: '/api/attention', query: { status: 'all' } }]],
  calendar_list: [{ from: '2026-11-29', to: '2026-12-05' }, [{ m: 'GET', url: '/api/calendar', query: { from: '2026-11-29', to: '2026-12-05' } }]],
  outbox_list: [{ status: 'pending' }, [{ m: 'GET', url: '/api/outbox', query: { status: 'pending' } }]],
  trash_list: [{ kind: 'task' }, [{ m: 'GET', url: '/api/trash', query: { kind: 'task' } }]],
  style_for: [{ to: 'dana@x.example' }, [{ m: 'GET', url: '/api/styles/for', query: { to: 'dana@x.example' } }]],
  apply: [{ dry: true, email: '7', decisions: [{ task: 1, action: 'no_change', reason: 'x' }], summary: 's' }, [{ m: 'POST', url: '/api/apply', body: { email: 7, decisions: [{ task: 1, action: 'no_change', reason: 'x' }], summary: 's' }, query: { dry: '1' } }]],
  run_summary: [{ text: 'סיכום' }, [{ m: 'POST', url: '/api/run-summary', body: { text: 'סיכום' } }]],
  task_create: [{ title: 'T', project: 'P', due: '2026-11-29', assignee: null, parent: 3 }, [{ m: 'POST', url: '/api/tasks', body: { title: 'T', project: 'P', due: '2026-11-29', assignee: null, parent: 3 } }]],
  task_update: [{ id: '104', due: 'none', status: 'בטיפול', desc: 'd' }, [{ m: 'PATCH', url: '/api/tasks/104', body: { due: null, status: 'בטיפול', desc: 'd' } }]],
  note_add: [{ task: 104, text: "it's \"quoted\"" }, [{ m: 'POST', url: '/api/notes', body: { task: 104, text: "it's \"quoted\"" } }]],
  draft_add: [{ task: 4, text: 'hi', long: true }, [{ m: 'POST', url: '/api/tasks/4/drafts', body: { text: 'hi', long: true } }]],
  chat_send: [{ text: 'hi', task: [5, 6], file: '7', main: true }, [{ m: 'POST', url: '/api/chat', body: { text: 'hi', task: '5,6', file: '7', main: true } }]],
  person_add: [{ name: 'דנה', emails: ['d@x.example'], status: 'partial' }, [{ m: 'POST', url: '/api/people', body: { name: 'דנה', emails: ['d@x.example'], status: 'partial' } }]],
  person_update: [{ person: 'דנה לוי', company: 'C' }, [{ m: 'PATCH', url: '/api/people/%D7%93%D7%A0%D7%94%20%D7%9C%D7%95%D7%99', body: { company: 'C' } }]],
  person_merge: [{ from: 14, into: 9 }, [{ m: 'POST', url: '/api/people/14/merge', body: { into: 9 } }]],
  project_propose: [{ name: 'Park', aliases: 'a,b', from: 'email:5' }, [{ m: 'POST', url: '/api/projects/propose', body: { name: 'Park', aliases: 'a,b', from: 'email:5' } }]],
  project_update: [{ project: 2, summary: 's' }, [{ m: 'PATCH', url: '/api/projects/2', body: { summary: 's' } }]],
  calendar_add: [{ title: 'Meet', start: '2026-11-29 11:00', task: 104 }, [{ m: 'POST', url: '/api/calendar/items', body: { title: 'Meet', start: '2026-11-29 11:00', task: 104 } }]],
  calendar_update: [{ id: 3, start: '30/11/2026 09:00' }, [{ m: 'PATCH', url: '/api/calendar/items/3', body: { start: '30/11/2026 09:00' } }]],
  calendar_delete: [{ id: 3 }, [{ m: 'DELETE', url: '/api/calendar/items/3' }]],
  attention_add: [{ kind: 'question', text: 'q', task: 4 }, [{ m: 'POST', url: '/api/attention', body: { kind: 'question', text: 'q', task: 4 } }]],
  attention_update: [{ id: 5, status: 'dismissed' }, [{ m: 'PATCH', url: '/api/attention/5', body: { status: 'dismissed' } }]],
  ack: [{ ids: '1,2' }, [{ m: 'POST', url: '/api/ack', body: { ids: [1, 2] } }]],
  outbox_draft: [{ to: 'a@x.example', subject: 'S', body: 'B', reply_email: 9, kind: 'reply' }, [{ m: 'POST', url: '/api/outbox', body: { kind: 'reply', to: 'a@x.example', subject: 'S', body: 'B', reply_email: 9 } }]],
  outbox_update: [{ id: 4, body: 'B2' }, [{ m: 'PATCH', url: '/api/outbox/4', body: { body: 'B2' } }]],
  outbox_cancel: [{ id: 4 }, [{ m: 'POST', url: '/api/outbox/4/cancel', body: {} }]],
  style_check: [{ to: 'a@x.example', body: 'B' }, [{ m: 'POST', url: '/api/styles/check', body: { to: 'a@x.example', body: 'B' } }]],
  confirm: [{ kind: 'project_delete', id: 'Tower', tasks: 'move:Park' }, [{ m: 'POST', url: '/api/confirm', body: { kind: 'project_delete', id: 'Tower', payload: { tasks: 'move:Park' } } }]],
  trash_restore: [{ id: 7 }, [{ m: 'POST', url: '/api/trash/7/restore', body: {} }]],
};
// invalid arguments: refused before any HTTP call, and the message names the field and shows an example
const BAD = {
  show: [{ kind: 'house', id: 1 }, /"kind" must be one of/],
  task_list: [{ limit: 'many' }, /"limit" must be an integer/],
  search: [{}, /"q" is required/],
  ask: [{ q: '' }, /"q" must not be empty/],
  project_list: [{ find: 5, extra: 1 }, /unknown field "extra"/],
  person_find: [{}, /"query" is required/],
  file_list: [{ project: { a: 1 } }, /"project"/],
  chat_list: [{ limit: 0 }, /"limit" must be at least 1/],
  pending: [{ x: 1 }, /unknown field/],
  attention_list: [{ status: 'done' }, /"status" must be one of/],
  calendar_list: [{ from: '29/11' }, /"from" must be a date/],
  outbox_list: [{ id: 'x' }, /"id" must be an integer/],
  trash_list: [{ kind: 'mail' }, /"kind" must be one of/],
  style_for: [{}, /give "to", "reply_email" or "task"/],
  apply: [{ new_task: [] }, /unknown field "new_task"/],
  run_summary: [{ text: '' }, /"text" must not be empty/],
  task_create: [{ title: 'T', due: '29/11' }, /"due" must be a date YYYY-MM-DD/],
  task_update: [{ due: '2026-11-29' }, /"id" is required/],
  note_add: [{ text: 'x' }, /give "task" or "project"/],
  draft_add: [{ task: 4 }, /"text" is required/],
  chat_send: [{}, /"text" is required/],
  person_add: [{ name: '' }, /"name" must not be empty/],
  person_update: [{ company: 'C' }, /"person" is required/],
  person_merge: [{ from: 1 }, /"into" is required/],
  project_propose: [{}, /"name" is required/],
  project_update: [{ summary: 's' }, /"project" is required/],
  calendar_add: [{ title: 'x', start: 'tomorrow' }, /"start" must be a date-time/],
  calendar_update: [{ id: 'abc' }, /"id" must be an integer/],
  calendar_delete: [{}, /"id" is required/],
  attention_add: [{ kind: 'alarm', text: 'x' }, /"kind" must be one of/],
  attention_update: [{ id: 1, status: 'x' }, /"status" must be one of/],
  ack: [{ ids: ['a'] }, /"ids\[0\]" must be an integer/],
  outbox_draft: [{ kind: 'send' }, /"kind" must be one of/],
  outbox_update: [{ body: 'x' }, /"id" is required/],
  outbox_cancel: [{}, /"id" is required/],
  style_check: [{ to: 'a' }, /"body" is required/],
  confirm: [{ kind: 'task_delete' }, /"id" is required for kind "task_delete"/],
  trash_restore: [{ id: 'x' }, /"id" must be an integer/],
};

test('every tool has a name, a short description, a schema, an example valid for it and a profile list', () => {
  const seen = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z_]*$/); assert.ok(!seen.has(t.name), 'duplicate ' + t.name); seen.add(t.name);
    assert.ok(t.description.length > 10 && t.description.length < 260, `${t.name}: description length ${t.description.length}`);
    assert.equal(typeof t.call, 'function');
    assert.ok(t.profiles.includes('full') && t.profiles.every((p) => PROFILES.includes(p)));
    const v = validateArgs(t, t.example, {}); assert.ok(v.ok, `${t.name} example: ${v.error}`);
    assert.ok(!('required' in t.schema) || t.schema.required.every((k) => k in t.schema.properties), `${t.name}: required names unknown properties`);
  }
  assert.ok(TOOLS.length >= 35 && TOOLS.length <= 45, `about 40 tools, got ${TOOLS.length}`);
});

test('coverage: every tool has a call test and a refusal test', () => {
  assert.deepEqual(Object.keys(CASES).sort(), TOOLS.map((t) => t.name).sort());
  assert.deepEqual(Object.keys(BAD).sort(), TOOLS.map((t) => t.name).sort());
});

for (const [name, [args, expected]] of Object.entries(CASES)) {
  test(`${name}: valid arguments make the expected call`, async () => {
    const calls = await run(name, args, name === 'person_find' || name === 'project_list' ? { 'GET /api/people': [], 'GET /api/projects': [] } : undefined);
    assert.deepEqual(calls, expected);
  });
}
for (const [name, [args, re]] of Object.entries(BAD)) {
  test(`${name}: invalid arguments are refused before any HTTP call`, async () => {
    const api = fakeApi();
    const s = createMcpServer({ api });
    const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, re);
    assert.match(r.result.content[0].text, new RegExp(`^${name}: `), 'the message starts with the tool name');
    assert.equal(api.calls.filter((c) => c.url !== '/api/bootstrap').length, 0, 'no HTTP call for the tool');
  });
}

test('person_find and project_list filter what the API returns, like the CLI', async () => {
  const people = [{ id: 1, name_he: 'דנה לוי', name_en: 'Dana Levi', emails: ['dana@exconstruct.example'], company: 'Example Construction' }, { id: 2, name_he: 'רון', emails: ['ron@x.example'] }];
  const api = fakeApi({ 'GET /api/people': people, 'GET /api/projects': [{ id: 1, name_he: 'מגדל הדוגמה', aliases: ['Example Tower'], open_count: 3 }, { id: 2, name_he: 'פארק', aliases: [] }] });
  assert.deepEqual((await byName.person_find.call({ query: 'EXCONSTRUCT' }, api)).map((x) => x.id), [1]);
  assert.deepEqual((await byName.project_list.call({ find: 'tower' }, api)).map((x) => x.id), [1]);
  assert.equal((await byName.project_list.call({}, api)).length, 2);
});

test('show needs a numeric id except for project and person (names work there)', async () => {
  const api = fakeApi();
  await assert.rejects(() => byName.show.call({ kind: 'email', id: 'abc' }, api), /"id" must be a number for kind "email"/);
  await byName.show.call({ kind: 'project', id: 'מגדל' }, api);
  assert.equal(api.calls[0].url, '/api/projects/%D7%9E%D7%92%D7%93%D7%9C/show');
});

test('profiles: full has every tool; import and apply_only are small and always have apply and run_summary', () => {
  assert.equal(forProfile('full').length, TOOLS.length);
  const imp = forProfile('import').map((t) => t.name), ao = forProfile('apply_only').map((t) => t.name);
  for (const n of ['apply', 'run_summary', 'show', 'search']) { assert.ok(imp.includes(n) && ao.includes(n), n); }
  assert.ok(imp.includes('person_find') && imp.includes('project_list') && !ao.includes('person_find'));
  for (const bad of ['outbox_draft', 'confirm', 'chat_send', 'task_update', 'calendar_delete', 'trash_restore']) assert.ok(!imp.includes(bad) && !ao.includes(bad), bad);
  assert.deepEqual(forProfile('nothing'), []);
});

test('no owner-only action is a tool', () => {
  const names = TOOLS.map((t) => t.name).join(' ');
  for (const banned of ['sql', 'password', 'rekey', 'backup', 'vault', 'connector', 'style_analyse', 'project_add', 'approve', 'send_mail', 'trash_delete', 'trash_empty', 'task_delete']) assert.ok(!names.includes(banned), banned);
  assert.ok(byName.confirm.description.includes('Nothing is deleted until he presses yes'));
});

test('output: compact JSON, cut at 20,000 characters with a note, offset and max_chars page through it', () => {
  assert.equal(formatResult({ a: [1, 2] }), '{"a":[1,2]}');
  const big = { t: 'x'.repeat(50000) };
  const first = formatResult(big, { windowed: true });
  assert.ok(first.length < CAP + 120);
  assert.match(first, /\.\.\.\[cut: \d+ more characters; call again with offset=20000\]$/);
  const next = formatResult(big, { windowed: true, offset: 20000 });
  assert.match(next, /offset=40000\]$/);
  const last = formatResult(big, { windowed: true, offset: 40000 });
  assert.ok(!last.includes('[cut'));
  assert.equal(formatResult(big, { windowed: true, offset: 100, maxChars: 10 }).slice(0, 10), JSON.stringify(big).slice(100, 110));
  assert.match(formatResult({ t: 'y'.repeat(30000) }), /narrow the request/);
  assert.match(formatResult('abc', { offset: 99 }), /beyond the end/);
});
