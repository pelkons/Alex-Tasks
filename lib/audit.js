'use strict';
// Quality audits that END as proposals for the owner (lib/proposals.js): tasks of an import (near-duplicates in code, the rest judged by one cheap model call)
// and people (duplicates and system senders, in code only). Nothing here changes data.
const { keywords } = require('./context');

const NOISE_ADDR = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply|mailer-daemon|postmaster|bounce|notifications?|alerts?|system|automailer|newsletter|news|updates?|support|info|office|admin|service|billing|invoice|accounts?|donotreply)([-_.+0-9].*)?@/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[\s'"׳״.,\-_()]+/g, '');

function createAudit({ db, store }) {
  const q = (sql) => db.prepare(sql);
  const hidden = q('SELECT id FROM statuses WHERE hidden_default=1').get()?.id;

  // ---------- tasks created by an import and still open
  function importTasks(importId) {
    const ids = q(`SELECT DISTINCT e.entity_id id FROM events e WHERE e.entity='task' AND e.action='create' AND e.run_id IN (SELECT id FROM claude_runs WHERE import_id=?)`).all(importId).map((r) => r.id);
    return ids.map((id) => { try { return store.getTask(id); } catch { return null; } }).filter((t) => t && !t.status_closed && t.status_id !== hidden);
  }
  function describe(t) {
    const src = t.source_email_id ? q('SELECT id, COALESCE(original_subject, subject) subj, body_text, direction, mail_date, thread_key FROM emails WHERE id=?').get(t.source_email_id) : null;
    const later = src && src.thread_key ? q('SELECT direction FROM emails WHERE thread_key=? AND mail_date > ? AND id<>?').all(src.thread_key, src.mail_date || '', src.id) : [];
    return { id: t.id, title: t.title, project: t.project, requester: t.requester, assignee: t.assignee, due: t.due_date, source: src ? { subject: src.subj, direction: src.direction, gist: String(src.body_text || '').replace(/\s+/g, ' ').slice(0, 220) } : null, later_mails: later.length, owner_replied_later: later.some((l) => l.direction === 'sent') };
  }
  // near-duplicates in the same project: the newer one is proposed as the duplicate of the older
  function duplicates(tasks) {
    const kw = new Map(tasks.map((t) => [t.id, new Set(keywords(t.title, 12))]));
    const out = [], seen = new Set();
    for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j]; if (a.project_id !== b.project_id) continue;
      const A = kw.get(a.id), B = kw.get(b.id); if (!A.size || !B.size) continue;
      let inter = 0; for (const x of A) if (B.has(x)) inter++;
      const sim = inter / (A.size + B.size - inter);
      if (sim >= 0.6 || norm(a.title) === norm(b.title)) {
        const [keep, dup] = a.id < b.id ? [a, b] : [b, a];
        if (seen.has(dup.id)) continue; seen.add(dup.id);
        out.push({ kind: 'task_merge', target_id: dup.id, other_id: keep.id, text: `משימה ${dup.id} "${dup.title}" היא כפילות של משימה ${keep.id} "${keep.title}"`, reason: `דמיון ${Math.round(sim * 100)}% באותו פרויקט` });
      }
    }
    return out;
  }
  function verdictsToProposals(descs, verdicts, skip = new Set()) {
    const byId = new Map(descs.map((d) => [d.id, d]));
    const kindOf = { resolved: 'task_close', info_only: 'task_info', not_ours: 'task_notours' };
    const label = { resolved: 'כבר טופל', info_only: 'לידיעה בלבד', not_ours: 'לא באחריות הצוות' };
    const out = [];
    for (const v of verdicts) {
      const d = byId.get(+v.id); const kind = kindOf[v.verdict];
      if (!d || !kind || skip.has(d.id)) continue;
      out.push({ kind, target_id: d.id, text: `משימה ${d.id} "${d.title}" (${label[v.verdict]})`, reason: String(v.reason || '').slice(0, 200) });
    }
    return out;
  }

  // ---------- people
  const refs = (id) => q('SELECT (SELECT COUNT(*) FROM tasks WHERE requester_id=? OR assignee_id=?) t, (SELECT COUNT(*) FROM protocol_items WHERE owner_person_id=?) pi').get(id, id, id);
  function people() {
    const all = store.listPeople().filter((p) => p.role !== 'owner' && p.role !== 'assistant');
    const used = (p) => { const r = refs(p.id); return r.t + r.pi; };
    const out = [], handled = new Set();
    const richness = (p) => used(p) * 10 + p.emails.length + (p.company ? 2 : 0) + (p.role_text ? 2 : 0) + (p.status === 'partial' ? 0 : 3);
    const pairUp = (group, why) => {
      const sorted = [...group].sort((a, b) => richness(b) - richness(a) || a.id - b.id);
      const keep = sorted[0];
      for (const dup of sorted.slice(1)) { if (handled.has(dup.id) || handled.has(keep.id)) continue; handled.add(dup.id); out.push({ kind: 'person_merge', target_id: dup.id, other_id: keep.id, text: `${dup.name_he}${dup.emails[0] ? ' <' + dup.emails[0] + '>' : ''} ← מיזוג לתוך ${keep.name_he}${keep.emails[0] ? ' <' + keep.emails[0] + '>' : ''}`, reason: why }); }
    };
    const byEmail = new Map(); for (const p of all) for (const e of p.emails) { const k = String(e).toLowerCase(); if (!byEmail.has(k)) byEmail.set(k, []); byEmail.get(k).push(p); }
    for (const [e, g] of byEmail) if (g.length > 1) pairUp(g, `אותה כתובת: ${e}`);
    const byName = new Map(); for (const p of all) { const k = norm(p.name_he); if (k.length >= 3) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); } }
    for (const g of byName.values()) { const rest = g.filter((p) => !handled.has(p.id)); if (rest.length > 1) pairUp(rest, 'אותו שם'); }
    for (const p of all) {
      if (handled.has(p.id) || used(p) > 0) continue;
      const nameNoise = /^[\d\W_a-z]{1,3}$/i.test(String(p.name_he).trim()) || /^[\d\s\-+()]+$/.test(p.name_he);
      const addrNoise = p.emails.length > 0 && p.emails.every((e) => NOISE_ADDR.test(e));
      const nameIsAddr = /@/.test(p.name_he);
      if (nameNoise || addrNoise || nameIsAddr) { handled.add(p.id); out.push({ kind: 'person_remove', target_id: p.id, text: `${p.name_he}${p.emails[0] ? ' <' + p.emails[0] + '>' : ''} (אף משימה לא קשורה אליו)`, reason: nameNoise ? 'שם לא תקין' : addrNoise ? 'כתובת מערכת או רשימת תפוצה' : 'השם הוא כתובת' }); }
    }
    return out;
  }
  return { importTasks, describe, duplicates, verdictsToProposals, people };
}
module.exports = { createAudit };
