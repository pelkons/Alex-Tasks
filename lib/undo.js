'use strict';
// Activity feed (what the assistant did, grouped by run) and undo through the events log.
const { now } = require('./db');
const { bad, missing } = require('./store');

const TASK_KEYS = { title: 'title', description: 'description', project: 'project', assignee: 'assignee', status: 'status', priority: 'priority', requester: 'requester', due_date: 'due_date', parent_task_id: 'parent_task_id' };
const PROJECT_KEYS = { partial: 'partial', name_he: 'name', aliases: 'aliases', description: 'description', status: 'status', color: 'color', summary_he: 'summary' };
const PERSON_KEYS = { name_he: 'name', role: 'role', emails: 'emails', notes: 'notes', company: 'company', role_text: 'role_text', status: 'status', name_en: 'name_en' };

function createUndo(db, store, knowledge) {
  const q = (sql) => db.prepare(sql);
  const owner = () => store.ownerId();
  const ownerLabel = (id) => (id ? q('SELECT name_he FROM people WHERE id=?').get(id)?.name_he : null);

  function entityLabel(entity, id) {
    try {
      if (entity === 'task') return q('SELECT title t FROM tasks WHERE id=?').get(id)?.t ?? null;
      if (entity === 'project') return q('SELECT name_he t FROM projects WHERE id=?').get(id)?.t ?? null;
      if (entity === 'knowledge') return q('SELECT title t FROM knowledge WHERE id=?').get(id)?.t ?? null;
      if (entity === 'person') return q('SELECT name_he t FROM people WHERE id=?').get(id)?.t ?? null;
      if (entity === 'attention') return q('SELECT text t FROM attention WHERE id=?').get(id)?.t ?? null;
      if (entity === 'file') return q('SELECT original_name t FROM files WHERE id=?').get(id)?.t ?? null;
      if (entity === 'fact') return q("SELECT key || ': ' || value t FROM project_facts WHERE id=?").get(id)?.t ?? null;
      if (entity === 'profile') return q("SELECT field || ': ' || value t FROM project_profile WHERE id=?").get(id)?.t ?? null;
      if (entity === 'pstatus') return q("SELECT process || ': ' || value t FROM project_status WHERE id=?").get(id)?.t ?? null;
      if (entity === 'email') return q('SELECT COALESCE(original_subject, subject) t FROM emails WHERE id=?').get(id)?.t ?? null;
      if (entity === 'chat') return q('SELECT substr(text,1,80) t FROM chat_messages WHERE id=?').get(id)?.t ?? null;
    } catch { /* ignore */ }
    return null;
  }

  const eqv = (a, b) => String(a ?? '') === String(b ?? '');
  const meta = (e) => { try { return e.meta ? JSON.parse(e.meta) : {}; } catch { return {}; } };

  // a resolution (completing or merging a partial person/project) is undone from its meta
  function resolveBlocker(table, e, m, cur) {
    if (!cur) return 'הרשומה כבר לא קיימת';
    if (m.in_place) return null;
    if (!m.from_row) return 'לא ניתן לבטל';
    return q(`SELECT 1 FROM ${table} WHERE id=?`).get(m.from_row.id) ? 'המזהה המקורי כבר בשימוש' : null;
  }
  function undoResolve(actor, table, e, m) {
    for (const id of m.note_ids || []) { q('DELETE FROM notes WHERE id=?').run(id); q("UPDATE events SET undone_at=? WHERE entity='task' AND action='note' AND undone_at IS NULL AND json_extract(meta,'$.note_id')=?").run(now(), id); }
    if (m.in_place || !m.from_row) return;
    const row = m.from_row;
    const cols = Object.keys(row);
    q(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    const back = (key, ids, ref) => { for (const id of ids) q(`UPDATE ${key.split('.')[0]} SET ${key.split('.')[1]}=? WHERE id=?`).run(ref, id); };
    for (const [key, ids] of Object.entries(m.moved || {})) back(key, ids, row.id);
    const type = table === 'people' ? 'person' : 'project';
    for (const id of [...(m.mentions || [])]) q('UPDATE mentions SET entity_id=? WHERE id=?').run(row.id, id);
    if (table === 'projects') {
      q('UPDATE projects SET aliases=? WHERE id=?').run(m.aliases_before, e.entity_id);
      for (const id of m.superseded || []) q('UPDATE project_facts SET superseded_by=NULL WHERE id=?').run(id);
      for (const [t, id] of m.superseded_slots || []) if (t === 'project_profile' || t === 'project_status') q(`UPDATE ${t} SET superseded_by=NULL WHERE id=?`).run(id);
    }
    if (table === 'people') {
      for (const id of m.protocols || []) {
        const pr = q('SELECT participants FROM protocols WHERE id=?').get(id);
        q('UPDATE protocols SET participants=? WHERE id=?').run(JSON.stringify(JSON.parse(pr.participants || '[]').map((x) => (x.person_id === e.entity_id ? { ...x, person_id: row.id } : x))), id);
      }
    }
    void type;
  }

  // null when the event can be undone, otherwise the reason (Hebrew)
  function blocker(e) {
    if (e.undone_at) return 'כבר בוטל';
    const m = meta(e);
    const same = (cur) => (eqv(cur, e.new_value) ? null : 'הערך השתנה מאז הפעולה');
    switch (e.entity) {
      case 'task': {
        const t = q('SELECT t.*, p.name_he project, a.name_he assignee, s.name_he status, pr.name_he priority, rq.name_he requester FROM tasks t JOIN projects p ON p.id=t.project_id JOIN statuses s ON s.id=t.status_id JOIN priorities pr ON pr.id=t.priority_id LEFT JOIN people a ON a.id=t.assignee_id LEFT JOIN people rq ON rq.id=t.requester_id WHERE t.id=?').get(e.entity_id);
        if (!t) return 'המשימה לא קיימת';
        if (e.action === 'create') return t.status === 'בוטל' ? 'המשימה כבר מבוטלת' : null;
        if (e.action === 'note') return q('SELECT 1 FROM notes WHERE id=?').get(m.note_id) ? null : 'ההערה כבר לא קיימת';
        if (e.action === 'draft') return q('SELECT 1 FROM drafts WHERE id=?').get(m.draft_id) ? null : 'הטיוטה כבר לא קיימת';
        if (e.action === 'decision') return 'ההחלטה נרשמה. אפשר לבטל את השינויים שבעקבותיה';
        if (e.action === 'update') {
          const f = e.field;
          if (['due_source', 'source_date'].includes(f)) return same(t[f]);
          if (!(f in TASK_KEYS)) return 'לא ניתן לבטל שינוי מסוג זה';
          const cur = { project: t.project, assignee: t.assignee, status: t.status, priority: t.priority, requester: t.requester }[f] ?? t[f === 'parent_task_id' ? 'parent_task_id' : f];
          return same(cur);
        }
        return 'לא ניתן לבטל';
      }
      case 'project': {
        const p = q('SELECT * FROM projects WHERE id=?').get(e.entity_id);
        if (e.action === 'resolve') return resolveBlocker('projects', e, m, p);
        if (e.action === 'merge') return 'לא ניתן לבטל מיזוג פרויקטים';
        if (!p) return 'הפרויקט לא קיים';
        if (e.action === 'create') return q('SELECT 1 FROM tasks WHERE project_id=?').get(p.id) ? 'יש בפרויקט משימות' : null;
        if (e.action === 'note') return q('SELECT 1 FROM notes WHERE id=?').get(m.note_id) ? null : 'ההערה כבר לא קיימת';
        if (e.action === 'update') return e.field in PROJECT_KEYS ? same(p[e.field]) : 'לא ניתן לבטל שינוי מסוג זה';
        return 'לא ניתן לבטל';
      }
      case 'person': {
        const p = q('SELECT * FROM people WHERE id=?').get(e.entity_id);
        if (e.action === 'resolve') return resolveBlocker('people', e, m, p);
        if (e.action === 'update' && p && e.field in PERSON_KEYS) return same(p[e.field]);
        return 'לא ניתן לבטל';
      }
      case 'attention': {
        const a = q('SELECT * FROM attention WHERE id=?').get(e.entity_id);
        if (!a) return 'הפריט לא קיים';
        if (e.action === 'create') return a.status === 'dismissed' ? 'הפריט כבר נדחה' : null;
        if (e.action === 'update') return same(a.status);
        return 'לא ניתן לבטל';
      }
      case 'knowledge': {
        const k = q('SELECT * FROM knowledge WHERE id=?').get(e.entity_id);
        if (!k) return 'פריט המידע לא קיים';
        if (e.action === 'create') return k.superseded_by ? 'הפריט הוחלף' : null;
        if (e.action === 'update') return ['title', 'body', 'kind', 'superseded_by', 'project'].includes(e.field) ? (e.field === 'project' ? null : same(e.field === 'superseded_by' ? k.superseded_by : k[e.field])) : 'לא ניתן לבטל שינוי מסוג זה';
        return 'לא ניתן לבטל';
      }
      case 'fact': {
        const f = q('SELECT * FROM project_facts WHERE id=?').get(e.entity_id);
        if (!f) return 'הנתון לא קיים';
        if (e.action === 'create') return f.superseded_by && !m.history_only ? 'הנתון הוחלף מאז' : null;
        if (e.action === 'update' && e.field === 'key') return same(f.key);
        if (e.action === 'update' && e.field === 'superseded_by') return same(f.superseded_by);
        return 'לא ניתן לבטל';
      }
      case 'profile': case 'pstatus': {
        const t = e.entity === 'profile' ? 'project_profile' : 'project_status';
        const r = q(`SELECT * FROM ${t} WHERE id=?`).get(e.entity_id);
        if (!r) return 'הערך לא קיים';
        if (e.action === 'create') return r.superseded_by && !m.history_only ? 'הערך הוחלף מאז' : null;
        return 'לא ניתן לבטל';
      }
      case 'file':
        return e.action === 'update' && ['project', 'task', 'summary'].includes(e.field) ? null : 'לא ניתן לבטל העלאת קובץ';
      default: return 'לא ניתן לבטל פעולה מסוג זה';
    }
  }

  function revert(actor, e) {
    const m = meta(e);
    const old = e.old_value;
    switch (e.entity) {
      case 'task':
        if (e.action === 'create') { store.updateTask(actor, e.entity_id, { status: q('SELECT id FROM statuses WHERE hidden_default=1 ORDER BY sort LIMIT 1').get().id }); break; }
        if (e.action === 'note') { q('DELETE FROM notes WHERE id=?').run(m.note_id); break; }
        if (e.action === 'draft') { q('DELETE FROM drafts WHERE id=?').run(m.draft_id); break; }
        if (e.field === 'due_source' || e.field === 'source_date') { q(`UPDATE tasks SET ${e.field}=?, updated_at=? WHERE id=?`).run(old, now(), e.entity_id); break; }
        store.updateTask(actor, e.entity_id, { [TASK_KEYS[e.field]]: old === null ? null : old });
        break;
      case 'project':
        if (e.action === 'resolve') { undoResolve(actor, 'projects', e, meta(e)); break; }
        if (e.action === 'create') { q('DELETE FROM projects WHERE id=?').run(e.entity_id); break; }
        if (e.action === 'note') { q('DELETE FROM notes WHERE id=?').run(m.note_id); break; }
        store.updateProject(actor, e.entity_id, { [PROJECT_KEYS[e.field]]: e.field === 'aliases' ? JSON.parse(old || '[]') : (old ?? '') });
        break;
      case 'person':
        if (e.action === 'resolve') { undoResolve(actor, 'people', e, meta(e)); break; }
        store.updatePerson(actor, e.entity_id, { [PERSON_KEYS[e.field]]: e.field === 'emails' ? JSON.parse(old || '[]') : (old ?? '') });
        break;
      case 'attention':
        q('UPDATE attention SET status=? WHERE id=?').run(e.action === 'create' ? 'dismissed' : (old || 'open'), e.entity_id);
        break;
      case 'knowledge':
        if (e.action === 'create') { q('DELETE FROM knowledge WHERE id=?').run(e.entity_id); break; }
        if (e.field === 'superseded_by') { q('UPDATE knowledge SET superseded_by=NULL, updated_at=? WHERE id=?').run(now(), e.entity_id); break; }
        knowledge.updateKnowledge(actor, e.entity_id, { [e.field]: old ?? '' });
        break;
      case 'fact': {
        const mm = meta(e);
        if (e.action === 'update' && e.field === 'key') { q('UPDATE project_facts SET key=? WHERE id=?').run(old, e.entity_id); break; }
        if (e.action === 'update' && e.field === 'superseded_by') { q('UPDATE project_facts SET superseded_by=NULL WHERE id=?').run(e.entity_id); break; }
        q('DELETE FROM project_facts WHERE id=?').run(e.entity_id);
        if (mm.replaced) q('UPDATE project_facts SET superseded_by=NULL WHERE id=?').run(mm.replaced);
        break;
      }
      case 'profile': case 'pstatus': {
        const t = e.entity === 'profile' ? 'project_profile' : 'project_status';
        q(`DELETE FROM ${t} WHERE id=?`).run(e.entity_id);
        if (m.replaced) q(`UPDATE ${t} SET superseded_by=NULL WHERE id=?`).run(m.replaced);
        break;
      }
      case 'file':
        knowledge.classifyFile(actor, e.entity_id, { [e.field]: old === null ? null : old });
        break;
      default: throw bad('לא ניתן לבטל');
    }
  }

  function describeForLog(e) {
    return JSON.stringify({ entity: e.entity, entity_id: e.entity_id, label: entityLabel(e.entity, e.entity_id), action: e.action, field: e.field, old: e.old_value, new: e.new_value, run_id: e.run_id, original_actor: ownerLabel(e.actor_id) });
  }

  function undoEvent(actor, id) {
    const e = q('SELECT * FROM events WHERE id=?').get(id);
    if (!e) throw missing('הפעולה לא נמצאה');
    const why = blocker(e);
    if (why) throw bad(why);
    return db.transaction(() => {
      revert(actor, e);
      const markerId = store.logEvent(actor, 'undo', e.id, 'undo', e.field, e.new_value, e.old_value, JSON.parse(describeForLog(e)));
      q('UPDATE events SET undone_at=?, undone_by=? WHERE id=?').run(now(), markerId, e.id);
      return { undone: e.id, marker: markerId };
    })();
  }

  function undoRun(actor, runId) {
    const evs = q('SELECT * FROM events WHERE run_id=? AND actor_id=? AND undone_at IS NULL AND entity <> ? ORDER BY id DESC').all(runId, store.assistantId(), 'undo');
    const done = [], skipped = [];
    for (const e of evs) {
      try { undoEvent(actor, e.id); done.push(e.id); } catch (x) { skipped.push({ id: e.id, reason: x.message }); }
    }
    return { run: runId, undone: done.length, skipped };
  }

  // ---- activity feed
  function jerusalemDay(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso)); }
  function actionsFor(where, args) {
    return q(`SELECT e.* FROM events e WHERE e.actor_id=? AND e.entity <> 'undo' AND ${where} ORDER BY e.id`).all(store.assistantId(), ...args).map((e) => {
      const why = blocker(e);
      return { id: e.id, entity: e.entity, entity_id: e.entity_id, label: entityLabel(e.entity, e.entity_id), action: e.action, field: e.field, old_value: e.old_value, new_value: e.new_value, created_at: e.created_at, undone_at: e.undone_at, undoable: !why, reason: why };
    });
  }
  function activity(limit = 30) {
    const runs = q('SELECT * FROM claude_runs ORDER BY id DESC LIMIT ?').all(Math.min(+limit || 30, 100))
      .map((r) => ({ ...r, actions: actionsFor('e.run_id=?', [r.id]), gate: q('SELECT id, code, task_id, detail, round, outcome FROM gate_log WHERE run_id=? ORDER BY id').all(r.id) }));
    const loose = actionsFor('e.run_id IS NULL', []).slice(-30).reverse();
    const todayKey = jerusalemDay(new Date().toISOString());
    const days = {};
    for (const r of q("SELECT started_at FROM claude_runs WHERE started_at >= datetime('now','-9 days')").all()) { const d = jerusalemDay(r.started_at); days[d] = (days[d] || 0) + 1; }
    return { today: todayKey, today_runs: days[todayKey] || 0, days: Object.entries(days).sort((a, b) => b[0].localeCompare(a[0])).map(([date, count]) => ({ date, count })), runs, loose };
  }

  return { undoEvent, undoRun, activity, entityLabel, blocker };
}

module.exports = { createUndo };
