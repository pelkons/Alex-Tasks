'use strict';
// Feedback and learning. 👍/👎 (with a preset reason) on anything the assistant produced from mail. Stored with the features of the source mail, used CODE-FIRST:
//  1. a clear pattern (3 "not a task" verdicts for one sender) becomes a one-tap FILTER proposal;
//  2. otherwise the most similar past examples are injected into the prompt of a similar thread (few-shot, by keyword similarity: free, no model);
//  3. the weekly curator distills the feedback into agent/memory/processing-rules.md.
const { now } = require('./db');
const { bad } = require('./store');
const { keywords } = require('./context');

const REASONS = ['לא משימה', 'משימה של מישהו אחר', 'פרויקט שגוי', 'תאריך שגוי', 'היה צריך משימה', 'כפילות'];
const PROMPT_VERSION = 'import-2026-11-26';
const NOT_A_TASK = new Set(['לא משימה', 'משימה של מישהו אחר', 'כפילות']);
const addrOf = (s) => String(((/<([^>]+)>/.exec(s || '') || [])[1] || s || '')).trim().toLowerCase();

function createFeedback({ db, store, proposals = null }) {
  const q = (sql) => db.prepare(sql);
  // the features of the source mail of an item, and the model that produced it
  function featuresOf(type, id) {
    let emailId = null, projectId = null, runId = null;
    if (type === 'task') { const t = q('SELECT source_email_id, project_id FROM tasks WHERE id=?').get(id); emailId = t?.source_email_id ?? null; projectId = t?.project_id ?? null; runId = q("SELECT run_id FROM events WHERE entity='task' AND entity_id=? AND action='create' AND run_id IS NOT NULL ORDER BY id LIMIT 1").get(id)?.run_id ?? null; }
    else if (type === 'email') emailId = id;
    else if (type === 'proposal') { const p = q('SELECT * FROM proposals WHERE id=?').get(id); if (p && p.kind.startsWith('task_')) return featuresOf('task', p.target_id); }
    const e = emailId ? q('SELECT from_addr, forwarded_from, subject, original_subject, project_id FROM emails WHERE id=?').get(emailId) : null;
    const sender = e ? addrOf(e.forwarded_from || e.from_addr) : null;
    const run = runId ? q('SELECT model FROM claude_runs WHERE id=?').get(runId) : null;
    return { email_id: emailId, sender, domain: sender ? sender.split('@')[1] || null : null, subject_kw: e ? keywords(e.original_subject || e.subject || '', 6).join(' ') : null, project_id: projectId ?? e?.project_id ?? null, model: run?.model ?? null, run_id: runId };
  }
  function record(actor, b) {
    const type = String(b.item_type || ''); if (!['task', 'closure', 'fact', 'decision', 'email', 'proposal'].includes(type)) throw bad('סוג פריט לא תקין');
    const verdict = b.verdict === 'down' ? 'down' : b.verdict === 'up' ? 'up' : null; if (!verdict) throw bad('נדרש up או down');
    const reason = b.reason ? String(b.reason).slice(0, 60) : null;
    const f = featuresOf(type === 'closure' || type === 'decision' ? 'task' : type, +b.item_id);
    const id = q(`INSERT INTO feedback (created_at, item_type, item_id, email_id, verdict, reason, reason_text, sender, domain, subject_kw, project_id, model, prompt_version, run_id, fix) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(now(), type, +b.item_id || null, f.email_id, verdict, reason, b.reason_text ? String(b.reason_text).slice(0, 300) : null, f.sender, f.domain, f.subject_kw, f.project_id, f.model, PROMPT_VERSION, f.run_id, b.fix ?? null).lastInsertRowid;
    store.logEvent(actor, 'feedback', id, 'create', 'verdict', null, `${verdict}${reason ? ':' + reason : ''}`);
    const sugg = verdict === 'down' ? suggestFilters() : null;
    return { id, suggestion: sugg };
  }
  // an immediate fix after a 👎, through the normal store functions (logged and undoable like everything else)
  function fix(actor, taskId, kind, value) {
    const t = store.getTask(taskId); const hiddenId = q('SELECT id FROM statuses WHERE hidden_default=1').get()?.id;
    if (kind === 'info') { store.addNote(actor, { task: taskId, text: 'הועברה למידע בלבד: לא דורשת פעולה' }); store.updateTask(actor, taskId, { status: hiddenId }); return 'הועברה למידע בלבד'; }
    if (kind === 'project') { store.updateTask(actor, taskId, { project: value }); return 'הפרויקט שונה'; }
    if (kind === 'assignee') { store.updateTask(actor, taskId, { assignee: value }); return 'האחראי שונה'; }
    if (kind === 'merge') { const keep = store.getTask(+value); store.addNote(actor, { task: keep.id, text: `מוזגה כפילות: משימה ${t.id} "${t.title}"` }); store.addNote(actor, { task: taskId, text: `כפילות של משימה ${keep.id}` }); store.updateTask(actor, taskId, { status: hiddenId }); return 'מוזגה'; }
    throw bad('תיקון לא מוכר');
  }
  const fixNote = (id, fix) => q('UPDATE feedback SET fix=? WHERE id=?').run(String(fix).slice(0, 200), id);

  // 3 "not a task" verdicts (or downgrades) from one sender: propose a filter with one tap (never silently)
  function suggestFilters() {
    if (!proposals) return null;
    const rows = q(`SELECT sender, COUNT(*) n, GROUP_CONCAT(DISTINCT reason) reasons FROM feedback WHERE verdict='down' AND sender IS NOT NULL AND reason IN ('לא משימה','משימה של מישהו אחר','כפילות') GROUP BY sender HAVING n >= 3`).all();
    const made = [];
    for (const r of rows) {
      if (q("SELECT 1 FROM mail_filters WHERE kind='sender' AND pattern=?").get(r.sender)) continue;
      if (q("SELECT 1 FROM proposals WHERE kind='filter_add' AND status='open' AND json_extract(payload,'$.pattern')=?").get(r.sender)) continue;
      if (q("SELECT 1 FROM proposals WHERE kind='filter_add' AND status IN ('rejected','applied') AND json_extract(payload,'$.pattern')=?").get(r.sender)) continue;
      made.push({ kind: 'filter_add', target_id: 0, text: `לסנן מיילים מ-${r.sender} (לידיעה בלבד)`, reason: `סימנת ${r.n} פעמים שמשימות ממנו אינן נדרשות`, payload: JSON.stringify({ kind: 'sender', pattern: r.sender, action: 'fyi' }) });
    }
    if (!made.length) return null;
    return proposals.createBatch('filters', 'הצעה לכלל סינון', made);
  }

  // few-shot: the most similar earlier feedback (same sender / domain / subject words / project), as short examples for the prompt
  function examples(email, limit = 4) {
    const sender = addrOf(email.forwarded_from || email.from_addr); const domain = sender.split('@')[1] || '';
    const kw = new Set(keywords(email.original_subject || email.subject || '', 8));
    const rows = q('SELECT * FROM feedback ORDER BY id DESC LIMIT 400').all();
    const scored = rows.map((r) => {
      let sc = 0; if (sender && r.sender === sender) sc += 4; if (domain && r.domain === domain) sc += 2; if (email.project_id && r.project_id === email.project_id) sc += 1;
      for (const w of String(r.subject_kw || '').split(' ').filter(Boolean)) if (kw.has(w)) sc += 1.5;
      return { r, sc };
    }).filter((x) => x.sc >= 3).sort((a, b) => b.sc - a.sc).slice(0, limit);
    return scored.map(({ r }) => { const t = r.item_type === 'task' && r.item_id ? q('SELECT title FROM tasks WHERE id=?').get(r.item_id)?.title : null; return `- ${r.verdict === 'up' ? 'CORRECT' : 'WRONG'}${t ? ` (task "${String(t).slice(0, 70)}")` : ` (${r.item_type})`}${r.reason ? `: ${r.reason}` : ''}${r.reason_text ? ` - ${String(r.reason_text).slice(0, 100)}` : ''} [mail from ${r.sender || '?'}${r.subject_kw ? `, about: ${r.subject_kw}` : ''}]`; });
  }
  function stats(days = 30) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const g = (w, a = []) => q(`SELECT verdict, COUNT(*) n FROM feedback WHERE created_at >= ? ${w} GROUP BY verdict`).all(since, ...a);
    const all = g(''); const up = all.find((x) => x.verdict === 'up')?.n || 0, down = all.find((x) => x.verdict === 'down')?.n || 0;
    const tasks = g("AND item_type='task'"); const tu = tasks.find((x) => x.verdict === 'up')?.n || 0, td = tasks.find((x) => x.verdict === 'down')?.n || 0;
    const weeks = q(`SELECT strftime('%Y-%W', created_at) w, MIN(substr(created_at,1,10)) from_day, SUM(verdict='down') down, SUM(verdict='up') up FROM feedback WHERE created_at >= ? GROUP BY w ORDER BY w`).all(new Date(Date.now() - 8 * 7 * 86400000).toISOString());
    const reasons = q("SELECT reason, COUNT(*) n FROM feedback WHERE verdict='down' AND reason IS NOT NULL AND created_at >= ? GROUP BY reason ORDER BY n DESC").all(since);
    return { days, total: up + down, up, down, task_precision: tu + td ? +(tu / (tu + td)).toFixed(2) : null, precision: up + down ? +(up / (up + down)).toFixed(2) : null, corrections_per_week: weeks, reasons };
  }
  const recent = (n = 60) => q('SELECT item_type, verdict, reason, reason_text, sender, subject_kw FROM feedback ORDER BY id DESC LIMIT ?').all(n);
  return { record, fix, fixNote, suggestFilters, examples, stats, recent, REASONS, PROMPT_VERSION, featuresOf };
}
module.exports = { createFeedback, REASONS, PROMPT_VERSION };
