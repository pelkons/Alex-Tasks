'use strict';
// The wiring of the MCP switch in the runner: which jobs get the server, what CLAUDE.md says, how the argv looks, and that "off" changes nothing.
const os = require('os'); const path = require('path'); const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-mcpr-'));
const argsFile = path.join(tmp, 'args.txt');
process.env.MESIMOT_SEMANTIC = '0'; process.env.MESIMOT_LOCK = path.join(tmp, 'runner.lock'); process.env.MESIMOT_RUN_LOG = path.join(tmp, 'runs');
process.env.MESIMOT_AGENT_DIR = path.join(tmp, 'agent'); process.env.MESIMOT_FILES = path.join(tmp, 'files');
process.env.MESIMOT_CLAUDE_BIN = path.join(__dirname, 'fixtures', 'fake-claude-args.sh'); process.env.FAKE_ARGS_FILE = argsFile;
process.env.MESIMOT_URL = 'http://127.0.0.1:8111';
delete process.env.MESIMOT_MCP;
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createRunner } = require('../lib/runner');
const mode = require('../lib/mcp/mode');
const agentdoc = require('../lib/agentdoc');
const { buildArgs, mcpConfig } = require('../lib/agents/claude-code');

function world() {
  const db = open(':memory:'); const store = createStore(db);
  agentdoc.install(process.env.MESIMOT_AGENT_DIR, { cfg: require('./fixtures/config.json') });
  return { db, store, runner: createRunner(db) };
}
const lastArgs = () => { try { return fs.readFileSync(argsFile, 'utf8'); } catch { return ''; } };
const argv = () => { const s = lastArgs(); const m = /--mcp-config (\{.*\}) --no-session-persistence/.exec(s); return { text: s, cfg: m ? JSON.parse(m[1]) : null }; };
async function chatRun(db, store, runner, say = 'שלום') {
  fs.rmSync(argsFile, { force: true });
  require('../lib/chat').createChat(db, store, require('../lib/knowledge').createKnowledge(db, store)).sendChat(store.ownerId(), { text: say });
  return runner.runOnce('chat');
}

test('the switch: env wins over the setting, anything unknown means off', () => {
  const db = open(':memory:');
  assert.deepEqual(mode.getSwitch(db, {}), { value: 'off', source: 'default' });
  mode.setSwitch(db, 'chat');
  assert.deepEqual(mode.getSwitch(db, {}), { value: 'chat', source: 'setting' });
  assert.deepEqual(mode.getSwitch(db, { MESIMOT_MCP: 'all' }), { value: 'all', source: 'env' });
  assert.deepEqual(mode.getSwitch(db, { MESIMOT_MCP: 'bogus' }), { value: 'chat', source: 'setting' });
  db.prepare("UPDATE settings SET value='weird' WHERE key='agent_mcp'").run();
  assert.equal(mode.getSwitch(db, {}).value, 'off');
  assert.throws(() => mode.setSwitch(db, 'on'));
});

test('profileFor: off = never; chat = the full-profile jobs; all = every job with commands; not for Codex or Gemini; not without `mesimot`', () => {
  const p = (m, job, extra = {}) => mode.profileFor({ mode: m, job, ...extra });
  for (const job of Object.keys(mode.JOB_PROFILE)) assert.equal(p('off', job), null, job);
  for (const job of ['chat', 'batch', 'reconcile', 'curator', 'pulse', 'gate']) { assert.equal(p('chat', job), 'full'); assert.equal(p('all', job), 'full'); }
  for (const job of ['import', 'import_lite', 'import_fyi']) { assert.equal(p('chat', job), null); assert.equal(p('all', job), 'import'); }
  for (const job of ['profile', 'names', 'facts']) { assert.equal(p('chat', job), null); assert.equal(p('all', job), 'apply_only'); }
  for (const job of ['triage', 'audit', 'style', 'style_draft', 'web', 'unknown']) assert.equal(p('all', job), null, job);
  assert.equal(p('all', 'chat', { adapter: 'codex' }), 'full'); assert.equal(p('all', 'chat', { adapter: 'gemini' }), 'full'); assert.equal(p('all', 'chat', { adapter: 'other' }), null);
  for (const job of ['chat', 'import', 'names']) assert.equal(p('only', job), p('all', job), job + ': only has the same profiles as all');
  assert.equal(p('all', 'chat', { allowedCommands: [] }), null);
});

test('the adapter: without `mcp` the arguments are what they were; with it the config and ONE allow rule, never the token', () => {
  // snapshots taken from the code before the MCP change
  assert.deepEqual(buildArgs({ prompt: 'P', model: 'sonnet', effort: 'high', readPaths: ['/a'], writePaths: ['/a/memory'] }), ['-p', 'P', '--model', 'sonnet', '--effort', 'high', '--tools', 'Bash,Read,Edit,Write', '--allowedTools', 'Bash(mesimot:*)', 'Read(//a/**)', 'Edit(//a/memory/**)', 'Write(//a/memory/**)', '--disallowedTools', 'Bash(*>*)', 'Bash(*<*)', 'Bash(*`*)', 'Bash(*$(*)', '--permission-mode', 'dontAsk', '--max-turns', '40', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence']);
  assert.deepEqual(buildArgs({ prompt: 'P', allowedCommands: [], readPaths: [], writePaths: [], web: true, maxTurns: 25 }), ['-p', 'P', '--model', 'sonnet', '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch', 'WebFetch', '--disallowedTools', 'Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'Task', '--permission-mode', 'dontAsk', '--max-turns', '25', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence']);
  assert.deepEqual(buildArgs({ prompt: 'P', mcp: null }), buildArgs({ prompt: 'P' }));

  const saved = process.env.MESIMOT_TOKEN; process.env.MESIMOT_TOKEN = 'super-secret-token-value';
  try {
    const mcp = mode.spec({ profile: 'full', runId: 12 });
    const a = buildArgs({ prompt: 'P', mcp });
    const plain = buildArgs({ prompt: 'P' });
    assert.ok(a.includes('--strict-mcp-config'), 'user-level servers stay out');
    const cfg = JSON.parse(a[a.indexOf('--mcp-config') + 1]);
    assert.deepEqual(Object.keys(cfg.mcpServers), ['mesimot']);
    assert.equal(cfg.mcpServers.mesimot.command, process.execPath);
    assert.ok(cfg.mcpServers.mesimot.args[0].endsWith(path.join('bin', 'mesimot-mcp')) && path.isAbsolute(cfg.mcpServers.mesimot.args[0]));
    assert.deepEqual(cfg.mcpServers.mesimot.env, { MESIMOT_MCP_PROFILE: 'full', MESIMOT_RUN_ID: '12', MESIMOT_URL: 'http://127.0.0.1:8111' });
    assert.equal(a.filter((x) => x === 'mcp__mesimot').length, 1, 'one allow rule for the whole server');
    assert.ok(a.indexOf('mcp__mesimot') > a.indexOf('--allowedTools') && a.indexOf('mcp__mesimot') < a.indexOf('--disallowedTools'));
    assert.deepEqual(a.filter((x) => x !== 'mcp__mesimot' && x !== a[a.indexOf('--mcp-config') + 1]), plain.filter((x) => x !== '{"mcpServers":{}}'), 'nothing else changes');
    assert.ok(!JSON.stringify(a).includes('super-secret-token-value'), 'no token in the arguments');
    assert.throws(() => mcpConfig({ command: 'x', env: { MESIMOT_TOKEN: 'a' } }), /secret/);
    assert.throws(() => mcpConfig({ command: 'x', env: { SOMETHING: 'super-secret-token-value' } }), /secret/);
  } finally { if (saved === undefined) delete process.env.MESIMOT_TOKEN; else process.env.MESIMOT_TOKEN = saved; }
});

test('runner, switch off: the arguments carry the empty MCP config and CLAUDE.md is the link to AGENTS.md', async () => {
  const { db, store, runner } = world();
  assert.equal(await chatRun(db, store, runner), true);
  const { text, cfg } = argv();
  assert.deepEqual(cfg, { mcpServers: {} });
  assert.ok(!text.includes('mcp__mesimot'));
  const dir = process.env.MESIMOT_AGENT_DIR;
  assert.ok(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink());
  assert.ok(!fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes('mcp__mesimot'));
});

test('runner, switch chat: the chat job gets the full profile and a real CLAUDE.md with the tool wording; AGENTS.md and GEMINI.md stay CLI', async () => {
  const { db, store, runner } = world();
  mode.setSwitch(db, 'chat');
  assert.equal(await chatRun(db, store, runner), true);
  const { text, cfg } = argv();
  assert.equal(cfg.mcpServers.mesimot.env.MESIMOT_MCP_PROFILE, 'full');
  assert.match(cfg.mcpServers.mesimot.env.MESIMOT_RUN_ID, /^\d+$/);
  assert.ok(text.includes('mcp__mesimot'));
  const dir = process.env.MESIMOT_AGENT_DIR;
  assert.ok(!fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink(), 'a real file');
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /# Tools \(mesimot MCP\)/);
  assert.ok(!fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('mesimot MCP'));
  assert.ok(!fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8').includes('mesimot MCP'));
});

test('runner, switch back to off: CLAUDE.md returns to the link and the next run has no server (no restart needed)', async () => {
  const { db, store, runner } = world();
  mode.setSwitch(db, 'all'); await chatRun(db, store, runner);
  assert.ok(argv().cfg.mcpServers.mesimot);
  mode.setSwitch(db, 'off'); await chatRun(db, store, runner, 'עוד הודעה');
  assert.deepEqual(argv().cfg, { mcpServers: {} });
  assert.ok(fs.lstatSync(path.join(process.env.MESIMOT_AGENT_DIR, 'CLAUDE.md')).isSymbolicLink());
});

test('runner: an env override wins over the setting, per run', async () => {
  const { db, store, runner } = world();
  mode.setSwitch(db, 'off'); process.env.MESIMOT_MCP = 'chat';
  try { await chatRun(db, store, runner); assert.ok(argv().cfg.mcpServers.mesimot); } finally { delete process.env.MESIMOT_MCP; }
});

test('runner: a background job with the apply_only profile gets MCP only under "all"', async () => {
  const { db, store, runner } = world();
  store.createPerson(store.ownerId(), { name: 'Ron Barak', role: 'contact' });
  mode.setSwitch(db, 'chat'); fs.rmSync(argsFile, { force: true });
  await runner.nameFixOnce();
  assert.deepEqual(argv().cfg, { mcpServers: {} }, 'chat mode: the names job has no MCP');
  mode.setSwitch(db, 'all'); db.prepare("DELETE FROM settings WHERE key='name_fix_tries'").run(); fs.rmSync(argsFile, { force: true });
  await runner.nameFixOnce();
  assert.equal(argv().cfg.mcpServers.mesimot.env.MESIMOT_MCP_PROFILE, 'apply_only');
});

test('howTo and the template: the CLI wording is untouched, the MCP wording names the tools', () => {
  assert.match(mode.howTo('apply_inline', false), /mesimot apply --json '<one-line JSON>'.*write ׳ instead\)$/);
  assert.match(mode.howTo('apply_inline', true), /`apply` tool/);
  assert.equal(mode.howTo('run_summary', false), '`mesimot run-summary`');
  const tpl = path.join(__dirname, '..', 'agent', 'AGENTS.template.md'), cfg = require('./fixtures/config.json');
  const cli = agentdoc.render(tpl, cfg), mcp = agentdoc.render(tpl, cfg, { mode: 'mcp' });
  assert.ok(!/<!--\/?(CLI|MCP)-->/.test(cli) && !/<!--\/?(CLI|MCP)-->/.test(mcp), 'no marker is left');
  assert.ok(!cli.includes('mcp__mesimot') && !cli.includes('# Tools (mesimot MCP)'));
  assert.ok(cli.includes('# CLI cheat sheet') && !mcp.includes('# CLI cheat sheet'));
  assert.ok(mcp.includes('`mcp__mesimot__<name>`') && mcp.includes('`outbox_draft`') && mcp.includes('`run_summary`'));
  // the rules are written once: every rule outside the blocks is in both
  for (const rule of ['# Mission (read first)', '## Deleting goes to the recycle bin', 'You CANNOT approve or send', '# Writing style (enforced by code)']) assert.ok(cli.includes(rule) && mcp.includes(rule), rule);
  assert.ok(agentdoc.blocks('a<!--CLI-->b<!--/CLI-->c<!--MCP-->d<!--/MCP-->e', 'cli') === 'abce' && agentdoc.blocks('a<!--CLI-->b<!--/CLI-->c<!--MCP-->d<!--/MCP-->e', 'mcp') === 'acde');
});

test('a refused mesimot tool call is retried like a refused command, and the MCP connection status is read from the init event', () => {
  const { deniedCommands } = require('../lib/runner');
  const { parseStream } = require('../lib/agents/claude-code');
  const raw = [
    JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'mesimot', status: 'failed' }] }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__mesimot__task_update', input: { id: 1 } }] } }),
    JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'mcp__mesimot__task_update', tool_use_id: 't1', message: 'denied' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__other__x', input: {} }] } }),
    JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'mcp__other__x', tool_use_id: 't2', message: 'denied' }),
  ].join('\n');
  assert.deepEqual(deniedCommands({ raw }), ['mcp__mesimot__task_update {"id":1}'], 'only the mesimot server, never another one');
  assert.deepEqual(parseStream(raw).mcpServers, [{ name: 'mesimot', status: 'failed' }]);
  assert.equal(parseStream('').mcpServers, null);
});

test('only: the assistant gets the tools and NO shell, in Claude Code, Codex and Gemini', () => {
  const mcp = mode.spec({ profile: 'full', runId: 5 });
  // Claude Code: no Bash among the tools, no Bash allow rule, the MCP rule stays
  const c = buildArgs({ prompt: 'P', allowedCommands: [], readPaths: ['/a'], writePaths: ['/a/memory'], mcp });
  assert.equal(c[c.indexOf('--tools') + 1], 'Read,Edit,Write');
  assert.ok(!c.some((x) => /^Bash\(mesimot/.test(x)) && c.includes('mcp__mesimot'));
  assert.ok(buildArgs({ prompt: 'P', readPaths: ['/a'], mcp })[buildArgs({ prompt: 'P', readPaths: ['/a'], mcp }).indexOf('--tools') + 1].startsWith('Bash'), 'all keeps the shell fallback');
  // Codex: -c overrides for the server, shell tools off
  const cx = require('../lib/agents/codex');
  const a = cx.buildArgs({ prompt: 'P', workdir: '/w', mcp, noShell: true }, '/l').join('\n');
  assert.match(a, /mcp_servers\.mesimot\.command="/); assert.match(a, /mcp_servers\.mesimot\.args=\["[^"]*mesimot-mcp"\]/); assert.match(a, /features\.shell_tool=false/); assert.match(a, /default_tools_approval_mode="approve"/);
  assert.ok(!cx.buildArgs({ prompt: 'P', workdir: '/w', mcp }, '/l').join('\n').includes('shell_tool'));
  assert.ok(!cx.buildArgs({ prompt: 'P', workdir: '/w' }, '/l').join('\n').includes('mcp_servers'), 'without mcp the Codex arguments are unchanged');
  assert.throws(() => cx.buildArgs({ prompt: 'P', workdir: '/w', mcp: { command: 'x', env: { MESIMOT_TOKEN: 't' } } }, '/l'), /secret/);
  const ev = [{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'mesimot', tool: 'task_list', arguments: { open: true }, status: 'completed' } }, { type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }, { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }].map((x) => JSON.stringify(x)).join('\n');
  assert.deepEqual(cx.parseEvents(ev).toolCalls, [{ name: 'mcp__mesimot__task_list', input: { open: true } }, { name: 'shell', input: { command: 'ls' } }]);
  // Gemini: the server in the settings, trusted; no run_shell_command when only
  const gm = require('../lib/agents/gemini');
  const g = gm.settingsFor({ allowedCommands: ['mesimot'], mcp, noShell: false });
  assert.ok(g.tools.core.includes('run_shell_command(mesimot)')); assert.equal(g.mcpServers.mesimot.trust, true); assert.deepEqual(g.mcpServers.mesimot.env, mcp.env);
  assert.ok(!gm.settingsFor({ allowedCommands: ['mesimot'], mcp, noShell: true }).tools.core.some((x) => x.startsWith('run_shell_command')));
  assert.equal(gm.settingsFor({ allowedCommands: ['mesimot'] }).mcpServers, undefined);
  assert.throws(() => gm.settingsFor({ mcp: { command: 'x', env: { SECRET_X: '1' } } }), /secret/);
  assert.equal(gm.parseOutput(JSON.stringify({ response: 'x', stats: { tools: { byName: { mcp_mesimot_task_list: { count: 2 }, run_shell_command: { count: 1 } } } } })).toolCalls.filter((t) => t.name === 'mcp__mesimot__task_list').length, 2);
});

test('runner, switch only: no shell for the job, the tools-only instruction file; and for Codex the AGENTS.md is the tool variant', async () => {
  const { db, store, runner } = world();
  mode.setSwitch(db, 'only');
  assert.equal(await chatRun(db, store, runner), true);
  const { text, cfg } = argv();
  assert.ok(cfg.mcpServers.mesimot);
  assert.match(text, /--tools Read,Edit,Write /); assert.ok(!text.includes('Bash(mesimot'));
  const md = fs.readFileSync(path.join(process.env.MESIMOT_AGENT_DIR, 'CLAUDE.md'), 'utf8');
  assert.ok(md.includes('you have no shell') && !md.includes('# CLI cheat sheet'));
  assert.ok((md.match(/`mesimot [a-z]/g) || []).length <= 3, 'no CLI vocabulary left in the tools-only instructions apart from the table');
  // a name-fix job under `only` is a tools job as well
  assert.equal(mode.profileFor({ mode: 'only', job: 'names' }), 'apply_only');
  // Codex reads AGENTS.md: it becomes the tool variant, CLAUDE.md goes back to a plain CLI copy
  agentdoc.sync(process.env.MESIMOT_AGENT_DIR, 'codex', 'mcp', { cfg: require('./fixtures/config.json') });
  const dir = process.env.MESIMOT_AGENT_DIR;
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /# Tools \(mesimot MCP\)/);
  assert.ok(!fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes('# Tools (mesimot MCP)'));
  assert.equal(agentdoc.state(dir), 'codex:mcp');
  assert.equal(agentdoc.sync(dir, 'codex', 'mcp'), false, 'nothing to do twice');
  agentdoc.sync(dir, 'claude-code', 'cli', { cfg: require('./fixtures/config.json') });
  assert.ok(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink());
});

test('the default: a fresh install starts on `all`, an install that already has runs starts on `off`; nothing is overwritten', () => {
  const fresh = open(':memory:');
  assert.equal(mode.getSwitch(fresh, {}).value, 'off', 'absent = off until the first start decides');
  assert.equal(mode.ensureDefault(fresh), 'all');
  assert.deepEqual(mode.getSwitch(fresh, {}), { value: 'all', source: 'setting' });
  const used = open(':memory:');
  used.prepare('INSERT INTO claude_runs (started_at, trigger, events_count) VALUES (?,?,?)').run(new Date().toISOString(), 'chat', 0);
  assert.equal(mode.ensureDefault(used), 'off');
  mode.setSwitch(used, 'chat');
  assert.equal(mode.ensureDefault(used), 'chat', 'an existing choice stays');
  assert.equal(mode.getSwitch(used, { MESIMOT_MCP: 'only' }).value, 'only', 'the env override still wins');
});
