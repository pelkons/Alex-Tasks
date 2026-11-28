'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');

test('Settings: the MCP switch is read and saved through /api/settings, four values, the env override is reported', async () => {
  const db = open(':memory:'); auth.setPassword(db, 'correct horse battery'); auth.resetFailures();
  const app = build({ db, token: 't', loginDelayMs: 0 }); require('./helpers/owner')(app, db, 'correct horse battery');
  const h = await app.ownerH();
  const get = async () => (await app.inject({ method: 'GET', url: '/api/settings', headers: h })).json().agent.mcp;
  delete process.env.MESIMOT_MCP;
  let m = await get();
  assert.equal(m.value, 'off'); assert.equal(m.source, 'default'); assert.deepEqual(m.options.map((o) => o.value), ['off', 'chat', 'all', 'only']);
  assert.deepEqual(m.options.map((o) => o.label), ['כבוי', 'צ׳אט בלבד', 'הכול', 'כלים בלבד']);
  for (const v of ['chat', 'all', 'only', 'off']) {
    const r = await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { agent_mcp: v } });
    assert.equal(r.statusCode, 200); m = await get(); assert.equal(m.value, v); assert.equal(m.source, 'setting');
  }
  const bad = await app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: { agent_mcp: 'on' } });
  assert.equal(bad.statusCode, 400);
  process.env.MESIMOT_MCP = 'chat';
  try { m = await get(); assert.deepEqual([m.value, m.source], ['chat', 'env']); } finally { delete process.env.MESIMOT_MCP; }
});
