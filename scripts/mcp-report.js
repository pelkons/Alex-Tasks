#!/usr/bin/env node
'use strict';
// How the assistant uses the built-in tools (docs/MCP.md). Reads the run logs through lib/vault.js and the usage table:
//   node scripts/mcp-report.js [--days N] [--json]        (uses MESIMOT_DB and MESIMOT_RUN_LOG like the runner)
// Per day and per job: runs, tool calls by name, refused Bash calls, tool errors seen by the model (validation or server refusal),
// the server's own refusals (table mcp_errors), the share of actions done through MCP versus the shell, tokens and cost per run.
const fs = require('fs');
const path = require('path');

const isMcp = (n) => String(n).startsWith('mcp__mesimot__');
const isShell = (t) => t.tool === 'Bash' || t.tool === 'shell';

function readLog(file, vault) { try { return vault.readFile(file).toString('utf8'); } catch { return null; } }

function report({ db, runsDir, days = 7, vault = require('../lib/vault'), now = Date.now() }) {
  const since = new Date(now - days * 86400000).toISOString();
  const runs = new Map(db.prepare('SELECT id, started_at, trigger FROM claude_runs WHERE started_at >= ?').all(since).map((r) => [r.id, r]));
  const usage = new Map();
  for (const u of db.prepare('SELECT run_id, job, adapter, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) tok, SUM(COALESCE(cost_usd,0)) cost, SUM(COALESCE(turns,0)) turns FROM run_usage WHERE at >= ? GROUP BY run_id, job').all(since)) {
    const cur = usage.get(u.run_id) || { job: u.job, adapter: u.adapter, tok: 0, cost: 0, turns: 0 }; cur.tok += u.tok; cur.cost += u.cost; cur.turns += u.turns; usage.set(u.run_id, cur);
  }
  const rows = new Map(); // "day|job" -> row
  const row = (day, job) => { const k = `${day}|${job}`; if (!rows.has(k)) rows.set(k, { day, job, runs: new Set(), calls: {}, mcp: 0, shell: 0, refused_bash: 0, tool_errors: 0, tokens: 0, cost: 0 }); return rows.get(k); };
  const seenRun = new Set();
  if (fs.existsSync(runsDir)) for (const f of fs.readdirSync(runsDir)) {
    const m = /^(\d+)(.*)\.tools\.json$/.exec(f); if (!m) continue;
    const runId = +m[1], run = runs.get(runId); if (!run) continue;
    const u = usage.get(runId) || { job: run.trigger };
    const r = row(run.started_at.slice(0, 10), u.job);
    r.runs.add(runId);
    let calls = []; try { calls = JSON.parse(readLog(path.join(runsDir, f), vault) || '[]'); } catch { /* unreadable log */ }
    for (const t of calls) { r.calls[t.tool] = (r.calls[t.tool] || 0) + 1; if (isMcp(t.tool)) r.mcp++; else if (isShell(t)) r.shell++; }
    const stream = readLog(path.join(runsDir, `${m[1]}${m[2]}.stream.jsonl`), vault) || '';
    const denied = new Set(); const errIds = new Set();
    for (const line of stream.split('\n')) {
      if (line.includes('"permission_denied"')) { try { const o = JSON.parse(line); if (o.subtype === 'permission_denied') denied.add(o.tool_use_id); } catch { /* skip */ } }
      if (line.includes('"is_error":true') && line.includes('tool_result')) { try { const o = JSON.parse(line); for (const c of o.message?.content || []) if (c.type === 'tool_result' && c.is_error) errIds.add(c.tool_use_id); } catch { /* skip */ } }
    }
    r.refused_bash += denied.size; r.tool_errors += errIds.size;
    if (!seenRun.has(runId)) { seenRun.add(runId); r.tokens += u.tok || 0; r.cost += u.cost || 0; }
  }
  const out = [...rows.values()].sort((a, b) => (a.day === b.day ? a.job.localeCompare(b.job) : a.day.localeCompare(b.day))).map((r) => {
    const n = r.runs.size, acts = r.mcp + r.shell;
    return { day: r.day, job: r.job, runs: n, calls: r.calls, mcp_calls: r.mcp, shell_calls: r.shell, mcp_share: acts ? +(r.mcp / acts).toFixed(2) : null, refused_bash: r.refused_bash, tool_errors: r.tool_errors, tokens_per_run: n ? Math.round(r.tokens / n) : 0, cost_per_run: n ? +(r.cost / n).toFixed(4) : 0 };
  });
  const server = db.prepare('SELECT substr(at,1,10) day, COUNT(*) n FROM mcp_errors WHERE at >= ? GROUP BY day ORDER BY day').all(since);
  return { days, rows: out, server_refusals: server };
}

function main() {
  const argv = process.argv.slice(2);
  const days = +(argv[argv.indexOf('--days') + 1] || 7) || 7;
  const { open } = require('../lib/db');
  const db = open(process.env.MESIMOT_DB);
  const rep = report({ db, runsDir: process.env.MESIMOT_RUN_LOG || path.join(__dirname, '..', 'data', 'runs'), days });
  if (argv.includes('--json')) return console.log(JSON.stringify(rep, null, 1));
  console.log(`MCP report, last ${rep.days} days`);
  for (const r of rep.rows) console.log(`${r.day} ${r.job.padEnd(12)} runs ${String(r.runs).padStart(3)} | mcp ${String(r.mcp_calls).padStart(3)} shell ${String(r.shell_calls).padStart(3)} share ${r.mcp_share === null ? '  - ' : Math.round(r.mcp_share * 100) + '%'} | refused bash ${r.refused_bash} tool errors ${r.tool_errors} | ${r.tokens_per_run} tok, $${r.cost_per_run}/run | ${Object.entries(r.calls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace('mcp__mesimot__', '')}:${v}`).join(' ')}`);
  console.log('server refusals to tools by day:', rep.server_refusals.map((x) => `${x.day}:${x.n}`).join(' ') || 'none');
}
if (require.main === module) main();
module.exports = { report };
