'use strict';
// Gemini CLI, non-interactive (`gemini -p`). It reads GEMINI.md (a link to AGENTS.md). Tools are restricted with a per-run system settings
// file (GEMINI_CLI_SYSTEM_SETTINGS_PATH): core tools limited to run_shell_command(mesimot) and file tools. KNOWN GAPS: file tools cannot be
// limited to particular directories; `--approval-mode yolo` auto-approves the allowed tools (there is nobody to ask).
const fs = require('fs');
const { capture, agentEnv, clip, tmpFile } = require('./util');

function settingsFor({ allowedCommands = ['mesimot'] }) {
  return { tools: { core: [...allowedCommands.map((c) => `run_shell_command(${c})`), 'read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content', 'write_file', 'replace'] }, telemetry: { enabled: false } };
}
function buildArgs({ prompt, model }) {
  const args = ['-p', prompt, '--approval-mode', 'yolo', '--output-format', 'json'];
  if (model) args.push('-m', model);
  return args;
}
function parseOutput(stdout) {
  const s = String(stdout);
  const i = s.indexOf('{');
  let o = null;
  try { o = JSON.parse(s.slice(i)); } catch { /* plain text mode */ }
  if (!o) return { text: s.trim() || null, usage: {}, toolCalls: [] };
  const models = Object.values(o.stats?.models || {});
  const sum = (k) => models.reduce((n, m) => n + (m.tokens?.[k] || 0), 0);
  const tools = o.stats?.tools?.byName ? Object.entries(o.stats.tools.byName).flatMap(([name, v]) => Array.from({ length: v.count || 1 }, () => ({ name, input: {} }))) : [];
  return { text: o.response ?? null, usage: { input_tokens: sum('prompt') || null, output_tokens: sum('candidates') || null }, toolCalls: tools };
}
function create({ bin = process.env.MESIMOT_GEMINI_BIN || 'gemini' } = {}) {
  return {
    name: 'gemini',
    instructionsFile: 'GEMINI.md',
    async run(opts) {
      const settings = tmpFile('settings.json');
      fs.writeFileSync(settings, JSON.stringify(settingsFor(opts)));
      const { stdout, stderr, code, timedOut } = await capture(bin, buildArgs(opts), { cwd: opts.workdir, env: agentEnv({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, ...(opts.env || {}) }), timeoutMs: opts.timeoutMs });
      const p = parseOutput(stdout);
      const error = code === 0 && p.text !== null ? null : (timedOut ? 'timed out' : `gemini exited with code ${code}: ${clip(stderr || stdout, 400)}`);
      return { text: p.text, toolCalls: p.toolCalls, usage: { turns: p.toolCalls.length || null, ...p.usage }, exitCode: code, raw: stdout, stderr, error };
    },
    available() { return require('./util').onPath(bin); },
    setup: 'Install the Gemini CLI (npm i -g @google/gemini-cli) and sign in once with `gemini` with your own Google account. Reads agent/GEMINI.md. Gaps: file tools are not limited to directories.',
  };
}
module.exports = { create, buildArgs, parseOutput, settingsFor };
