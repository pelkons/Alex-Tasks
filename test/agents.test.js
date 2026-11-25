'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgent, configured, describe, NAMES } = require('../lib/agents');
const { open } = require('../lib/db');

const fx = (n) => path.join(__dirname, 'fixtures', n);
const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-ag-')), n);
const base = { prompt: 'שלום', workdir: process.cwd(), allowedCommands: ['mesimot'], readPaths: ['/x/agent', '/x/files'], writePaths: ['/x/agent/memory', '/x/agent/tmp'], timeoutMs: 20000 };

test('claude-code: the allow and deny lists are built from the generic options, and the stream is parsed into the common result', async () => {
  const argsFile = tmp('args');
  const a = createAgent('claude-code', { bin: fx('fake-claude-args.sh') });
  const r = await a.run({ ...base, model: 'sonnet', env: { FAKE_ARGS_FILE: argsFile } });
  assert.equal(r.text, 'סיימתי'); assert.equal(r.error, null); assert.equal(r.usage.turns, 3); assert.equal(r.usage.input_tokens, 9);
  assert.deepEqual(r.toolCalls, [{ name: 'Bash', input: { command: 'mesimot task list' } }]);
  const args = fs.readFileSync(argsFile, 'utf8');
  for (const want of ['Bash(mesimot:*)', 'Read(//x/agent/**)', 'Edit(//x/agent/memory/**)', 'Write(//x/agent/tmp/**)', '--permission-mode dontAsk', '--model sonnet', 'Bash(*>*)']) assert.ok(args.includes(want), want);
});

test('codex: workspace-write sandbox in the working directory, no approvals, the last message wins, usage and commands parsed', async () => {
  const argsFile = tmp('args');
  const a = createAgent('codex', { bin: fx('fake-codex.sh') });
  const r = await a.run({ ...base, model: 'gpt-5', env: { FAKE_ARGS_FILE: argsFile } });
  assert.equal(r.text, 'סיכום סופי'); assert.equal(r.error, null);
  assert.deepEqual(r.toolCalls, [{ name: 'shell', input: { command: 'mesimot task list' } }]);
  assert.equal(r.usage.output_tokens, 5);
  const args = fs.readFileSync(argsFile, 'utf8');
  for (const want of ['exec', '--json', '--sandbox workspace-write', `--cd ${process.cwd()}`, 'approval_policy="never"', '-m gpt-5', '--add-dir /x/agent/memory']) assert.ok(args.includes(want), want);
  assert.ok(args.trim().endsWith('שלום'));
});

test('gemini: a per-run settings file limits the core tools to the mesimot command and file tools; the JSON answer is parsed', async () => {
  const argsFile = tmp('args'), settings = tmp('settings.json');
  const a = createAgent('gemini', { bin: fx('fake-gemini.sh') });
  const r = await a.run({ ...base, model: 'gemini-2.5-pro', env: { FAKE_ARGS_FILE: argsFile, FAKE_SETTINGS_COPY: settings } });
  assert.equal(r.text, 'תשובה מג׳מיני'); assert.equal(r.usage.input_tokens, 20); assert.equal(r.toolCalls.length, 2);
  const cfg = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(cfg.tools.core.includes('run_shell_command(mesimot)')); assert.ok(!cfg.tools.core.some((t) => /^run_shell_command$/.test(t)), 'no unrestricted shell');
  const args = fs.readFileSync(argsFile, 'utf8');
  for (const want of ['-p שלום', '--approval-mode yolo', '--output-format json', '-m gemini-2.5-pro']) assert.ok(args.includes(want), want);
});

test('a missing binary or a failing CLI becomes an error result, never an exception', async () => {
  for (const n of ['claude-code', 'codex', 'gemini']) {
    const r = await createAgent(n, { bin: '/nonexistent/binary' }).run({ ...base, timeoutMs: 5000 });
    assert.ok(r.error && r.text === null, n);
  }
});

test('the provider is chosen by the database setting first, then the environment; the list shows what is installed', () => {
  const db = open(':memory:');
  assert.deepEqual(configured(db, {}), { name: 'claude-code', model: '' });
  assert.deepEqual(configured(db, { MESIMOT_AGENT: 'codex', MESIMOT_AGENT_MODEL: 'gpt-5' }), { name: 'codex', model: 'gpt-5' });
  assert.equal(configured(db, { MESIMOT_AGENT: 'nonsense' }).name, 'claude-code');
  db.prepare("INSERT INTO settings (key,value) VALUES ('agent_provider','gemini'), ('agent_model','gemini-2.5-flash')").run();
  assert.deepEqual(configured(db, { MESIMOT_AGENT: 'codex' }), { name: 'gemini', model: 'gemini-2.5-flash' });
  const d = describe(db, {});
  assert.deepEqual(d.options.map((o) => o.name), NAMES);
  assert.deepEqual(NAMES, ['claude-code', 'codex', 'gemini']);
  assert.throws(() => createAgent('api'), /unknown agent/);
});

test('license hygiene: the adapters only invoke the official CLI; no credentials, tokens, API keys or vendor endpoints in our code', () => {
  const dir = path.join(__dirname, '..', 'lib', 'agents');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/API_KEY|ANTHROPIC_|OPENAI_|api\.anthropic|api\.openai|googleapis|oauth|\.credentials|\.claude\/|\.codex\/|\.gemini\/oauth/i.test(src), `${f} touches credentials or vendor endpoints`);
  }
});

test('model routing: built-in sonnet/medium, config and Settings overrides per job, the env benchmark override wins; recorded on the run', () => {
  const models = require('../lib/agents/models');
  const db = open(':memory:');
  const none = { agent_models: {} };
  assert.deepEqual(models.resolve({ adapter: 'claude-code', job: 'chat', db, config: none, env: {} }), { model: 'sonnet', effort: 'medium', fallback: '' });
  const cfg = { agent_models: { 'claude-code': { jobs: { pulse: { model: 'haiku', effort: 'low', fallback: 'sonnet' } } } } };
  assert.deepEqual(models.resolve({ adapter: 'claude-code', job: 'pulse', db, config: cfg, env: {} }), { model: 'haiku', effort: 'low', fallback: 'sonnet' });
  assert.equal(models.resolve({ adapter: 'claude-code', job: 'batch', db, config: cfg, env: {} }).model, 'sonnet');
  models.saveOverrides(db, 'claude-code', { jobs: { names: { model: 'haiku', effort: 'low' }, batch: { model: 'sonnet', effort: 'medium' } } });
  assert.equal(models.resolve({ adapter: 'claude-code', job: 'names', db, config: none, env: {} }).model, 'haiku');
  assert.ok(!JSON.parse(db.prepare("SELECT value FROM settings WHERE key='agent_models'").get().value)['claude-code'].jobs.batch, 'a value equal to the default is not an override');
  assert.equal(models.resolve({ adapter: 'claude-code', job: 'names', db, config: none, env: { MESIMOT_JOB_MODELS: 'names=opus:high' } }).model, 'opus');
  assert.deepEqual(models.resolve({ adapter: 'codex', job: 'chat', db, config: none, env: {} }), { model: '', effort: '', fallback: '' });
  const t = models.table({ adapter: 'claude-code', db, config: none });
  assert.ok(t.find((x) => x.job === 'pulse') && t.find((x) => x.job === 'names').model === 'haiku');
});

test('the adapters pass effort and fallback model to their CLIs', () => {
  const cc = require('../lib/agents/claude-code').buildArgs({ prompt: 'x', model: 'haiku', effort: 'low', fallbackModel: 'sonnet' });
  assert.ok(cc.join(' ').includes('--model haiku --effort low --fallback-model sonnet'));
  const cx = require('../lib/agents/codex').buildArgs({ prompt: 'x', workdir: '/w', model: 'gpt-5', effort: 'low' }, '/tmp/l');
  assert.ok(cx.join(' ').includes('model_reasoning_effort="low"'));
});
