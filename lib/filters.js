'use strict';
// User-managed mail filters, applied in CODE before any model call (in the daily import and in live mail).
//   action skip     : the mail is stored and searchable, never sent to a model
//   action fyi      : facts only (no tasks), cheap model
//   action relevant : never filtered (also beats every other rule and the code noise filter)
// Rule kinds: sender (exact address), domain, text (a plain phrase in subject/body), regex (advanced). An optional project scope limits a rule to mail about that project.
const { now } = require('./db');
const { bad, missing } = require('./store');

const ACTIONS = ['skip', 'fyi', 'relevant'];
const KINDS = ['sender', 'domain', 'text', 'regex'];
const addrOf = (s) => String(((/<([^>]+)>/.exec(s || '') || [])[1] || s || '')).trim().toLowerCase();
const ACTION_HE = { skip: 'לדלג (רק לשמור)', fyi: 'לידיעה בלבד (עובדות)', relevant: 'תמיד רלוונטי' };

function createFilters({ db, store }) {
  const q = (sql) => db.prepare(sql);
  const row = (id) => { const r = q('SELECT * FROM mail_filters WHERE id=?').get(id); if (!r) throw missing('הכלל לא נמצא'); return r; };
  const list = () => q('SELECT f.*, p.name_he AS project FROM mail_filters f LEFT JOIN projects p ON p.id=f.project_id ORDER BY f.id').all().map((r) => ({ ...r, enabled: !!r.enabled, action_he: ACTION_HE[r.action] }));

  function norm(b) {
    const kind = String(b.kind || '').trim(); if (!KINDS.includes(kind)) throw bad('סוג כלל לא תקין');
    const action = String(b.action || 'skip').trim(); if (!ACTIONS.includes(action)) throw bad('פעולה לא תקינה: skip, fyi או relevant');
    let pattern = String(b.pattern ?? '').trim(); if (!pattern) throw bad('יש להזין תבנית');
    if (kind === 'sender' || kind === 'domain') pattern = pattern.toLowerCase().replace(/^@/, '');
    if (kind === 'regex') { try { new RegExp(pattern, 'i'); } catch { throw bad('הביטוי הרגולרי אינו תקין'); } }
    const field = ['subject', 'body', 'any'].includes(b.field) ? b.field : 'any';
    const project = b.project ?? b.project_id; const pid = project ? store.findProject(project).id : null;
    return { kind, action, pattern, field, project_id: pid, note: String(b.note ?? '').slice(0, 200) };
  }
  function add(actor, b) {
    const r = norm(b);
    const dup = q('SELECT id FROM mail_filters WHERE kind=? AND pattern=? AND action=? AND COALESCE(project_id,0)=?').get(r.kind, r.pattern, r.action, r.project_id ?? 0);
    if (dup) return list().find((x) => x.id === dup.id);
    const id = q('INSERT INTO mail_filters (kind, pattern, field, project_id, action, note, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)').run(r.kind, r.pattern, r.field, r.project_id, r.action, r.note, now()).lastInsertRowid;
    store.logEvent(actor, 'filter', id, 'create', 'pattern', null, `${r.kind}:${r.pattern} -> ${r.action}`);
    return list().find((x) => x.id === id);
  }
  function update(actor, id, b) {
    const cur = row(id);
    if (b.enabled !== undefined) { q('UPDATE mail_filters SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, id); store.logEvent(actor, 'filter', id, 'update', 'enabled', cur.enabled, b.enabled ? 1 : 0); }
    if (b.action !== undefined) { if (!ACTIONS.includes(b.action)) throw bad('פעולה לא תקינה'); q('UPDATE mail_filters SET action=? WHERE id=?').run(b.action, id); }
    return list().find((x) => x.id === id);
  }
  function remove(actor, id) { row(id); return require('./trash').createTrash({ db, store }).trashFilter(actor, id); } // to the recycle bin (restorable)

  // ---- matching
  const projectsIn = (text) => { const h = String(text || '').toLowerCase(); return store.listProjects().filter((p) => !p.is_default && [p.name_he, ...p.aliases].some((n) => n && [...String(n)].length >= 3 && h.includes(String(n).toLowerCase()))).map((p) => p.id); };
  function features(e) {
    const from = addrOf(e.forwarded_from || e.from_addr);
    const subject = String(e.original_subject || e.subject || ''); const body = String(e.body_text || '').slice(0, 8000);
    return { from, domain: from.split('@')[1] || '', subject, body, projects: e.project_id ? [e.project_id] : projectsIn(`${subject} ${body.slice(0, 3000)}`) };
  }
  function ruleMatches(r, f) {
    if (r.project_id && !f.projects.includes(r.project_id)) return false;
    const p = r.pattern;
    switch (r.kind) {
      case 'sender': return f.from === p;
      case 'domain': return f.domain === p || f.domain.endsWith('.' + p);
      case 'text': { const lp = p.toLowerCase(); return (r.field !== 'body' && f.subject.toLowerCase().includes(lp)) || (r.field !== 'subject' && f.body.toLowerCase().includes(lp)); }
      case 'regex': { const re = new RegExp(p, 'i'); return (r.field !== 'body' && re.test(f.subject)) || (r.field !== 'subject' && re.test(f.body)); }
      default: return false;
    }
  }
  // the winning rule for an email: any "relevant" rule beats everything, then skip, then fyi
  function match(e, rules = null) {
    const f = features(e); const hits = (rules || list().filter((r) => r.enabled)).filter((r) => ruleMatches(r, f));
    for (const a of ['relevant', 'skip', 'fyi']) { const r = hits.find((x) => x.action === a); if (r) return { rule: r, action: a }; }
    return null;
  }
  // how many mails of the last N days a rule (not yet saved) would catch
  function preview(b, days = 30) {
    const r = { ...norm(b), enabled: true };
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = q(`SELECT id, from_addr, forwarded_from, subject, original_subject, body_text, project_id, COALESCE(mail_date, forwarded_date, received_at) d FROM emails WHERE archived = 0 AND COALESCE(import_state,'') NOT IN ('container','outer') AND COALESCE(mail_date, forwarded_date, received_at) >= ? ORDER BY d DESC`).all(since);
    const hit = rows.filter((e) => ruleMatches(r, features(e)));
    return { days, total: rows.length, matches: hit.length, examples: hit.slice(0, 5).map((e) => ({ id: e.id, from: addrOf(e.forwarded_from || e.from_addr), subject: String(e.original_subject || e.subject || '').slice(0, 80) })) };
  }
  // stamp an email with its filter result; skip mails are finished here (stored, searchable, never sent to a model)
  function apply(emailId) {
    const e = q('SELECT * FROM emails WHERE id=?').get(emailId); if (!e) return null;
    const m = match(e); if (!m) return null;
    q('UPDATE emails SET filter_action=?, filter_rule=? WHERE id=?').run(m.action, m.rule.id, emailId);
    q('UPDATE mail_filters SET hits=hits+1 WHERE id=?').run(m.rule.id);
    if (m.action === 'skip') {
      q("UPDATE emails SET import_state=CASE WHEN import_state IS NULL OR import_state IN ('parsed','staged') THEN 'noise' ELSE import_state END, triage='noise', noise_reason=?, processed_at=COALESCE(processed_at, ?) WHERE id=?").run(`כלל שלך: ${m.rule.kind} ${m.rule.pattern}`, now(), emailId);
      q("UPDATE events SET processed_at=? WHERE entity='email' AND entity_id=? AND processed_at IS NULL").run(now(), emailId);
    }
    return m;
  }
  return { list, add, update, remove, match, preview, apply, features, ACTIONS, KINDS };
}
module.exports = { createFilters, ACTIONS, KINDS };
