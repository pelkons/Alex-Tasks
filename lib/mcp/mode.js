'use strict';
// The MCP switch and the choice of the tool profile per job (docs/MCP.md). Read on every pass, so a change applies to the next run with no restart.
//   off  : no MCP server, the assistant works through the CLI exactly as before (the default)
//   chat : the `full` profile jobs only (chat, batch, reconcile, curator, pulse, gate)
//   all  : every job that is allowed to run commands; the shell `mesimot` stays as a fallback
//   only : like all, but the assistant gets NO shell (where the adapter can do that)
// A fresh install (no runs yet) starts on `all`; an install that already has runs starts on `off` (the first start writes it once, see ensureDefault).
const path = require('path');

const VALUES = ['off', 'chat', 'all', 'only'];
const LABELS = { off: 'כבוי', chat: 'צ׳אט בלבד', all: 'הכול', only: 'כלים בלבד' };
const ADAPTERS = ['claude-code', 'codex', 'gemini'];
// the runner chooses the profile from the job name; a job that is not listed (triage, audit, style, style_draft, web, ...) gets no MCP
const JOB_PROFILE = {
  chat: 'full', batch: 'full', reconcile: 'full', curator: 'full', pulse: 'full', gate: 'full',
  import: 'import', import_lite: 'import', import_fyi: 'import',
  profile: 'apply_only', names: 'apply_only', facts: 'apply_only',
};

// { value, source }: the env var MESIMOT_MCP wins over the setting `agent_mcp`; anything else means off
function getSwitch(db, env = process.env) {
  if (VALUES.includes(env.MESIMOT_MCP)) return { value: env.MESIMOT_MCP, source: 'env' };
  let s = null; try { s = db?.prepare("SELECT value FROM settings WHERE key='agent_mcp'").get()?.value; } catch { /* no settings table yet */ }
  if (VALUES.includes(s)) return { value: s, source: 'setting' };
  return { value: 'off', source: 'default' };
}
function setSwitch(db, value) {
  if (!VALUES.includes(value)) throw new Error(`agent_mcp must be one of ${VALUES.join(', ')}`);
  db.prepare("INSERT INTO settings (key,value) VALUES ('agent_mcp',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
}

// the profile of this job under this switch value, or null (no MCP)
function profileFor({ mode, job, adapter = 'claude-code', allowedCommands = ['mesimot'] }) {
  if (!ADAPTERS.includes(adapter) || !Array.isArray(allowedCommands) || !allowedCommands.includes('mesimot')) return null;
  const profile = JOB_PROFILE[job];
  if (!profile || mode === 'off') return null;
  if (mode === 'chat' && profile !== 'full') return null;
  return profile;
}
// the instruction variant for a switch value: cli, mcp (tools + shell fallback) or only (tools, no shell)
const docMode = (mode) => (mode === 'off' ? 'cli' : mode === 'only' ? 'only' : 'mcp');
// `only`: the assistant gets no shell
const noShell = (mode) => mode === 'only';
// the first start decides the default once: a database with runs is an existing install (off, so nothing changes under the owner), a new one starts on `all`
function ensureDefault(db) {
  let s = null; try { s = db.prepare("SELECT value FROM settings WHERE key='agent_mcp'").get()?.value; } catch { return null; }
  if (VALUES.includes(s)) return s;
  const used = !!db.prepare('SELECT 1 FROM claude_runs LIMIT 1').get();
  const v = used ? 'off' : 'all';
  setSwitch(db, v);
  return v;
}

// the `mcp` option of the adapter: no secret in it (the process reads the token from its environment or the env file)
function spec({ profile, runId, root = path.join(__dirname, '..', '..'), env = process.env }) {
  const e = { MESIMOT_MCP_PROFILE: profile };
  if (runId !== undefined && runId !== null) e.MESIMOT_RUN_ID = String(runId);
  for (const k of ['MESIMOT_URL', 'MESIMOT_ENV_FILE']) if (env[k]) e[k] = env[k];
  return { command: process.execPath, args: [path.join(root, 'bin', 'mesimot-mcp')], env: e };
}

// the words that teach HOW to call a thing, in one place for the runner prompts: howTo('apply_inline', useMcp) etc.
const HOW = {
  apply_inline: {
    mcp: 'Send the apply as ONE call of the `apply` tool (its arguments are the JSON itself: no file, no quoting; an apostrophe or a quote inside the text is fine)',
    cli: 'Send the apply as ONE command-line call: `mesimot apply --json \'<one-line JSON>\'` (the Write tool and heredocs/redirects are blocked; never use an apostrophe inside the JSON, write ׳ instead)',
  },
  run_summary: {
    mcp: 'the `run_summary` tool',
    cli: '`mesimot run-summary`',
  },
  apply_file: { // the profile backfill: the JSON goes in ONE apply call
    mcp: 'Then call the `apply` tool ONCE with this JSON object as its arguments (no file):',
    cli: null, // the CLI wording stays inline in the prompt
  },
  run_summary_text: {
    mcp: 'call the `run_summary` tool with `text` = <one short Hebrew line about what you did>.',
    cli: 'run `mesimot run-summary --text "<one short Hebrew line about what you did>"`.',
  },
  chat_send: { mcp: 'the `chat_send` tool', cli: '`mesimot chat send`' },
  no_chat: { mcp: '(no `chat_send`, no chat_message)', cli: '(no `mesimot chat send`, no chat_message)' },
};
const howTo = (kind, useMcp) => HOW[kind][useMcp ? 'mcp' : 'cli'];

module.exports = { VALUES, LABELS, ADAPTERS, JOB_PROFILE, getSwitch, setSwitch, ensureDefault, profileFor, noShell, docMode, spec, howTo };
