'use strict';
// Per-job model routing: which model and effort each kind of run uses, per adapter. Strings are passed to the adapter's CLI as they are,
// so Codex and Gemini get their own names. Order of precedence: env MESIMOT_JOB_MODELS (benchmarks), the Settings override (database),
// config/mesimot.config.json ("agent_models"), then the built-in defaults.
const JOBS = {
  chat: 'הודעת צ׳אט', batch: 'עיבוד מיילים וקבצים', reconcile: 'התאמה יומית', curator: 'מנהל זיכרון שבועי', pulse: 'הודעת דופק', names: 'שמות בעברית',
  gate: 'תיקון אחרי בקרה', facts: 'השלמת כרטיס פרויקט', web: 'חיפוש באינטרנט (/s)', triage: 'מיון ייבוא יומי', import_fyi: 'ייבוא יומי: לידיעה בלבד', audit: 'בדיקת איכות והצעות', import_lite: 'ייבוא יומי: שרשור רגיל (מודל זול)', import: 'עיבוד שרשור מייבוא יומי',
};
const DEFAULTS = {
  'claude-code': { default: { model: 'sonnet', effort: 'medium' }, jobs: { triage: { model: 'haiku', effort: 'low', fallback: 'sonnet' }, import_fyi: { model: 'haiku', effort: 'low', fallback: 'sonnet' }, audit: { model: 'haiku', effort: 'low', fallback: 'sonnet' }, import_lite: { model: 'haiku', effort: 'medium', fallback: 'sonnet' } } },
  codex: { default: { model: '', effort: '' }, jobs: {} },
  gemini: { default: { model: '', effort: '' }, jobs: {} },
};
const clean = (x) => (x && typeof x === 'object' ? { model: String(x.model ?? '').trim(), effort: String(x.effort ?? '').trim(), fallback: String(x.fallback ?? '').trim() } : null);

// MESIMOT_JOB_MODELS="pulse=haiku:low,names=haiku:low:sonnet" (job=model:effort[:fallback]) overrides everything: used by the benchmarks
function envOverrides(env = process.env) {
  const out = {};
  for (const part of String(env.MESIMOT_JOB_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [job, rest] = part.split('='); const [model = '', effort = '', fallback = ''] = String(rest || '').split(':');
    if (job) out[job.trim()] = { model, effort, fallback };
  }
  return out;
}

function resolve({ adapter, job, db = null, config = {}, env = process.env }) {
  const builtin = DEFAULTS[adapter] || { default: { model: '', effort: '' }, jobs: {} };
  const dbRaw = (() => { try { return JSON.parse(db?.prepare("SELECT value FROM settings WHERE key='agent_models'").get()?.value || '{}'); } catch { return {}; } })();
  const layers = [builtin, config.agent_models?.[adapter] || {}, dbRaw[adapter] || {}];
  let r = { model: '', effort: '', fallback: '' };
  for (const l of layers) { const d = clean(l.default); if (d) r = { ...r, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v)) }; }
  if (env.MESIMOT_AGENT_MODEL) r.model = env.MESIMOT_AGENT_MODEL; // the older single-model switch still works for the default
  for (const l of layers) { const j = clean(l.jobs?.[job]); if (j) r = { ...r, ...Object.fromEntries(Object.entries(j).filter(([, v]) => v)) }; }
  const e = envOverrides(env)[job]; if (e) r = { ...r, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v)) };
  const fromDb = dbRaw[adapter];
  // the legacy model column of Settings ("agent_model") overrides the default model only
  const legacy = (() => { try { return db?.prepare("SELECT value FROM settings WHERE key='agent_model'").get()?.value || ''; } catch { return ''; } })();
  if (legacy && !fromDb?.jobs?.[job]?.model && !(envOverrides(env)[job] || {}).model && !(config.agent_models?.[adapter]?.jobs?.[job]?.model)) r.model = legacy;
  return r;
}
// what Settings shows: every job with its effective model and effort
function table({ adapter, db, config }) {
  return Object.entries(JOBS).map(([job, label]) => ({ job, label, ...resolve({ adapter, job, db, config, env: {} }) }));
}
function saveOverrides(db, adapter, body) {
  const cur = (() => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='agent_models'").get()?.value || '{}'); } catch { return {}; } })();
  const next = { default: clean(body.default) || {}, jobs: {} };
  const base = resolve({ adapter, job: '__default__', db: null, config: require('../config').get(), env: {} });
  for (const [job, v] of Object.entries(body.jobs || {})) {
    if (!JOBS[job]) continue;
    const c = clean(v);
    // only what differs from the default is an override
    if (c && ((c.model && c.model !== base.model) || (c.effort && c.effort !== base.effort) || c.fallback)) next.jobs[job] = c;
  }
  cur[adapter] = next;
  db.prepare("INSERT INTO settings (key,value) VALUES ('agent_models',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(cur));
  return next;
}
module.exports = { JOBS, DEFAULTS, resolve, table, saveOverrides, envOverrides };
