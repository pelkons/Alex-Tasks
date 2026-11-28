'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { deniedCommands } = require('../lib/runner');

test('commands refused by the permission system are listed, the ones that ran are not', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd ~/app && mesimot task list' } }] } }),
    JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', message: 'denied' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'mesimot task show 1' } }] } }),
  ].join('\n');
  assert.deepStrictEqual(deniedCommands({ raw }), ['cd ~/app && mesimot task list']);
  assert.deepStrictEqual(deniedCommands({ raw: '' }), []);
  assert.deepStrictEqual(deniedCommands({}), []);
});
