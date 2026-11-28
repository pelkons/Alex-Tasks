'use strict';
// `mesimot apply`: the assistant's structured answer. Decisions on related tasks, new tasks, knowledge and the chat reply are
// validated together and applied in one transaction, so a bad answer changes nothing and everything is logged and undoable.
const { now } = require('./db');
const { bad } = require('./store');

const ACTIONS = ['close', 'advance', 'update', 'no_change'];
const ACTION_HE = { close: 'נסגרה', advance: 'התקדמה', update: 'עודכנה' };
const CHANGE_KEYS = { status: 'status', priority: 'priority', due: 'due', due_date: 'due', due_source: 'due_source', assignee: 'assignee', project: 'project', title: 'title', description: 'description', desc: 'description', requester: 'requester' };

class Rollback extends Error {}

function createApply(db, store, knowledge, chat, protocols, calendar, entities = null) {
  const q = (sql) => db.prepare(sql);
  const runIdOpen = () => q('SELECT id, required_tasks, required_entities FROM claude_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1').get();

  function missingDecisions(runId, required, inPayload) {
    const decided = new Set([...(runId ? q('SELECT task_id FROM decisions WHERE run_id=?').all(runId).map((r) => r.task_id) : []), ...inPayload]);
    return required.filter((t) => !decided.has(t.id));
  }

  function apply(actor, payload, { dry = false } = {}) {
    if (!payload || typeof payload !== 'object') throw bad('נדרש JSON עם החלטות');
    const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
    const newTasks = Array.isArray(payload.new_tasks) ? payload.new_tasks : [];
    const facts = Array.isArray(payload.knowledge) ? payload.knowledge : [];
    const attention = Array.isArray(payload.attention) ? payload.attention : [];
    const projectFacts = Array.isArray(payload.facts) ? payload.facts : [];
    const run = runIdOpen();
    const required = run?.required_tasks ? JSON.parse(run.required_tasks) : [];

    // shape checks and the completeness rule come first: nothing is applied when a related task has no decision
    for (const d of decisions) {
      if (!d || !Number.isInteger(+d.task)) throw bad('בכל החלטה חייב להופיע מזהה משימה (task)');
      if (!ACTIONS.includes(d.action)) throw bad(`פעולה לא תקינה בהחלטה על משימה ${d.task}. האפשרויות: ${ACTIONS.join(', ')}`);
      if (!String(d.reason ?? '').trim()) throw bad(`חסרה סיבה (reason) בהחלטה על משימה ${d.task}`);
      store.getTask(+d.task);
    }
    // partial people / vague projects the code found in the incoming items need a verdict too: resolve (merge or complete) or not_same
    const resolutions = Array.isArray(payload.resolutions) ? payload.resolutions : [];
    const reqEntities = run?.required_entities ? JSON.parse(run.required_entities) : [];
    for (const r of resolutions) {
      if (!['person', 'project'].includes(r?.type) || !Number.isInteger(+r.id)) throw bad('בכל קביעה על זיהוי חייבים type (person/project) ו-id');
      if (!['merge', 'complete', 'not_same'].includes(r.action)) throw bad(`פעולה לא תקינה בזיהוי ${r.type} ${r.id}. האפשרויות: merge, complete, not_same`);
      if (!String(r.reason ?? '').trim()) throw bad(`חסרה סיבה (reason) בזיהוי ${r.type} ${r.id}`);
      if (r.action === 'merge' && !(r.into ?? r.into_id)) throw bad(`חסר into במיזוג ${r.type} ${r.id}`);
    }
    const stillOpen = (en) => {
      const row = q(en.type === 'person' ? "SELECT status AS s FROM people WHERE id=?" : 'SELECT partial AS s FROM projects WHERE id=?').get(en.id);
      if (!row || (en.type === 'person' ? row.s !== 'partial' : !row.s)) return false; // completed or merged earlier in this run
      const t0 = run ? q('SELECT started_at FROM claude_runs WHERE id=?').get(run.id)?.started_at || '' : '';
      return !(en.identities || []).some((i) => q('SELECT 1 FROM entity_decisions WHERE entity_type=? AND entity_id=? AND identity=? AND created_at >= ?').get(en.type, en.id, String(i).toLowerCase(), t0));
    };
    const unresolved = reqEntities.filter((en) => !resolutions.some((r) => r.type === en.type && +r.id === en.id) && stillOpen(en));
    if (unresolved.length) throw bad(`חסרה קביעה על זיהוי: ${unresolved.map((en) => `${en.type} ${en.id} (${en.name})`).join('; ')}. לכל אחד יש להחליט ב-"resolutions": merge (לאחד עם רשומה מלאה), complete (להשלים פרטים במקום) או not_same (לא אותו אדם/פרויקט), עם reason.`);
    let missing = missingDecisions(run?.id, required, decisions.map((d) => +d.task));
    // WEAKLY related tasks (search hits, same-project context: rank above 3) that got no decision are treated as "no_change" automatically; only STRONG links must be decided
    const weakMissing = missing.filter((t) => (t.rank ?? 0) > 3);
    missing = missing.filter((t) => !((t.rank ?? 0) > 3));
    for (const t of weakMissing) decisions.push({ task: t.id, action: 'no_change', reason: 'לא קשור ישירות למקור (נקבע אוטומטית)', _auto: true });
    if (missing.length) throw bad(`חסרות החלטות על משימות קשורות: ${missing.map((t) => `${t.id} (${t.title})`).join('; ')}. יש לשלוח את כל ההחלטות בקריאה אחת: close / advance / update / no_change עם reason.`);

    const touched = [], created = [];
    const resolved = [];
    const doIt = db.transaction(() => {
      for (const r of resolutions) {
        if (!entities) throw bad('זיהוי ישויות אינו זמין');
        const req = reqEntities.find((en) => en.type === r.type && en.id === +r.id);
        if (r.action === 'not_same') {
          for (const identity of (req && req.identities) || [`reason:${r.id}`]) entities.markNotSame(actor, r.type, +r.id, identity, String(r.reason).trim());
          resolved.push({ type: r.type, id: +r.id, action: 'not_same' });
          continue;
        }
        const opts = { ...r, into: r.action === 'merge' ? (r.into ?? r.into_id) : undefined };
        const out = r.type === 'person' ? entities.resolvePerson(actor, +r.id, opts) : entities.resolveProject(actor, +r.id, opts);
        resolved.push({ type: r.type, id: +r.id, action: r.action, relinked_tasks: out.relinked_tasks ?? out.moved_tasks ?? 0 });
      }
      for (const d of decisions) {
        const id = +d.task;
        const emailId = d.email ?? payload.email ?? null;
        const input = {};
        for (const [k, v] of Object.entries(d.changes || {})) { if (!CHANGE_KEYS[k]) throw bad(`שדה לא נתמך בשינויים: ${k}`); input[CHANGE_KEYS[k]] = v; }
        if (d.action === 'close' && !input.status) input.status = q('SELECT id FROM statuses WHERE is_done=1 ORDER BY sort LIMIT 1').get().id;
        if (d.action === 'advance' && !input.status && store.getTask(id).status === 'חדש') input.status = 'בטיפול';
        if (d.action !== 'no_change' && Object.keys(input).length) store.updateTask(actor, id, input);
        if (d.action !== 'no_change') {
          store.addNote(actor, { task: id, text: `${ACTION_HE[d.action]}: ${String(d.reason).trim()}${d.note ? '\n' + d.note : ''}` });
          touched.push(id);
        }
        if (emailId && d.action !== 'no_change') store.linkTaskEmail(actor, id, +emailId, d.action === 'close' ? 'closed' : 'updated');
        const did = q('INSERT INTO decisions (run_id, task_id, action, reason, email_id, created_at) VALUES (?,?,?,?,?,?)').run(run?.id ?? null, id, d.action, String(d.reason).trim(), emailId ? +emailId : null, now()).lastInsertRowid;
        store.logEvent(actor, 'task', id, 'decision', d.action, null, String(d.reason).trim(), { decision_id: did });
      }
      for (const nt of newTasks) {
        const t = store.createTask(actor, { ...nt, email: nt.email ?? payload.email ?? undefined });
        created.push(t.id);
      }
      for (const k of facts) knowledge.addKnowledge(actor, { source: 'chat', ...k });
      if (run && (Array.isArray(payload.facts) || payload.facts_checked)) q('UPDATE claude_runs SET facts_checked=1 WHERE id=?').run(run.id);
      for (const dn of Array.isArray(payload.dismiss_names) ? payload.dismiss_names : []) {
        q('INSERT OR REPLACE INTO entity_decisions (entity_type, entity_id, identity, verdict, reason, created_at) VALUES (?,?,?,?,?,?)').run('name', run?.id ?? 0, String(dn.name).trim().toLowerCase(), 'dismissed', String(dn.reason ?? ''), now());
      }
      for (const dc of Array.isArray(payload.dup_checks) ? payload.dup_checks : []) {
        q('INSERT OR REPLACE INTO entity_decisions (entity_type, entity_id, identity, verdict, reason, created_at) VALUES (?,?,?,?,?,?)').run('dup', +dc.task, `of:${+dc.of}`, String(dc.verdict || 'different'), String(dc.reason ?? ''), now());
      }
      for (const mn of Array.isArray(payload.mentions) ? payload.mentions : []) {
        if (!entities) break;
        const type = mn.type === 'project' ? 'project' : 'person';
        const ent = type === 'person' ? store.findPerson(mn.id ?? mn.name) : store.findProject(mn.id ?? mn.name);
        entities.addMention(type, ent.id, mn.source_type || 'chat', +mn.source_id, mn.surface || mn.name || '');
      }
      for (const pr of Array.isArray(payload.protocols) ? payload.protocols : []) protocols.addProtocol(actor, { source: payload.email ? `email:${payload.email}` : undefined, ...pr });
      for (const ci of Array.isArray(payload.calendar) ? payload.calendar : []) calendar.addItem(actor, { email: payload.email, ...ci });
      for (const d of Array.isArray(payload.drafts) ? payload.drafts : []) store.addDraft(actor, +d.task, d.text, { long: !!d.long });
      // outgoing mail: the assistant can only create / change / cancel DRAFTS here. There is no "approve" and no "send": that belongs to the owner's button.
      for (const o of Array.isArray(payload.outbox) ? payload.outbox : []) {
        const ob = store.hooks.outbox; if (!ob) throw bad('שליחת מיילים אינה זמינה');
        const { op, id, ...b } = o || {};
        if (op === 'draft' || (!op && !id)) ob.create(actor, b);
        else if (op === 'update' || (!op && id)) ob.update(actor, +id, b);
        else if (op === 'cancel') ob.cancel(actor, +id);
        else throw bad(`פעולה לא מוכרת ב-outbox: ${op}. מותר: draft, update, cancel`);
      }
      for (const pp of Array.isArray(payload.people) ? payload.people : []) store.updatePerson(actor, pp.id ?? pp.person, { name: pp.name ?? pp.name_he, name_en: pp.name_en });
      // attachments: {id, project, summary, facts_checked} per file; facts sourced file:ID also mark that file as checked for facts
      for (const fl of Array.isArray(payload.files) ? payload.files : []) {
        if (!fl || !Number.isInteger(+fl.id)) throw bad('בכל קובץ ב-files חייב להופיע id');
        knowledge.classifyFile(actor, +fl.id, { project: fl.project, summary: fl.summary, facts_checked: fl.facts_checked });
      }
      for (const f of projectFacts) { const m = /^file:(\d+)$/.exec(String(f.source || '')); if (m) q('UPDATE files SET facts_checked=1 WHERE id=?').run(+m[1]); }
      const factResults = projectFacts.map((f) => knowledge.setFact(actor, { source: payload.email ? `email:${payload.email}` : 'chat', ...f }).result);
      for (const m of Array.isArray(payload.fact_merges) ? payload.fact_merges : []) knowledge.mergeFactKey(actor, m);
      // the PASSPORT and the LATEST STATUS PER PROCESS (lib/profile.js enforces newer-wins, owner-wins and a real source)
      const defSrc = payload.email ? `email:${payload.email}` : undefined;
      const profileResults = (Array.isArray(payload.profile) ? payload.profile : []).map((pr) => knowledge.profile.setProfile(actor, { source: defSrc, ...pr }).results);
      const statusResults = (Array.isArray(payload.statuses) ? payload.statuses : []).map((st) => knowledge.profile.setStatus(actor, { source: defSrc, ...st }).result);
      for (const ft of Array.isArray(payload.fact_topics) ? payload.fact_topics : []) {
        if (Array.isArray(ft.ids)) { for (const id of ft.ids) knowledge.profile.setFactTopic(actor, { id, topic: ft.topic }); } else knowledge.profile.setFactTopic(actor, ft);
      }
      if (run && (Array.isArray(payload.profile) || Array.isArray(payload.statuses) || payload.profile_checked)) q('UPDATE claude_runs SET profile_checked=1 WHERE id=?').run(run.id);
      for (const pr of Array.isArray(payload.projects) ? payload.projects : []) store.updateProject(actor, pr.project ?? pr.id, { summary: pr.summary ?? pr.summary_he });
      for (const m of Array.isArray(payload.merge_people) ? payload.merge_people : []) store.mergePerson(actor, m.from, m.into);
      for (const a of attention) store.addAttention(actor, a);
      let message = null;
      if (payload.chat_message && String(payload.chat_message).trim()) {
        const ids = [...new Set([...created, ...touched])];
        message = chat.sendChat(actor, { text: String(payload.chat_message), task: (payload.chat_tasks ? payload.chat_tasks : ids).join(','), file_ids: Array.isArray(payload.chat_files) ? payload.chat_files : [] }, { agent: true });
      }
      if (payload.summary && run) q('UPDATE claude_runs SET summary_he=? WHERE id=?').run(String(payload.summary).trim(), run.id);
      if (dry) throw new Rollback();
      return { resolutions: resolved, decisions: decisions.length, closed: decisions.filter((d) => d.action === 'close').length, created, knowledge: facts.length, facts: factResults, profile: profileResults, statuses: statusResults, attention: attention.length, message: message ? message.id : null };
    });
    try { return { ok: true, ...doIt() }; } catch (e) { if (e instanceof Rollback) return { ok: true, dry: true, decisions: decisions.length, new_tasks: newTasks.length }; throw e; }
  }

  return { apply };
}

module.exports = { createApply };
