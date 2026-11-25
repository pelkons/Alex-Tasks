'use strict';
// What the assistant actually looked at during a run (searches, asks, opened chunks/files, project card, chat history). The "don't give up" gate
// reads this instead of trusting the agent's word. Only calls made while a run is open (the CLI path) are recorded.
const { now } = require('./db');

function createTrace(db) {
  const open = () => db.prepare('SELECT id FROM claude_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1').get()?.id ?? null;
  function log(kind, arg = '', extra = null) {
    const run = open();
    if (!run) return;
    try { db.prepare('INSERT INTO run_trace (run_id, at, kind, arg, extra) VALUES (?,?,?,?,?)').run(run, now(), kind, String(arg ?? '').slice(0, 400), extra == null ? null : JSON.stringify(extra).slice(0, 4000)); } catch { /* tracing never breaks a request */ }
  }
  const forRun = (runId) => db.prepare('SELECT * FROM run_trace WHERE run_id=? ORDER BY id').all(runId).map((r) => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : null }));
  return { log, forRun, open };
}
module.exports = { createTrace };
