'use strict';
// OpenAI Codex CLI (`codex exec`). It reads AGENTS.md. KNOWN GAPS (document, do not hide):
//  - Codex has no per-command allowlist like Claude Code's. We run it in the `workspace-write` sandbox with the working directory as the
//    only writable place, approvals disabled, and network access only because the mesimot CLI talks to 127.0.0.1. Inside that sandbox the
//    model can still run ANY shell command and read files outside the workdir. The instructions forbid it, and the code-side gate and apply validation catch the consequences.
//  - readPaths outside the working directory cannot be restricted; writePaths other than the working directory are added with --add-dir.
const fs = require('fs');
const { capture, agentEnv, clip, tmpFile } = require('./util');

// TOML values for `-c key=value` (JSON strings and arrays are valid TOML; an env table is written inline)
const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(',')}]` : JSON.stringify(v));
const tomlTable = (o) => `{${Object.entries(o || {}).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`;
// The built-in MCP server (docs/MCP.md): mcp_servers.mesimot from -c overrides, tools auto-approved (the sandbox and the server's own rules still apply).
// `noShell` (switch value `only`): the shell tools of Codex are switched off, the model has the MCP tools and the file edit tool only.
function mcpArgs(mcp, noShell) {
  const a = [];
  if (mcp) {
    for (const [k, v] of Object.entries(mcp.env || {})) if (/token|secret|password|key/i.test(k)) throw new Error(`the MCP environment must not carry a secret (${k})`);
    a.push('-c', `mcp_servers.mesimot.command=${toml(mcp.command)}`, '-c', `mcp_servers.mesimot.args=${toml(mcp.args || [])}`, '-c', `mcp_servers.mesimot.env=${tomlTable(mcp.env)}`,
      '-c', 'mcp_servers.mesimot.default_tools_approval_mode="approve"', '-c', 'mcp_servers.mesimot.startup_timeout_sec=30', '-c', 'mcp_servers.mesimot.tool_timeout_sec=180');
  }
  if (noShell) a.push('-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false');
  return a;
}
function buildArgs({ prompt, workdir, writePaths = [], model, effort, mcp = null, noShell = false }, lastFile) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--cd', workdir,
    '-c', 'sandbox_workspace_write.network_access=true', '-c', 'approval_policy="never"', '--output-last-message', lastFile];
  args.push(...mcpArgs(mcp, noShell));
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  for (const p of writePaths) if (!p.startsWith(workdir)) args.push('--add-dir', p);
  args.push(prompt);
  return args;
}
function parseEvents(stdout) {
  const toolCalls = []; let text = null, usage = {};
  for (const line of String(stdout).split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const item = o.item || o.msg?.item;
    if (o.type === 'item.completed' && item) {
      if (item.type === 'agent_message' && item.text) text = item.text;
      if (item.type === 'command_execution') toolCalls.push({ name: 'shell', input: { command: item.command } });
      if (item.type === 'mcp_tool_call') toolCalls.push({ name: `mcp__${item.server || 'mesimot'}__${item.tool}`, input: item.arguments ?? {} }); // the same names as Claude Code, so one report counts them all
    }
    if (o.type === 'turn.completed' && o.usage) usage = { input_tokens: o.usage.input_tokens ?? null, output_tokens: o.usage.output_tokens ?? null };
  }
  return { text, toolCalls, usage };
}
function create({ bin = process.env.MESIMOT_CODEX_BIN || 'codex' } = {}) {
  return {
    name: 'codex',
    instructionsFile: 'AGENTS.md',
    async run(opts) {
      const last = tmpFile('last-message.txt');
      const { stdout, stderr, code, timedOut } = await capture(bin, buildArgs(opts, last), { cwd: opts.workdir, env: agentEnv(opts.env), timeoutMs: opts.timeoutMs });
      const p = parseEvents(stdout);
      let text = p.text;
      try { const t = fs.readFileSync(last, 'utf8').trim(); if (t) text = t; } catch { /* no file */ }
      const error = code === 0 && text !== null ? null : (timedOut ? 'timed out' : `codex exited with code ${code}: ${clip(stderr || stdout, 400)}`);
      return { text, toolCalls: p.toolCalls, usage: { turns: p.toolCalls.length || null, ...p.usage }, exitCode: code, raw: stdout, stderr, error };
    },
    available() { return require('./util').onPath(bin); },
    setup: 'Install the Codex CLI (npm i -g @openai/codex) and run `codex login` once with your own account. Reads agent/AGENTS.md. Gaps: no command allowlist (see lib/agents/codex.js).',
  };
}
module.exports = { create, buildArgs, parseEvents };
