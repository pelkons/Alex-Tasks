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
// Two vocabularies in one template: `<!--CLI-->...<!--/CLI-->` teaches the shell commands, `<!--MCP-->...<!--/MCP-->` the built-in tools (docs/MCP.md).
// The renderer keeps one kind, drops the other and removes the markers. The rules themselves are written once, outside the blocks.
function blocks(text, mode) {
  const keep = mode === 'mcp' ? 'MCP' : 'CLI', drop = mode === 'mcp' ? 'CLI' : 'MCP';
  return text.replace(new RegExp(`<!--${drop}-->[\\s\\S]*?<!--/${drop}-->`, 'g'), '').replace(new RegExp(`<!--/?${keep}-->`, 'g'), '');
}
function render(templateFile, cfg = require('./config').get(), { mode = 'cli' } = {}) {
  const v = vars(cfg);
  const body = blocks(fs.readFileSync(templateFile, 'utf8'), mode).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in v ? v[k] : m));
  const who = templateFile.endsWith('web.AGENTS.template.md') ? '' : `\n\n# This installation (generated from the configuration)\n\n- Owner: ${v.OWNER_NAME} (${v.OWNER_EN}); addresses: ${v.OWNER_EMAILS}.\n- Assistant: ${v.ASSISTANT_NAME} (${v.ASSISTANT_EN}). Answer and write in ${v.LANGUAGE}.\n- Bosses of the owner (priority, immediate questions): ${v.BOSSES}.\n- Team (project managers and contacts): ${v.TEAM}.\n- The owner-specific knowledge is in memory/ (owner.md, people.md, projects-index.md).\n`;
  return `<!-- Generated from ${path.basename(templateFile)} and config/mesimot.config.json. Do not edit: edit the template or the configuration. -->\n${body}${who}`;
}
const STATE = ['tmp', '.claude-instructions'];
const link = (dir, name) => { const p = path.join(dir, name); try { fs.rmSync(p, { force: true }); fs.symlinkSync('AGENTS.md', p); } catch { fs.copyFileSync(path.join(dir, 'AGENTS.md'), p); } };
// CLAUDE.md is the only file with a second vocabulary: with the MCP switch on it is a real file rendered with the tool wording (AGENTS.md for Codex and GEMINI.md stay CLI).
// The last mode is recorded in agent/tmp so the runner re-renders only when the switch changes.
function installClaude(dir, mode = 'cli', { template = path.join(ROOT, 'agent', 'AGENTS.template.md'), cfg } = {}) {
  const p = path.join(dir, 'CLAUDE.md');
  if (mode === 'mcp') { fs.rmSync(p, { force: true }); fs.writeFileSync(p, render(template, cfg, { mode: 'mcp' })); } else link(dir, 'CLAUDE.md');
  fs.mkdirSync(path.join(dir, STATE[0]), { recursive: true });
  fs.writeFileSync(path.join(dir, ...STATE), mode);
  return p;
}
const claudeMode = (dir) => { try { return fs.readFileSync(path.join(dir, ...STATE), 'utf8').trim(); } catch { return null; } };
// before a run: make CLAUDE.md match the switch (cheap when nothing changed)
function syncClaude(dir, mode, opts) { const m = mode === 'mcp' ? 'mcp' : 'cli'; if (claudeMode(dir) === m && fs.existsSync(path.join(dir, 'CLAUDE.md'))) return false; installClaude(dir, m, opts); return true; }
// write AGENTS.md and the CLAUDE.md / GEMINI.md files into dir (the agent's working directory)
function install(dir, { template = path.join(ROOT, 'agent', 'AGENTS.template.md'), cfg, mode = 'cli' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), render(template, cfg));
  link(dir, 'GEMINI.md');
  installClaude(dir, mode, { template, cfg });
  return path.join(dir, 'AGENTS.md');
}
const renderWeb = (cfg) => render(path.join(ROOT, 'agent', 'web.AGENTS.template.md'), cfg);
module.exports = { render, install, installClaude, syncClaude, claudeMode, renderWeb, vars, blocks };
