'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const vault = require('../lib/vault');
const { report } = require('../scripts/mcp-report');

test('the report counts MCP calls, shell calls, refused Bash, tool errors and server refusals per day and job, for every adapter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcprep-')); const db = open(':memory:');
  const at = new Date().toISOString();
  const run = (trigger) => db.prepare('INSERT INTO claude_runs (started_at, trigger, events_count) VALUES (?,?,0)').run(at, trigger).lastInsertRowid;
  const use = (runId, job, tok) => db.prepare('INSERT INTO run_usage (run_id, at, job, adapter, turns, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?)').run(runId, at, job, 'claude-code', 3, tok, 10, 0.02);
  const w = (id, label, calls, stream = '') => { vault.writeFile(path.join(dir, `${id}${label}.tools.json`), Buffer.from(JSON.stringify(calls))); vault.writeFile(path.join(dir, `${id}${label}.stream.jsonl`), Buffer.from(stream)); };
  const a = run('chat'); use(a, 'chat', 1000);
  w(a, '', [{ tool: 'mcp__mesimot__task_update', input: {} }, { tool: 'mcp__mesimot__chat_send', input: {} }, { tool: 'Bash', input: { command: 'mesimot pending' } }],
    [JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't9' }), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'x' }] } })].join('\n'));
  const b = run('chat'); use(b, 'chat', 3000);
  w(b, '', [{ tool: 'mcp__mesimot__apply', input: {} }, { tool: 'shell', input: { command: 'x' } }]);
  db.prepare("INSERT INTO mcp_errors (at, run_id, method, path, status) VALUES (?,?,?,?,?)").run(at, a, 'PATCH', '/api/tasks/:id', 400);
  const rep = report({ db, runsDir: dir, days: 3 });
  assert.equal(rep.rows.length, 1);
  const r = rep.rows[0];
  assert.deepEqual([r.job, r.runs, r.mcp_calls, r.shell_calls, r.mcp_share, r.refused_bash, r.tool_errors], ['chat', 2, 3, 2, 0.6, 1, 1]);
  assert.equal(r.calls.mcp__mesimot__apply, 1); assert.equal(r.tokens_per_run, 2010);
  assert.equal(rep.server_refusals[0].n, 1);
});
