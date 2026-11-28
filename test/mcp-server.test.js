'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createMcpServer } = require('../lib/mcp/server');
const { createApi } = require('../lib/mcp/api');

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const fakeFetch = (routes) => async (url, init) => {
  const u = new URL(url); const key = `${init.method} ${u.pathname}`;
  const r = routes[key]; if (!r) return new Response(JSON.stringify({ error: 'לא נמצא' }), { status: 404 });
  if (r instanceof Error) throw r;
  return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
};
const server = (routes, opts = {}) => createMcpServer({ api: createApi({ base: 'http://x.example', token: 'tok', fetchImpl: fakeFetch(routes), ...opts }), log: () => {} });
const call = (s, name, args) => s.handle(rpc(1, 'tools/call', { name, arguments: args }));
const BOOT = { 'GET /api/bootstrap': { body: { statuses: [{ id: 1, name_he: 'פתוח' }, { id: 2, name_he: 'בטיפול' }], priorities: [{ id: 1, name_he: 'רגיל' }], people: [], projects: [] } } };

test('initialize answers with the tools capability; initialized and unknown notifications get no answer; unknown requests an error', async () => {
  const s = server({});
  const r = await s.handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
  assert.equal(r.result.protocolVersion, '2025-06-18'); assert.deepEqual(r.result.capabilities, { tools: {} }); assert.equal(r.result.serverInfo.name, 'mesimot');
  assert.equal((await s.handle(rpc(2, 'initialize', { protocolVersion: '1999-01-01' }))).result.protocolVersion, '2025-06-18');
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await s.handle(rpc(3, 'nope/nope'))).error.code, -32601);
  assert.deepEqual((await s.handle(rpc(4, 'ping'))).result, {});
});

test('tools/list: the profile decides the tools; status and priority show the current names', async () => {
  const full = (await server(BOOT).handle(rpc(1, 'tools/list'))).result.tools;
  assert.ok(full.length >= 35);
  const upd = full.find((t) => t.name === 'task_update');
  assert.deepEqual(upd.inputSchema.properties.status.enum, ['פתוח', 'בטיפול']);
  assert.equal(upd.inputSchema.properties.status.lookup, undefined);
  assert.equal(upd.inputSchema.properties.due.expect, undefined);
  assert.deepEqual(upd.inputSchema.required, ['id']);
  assert.equal(upd.inputSchema.additionalProperties, undefined);
  const imp = (await createMcpServer({ profile: 'import', api: createApi({ base: 'http://x.example', token: 't', fetchImpl: fakeFetch(BOOT) }) }).handle(rpc(1, 'tools/list'))).result.tools.map((t) => t.name);
  assert.ok(imp.length >= 20 && imp.length <= 25 && imp.includes('style_for') && imp.includes('apply') && !imp.includes('chat_send'));
  const unknown = createMcpServer({ profile: 'bogus', api: createApi({ token: 't', fetchImpl: fakeFetch(BOOT) }) });
  assert.equal(unknown.tools.length, full.length, 'an unknown profile falls back to full');
});

test('the tool list stays small: it is sent on every run', async () => {
  const list = JSON.stringify((await server(BOOT).handle(rpc(1, 'tools/list'))).result.tools);
  assert.ok(list.length < 30000, `the full list is ${list.length} characters`);
});

test('a status that is not in the lookups is refused before the call, with the names', async () => {
  const s = server({ ...BOOT, 'PATCH /api/tasks/5': { body: { id: 5 } } });
  const r = (await call(s, 'task_update', { id: 5, status: 'סגור' })).result;
  assert.equal(r.isError, true); assert.match(r.content[0].text, /must be one of פתוח, בטיפול/);
  assert.equal((await call(s, 'task_update', { id: 5, status: 'בטיפול' })).result.isError, undefined);
});

test('errors: 4xx keeps the Hebrew text of the server; 5xx and no connection say nothing was changed', async () => {
  const s = server({ ...BOOT, 'PATCH /api/tasks/5': { status: 400, body: { error: 'תאריך לא תקין' } }, 'GET /api/pending': { status: 500, body: { error: 'x' } }, 'GET /api/chat': new TypeError('fetch failed') });
  let r = (await call(s, 'task_update', { id: 5, due: '2026-02-30' })).result;
  assert.equal(r.isError, true); assert.equal(r.content[0].text, 'The server refused (HTTP 400): תאריך לא תקין');
  r = (await call(s, 'pending', {})).result;
  assert.match(r.content[0].text, /^The server is not reachable right now \(HTTP 500\)\. Nothing was changed\. Try once more; if it fails again, finish and say so in run_summary\.$/);
  r = (await call(s, 'chat_list', {})).result;
  assert.match(r.content[0].text, /^The server is not reachable right now \(fetch failed\)\. Nothing was changed/);
});

test('without a token nothing is sent and the error says so', async () => {
  const saved = { t: process.env.MESIMOT_TOKEN, f: process.env.MESIMOT_ENV_FILE };
  delete process.env.MESIMOT_TOKEN;
  try {
    let hit = false;
    const api = createApi({ base: 'http://x.example', fetchImpl: async () => { hit = true; return new Response('{}'); } });
    // the env file of this machine may hold a token: only assert when it does not
    const { readEnvFile } = require('../lib/envfile');
    if (!readEnvFile().MESIMOT_TOKEN) {
      const r = (await createMcpServer({ api }).handle(rpc(1, 'tools/call', { name: 'pending', arguments: {} }))).result;
      assert.match(r.content[0].text, /no API token/); assert.equal(hit, false);
    }
  } finally { if (saved.t !== undefined) process.env.MESIMOT_TOKEN = saved.t; }
});

test('the token and the run context go in headers, never in the body or the URL', async () => {
  const seen = [];
  const api = createApi({ base: 'http://x.example', token: 'secret-token-xyz', runId: '42', fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response('{}'); } });
  await createMcpServer({ api }).handle(rpc(1, 'tools/call', { name: 'run_summary', arguments: { text: 'x' } }));
  const { url, init } = seen[0];
  assert.equal(init.headers.Authorization, 'Bearer secret-token-xyz'); assert.equal(init.headers['X-Mesimot-Via'], 'mcp'); assert.equal(init.headers['X-Mesimot-Run'], '42');
  assert.ok(!url.includes('secret') && !String(init.body).includes('secret'));
});

test('a long result is cut at 20,000 characters and `show` pages through it with offset', async () => {
  const s = server({ 'GET /api/tasks/9': { body: { description: 'ש'.repeat(45000) } } });
  const a = (await call(s, 'show', { kind: 'task', id: 9 })).result.content[0].text;
  assert.ok(a.length < 20200); assert.match(a, /\[cut: \d+ more characters; call again with offset=20000\]$/);
  const b = (await call(s, 'show', { kind: 'task', id: 9, offset: 20000, max_chars: 5000 })).result.content[0].text;
  assert.match(b, /offset=25000\]$/);
});

test('an unknown tool, and a tool of another profile, give an error result (no crash)', async () => {
  const s = server({});
  assert.match((await call(s, 'rm_rf', {})).result.content[0].text, /Unknown tool "rm_rf"/);
  const imp = createMcpServer({ profile: 'apply_only', api: createApi({ token: 't', fetchImpl: fakeFetch({}) }) });
  assert.match((await imp.handle(rpc(1, 'tools/call', { name: 'chat_send', arguments: { text: 'x' } }))).result.content[0].text, /Unknown tool "chat_send"/);
  assert.match((await call(s, undefined, undefined)).result.content[0].text, /Unknown tool/);
});

test('a handler that throws becomes an error result', async () => {
  const s = server({});
  const t = s.tools.find((x) => x.name === 'pending'); const orig = t.call; t.call = () => { throw new Error('boom'); };
  try { const r = (await call(s, 'pending', {})).result; assert.equal(r.isError, true); assert.match(r.content[0].text, /pending: the tool failed unexpectedly \(boom\)/); } finally { t.call = orig; }
});

test('over stdio: garbage lines, batches, partial lines and a missing newline at the end never stop the server', async () => {
  const s = server({ ...BOOT, 'GET /api/pending': { body: [] } });
  const input = new PassThrough(), output = new PassThrough(); const lines = [];
  output.setEncoding('utf8'); let acc = ''; output.on('data', (d) => { acc += d; });
  const done = s.serve(input, output);
  input.write('not json at all\n');
  input.write('{"jsonrpc":"2.0","id":1,"meth');
  input.write('od":"ping"}\n');
  input.write('[1,2,{"jsonrpc":"2.0","id":2,"method":"ping"}]\n');
  input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pending","arguments":{}}}');
  input.end();
  await done;
  for (const l of acc.split('\n').filter(Boolean)) lines.push(JSON.parse(l));
  assert.ok(lines.some((l) => l.error?.code === -32700), 'parse error answered');
  assert.ok(lines.some((l) => l.id === 1 && l.result), 'a line split in two chunks works');
  assert.ok(lines.filter((l) => l.error?.code === -32600).length === 2, 'invalid batch members get invalid-request errors');
  assert.ok(lines.some((l) => l.id === 2 && l.result), 'a batch member works');
  assert.ok(lines.some((l) => l.id === 3 && l.result.content), 'the last line without a newline is still handled');
});

test('the process (bin/mesimot-mcp) answers over real stdio and exits when stdin closes', async () => {
  const { spawn } = require('node:child_process');
  const p = spawn(process.execPath, [require('path').join(__dirname, '..', 'bin', 'mesimot-mcp')], { env: { ...process.env, MESIMOT_TOKEN: 't', MESIMOT_URL: 'http://127.0.0.1:1', MESIMOT_MCP_PROFILE: 'apply_only' } });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  p.stdin.write(JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-06-18' })) + '\n' + 'garbage\n' + JSON.stringify(rpc(2, 'tools/list')) + '\n');
  p.stdin.end();
  const code = await new Promise((res) => p.on('close', res));
  assert.equal(code, 0);
  const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(msgs.find((m) => m.id === 2).result.tools.length, 22);
});
