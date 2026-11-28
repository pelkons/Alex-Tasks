'use strict';
// The MCP server for the assistant: newline-delimited JSON-RPC 2.0 over stdio (initialize, ping, tools/list, tools/call), one stateless process per run.
// No dependency: the protocol subset Claude Code needs is small. It never opens the database; every tool is an HTTP call (lib/mcp/tools.js).
const { forProfile, PROFILES } = require('./tools');
const { validateArgs } = require('./validate');
const { createApi, ToolError } = require('./api');

const CAP = 20000; // characters per result: far below Claude Code's MAX_MCP_OUTPUT_TOKENS
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LOOKUP_WAIT_MS = 3000;
const SELF_EVIDENT = 26; // descriptions up to this length are left out of the tool list

// the exposed JSON schema: only standard keywords; a lookup becomes an enum of the current names
function publicSchema(schema, lookups) {
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'expect' || k === 'lookup') continue;
    if (k === 'description' && typeof v === 'string' && v.length <= SELF_EVIDENT) continue; // "Task id", "Title": the name says it; the list is sent on every run
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, publicSchema(s, lookups)]));
    else if (k === 'items') out.items = publicSchema(v, lookups);
    else out[k] = v;
  }
  if (schema.lookup && lookups?.[schema.lookup]) out.enum = lookups[schema.lookup].map((r) => r.name_he);
  return out;
}

// compact text for one result, cut at CAP; `offset` / `max_chars` page through a long one
function formatResult(data, { offset = 0, maxChars, windowed = false } = {}) {
  const full = typeof data === 'string' ? data : JSON.stringify(data === undefined ? null : data);
  if (offset > full.length) return `[offset ${offset} is beyond the end: the text has ${full.length} characters]`;
  const limit = Math.min(maxChars || CAP, CAP);
  const part = full.slice(offset, offset + limit);
  const left = full.length - (offset + part.length);
  if (left <= 0) return part;
  return `${part}...[cut: ${left} more characters; ${windowed ? `call again with offset=${offset + part.length}` : 'narrow the request with filters or a limit'}]`;
}

function createMcpServer({ profile = 'full', api = createApi(), debug = !!process.env.MESIMOT_MCP_DEBUG, log = (...a) => process.stderr.write(a.join(' ') + '\n') } = {}) {
  if (!PROFILES.includes(profile)) profile = 'full';
  const tools = forProfile(profile);
  const byName = new Map(tools.map((t) => [t.name, t]));
  let lookups = null, lookupsTried = false;

  async function loadLookups() {
    if (lookups || lookupsTried) return lookups;
    lookupsTried = true;
    try {
      const b = await Promise.race([api.get('/api/bootstrap'), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), LOOKUP_WAIT_MS).unref())]);
      if (b && Array.isArray(b.statuses) && Array.isArray(b.priorities)) lookups = { statuses: b.statuses.map((x) => ({ id: x.id, name_he: x.name_he })), priorities: b.priorities.map((x) => ({ id: x.id, name_he: x.name_he })) };
    } catch { /* the server may be down: the lists are then not checked here, the server checks them */ }
    return lookups;
  }

  const errResult = (text) => ({ content: [{ type: 'text', text }], isError: true });
  async function callTool(name, args) {
    const t = byName.get(name);
    if (!t) return errResult(`Unknown tool "${name}". Available: ${tools.map((x) => x.name).join(', ')}`);
    try {
      if (JSON.stringify(t.schema).includes('"lookup"')) await loadLookups();
      const v = validateArgs(t, args, { lookups });
      if (!v.ok) return errResult(v.error);
      const data = await t.call(v.value, api);
      return { content: [{ type: 'text', text: formatResult(data, { offset: t.textWindow ? v.value.offset : 0, maxChars: t.textWindow ? v.value.max_chars : undefined, windowed: !!t.textWindow }) }] };
    } catch (e) {
      if (e instanceof ToolError) return errResult(e.message);
      if (debug) log('tool failed', name, e && e.stack);
      return errResult(`${name}: the tool failed unexpectedly (${String(e && e.message || e).slice(0, 200)}). Check with a read tool whether anything changed before you try again.`);
    }
  }

  // one JSON-RPC message in, one response (or undefined for a notification) out; never throws
  async function handle(msg) {
    try {
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
      const { id, method, params } = msg;
      const reply = (result) => (id === undefined || id === null ? undefined : { jsonrpc: '2.0', id, result });
      const fail = (code, message) => (id === undefined || id === null ? undefined : { jsonrpc: '2.0', id, error: { code, message } });
      switch (method) {
        case 'initialize': {
          const want = params?.protocolVersion;
          return reply({ protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: { name: 'mesimot', version: '1.0.0' } });
        }
        case 'ping': return reply({});
        case 'tools/list': {
          await loadLookups();
          return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', ...publicSchema(t.schema, lookups) } })) });
        }
        case 'tools/call': return reply(await callTool(params?.name, params?.arguments));
        case 'resources/list': return reply({ resources: [] });
        case 'prompts/list': return reply({ prompts: [] });
        default:
          if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      if (debug) log('handler failed', e && e.stack);
      return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32603, message: 'Internal error' } };
    }
  }

  // read lines from `input`, write responses to `output`; resolves when the input ends and every call is answered
  function serve(input = process.stdin, output = process.stdout) {
    return new Promise((resolve) => {
      let buf = '', pending = 0, ended = false;
      const send = (o) => { try { output.write(JSON.stringify(o) + '\n'); } catch { /* the pipe is gone */ } };
      const done = () => { if (ended && pending === 0) resolve(); };
      const line = (l) => {
        if (!l.trim()) return;
        let m; try { m = JSON.parse(l); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        for (const one of Array.isArray(m) ? m : [m]) { pending++; handle(one).then((r) => { if (r) send(r); }).finally(() => { pending--; done(); }); }
      };
      input.setEncoding && input.setEncoding('utf8');
      input.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); } });
      input.on('end', () => { if (buf.trim()) line(buf); buf = ''; ended = true; done(); });
      input.on('error', () => { ended = true; done(); });
    });
  }
  return { handle, serve, tools };
}

module.exports = { createMcpServer, formatResult, publicSchema, CAP };
