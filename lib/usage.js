'use strict';
// Usage measurement: one row per agent call (run_usage) with tokens, cache tokens and the API-equivalent cost reported by the CLI, the run totals in
// claude_runs, rate-limit events, the back-off of background jobs, the panel data, the weekly summary. The subscription is a flat fee with usage
// limits: the cost here is an estimate ("שווה ערך API") that shows how much of it is used.
const { now } = require('./db');

const OPTIONAL = new Set(['curator', 'facts', 'audit', 'import_fyi']); // the only jobs the daily budget may delay
const BACKGROUND = new Set(['import', 'import_lite', 'import_fyi', 'triage', 'facts', 'profile', 'curator', 'reconcile', 'pulse', 'names']);
const LIMIT_RE = /(usage limit|rate.?limit|limit reached|limit will reset|quota|too many requests|\b429\b|exceeded your|resets? (at )?\d|overloaded_error|credit balance)/i;
const KIND_HE = { chat: 'צ׳אט', batch: 'מיילים וקבצים', import: 'ייבוא יומי (שרשורים)', triage: 'ייבוא יומי (מיון)', reconcile: 'התאמה יומית', curator: 'מנהל זיכרון', pulse: 'דופק', names: 'שמות', gate: 'תיקוני בקרה', facts: 'כרטיס פרויקט וקבצים', profile: 'דרכון וסטטוס פרויקט', web: 'חיפוש באינטרנט' };

function createUsage(db) {
  const q = (s) => db.prepare(s);
  const setting = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
  const setSetting = (k, v) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

  // when the limit text says when it resets ("resets 3pm", "...|1731340800" epoch), use it; otherwise wait 30 minutes
  function resumeAt(msg, from = new Date()) {
    const epoch = /\|(\d{10})\b/.exec(msg);
    if (epoch) return new Date(+epoch[1] * 1000);
    const m = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(msg);
    if (m) {
      let h = +m[1]; const mi = +(m[2] || 0);
      if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
      const d = new Date(from); d.setHours(h, mi, 0, 0);
      if (d <= from) d.setDate(d.getDate() + 1);
      return d;
    }
    return new Date(from.getTime() + 30 * 60000);
  }
  const isLimit = (msg) => !!msg && LIMIT_RE.test(String(msg));

  // one agent call. rec: { runId, job, adapter, model, effort, duration_ms, usage:{...}, error, importId }
  function record(rec) {
    const u = rec.usage || {};
    const limited = isLimit(rec.error);
    q(`INSERT INTO run_usage (run_id, at, job, adapter, model, effort, duration_ms, turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, error, rate_limited, import_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(rec.runId ?? null, now(), rec.job || 'batch', rec.adapter ?? null, u.model || rec.model || null, rec.effort || null, rec.duration_ms ?? null, u.turns ?? null,
      u.input_tokens ?? null, u.output_tokens ?? null, u.cache_read_tokens ?? null, u.cache_write_tokens ?? null, u.cost_usd ?? null, rec.error ? String(rec.error).slice(0, 300) : null, limited ? 1 : 0, rec.importId ?? null);
    if (rec.runId) {
      q(`UPDATE claude_runs SET input_tokens = COALESCE(input_tokens,0) + ?, output_tokens = COALESCE(output_tokens,0) + ?, cache_read_tokens = COALESCE(cache_read_tokens,0) + ?, cache_write_tokens = COALESCE(cache_write_tokens,0) + ?,
        cost_usd = CASE WHEN ? IS NULL THEN cost_usd ELSE COALESCE(cost_usd,0) + ? END WHERE id=?`).run(u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_tokens ?? 0, u.cache_write_tokens ?? 0, u.cost_usd ?? null, u.cost_usd ?? 0, rec.runId);
    }
    if (limited) {
      const at = resumeAt(rec.error);
      q('INSERT INTO usage_events (at, kind, job, message, resume_at) VALUES (?,?,?,?,?)').run(now(), 'rate_limit', rec.job || null, String(rec.error).slice(0, 300), at.toISOString());
      if (!at || at > new Date(setting('rate_limit_until') || 0)) setSetting('rate_limit_until', at.toISOString());
    }
    return { limited };
  }

  // background jobs wait while the limit is active; chat never does
  const backoffUntil = () => { const v = setting('rate_limit_until'); const d = v ? new Date(v) : null; return d && d > new Date() ? d : null; };
  // daily soft budget (Settings, opt-in, default OFF: "עבודה לא דחופה בלבד"): it may only delay work that is truly optional, and never for more than 24 hours.
  // Anything that can produce or change a task, a deadline, a boss request, a closure or a question to the owner (live mail, import threads, chat, task chat, pulse, reconcile) is never touched.
  const jerusalemDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
  const budget = () => +(setting('daily_budget_usd') || 0) || 0;
  function spendOn(day) {
    const from = new Date(Date.parse(day + 'T00:00:00Z') - 36 * 3600e3).toISOString(), to = new Date(Date.parse(day + 'T00:00:00Z') + 60 * 3600e3).toISOString();
    return q('SELECT at, cost_usd FROM run_usage WHERE at >= ? AND at <= ? AND cost_usd IS NOT NULL').all(from, to).filter((r) => jerusalemDay(new Date(r.at)) === day).reduce((a, r) => a + r.cost_usd, 0);
  }
  const todaySpend = () => spendOn(jerusalemDay());
  const budgetExceeded = () => { const b = budget(); return b > 0 && todaySpend() >= b; };
  function shouldTellBudget() { if (!budgetExceeded()) return null; const day = jerusalemDay(); if (setting('budget_told_day') === day) return null; setSetting('budget_told_day', day); return { budget: budget() }; }
  // optional work waits while the budget is used, but at most 24 hours from its first deferral
  function budgetDeferred(job) {
    if (!OPTIONAL.has(job)) return false;
    const key = `budget_deferred:${job}`;
    if (!budgetExceeded()) { if (setting(key)) q('DELETE FROM settings WHERE key=?').run(key); return false; }
    const since = setting(key); if (!since) { setSetting(key, now()); return true; }
    return Date.now() - Date.parse(since) < 24 * 3600e3;
  }
  // a rate limit pauses the background jobs (chat and live mail first); the budget never does it for the ones that matter
  const blocked = (job) => (BACKGROUND.has(job) && !!backoffUntil()) || budgetDeferred(job);
  // anomaly alert: today's spend above 2x the average of the previous 14 days: tell the owner once, keep working
  function anomaly() {
    const day = jerusalemDay(); if (setting('anomaly_told_day') === day) return null;
    const today = todaySpend(); if (today < 8) return null;
    const prev = []; for (let i = 1; i <= 14; i++) { const d = jerusalemDay(new Date(Date.now() - i * 86400000)); prev.push(spendOn(d)); }
    const days = prev.filter((x) => x > 0); if (days.length < 3) return null;
    const avg = days.reduce((a, x) => a + x, 0) / days.length;
    if (today <= 2 * avg) return null;
    setSetting('anomaly_told_day', day);
    const from = new Date(Date.now() - 30 * 3600e3).toISOString();
    const top = q('SELECT job, ROUND(SUM(cost_usd),2) c, COUNT(*) n FROM run_usage WHERE at >= ? GROUP BY job ORDER BY SUM(cost_usd) DESC LIMIT 3').all(from);
    return { today, avg, top };
  }

  // true once per limit episode: the owner is told in the chat
  function shouldTellOwner() {
    const until = backoffUntil(); if (!until) return null;
    const told = setting('rate_limit_told_for');
    if (told === until.toISOString()) return null;
    setSetting('rate_limit_told_for', until.toISOString());
    return until;
  }

  const since = (days) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1)); return d.toISOString(); };
  function totals(days) {
    const r = q(`SELECT COUNT(*) runs, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(cache_read_tokens),0) cache_read, COALESCE(SUM(cache_write_tokens),0) cache_write,
      ROUND(COALESCE(SUM(cost_usd),0),4) cost, CAST(COALESCE(AVG(duration_ms),0) AS INTEGER) avg_ms, SUM(rate_limited) limited FROM run_usage WHERE at >= ?`).get(since(days));
    return { ...r, limited: r.limited || 0 };
  }
  function by(days, col) {
    return q(`SELECT COALESCE(${col},'?') AS key, COUNT(*) runs, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(cache_read_tokens),0) cache_read, COALESCE(SUM(cache_write_tokens),0) cache_write,
      ROUND(COALESCE(SUM(cost_usd),0),4) cost, CAST(COALESCE(AVG(duration_ms),0) AS INTEGER) avg_ms FROM run_usage WHERE at >= ? GROUP BY 1 ORDER BY cost DESC, runs DESC`).all(since(days))
      .map((r) => ({ ...r, label: col === 'job' ? (KIND_HE[r.key] || r.key) : r.key }));
  }
  function daily(days = 30) {
    const rows = q(`SELECT substr(at,1,10) AS day, COUNT(*) runs, ROUND(COALESCE(SUM(cost_usd),0),4) cost, COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)),0) tokens FROM run_usage WHERE at >= ? GROUP BY 1`).all(since(days));
    const map = new Map(rows.map((r) => [r.day, r])); const out = [];
    for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = d.toISOString().slice(0, 10); out.push(map.get(k) || { day: k, runs: 0, cost: 0, tokens: 0 }); }
    return out;
  }
  function imports(days = 30) {
    return q('SELECT id, created_at, file_count, status, stats FROM imports WHERE created_at >= ? ORDER BY id DESC').all(since(days)).map((i) => {
      const u = q('SELECT COUNT(*) runs, ROUND(COALESCE(SUM(cost_usd),0),4) cost FROM run_usage WHERE import_id=?').get(i.id);
      const st = JSON.parse(i.stats || '{}'); const n = st.total || i.file_count || 0;
      return { id: i.id, at: i.created_at, emails: n, runs: u.runs, cost: u.cost, per_email: n ? +(u.cost / n).toFixed(4) : null, status: i.status };
    });
  }
  function summary({ days = 7, by: dim = 'kind' } = {}) {
    return { days, equivalent_api_cost_note: 'שווה ערך API (הערכה): המנוי עצמו הוא תשלום קבוע עם מגבלות שימוש',
      today: totals(1), week: totals(7), month: totals(30), by_kind: by(days, 'job'), by_model: by(days, 'model'), by: dim === 'model' ? by(days, 'model') : by(days, 'job'),
      daily: daily(30), imports: imports(30), rate_limit_events: { week: q("SELECT COUNT(*) c FROM usage_events WHERE kind='rate_limit' AND at >= ?").get(since(7)).c, month: q("SELECT COUNT(*) c FROM usage_events WHERE kind='rate_limit' AND at >= ?").get(since(30)).c,
        last: q("SELECT at, job, resume_at FROM usage_events WHERE kind='rate_limit' ORDER BY id DESC LIMIT 1").get() || null, backoff_until: backoffUntil()?.toISOString() || null } };
  }

  const usd = (n) => `$${(+n || 0).toFixed(2)}`;
  const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
  // Sunday-morning chat message: 3-4 lines
  function weeklyText() {
    const cur = q(`SELECT COUNT(*) runs, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)),0) tokens FROM run_usage WHERE at >= ?`).get(since(7));
    const prevFrom = since(14), prevTo = since(7);
    const prev = q('SELECT COUNT(*) runs, COALESCE(SUM(cost_usd),0) cost FROM run_usage WHERE at >= ? AND at < ?').get(prevFrom, prevTo);
    const top = q('SELECT job, ROUND(SUM(cost_usd),2) cost, COUNT(*) runs FROM run_usage WHERE at >= ? GROUP BY job ORDER BY SUM(cost_usd) DESC LIMIT 3').all(since(7));
    const lim = q("SELECT COUNT(*) c FROM usage_events WHERE kind='rate_limit' AND at >= ?").get(since(7)).c;
    const trend = prev.cost > 0 ? `${cur.cost >= prev.cost ? 'עלייה' : 'ירידה'} של ${Math.round(Math.abs(cur.cost - prev.cost) / prev.cost * 100)}% לעומת השבוע הקודם (${usd(prev.cost)})` : 'אין שבוע קודם להשוואה';
    return [`שימוש שבועי: ${cur.runs} הרצות, ${kfmt(cur.tokens)} טוקנים, שווה ערך API ${usd(cur.cost)} (הערכה; המנוי הוא תשלום קבוע).`,
      top.length ? `הצרכנים הגדולים: ${top.map((t) => `${KIND_HE[t.job] || t.job} ${usd(t.cost)}`).join(', ')}.` : 'אין עדיין נתוני שימוש.',
      `מגמה: ${trend}.`, lim ? `פגיעה במגבלת המנוי: ${lim} פעמים השבוע.` : 'לא הייתה פגיעה במגבלת המנוי.'].join('\n');
  }
  return { budget, todaySpend, budgetExceeded, shouldTellBudget, budgetDeferred, anomaly, OPTIONAL, record, isLimit, resumeAt, backoffUntil, blocked, shouldTellOwner, summary, totals, by, daily, imports, weeklyText, BACKGROUND, KIND_HE };
}
module.exports = { createUsage, BACKGROUND, LIMIT_RE, KIND_HE };
