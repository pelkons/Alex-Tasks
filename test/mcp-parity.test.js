'use strict';
// Tool parity: every command of bin/mesimot that the assistant may use has an MCP tool. A new CLI command fails this test until it gets a tool
// (field `cli` of the tool, table CLI in lib/mcp/tools.js) or is put on the owner/administrator list (CLI_ONLY).
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS, CLI_ONLY } = require('../lib/mcp/tools');
const { cliCommands } = require('./helpers/cli-commands');

const commands = cliCommands();
const covered = new Map();
for (const t of TOOLS) for (const c of t.cli) { assert.ok(!covered.has(c), `"${c}" is claimed by two tools`); covered.set(c, t.name); }

test('the parser finds the commands of bin/mesimot', () => {
  for (const c of ['task add', 'apply', 'outbox draft', 'protocol item promote', 'trash empty', 'style suggest', 'archive estimate', 'filter disable']) assert.ok(commands.includes(c), c);
  assert.ok(commands.length > 80, `${commands.length} commands`);
});

test('every CLI command is a tool or on the CLI-only list', () => {
  const missing = commands.filter((c) => !covered.has(c) && !CLI_ONLY.includes(c));
  assert.deepEqual(missing, [], `these commands have no MCP tool: add one in lib/mcp/tools.js (and its cases in test/mcp-tools.test.js), or add the command to CLI_ONLY if only the owner may use it`);
});

test('no stale names: every claimed or CLI-only command exists in bin/mesimot, and nothing is both', () => {
  assert.deepEqual([...covered.keys()].filter((c) => !commands.includes(c)), []);
  assert.deepEqual(CLI_ONLY.filter((c) => !commands.includes(c)), []);
  assert.deepEqual(CLI_ONLY.filter((c) => covered.has(c)), []);
});

test('the commands the CLI refuses to the assistant (MESIMOT_AGENT_MODE) are never tools', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'bin', 'mesimot'), 'utf8');
  for (const c of ['web-password', 'rekey', 'backup', 'vault cat', 'sql', 'calendar-token', 'telegram bind', 'push test', 'style analyse', 'style try']) assert.ok(CLI_ONLY.includes(c), c);
  assert.ok((src.match(/MESIMOT_AGENT_MODE/g) || []).length >= 10);
});
