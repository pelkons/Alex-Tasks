'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createUsage } = require('../lib/usage');

const setup = () => { const db = open(':memory:'); return { db, u: createUsage(db) }; };
const U = (o = {}) => ({ turns: 3, input_tokens: 10, output_tokens: 500, cache_read_tokens: 20000, cache_write_tokens: 3000, cost_usd: 0.12, model: 'claude-sonnet-5-5', ...o });

test('every call is recorded with tokens, cache tokens and cost, and summed into the run', () => {
  const { db, u } = setup();
  const run = db.prepare("INSERT INTO claude_runs (started_at, trigger) VALUES (?, 'chat')").run(new Date().toISOString()).lastInsertRowid;
  u.record({ runId: run, job: 'chat', adapter: 'claude-code', effort: 'medium', duration_ms: 20000, usage: U() });
  u.record({ runId: run, job: 'gate', adapter: 'claude-code', duration_ms: 10000, usage: U({ cost_usd: 0.05 }) });
  u.record({ runId: run, job: 'chat', adapter: 'gemini', duration_ms: 5000, usage: { input_tokens: 5, output_tokens: 7 } }); // no cost: stays null
  const r = db.prepare('SELECT * FROM claude_runs WHERE id=?').get(run);
  assert.equal(r.output_tokens, 1007); assert.equal(r.cache_read_tokens, 40000); assert.ok(Math.abs(r.cost_usd - 0.17) < 1e-9);
  const t = u.totals(1); assert.equal(t.runs, 3); assert.equal(t.cost, 0.17);
  const kinds = u.by(7, 'job'); assert.equal(kinds[0].key, 'chat'); assert.equal(kinds[0].label, 'צ׳אט');
  assert.equal(u.by(7, 'model').find((x) => x.key === 'claude-sonnet-5-5').runs, 2);
  assert.equal(u.daily(30).length, 30); assert.equal(u.daily(30)[29].runs, 3);
});

test('a rate-limit error is logged, pauses background jobs but never chat, and the owner is told once', () => {
  const { db, u } = setup();
  assert.equal(u.blocked('import'), false);
  u.record({ job: 'import', error: "Claude AI usage limit reached|" + Math.floor((Date.now() + 3600e3) / 1000) });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_events WHERE kind='rate_limit'").get().c, 1);
  assert.equal(u.blocked('import'), true); assert.equal(u.blocked('curator'), true); assert.equal(u.blocked('chat'), false);
  assert.ok(u.shouldTellOwner() instanceof Date); assert.equal(u.shouldTellOwner(), null, 'only once per episode');
  assert.equal(u.summary({}).rate_limit_events.week, 1);
  assert.equal(u.isLimit('claude exited with code 1: 5-hour limit reached, resets 3pm'), true);
  assert.equal(u.isLimit('some other failure'), false);
});

test('reset time is read from the message; otherwise 30 minutes', () => {
  const { u } = setup();
  const from = new Date('2026-11-25T10:00:00');
  const d = u.resumeAt('limit reached, resets 3pm', from); assert.equal(d.getHours(), 15);
  assert.equal(u.resumeAt('usage limit', from) - from, 30 * 60000);
});

test('weekly summary: 3-4 lines with totals, biggest consumers and the trend', () => {
  const { db, u } = setup();
  u.record({ job: 'import', usage: U({ cost_usd: 1.5 }) }); u.record({ job: 'chat', usage: U({ cost_usd: 0.5 }) });
  db.prepare("INSERT INTO run_usage (at, job, cost_usd) VALUES (?, 'chat', 1.0)").run(new Date(Date.now() - 10 * 86400000).toISOString());
  const t = u.weeklyText(); const lines = t.split('\n');
  assert.ok(lines.length >= 3 && lines.length <= 4, t); assert.match(t, /שווה ערך API/); assert.match(t, /ייבוא יומי/); assert.match(t, /עלייה|ירידה/);
});

test('daily import cost per email', () => {
  const { db, u } = setup();
  const id = db.prepare("INSERT INTO imports (created_at, file_count, status, stats) VALUES (?,?,?,?)").run(new Date().toISOString(), 10, 'done', JSON.stringify({ total: 10 })).lastInsertRowid;
  u.record({ job: 'import', importId: id, usage: U({ cost_usd: 2 }) });
  const i = u.imports(30)[0]; assert.equal(i.emails, 10); assert.equal(i.per_email, 0.2);
});
