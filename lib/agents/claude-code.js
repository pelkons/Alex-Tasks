'use strict';
// Claude Code (`claude -p`): the tool restrictions are enforced by the CLI itself (allow and deny lists), the most complete of the CLI adapters.
const { capture, agentEnv, clip } = require('./util');

function parseStream(text) {
  let result = null; const toolCalls = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'result') result = o;
    if (o.type === 'assistant') for (const c of o.message?.content || []) if (c.type === 'tool_use') toolCalls.push({ name: c.name, input: c.input });
  }
  return { result, toolCalls };
}

// The tool set follows the options exactly: Bash only when commands are allowed, Read/Edit/Write only when paths are given, WebSearch and WebFetch only for
// `web: true` (the isolated /s run: no commands, no files, nothing of the owner's data).
function toolList({ allowedCommands = ['mesimot'], readPaths = [], writePaths = [], web = false }) {
  return [...(allowedCommands.length ? ['Bash'] : []), ...(readPaths.length ? ['Read'] : []), ...(writePaths.length ? ['Edit', 'Write'] : []), ...(web ? ['WebSearch', 'WebFetch'] : [])];
}
// Claude Code permission rules: a path starting with a single / is relative to the project root; an ABSOLUTE path needs //
const absRule = (p) => (String(p).startsWith('/') ? '/' + p : p);
function buildArgs({ prompt, allowedCommands = ['mesimot'], readPaths = [], writePaths = [], web = false, model, effort, fallbackModel, maxTurns = 40 }) {
  return ['-p', prompt, '--model', model || 'sonnet', ...(effort ? ['--effort', effort] : []), ...(fallbackModel ? ['--fallback-model', fallbackModel] : []), '--tools', toolList({ allowedCommands, readPaths, writePaths, web }).join(','),
    '--allowedTools', ...allowedCommands.map((c) => `Bash(${c}:*)`), ...readPaths.map((p) => `Read(${absRule(p)}/**)`), ...writePaths.flatMap((p) => [`Edit(${absRule(p)}/**)`, `Write(${absRule(p)}/**)`]), ...(web ? ['WebSearch', 'WebFetch'] : []),
    '--disallowedTools', ...(web && !allowedCommands.length ? ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'Task'] : ['Bash(*>*)', 'Bash(*<*)', 'Bash(*`*)', 'Bash(*$(*)']),
    '--permission-mode', 'dontAsk', '--max-turns', String(maxTurns), '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'];
}

function create({ bin = process.env.MESIMOT_CLAUDE_BIN || 'claude' } = {}) {
  return {
    name: 'claude-code',
    instructionsFile: 'CLAUDE.md',
    supportsWeb: true,
    async run(opts) {
      const { stdout, stderr, code, timedOut } = await capture(bin, buildArgs(opts), { cwd: opts.workdir, env: agentEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...(opts.env || {}) }), timeoutMs: opts.timeoutMs });
      const { result, toolCalls } = parseStream(stdout);
      let text = null, error = null;
      if (result) { text = result.is_error ? null : String(result.result ?? ''); if (result.is_error) error = clip(result.result, 500); }
      else error = timedOut ? 'timed out' : `claude exited with code ${code}: ${clip(stderr || stdout, 400)}`;
      return { text, toolCalls, usage: { turns: result?.num_turns ?? null, input_tokens: result?.usage?.input_tokens ?? null, output_tokens: result?.usage?.output_tokens ?? null, cache_read_tokens: result?.usage?.cache_read_input_tokens ?? null, cache_write_tokens: result?.usage?.cache_creation_input_tokens ?? null, cost_usd: result?.total_cost_usd ?? null, model: Object.keys(result?.modelUsage || {})[0] || null, api_ms: result?.duration_api_ms ?? null }, exitCode: code, raw: stdout, stderr, error };
    },
    available() { return require('./util').onPath(bin) || require('path').isAbsolute(bin); },
    setup: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) and log in once with `claude`. Reads agent/CLAUDE.md (a link to AGENTS.md).',
  };
}
module.exports = { create, buildArgs, toolList, parseStream };
