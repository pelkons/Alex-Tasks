'use strict';
// The assistant's instructions are a generic template (agent/AGENTS.template.md). The owner's name, the assistant's name, the bosses and the team
// come from config/mesimot.config.json and are rendered into agent/AGENTS.md (plus CLAUDE.md / GEMINI.md links) at install time and at runner start.
// The rendered files are never committed. Owner-specific memory lives in agent/memory/ (also not committed).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const list = (a, he) => (a || []).map((p) => (he ? p.name_he : (p.name_en || p.name_he)) || p.name_he).filter(Boolean).join(', ') || '-';

function vars(cfg) {
  const first = (n) => String(n || '').trim().split(/\s+/)[0];
  return {
    OWNER_NAME: cfg.owner.name_he || 'הבעלים', OWNER_EN: cfg.owner.name_en || 'the owner', OWNER_FIRST: first(cfg.owner.name_he) || 'הבעלים',
    ASSISTANT_NAME: cfg.assistant.name_he || 'אלכס', ASSISTANT_EN: cfg.assistant.name_en || 'Alex',
    BOSSES: list(cfg.bosses, true), TEAM: list(cfg.team, true), COMPANY: cfg.company || '', LANGUAGE: cfg.language || 'Hebrew',
    OWNER_EMAILS: (cfg.owner.emails || []).join(', ') || '-',
  };
}
// Three vocabularies in one template (docs/MCP.md): `<!--CLI-->` teaches the shell commands, `<!--MCP-->` the built-in tools, `<!--SHELL-->` (inside MCP) the
// shell fallback that only exists while the assistant still has a shell, `<!--ONLY-->` what is true when the tools are all it has. Modes:
//   cli = CLI blocks; mcp = MCP + SHELL; only = MCP + ONLY, and every `mesimot <command> ...` in backticks is written as the tool name.
// The renderer keeps what the mode needs, drops the rest and removes the markers. The rules themselves are written once, outside the blocks.
const KEEP = { cli: ['CLI'], mcp: ['MCP', 'SHELL'], only: ['MCP', 'ONLY'] };
function blocks(text, mode = 'cli') {
  const keep = KEEP[mode] || KEEP.cli;
  let out = text;
  for (const k of ['CLI', 'MCP', 'SHELL', 'ONLY']) out = keep.includes(k) ? out.replace(new RegExp(`<!--/?${k}-->`, 'g'), '') : out.replace(new RegExp(`<!--${k}-->[\\s\\S]*?<!--/${k}-->`, 'g'), '');
  return out;
}
// "`mesimot task list --open`" -> "`task_list`" (tool names from the CLI table of lib/mcp/tools.js)
function toolWords(text) {
  const byCmd = {};
  for (const t of require('./mcp/tools').TOOLS) for (const c of t.cli) byCmd[c] = t.name;
  return text.replace(/`mesimot ([a-z-]+)((?: [a-z-]+){0,2})[^`]{0,400}`/g, (m, cmd, rest) => {
    const w = rest.trim().split(' ').filter(Boolean);
    for (let n = w.length; n >= 0; n--) { const tool = byCmd[[cmd, ...w.slice(0, n)].join(' ')]; if (tool) return `\`${tool}\``; }
    return m;
  });
}
function render(templateFile, cfg = require('./config').get(), { mode = 'cli' } = {}) {
  const v = vars(cfg);
  const body = (mode === 'only' ? toolWords : (x) => x)(blocks(fs.readFileSync(templateFile, 'utf8'), mode)).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in v ? v[k] : m));
  const who = templateFile.endsWith('web.AGENTS.template.md') ? '' : `\n\n# This installation (generated from the configuration)\n\n- Owner: ${v.OWNER_NAME} (${v.OWNER_EN}); addresses: ${v.OWNER_EMAILS}.\n- Assistant: ${v.ASSISTANT_NAME} (${v.ASSISTANT_EN}). Answer and write in ${v.LANGUAGE}.\n- Bosses of the owner (priority, immediate questions): ${v.BOSSES}.\n- Team (project managers and contacts): ${v.TEAM}.\n- The owner-specific knowledge is in memory/ (owner.md, people.md, projects-index.md).\n`;
  return `<!-- Generated from ${path.basename(templateFile)} and config/mesimot.config.json. Do not edit: edit the template or the configuration. -->\n${body}${who}`;
}
const STATE = ['tmp', '.instructions'];
const OWN = { 'claude-code': 'CLAUDE.md', codex: 'AGENTS.md', gemini: 'GEMINI.md' };
const link = (dir, name) => { const p = path.join(dir, name); try { fs.rmSync(p, { force: true }); fs.symlinkSync('AGENTS.md', p); } catch { fs.copyFileSync(path.join(dir, 'AGENTS.md'), p); } };
// AGENTS.md (Codex), CLAUDE.md and GEMINI.md: the file the CURRENT adapter reads is rendered with the tool wording when the MCP switch is on (mode mcp or only), a real file;
// the others stay CLI (links to AGENTS.md). The last state is recorded in agent/tmp so the runner re-renders only when the switch or the adapter changes.
function write(dir, { adapter = 'claude-code', mode = 'cli', template = path.join(ROOT, 'agent', 'AGENTS.template.md'), cfg } = {}) {
  fs.mkdirSync(path.join(dir, STATE[0]), { recursive: true });
  const own = OWN[adapter] || 'CLAUDE.md', tooled = mode !== 'cli';
  const cli = render(template, cfg), variant = tooled ? render(template, cfg, { mode }) : null;
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), own === 'AGENTS.md' && tooled ? variant : cli);
  for (const f of ['CLAUDE.md', 'GEMINI.md']) {
    if (f === own && tooled) { fs.rmSync(path.join(dir, f), { force: true }); fs.writeFileSync(path.join(dir, f), variant); }
    else if (own === 'AGENTS.md' && tooled) { fs.rmSync(path.join(dir, f), { force: true }); fs.writeFileSync(path.join(dir, f), cli); }
    else link(dir, f);
  }
  fs.writeFileSync(path.join(dir, ...STATE), `${adapter}:${mode}`);
}
const state = (dir) => { try { return fs.readFileSync(path.join(dir, ...STATE), 'utf8').trim(); } catch { return null; } };
// before a run: make the instruction files match the switch and the adapter (cheap when nothing changed); returns true when it rewrote them
function sync(dir, adapter, mode, opts) { if (state(dir) === `${adapter}:${mode}` && fs.existsSync(path.join(dir, 'AGENTS.md'))) return false; write(dir, { ...opts, adapter, mode }); return true; }
// write the instruction files into dir (the agent's working directory)
function install(dir, opts = {}) { fs.mkdirSync(dir, { recursive: true }); write(dir, opts); return path.join(dir, 'AGENTS.md'); }
const renderWeb = (cfg) => render(path.join(ROOT, 'agent', 'web.AGENTS.template.md'), cfg);
module.exports = { render, install, sync, state, renderWeb, vars, blocks, toolWords };
