'use strict';
const { now, PROJECT_COLORS } = require('./db');
const { jerusalemToISO } = require('./dates');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const missing = (m) => new HttpError(404, m);

const ROLES = ['owner', 'pm', 'assistant', 'contact'];
const PROJECT_STATUSES = ['פעיל', 'מושהה', 'סגור'];
const ATTENTION_KINDS = ['reminder', 'question', 'suggestion'];
const ATTENTION_STATUSES = ['open', 'accepted', 'dismissed'];
const NOTE_KINDS = ['text', 'voice', 'summary'];

const TASK_SELECT = `
SELECT t.id, t.title, t.description, t.due_date, t.created_at, t.updated_at, t.done_at,
  t.project_id, p.name_he AS project, p.color AS project_color, p.is_default AS project_default,
  t.assignee_id, a.name_he AS assignee,
  t.requester_id, rq.name_he AS requester, rq.company AS requester_company, rq.role_text AS requester_role, rq.status AS requester_status, t.source_date, t.due_source,
  t.status_id, s.name_he AS status, s.is_closed AS status_closed, s.is_done AS status_done, s.color AS status_color,
  t.priority_id, pr.name_he AS priority, pr.sort AS priority_sort, pr.color AS priority_color,
  t.source_email_id, t.parent_task_id, t.created_by, c.name_he AS created_by_name, t.needs_review, t.unassigned_reason
FROM tasks t
JOIN projects p ON p.id = t.project_id
JOIN statuses s ON s.id = t.status_id
JOIN priorities pr ON pr.id = t.priority_id
LEFT JOIN people a ON a.id = t.assignee_id
LEFT JOIN people rq ON rq.id = t.requester_id
LEFT JOIN people c ON c.id = t.created_by`;

function todayIL(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p; // YYYY-MM-DD
}

function normDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  let y, m, d, x;
  if ((x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s))) { d = +x[1]; m = +x[2]; y = +x[3]; }
  else throw bad('תאריך לא תקין. יש להזין בפורמט יום/חודש/שנה');
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw bad('תאריך לא תקין');
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const DUE_SOURCES = ['explicit', 'estimated', 'manual'];

// accepts ISO datetime, YYYY-MM-DD, or DD/MM/YYYY [HH:mm] (Jerusalem time)
function normDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  let x;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return normDate(s);
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
    const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s.replace(' ', 'T') : jerusalemToISO(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10), +s.slice(11, 13) || 0, +s.slice(14, 16) || 0));
    if (isNaN(d)) throw bad('תאריך לא תקין');
    return d.toISOString();
  }
  if ((x = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s))) {
    normDate(`${x[1]}/${x[2]}/${x[3]}`);
    if (x[4] === undefined) return normDate(`${x[1]}/${x[2]}/${x[3]}`);
    return jerusalemToISO(+x[3], +x[2], +x[1], +x[4], +x[5]);
  }
  throw bad('תאריך לא תקין. יש להזין בפורמט יום/חודש/שנה');
}

function createStore(db) {
  const q = (sql) => db.prepare(sql);
  const ownerId = () => q("SELECT id FROM people WHERE role='owner' ORDER BY id LIMIT 1").get().id;
  const assistantId = () => q("SELECT id FROM people WHERE role='assistant' ORDER BY id LIMIT 1").get().id;
  const defaultProjectId = () => q('SELECT id FROM projects WHERE is_default=1 ORDER BY id LIMIT 1').get().id;

  function logEvent(actor, entity, entityId, action, field = null, oldV = null, newV = null, meta = null) {
    const t = now();
    const isAssistant = actor === assistantId();
    const str = (v) => (v === null || v === undefined ? null : String(v));
    // actions taken while a run is open belong to that run
    const run = isAssistant ? q('SELECT id FROM claude_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1').get() : null;
    return q(`INSERT INTO events (actor_id, entity, entity_id, action, field, old_value, new_value, created_at, processed_at, run_id, meta)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(actor, entity, entityId, action, field, str(oldV), str(newV), t, isAssistant ? t : null, run?.id ?? null, meta ? JSON.stringify(meta) : null).lastInsertRowid;
  }

  // ---- lookups: accept id or name (projects also by alias)
  function findBy(table, v, label, extra) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) {
      const r = q(`SELECT * FROM ${table} WHERE id=?`).get(+v);
      if (r) return r;
    }
    const s = String(v).trim();
    const r = q(`SELECT * FROM ${table} WHERE name_he=?`).get(s) || q(`SELECT * FROM ${table} WHERE lower(name_he)=lower(?)`).get(s);
    if (r) return r;
    if (extra) { const e = extra(s); if (e) return e; }
    throw bad(`${label} לא נמצא: ${s}`);
  }
  const findProject = (v) => findBy('projects', v, 'פרויקט', (s) => {
    const low = s.toLowerCase();
    return q('SELECT * FROM projects').all().find((p) => JSON.parse(p.aliases).some((a) => String(a).toLowerCase() === low));
  });
  const findPerson = (v) => findBy('people', v, 'איש', (s2) => {
    const low = s2.toLowerCase();
    return q('SELECT * FROM people').all().find((p) => (p.name_en || '').toLowerCase() === low || JSON.parse(p.emails || '[]').some((e) => e.toLowerCase() === low));
  });
  const findStatus = (v) => findBy('statuses', v, 'סטטוס');
  const findPriority = (v) => findBy('priorities', v, 'דחיפות');

  const peopleName = (id) => (id ? q('SELECT name_he FROM people WHERE id=?').get(id)?.name_he ?? null : null);

  // ---- bootstrap
  function lookups() {
    return {
      statuses: q('SELECT * FROM statuses ORDER BY sort').all(),
      priorities: q('SELECT * FROM priorities ORDER BY sort').all(),
      people: listPeople(),
      projects: listProjects(),
      today: todayIL(),
    };
  }

  // ---- tasks
  function getTask(id) {
    const t = q(`${TASK_SELECT} WHERE t.id=?`).get(id);
    if (!t) throw missing('המשימה לא נמצאה');
    return t;
  }

  function listTasks(f = {}) {
    const where = [], args = [];
    const multi = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
    if (f.project) { const ids = multi(f.project).map((x) => findProject(x).id); where.push(`t.project_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
    if (f.assignee) {
      const ids = multi(f.assignee).map((x) => (x === 'none' ? 0 : findPerson(x).id));
      where.push(`COALESCE(t.assignee_id,0) IN (${ids.map(() => '?').join(',')})`); args.push(...ids);
    }
    if (f.requester) {
      const ids = multi(f.requester).map((x) => (x === 'none' ? 0 : findPerson(x).id));
      where.push(`COALESCE(t.requester_id,0) IN (${ids.map(() => '?').join(',')})`); args.push(...ids);
    }
    if (f.status) { const ids = multi(f.status).map((x) => findStatus(x).id); where.push(`t.status_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
    else if (!f.include_hidden && f.include_hidden !== '1' && !(f.closed === '1' || f.closed === true)) where.push('s.hidden_default=0');
    if (f.priority) { const ids = multi(f.priority).map((x) => findPriority(x).id); where.push(`t.priority_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
    if (f.open === '1' || f.open === true) where.push('s.is_closed=0');
    if (f.closed === '1' || f.closed === true) where.push('s.is_closed=1'); // the archive: done and cancelled tasks
    if (f.person) { const ids = multi(f.person).map((x) => findPerson(x).id); where.push(`(t.requester_id IN (${ids.map(() => '?').join(',')}) OR t.assignee_id IN (${ids.map(() => '?').join(',')}))`); args.push(...ids, ...ids); }
    if (f.from) { where.push('substr(COALESCE(t.done_at, t.updated_at),1,10) >= ?'); args.push(String(f.from).slice(0, 10)); }
    if (f.to) { where.push('substr(COALESCE(t.done_at, t.updated_at),1,10) <= ?'); args.push(String(f.to).slice(0, 10)); }
    if (f.overdue === '1' || f.overdue === true) { where.push('s.is_closed=0 AND t.due_date IS NOT NULL AND t.due_date < ?'); args.push(todayIL()); }
    if (f.stale_days) {
      const n = parseInt(f.stale_days, 10);
      if (!(n >= 0)) throw bad('מספר ימים לא תקין');
      where.push('s.is_closed=0 AND t.updated_at < ?'); args.push(new Date(Date.now() - n * 86400000).toISOString());
    }
    if (f.q) {
      const like = `%${String(f.q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR p.name_he LIKE ? ESCAPE '\\')"); args.push(like, like, like);
    }
    const archive = f.closed === '1' || f.closed === true;
    const lim = Math.min(Math.max(parseInt(f.limit, 10) || (archive ? 50 : 1000), 1), 1000), off = Math.max(parseInt(f.offset, 10) || 0, 0);
    const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${archive ? 'COALESCE(t.done_at, t.updated_at) DESC, t.id DESC' : 's.is_closed, (t.due_date IS NULL), t.due_date, pr.sort, t.id DESC'} LIMIT ${lim} OFFSET ${off}`;
    return db.prepare(sql).all(...args);
  }

  const RELATIONS = ['created', 'updated', 'closed', 'info'];
  // a task can be linked to many emails; linking never replaces the original source email
  function linkTaskEmail(actor, taskId, emailId, relation = 'updated', quiet = false) {
    if (!RELATIONS.includes(relation)) throw bad('סוג הקישור לא תקין. האפשרויות: ' + RELATIONS.join(', '));
    getTask(taskId);
    if (!q('SELECT 1 FROM emails WHERE id=?').get(emailId)) throw bad('הדוא״ל לא נמצא');
    const ex = q('SELECT id, relation FROM task_emails WHERE task_id=? AND email_id=?').get(taskId, emailId);
    if (ex) { if (ex.relation !== relation && ex.relation !== 'created') q('UPDATE task_emails SET relation=? WHERE id=?').run(relation, ex.id); }
    else q('INSERT INTO task_emails (task_id, email_id, relation, created_at) VALUES (?,?,?,?)').run(taskId, emailId, relation, now());
    if (!quiet) logEvent(actor, 'task', taskId, 'update', 'email_link', null, `${emailId}:${relation}`);
    q('UPDATE tasks SET updated_at=? WHERE id=?').run(now(), taskId);
  }

  const TASK_FIELDS = ['title', 'description', 'project', 'assignee', 'status', 'priority', 'due_date', 'parent_task_id'];

  function normalizeTaskInput(b) {
    const out = {};
    for (const k of Object.keys(b || {})) {
      const base = k.replace(/_id$/, '');
      if (k === 'due' || k === 'due_date') out.due_date = b[k];
      else if (k === 'desc' || k === 'description') out.description = b[k];
      else if (k === 'parent_task_id' || k === 'parent') out.parent_task_id = b[k];
      else if (k === 'source_date' || k === 'source-date') out.source_date = b[k];
      else if (k === 'due_source' || k === 'due-source') out.due_source = b[k];
      else if (['project', 'assignee', 'status', 'priority', 'requester'].includes(base)) out[base] = b[k];
      else if (k === 'title') out.title = b[k];
      else if (['email', 'source_email_id'].includes(k)) out.source_email_id = b[k];
      else if (k === 'relation') out.relation = b[k];
      else if (k === 'unassigned_reason' || k === 'unassigned-reason') out.unassigned_reason = b[k];
    }
    return out;
  }

  function dueSourceFor(actor, due, given) {
    if (given !== undefined && given !== null && given !== '') {
      if (!DUE_SOURCES.includes(given)) throw bad('מקור תאריך היעד לא תקין. האפשרויות: explicit, estimated, manual');
      return due ? given : null;
    }
    if (!due) return null;
    return actor === assistantId() ? 'explicit' : 'manual';
  }

  function createTask(actor, body) {
    const b = normalizeTaskInput(body);
    const title = String(b.title ?? '').trim();
    if (!title) throw bad('יש להזין כותרת למשימה');
    if (title.length > 300) throw bad('הכותרת ארוכה מדי');
    const project = b.project ? findProject(b.project) : { id: defaultProjectId() };
    const assignee = b.assignee === undefined ? { id: ownerId() } : (b.assignee === null || b.assignee === '' ? null : findPerson(b.assignee));
    const status = b.status ? findStatus(b.status) : q('SELECT * FROM statuses ORDER BY sort LIMIT 1').get();
    const priority = b.priority ? findPriority(b.priority) : (q("SELECT * FROM priorities WHERE name_he='רגיל'").get() || q('SELECT * FROM priorities ORDER BY sort LIMIT 1').get());
    const due = normDate(b.due_date);
    const requester = b.requester === undefined || b.requester === null || b.requester === '' ? null : findPerson(b.requester);
    const emailRow = b.source_email_id ? q('SELECT forwarded_date, received_at FROM emails WHERE id=?').get(+b.source_email_id) : null;
    const sourceDate = b.source_date !== undefined ? normDateTime(b.source_date)
      : emailRow ? (emailRow.forwarded_date || emailRow.received_at) : (actor === ownerId() ? now() : null);
    const dueSource = dueSourceFor(actor, due, b.due_source);
    const parent = b.parent_task_id ? getTask(+b.parent_task_id).id : null;
    const email = b.source_email_id ? +b.source_email_id : null;
    if (email && !q('SELECT 1 FROM emails WHERE id=?').get(email)) throw bad('הודעת הדוא״ל לא נמצאה');
    const t = now();
    return db.transaction(() => {
      const id = q(`INSERT INTO tasks (title, description, project_id, assignee_id, status_id, priority_id, due_date, source_email_id, parent_task_id, created_by, created_at, updated_at, done_at, requester_id, source_date, due_source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(title, String(b.description ?? ''), project.id, assignee?.id ?? null, status.id, priority.id, due, email, parent, actor, t, t, status.is_done ? t : null, requester?.id ?? null, sourceDate, dueSource).lastInsertRowid;
      logEvent(actor, 'task', id, 'create', 'title', null, title);
      if (b.unassigned_reason) q('UPDATE tasks SET unassigned_reason=? WHERE id=?').run(String(b.unassigned_reason).slice(0, 500), id);
      if (hooks.mention) { try { hooks.mention('task', id, { title, description: b.description, requester: requester?.id, assignee: assignee?.id, project: project.id }); } catch { /* mentions must never break a write */ } }
      if (email) linkTaskEmail(actor, id, email, 'created', true);
      return getTask(id);
    })();
  }

  function updateTask(actor, id, body) {
    const cur = getTask(id);
    const b = normalizeTaskInput(body);
    const sets = {}, changes = [];
    const set = (col, val, field, oldLabel, newLabel) => {
      sets[col] = val; changes.push([field, oldLabel, newLabel]);
    };
    if ('title' in b) {
      const v = String(b.title ?? '').trim();
      if (!v) throw bad('יש להזין כותרת למשימה');
      if (v.length > 300) throw bad('הכותרת ארוכה מדי');
      if (v !== cur.title) set('title', v, 'title', cur.title, v);
    }
    if ('description' in b) {
      const v = String(b.description ?? '');
      if (v !== cur.description) set('description', v, 'description', cur.description, v);
    }
    if ('project' in b) {
      const p = findProject(b.project);
      if (p.id !== cur.project_id) set('project_id', p.id, 'project', cur.project, p.name_he);
    }
    if ('assignee' in b) {
      const p = b.assignee === null || b.assignee === '' ? null : findPerson(b.assignee);
      if ((p?.id ?? null) !== cur.assignee_id) set('assignee_id', p?.id ?? null, 'assignee', cur.assignee, p?.name_he ?? null);
    }
    if ('status' in b) {
      const s = findStatus(b.status);
      if (s.id !== cur.status_id) {
        set('status_id', s.id, 'status', cur.status, s.name_he);
        sets.done_at = s.is_done ? now() : null;
      }
    }
    if ('priority' in b) {
      const p = findPriority(b.priority);
      if (p.id !== cur.priority_id) set('priority_id', p.id, 'priority', cur.priority, p.name_he);
    }
    let dueChanged = false;
    if ('due_date' in b) {
      const d = normDate(b.due_date);
      if (d !== cur.due_date) { set('due_date', d, 'due_date', cur.due_date, d); dueChanged = true; }
    }
    if ('due_source' in b || dueChanged) {
      const newDue = 'due_date' in sets ? sets.due_date : cur.due_date;
      const ds = dueSourceFor(actor, newDue, b.due_source);
      if (ds !== cur.due_source) set('due_source', ds, 'due_source', cur.due_source, ds);
    }
    if ('requester' in b) {
      const p = b.requester === null || b.requester === '' ? null : findPerson(b.requester);
      if ((p?.id ?? null) !== cur.requester_id) set('requester_id', p?.id ?? null, 'requester', cur.requester, p?.name_he ?? null);
    }
    if ('source_date' in b) {
      const d = normDateTime(b.source_date);
      if (d !== cur.source_date) set('source_date', d, 'source_date', cur.source_date, d);
    }
    if ('parent_task_id' in b) {
      const pid = b.parent_task_id ? getTask(+b.parent_task_id).id : null;
      if (pid === id) throw bad('משימה לא יכולה להיות תת־משימה של עצמה');
      if (pid !== cur.parent_task_id) set('parent_task_id', pid, 'parent_task_id', cur.parent_task_id, pid);
    }
    if (b.source_email_id) { // add a link to another email (the original source stays)
      linkTaskEmail(actor, id, +b.source_email_id, b.relation || 'updated');
      if (!changes.length) return getTask(id);
    }
    if (!changes.length) return cur;
    return db.transaction(() => {
      sets.updated_at = now();
      const cols = Object.keys(sets);
      q(`UPDATE tasks SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), id);
      for (const [f, o, n] of changes) logEvent(actor, 'task', id, 'update', f, o, n);
      return getTask(id);
    })();
  }

  function taskDetail(id) {
    const task = getTask(id);
    const notes = q(`SELECT n.*, p.name_he AS author FROM notes n LEFT JOIN people p ON p.id=n.author_id WHERE n.task_id=? ORDER BY n.id DESC`).all(id);
    const history = q(`SELECT e.id, e.actor_id, p.name_he AS actor, e.action, e.field, e.old_value, e.new_value, e.created_at, e.run_id
      FROM events e LEFT JOIN people p ON p.id=e.actor_id WHERE e.entity='task' AND e.entity_id=? ORDER BY e.id DESC`).all(id);
    const drafts = q('SELECT * FROM drafts WHERE task_id=? ORDER BY id DESC').all(id);
    return { ...task, notes, history, drafts };
  }

  function addNote(actor, { task, project, text, kind }) {
    const tx = String(text ?? '').trim();
    if (!tx) throw bad('יש להזין טקסט להערה');
    const k = kind || 'text';
    if (!NOTE_KINDS.includes(k)) throw bad('סוג הערה לא תקין');
    if (!task && !project) throw bad('יש לציין משימה או פרויקט');
    return db.transaction(() => {
      let taskId = null, projectId = null;
      if (task) { taskId = getTask(+task).id; q('UPDATE tasks SET updated_at=? WHERE id=?').run(now(), taskId); }
      else projectId = findProject(project).id;
      const id = q('INSERT INTO notes (task_id, project_id, text, kind, author_id, created_at) VALUES (?,?,?,?,?,?)').run(taskId, projectId, tx, k, actor, now()).lastInsertRowid;
      logEvent(actor, taskId ? 'task' : 'project', taskId || projectId, 'note', 'note', null, tx, { note_id: id });
      if (hooks.mention) { try { hooks.mention('note', id, { text: tx }); } catch { /* ignore */ } }
      return q('SELECT n.*, p.name_he AS author FROM notes n LEFT JOIN people p ON p.id=n.author_id WHERE n.id=?').get(id);
    })();
  }

  function addDraft(actor, taskId, text) {
    const tx = String(text ?? '').trim();
    if (!tx) throw bad('יש להזין טקסט לטיוטה');
    getTask(taskId);
    return db.transaction(() => {
      const id = q('INSERT INTO drafts (task_id, text, created_at) VALUES (?,?,?)').run(taskId, tx, now()).lastInsertRowid;
      logEvent(actor, 'task', taskId, 'draft', 'draft', null, tx, { draft_id: id });
      return q('SELECT * FROM drafts WHERE id=?').get(id);
    })();
  }

  // ---- projects
  const fmtProject = (p) => ({ ...p, aliases: JSON.parse(p.aliases), is_default: !!p.is_default });

  function listProjects() {
    return q(`SELECT p.*,
      (SELECT COUNT(*) FROM tasks t JOIN statuses s ON s.id=t.status_id WHERE t.project_id=p.id AND s.is_closed=0) AS open_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) AS total_count
      FROM projects p ORDER BY p.is_default, p.name_he`).all().map(fmtProject);
  }

  function normAliases(v) {
    const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,،\n]/);
    return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
  }

  function normColor(v) {
    const c = String(v).trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(c)) throw bad('צבע לא תקין');
    return c;
  }

  function createProject(actor, b) {
    const name = String(b.name ?? b.name_he ?? '').trim();
    if (!name) throw bad('יש להזין שם לפרויקט');
    if (q('SELECT 1 FROM projects WHERE lower(name_he)=lower(?)').get(name)) throw bad('כבר קיים פרויקט בשם הזה');
    const status = b.status || 'פעיל';
    if (!PROJECT_STATUSES.includes(status)) throw bad('סטטוס פרויקט לא תקין');
    return db.transaction(() => {
      const id = q('INSERT INTO projects (name_he, aliases, description, status, created_by, created_at, partial) VALUES (?,?,?,?,?,?,?)')
        .run(name, JSON.stringify(normAliases(b.aliases)), String(b.description ?? ''), status, actor, now(), b.partial ? 1 : 0).lastInsertRowid;
      const color = b.color ? normColor(b.color) : PROJECT_COLORS[id % PROJECT_COLORS.length];
      q('UPDATE projects SET color=? WHERE id=?').run(color, id);
      logEvent(actor, 'project', id, 'create', 'name_he', null, name);
      return getProject(id);
    })();
  }

  function getProject(id) {
    const p = listProjects().find((x) => x.id === +id);
    if (!p) throw missing('הפרויקט לא נמצא');
    return p;
  }

  function updateProject(actor, idOrName, b0) {
    let b = b0;
    const cur = findProject(idOrName);
    const sets = {}, changes = [];
    const name = b.name ?? b.name_he;
    if (name !== undefined) {
      const v = String(name).trim();
      if (!v) throw bad('יש להזין שם לפרויקט');
      const dup = q('SELECT id FROM projects WHERE lower(name_he)=lower(?) AND id<>?').get(v, cur.id);
      if (dup) throw bad('כבר קיים פרויקט בשם הזה');
      if (v !== cur.name_he) {
        sets.name_he = v; changes.push(['name_he', cur.name_he, v]);
        // the old name keeps working as a synonym
        const keep = normAliases([...JSON.parse(b.aliases !== undefined ? JSON.stringify(normAliases(b.aliases)) : cur.aliases), cur.name_he]).filter((a) => a.toLowerCase() !== v.toLowerCase());
        b = { ...b, aliases: keep };
      }
    }
    if (b.aliases !== undefined) {
      const v = JSON.stringify(normAliases(b.aliases));
      if (v !== cur.aliases) { sets.aliases = v; changes.push(['aliases', cur.aliases, v]); }
    }
    if (b.description !== undefined && String(b.description) !== cur.description) { sets.description = String(b.description); changes.push(['description', cur.description, sets.description]); }
    const summary = b.summary ?? b.summary_he;
    if (summary !== undefined && String(summary) !== cur.summary_he) { sets.summary_he = String(summary); changes.push(['summary_he', cur.summary_he, sets.summary_he]); }
    if (b.partial !== undefined) { const v = b.partial && b.partial !== '0' ? 1 : 0; if (v !== cur.partial) { sets.partial = v; changes.push(['partial', cur.partial, v]); } }
    if (b.color !== undefined) {
      const c = normColor(b.color);
      if (c !== cur.color) { sets.color = c; changes.push(['color', cur.color, c]); }
    }
    if (b.status !== undefined) {
      if (!PROJECT_STATUSES.includes(b.status)) throw bad('סטטוס פרויקט לא תקין');
      if (b.status !== cur.status) { sets.status = b.status; changes.push(['status', cur.status, b.status]); }
    }
    if (!changes.length) return getProject(cur.id);
    return db.transaction(() => {
      const cols = Object.keys(sets);
      q(`UPDATE projects SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), cur.id);
      for (const [f, o, n] of changes) logEvent(actor, 'project', cur.id, 'update', f, o, n);
      return getProject(cur.id);
    })();
  }

  function mergeProject(actor, fromV, intoV) {
    const from = findProject(fromV), into = findProject(intoV);
    if (from.id === into.id) throw bad('לא ניתן למזג פרויקט לתוך עצמו');
    if (from.is_default) throw bad('לא ניתן למזג את הפרויקט "' + from.name_he + '" לתוך פרויקט אחר');
    return db.transaction(() => {
      const moved = q('SELECT id FROM tasks WHERE project_id=?').all(from.id);
      const t = now();
      for (const { id } of moved) {
        q('UPDATE tasks SET project_id=?, updated_at=? WHERE id=?').run(into.id, t, id);
        logEvent(actor, 'task', id, 'update', 'project', from.name_he, into.name_he);
      }
      q('UPDATE notes SET project_id=? WHERE project_id=?').run(into.id, from.id);
      q('UPDATE emails SET project_id=? WHERE project_id=?').run(into.id, from.id);
      q('UPDATE files SET project_id=? WHERE project_id=?').run(into.id, from.id);
      const aliases = normAliases([...JSON.parse(into.aliases), from.name_he, ...JSON.parse(from.aliases)])
        .filter((a) => a.toLowerCase() !== into.name_he.toLowerCase());
      q('UPDATE projects SET aliases=? WHERE id=?').run(JSON.stringify(aliases), into.id);
      q('DELETE FROM projects WHERE id=?').run(from.id);
      logEvent(actor, 'project', into.id, 'merge', 'project', from.name_he, into.name_he);
      return { merged: from.name_he, into: getProject(into.id), moved_tasks: moved.length };
    })();
  }

  // ---- people
  // a partial person is missing the surname, company, email or role: say what
  const fmtPerson = (p) => {
    const emails = JSON.parse(p.emails);
    const missing = [];
    if (p.status === 'partial') {
      if (String(p.name_he).trim().split(/\s+/).length < 2) missing.push('שם משפחה');
      if (!p.company) missing.push('חברה');
      if (!emails.length) missing.push('דוא״ל');
      if (!p.role_text) missing.push('תפקיד');
    }
    return { ...p, emails, missing };
  };
  function listPeople() {
    return q('SELECT * FROM people ORDER BY id').all().map(fmtPerson);
  }
  function normEmails(v) {
    const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/);
    return [...new Set(arr.map((x) => String(x).trim().replace(/^['"]+|['"]+$/g, '').toLowerCase()).filter(Boolean))];
  }
  const hasHebrew = (s) => /[\u0590-\u05ff]/.test(String(s || ''));
  function createPerson(actor, b) {
    const name = String(b.name ?? b.name_he ?? '').trim();
    if (!name) throw bad('יש להזין שם');
    const role = b.role || 'contact';
    if (!ROLES.includes(role)) throw bad('תפקיד לא תקין');
    if (role === 'owner' || role === 'assistant') throw bad('לא ניתן להוסיף עוד בעלים או עוזר');
    const en = String(b.name_en ?? (hasHebrew(name) ? '' : name)).trim() || null;
    return db.transaction(() => {
      const status = b.status === 'partial' ? 'partial' : 'full';
      const id = q('INSERT INTO people (name_he, name_en, role, emails, notes, created_at, status, company, role_text) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(name, en, role, JSON.stringify(normEmails(b.emails)), String(b.notes ?? ''), now(), status, String(b.company ?? '').trim() || null, String(b.role_text ?? '').trim() || null).lastInsertRowid;
      logEvent(actor, 'person', id, 'create', 'name_he', null, name);
      return fmtPerson(q('SELECT * FROM people WHERE id=?').get(id));
    })();
  }
  function updatePerson(actor, idOrName, b) {
    const cur = findPerson(idOrName);
    const sets = {}, changes = [];
    const name = b.name ?? b.name_he;
    if (name !== undefined) {
      const v = String(name).trim();
      if (!v) throw bad('יש להזין שם');
      if (v !== cur.name_he) {
        sets.name_he = v; changes.push(['name_he', cur.name_he, v]);
        // a Latin name that gets a Hebrew one is kept as the matching alias
        if (!hasHebrew(cur.name_he) && !cur.name_en && b.name_en === undefined) { sets.name_en = cur.name_he; changes.push(['name_en', null, cur.name_he]); }
      }
    }
    if (b.name_en !== undefined) { const v = String(b.name_en || '').trim() || null; if (v !== cur.name_en && !('name_en' in sets)) { sets.name_en = v; changes.push(['name_en', cur.name_en, v]); } }
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) throw bad('תפקיד לא תקין');
      if (b.role !== cur.role) {
        if (cur.role === 'owner' || cur.role === 'assistant' || b.role === 'owner' || b.role === 'assistant') throw bad('לא ניתן לשנות תפקיד זה');
        sets.role = b.role; changes.push(['role', cur.role, b.role]);
      }
    }
    if (b.emails !== undefined) {
      const v = JSON.stringify(normEmails(b.emails));
      if (v !== cur.emails) { sets.emails = v; changes.push(['emails', cur.emails, v]); }
    }
    if (b.notes !== undefined && String(b.notes) !== cur.notes) { sets.notes = String(b.notes); changes.push(['notes', cur.notes, sets.notes]); }
    for (const k of ['company', 'role_text']) if (b[k] !== undefined) { const v = String(b[k] ?? '').trim() || null; if (v !== (cur[k] ?? null)) { sets[k] = v; changes.push([k, cur[k] ?? null, v]); } }
    if (b.status !== undefined) {
      if (!['full', 'partial'].includes(b.status)) throw bad('סטטוס לא תקין');
      if (b.status !== cur.status) { sets.status = b.status; changes.push(['status', cur.status, b.status]); }
    }
    if (changes.length) {
      db.transaction(() => {
        const cols = Object.keys(sets);
        q(`UPDATE people SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), cur.id);
        for (const [f, o, n] of changes) logEvent(actor, 'person', cur.id, 'update', f, o, n);
      })();
    }
    return fmtPerson(q('SELECT * FROM people WHERE id=?').get(cur.id));
  }
  // two records of one person become one: links, emails and the Latin spelling move to the kept record
  function mergePerson(actor, fromV, intoV) {
    const from = findPerson(fromV), into = findPerson(intoV);
    if (from.id === into.id) throw bad('לא ניתן למזג איש לתוך עצמו');
    if (from.role === 'owner' || from.role === 'assistant') throw bad('לא ניתן למזג את הבעלים או את העוזר לתוך אחר');
    return db.transaction(() => {
      for (const [t, c] of [['tasks', 'assignee_id'], ['tasks', 'requester_id'], ['tasks', 'created_by'], ['notes', 'author_id'], ['events', 'actor_id'], ['projects', 'created_by'], ['knowledge', 'created_by'], ['project_facts', 'created_by'], ['protocols', 'created_by'], ['protocol_items', 'owner_person_id']]) {
        q(`UPDATE ${t} SET ${c}=? WHERE ${c}=?`).run(into.id, from.id);
      }
      for (const pr of q('SELECT id, participants FROM protocols').all()) {
        const parts = JSON.parse(pr.participants || '[]');
        if (parts.some((x) => x.person_id === from.id)) q('UPDATE protocols SET participants=? WHERE id=?').run(JSON.stringify(parts.map((x) => (x.person_id === from.id ? { ...x, person_id: into.id } : x))), pr.id);
      }
      const emails = normEmails([...JSON.parse(into.emails), ...JSON.parse(from.emails)]);
      const en = into.name_en || (!hasHebrew(from.name_he) ? from.name_he : from.name_en) || null;
      q('UPDATE people SET emails=?, name_en=?, notes=CASE WHEN notes=\'\' THEN ? ELSE notes END WHERE id=?').run(JSON.stringify(emails), en, from.notes || '', into.id);
      q('DELETE FROM people WHERE id=?').run(from.id);
      logEvent(actor, 'person', into.id, 'merge', 'person', from.name_he, into.name_he);
      return fmtPerson(q('SELECT * FROM people WHERE id=?').get(into.id));
    })();
  }

  // ---- attention
  function listAttention(status) {
    const s = status || 'open';
    if (s !== 'all' && !ATTENTION_STATUSES.includes(s)) throw bad('סטטוס לא תקין');
    return q(`SELECT a.*, t.title AS task_title FROM attention a LEFT JOIN tasks t ON t.id=a.task_id
      ${s === 'all' ? '' : 'WHERE a.status=?'} ORDER BY a.id DESC`).all(...(s === 'all' ? [] : [s]));
  }
  const hooks = {};
  function addAttention(actor, b) {
    if (!ATTENTION_KINDS.includes(b.kind)) throw bad('סוג לא תקין. האפשרויות: reminder, question, suggestion');
    const text = String(b.text ?? '').trim();
    if (!text) throw bad('יש להזין טקסט');
    const task = b.task ? getTask(+b.task).id : null;
    // inside an import run (daily import or live Outlook mail) a question is collected for the digest instead of becoming an attention item per email
    const imp = actor === assistantId() && b.kind !== 'reminder' ? q('SELECT id, import_id FROM claude_runs WHERE finished_at IS NULL AND import_id IS NOT NULL ORDER BY id DESC LIMIT 1').get() : null;
    if (imp) { q('INSERT INTO import_questions (import_id, run_id, kind, text, task_id, created_at) VALUES (?,?,?,?,?,?)').run(imp.import_id, imp.id, b.kind, text, task, now()); return { id: 0, kind: b.kind, text, task_id: task, status: 'deferred' }; }
    return db.transaction(() => {
      const id = q('INSERT INTO attention (kind, text, task_id, created_at) VALUES (?,?,?,?)').run(b.kind, text, task, now()).lastInsertRowid;
      logEvent(actor, 'attention', id, 'create', 'text', null, text);
      const row = q('SELECT * FROM attention WHERE id=?').get(id);
      if (hooks.attention) { try { hooks.attention(row); } catch { /* notifications must never break a write */ } }
      return row;
    })();
  }
  function updateAttention(actor, id, b) {
    const cur = q('SELECT * FROM attention WHERE id=?').get(id);
    if (!cur) throw missing('הפריט לא נמצא');
    if (!ATTENTION_STATUSES.includes(b.status)) throw bad('סטטוס לא תקין');
    if (b.status !== cur.status) {
      db.transaction(() => {
        q('UPDATE attention SET status=? WHERE id=?').run(b.status, id);
        logEvent(actor, 'attention', id, 'update', 'status', cur.status, b.status);
      })();
    }
    return q('SELECT * FROM attention WHERE id=?').get(id);
  }

  // ---- events
  function pending() {
    const events = q(`SELECT e.*, p.name_he AS actor FROM events e LEFT JOIN people p ON p.id=e.actor_id WHERE e.processed_at IS NULL ORDER BY e.id`).all();
    const emails = q('SELECT id, subject, from_addr, received_at FROM emails WHERE processed_at IS NULL ORDER BY id').all();
    return { events, emails };
  }
  function ack(ids) {
    if (!Array.isArray(ids) || !ids.length) throw bad('יש לציין מזהי אירועים');
    const t = now();
    const st = q('UPDATE events SET processed_at=? WHERE id=? AND processed_at IS NULL');
    let n = 0;
    db.transaction(() => { for (const i of ids) n += st.run(t, +i).changes; })();
    return { acked: n };
  }

  return {
    ownerId, assistantId, logEvent, linkTaskEmail, lookups, listTasks, getTask, createTask, updateTask, taskDetail, addNote, addDraft,
    listProjects, getProject, createProject, updateProject, mergeProject, listPeople, createPerson, updatePerson,
    hooks, mergePerson, findPerson, hasHebrew, listAttention, addAttention, updateAttention, pending, ack, todayIL, findProject,
  };
}

module.exports = { createStore, HttpError, todayIL, normDate, normDateTime, bad, missing };
