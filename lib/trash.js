'use strict';
// RECYCLE BIN ("סל מחזור"). Everything the owner can delete goes here first: the live rows are removed exactly as a deletion always did (so lists, counts, search,
// the semantic index and the assistant's context no longer see it) and a snapshot of those rows, with what hung on them, is kept in the `trash` table of the
// encrypted database. Restoring re-inserts the rows (ids kept when free; a parent that is gone falls back to "לא משויך" or to nothing). Permanent deletion happens
// only from inside the bin (the owner in the web app, or the owner's answer to a confirmation the assistant asked for) and by expiry: the nightly housekeeping
// removes items older than the setting `trash_days` (default 60; 0 = never). Events that mention an item are anonymised only at that final step.
const { now } = require('./db');
const { bad, missing } = require('./store');

const DEFAULT_DAYS = 60;
const DAY = 86400000;
const KINDS = { task: 'משימה', project: 'פרויקט', person: 'איש קשר', protocol: 'פרוטוקול', calendar: 'יומן', chat: 'הודעה', filter: 'כלל דואר', email: 'מייל' };
const EVENT_ENTITY = { task: 'task', project: 'project', person: 'person', protocol: 'protocol', calendar: 'calendar', chat: 'chat', filter: 'filter', email: 'email' };

function createTrash({ db, store }) {
  const q = (sql) => db.prepare(sql);
  const rows = (sql, ...a) => q(sql).all(...a);
  const hasTable = (n) => !!q("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(n);
  const colCache = new Map(), fkCache = new Map();
  const cols = (t) => { if (!colCache.has(t)) colCache.set(t, new Map(rows(`PRAGMA table_info(${t})`).map((c) => [c.name, c]))); return colCache.get(t); };
  const fks = (t) => { if (!fkCache.has(t)) fkCache.set(t, rows(`PRAGMA foreign_key_list(${t})`)); return fkCache.get(t); };
  const chunk = (a, n = 400) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
  const updIds = (sql, ids, ...pre) => { let n = 0; for (const c of chunk(ids)) n += q(sql.replace('(?)', `(${c.map(() => '?').join(',')})`)).run(...pre, ...c).changes; return n; };
  const lastEvent = () => q('SELECT COALESCE(MAX(id),0) m FROM events').get().m;
  const defaultProject = () => store.defaultProjectId();
  // bookkeeping events that need no reaction from the assistant (a chat event would otherwise wake a chat run)
  const quiet = (evId) => q('UPDATE events SET processed_at=? WHERE id=? AND processed_at IS NULL').run(now(), evId);

  // ---- settings
  function days() { const v = q("SELECT value FROM settings WHERE key='trash_days'").get()?.value; const n = parseInt(v ?? DEFAULT_DAYS, 10); return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAYS; }
  function setDays(n) {
    const v = parseInt(n, 10);
    if (!(Number.isInteger(v) && v >= 0 && v <= 3650)) throw bad('מספר הימים בסל חייב להיות בין 0 ל־3650 (0 = לא לרוקן אוטומטית)');
    q("INSERT INTO settings (key,value) VALUES ('trash_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v));
    return v;
  }
  // the purge date is computed from deleted_at and the CURRENT setting, so changing the setting applies to everything already in the bin
  const purgeAt = (r, d = days()) => (d > 0 ? new Date(Date.parse(r.deleted_at) + d * DAY).toISOString() : null);

  // ---- index helpers: remove a row from the keyword index and its vectors (the semantic indexer would drop them too, but not right away)
  function unindex(kind, refIds) {
    for (const id of refIds) {
      try { q('DELETE FROM search_index WHERE kind=? AND ref_id=?').run(kind, id); } catch { /* no index */ }
      if (hasTable('embeddings')) for (const e of rows('SELECT id FROM embeddings WHERE kind=? AND ref_id=?', kind, id)) { try { q('DELETE FROM vec_items WHERE rowid=?').run(BigInt(e.id)); } catch { /* no vector table */ } q('DELETE FROM embeddings WHERE id=?').run(e.id); }
    }
  }

  // ---- generic re-insert: unknown columns dropped, a reference to a row that is gone falls back (project -> "לא משויך", status/priority -> the default, person -> nothing
  // or the assistant when required), an id that a newer row took is replaced by a fresh one. Returns the id of the row.
  function fallback(refTable, notnull) {
    if (refTable === 'projects') return defaultProject();
    if (refTable === 'statuses') return q('SELECT id FROM statuses ORDER BY sort LIMIT 1').get().id;
    if (refTable === 'priorities') return (q("SELECT id FROM priorities WHERE name_he='רגיל'").get() || q('SELECT id FROM priorities ORDER BY sort LIMIT 1').get()).id;
    if (refTable === 'people' && notnull) return store.assistantId();
    if (notnull) throw bad('לא ניתן לשחזר: רשומה קשורה כבר לא קיימת');
    return null;
  }
  function reinsert(table, row, { orIgnore = false, defer = [] } = {}) {
    const info = cols(table); const r = {};
    for (const [k, v] of Object.entries(row)) if (info.has(k) && !defer.includes(k)) r[k] = v;
    for (const fk of fks(table)) {
      const v = r[fk.from]; if (v === null || v === undefined) continue;
      if (fk.table === table && fk.from !== 'id') continue; // self references (parent task, superseded fact) are re-linked by the caller
      if (!q(`SELECT 1 FROM ${fk.table} WHERE ${fk.to || 'id'}=?`).get(v)) r[fk.from] = fallback(fk.table, !!info.get(fk.from)?.notnull);
    }
    for (const fk of fks(table)) if (fk.table === table && r[fk.from] != null && !q(`SELECT 1 FROM ${table} WHERE id=?`).get(r[fk.from])) r[fk.from] = null;
    if (r.id != null && q(`SELECT 1 FROM ${table} WHERE id=?`).get(r.id)) delete r.id;
    const c = Object.keys(r);
    const res = q(`INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${c.join(',')}) VALUES (${c.map(() => '?').join(',')})`).run(...c.map((k) => r[k]));
    return r.id ?? Number(res.lastInsertRowid);
  }

  // ======== TASK
  function collectTask(id) {
    const task = q('SELECT * FROM tasks WHERE id=?').get(id); if (!task) throw missing('המשימה לא נמצאה');
    return {
      task, notes: rows('SELECT * FROM notes WHERE task_id=?', id), drafts: rows('SELECT * FROM drafts WHERE task_id=?', id), task_emails: rows('SELECT * FROM task_emails WHERE task_id=?', id),
      decisions: rows('SELECT * FROM decisions WHERE task_id=?', id), attention: rows('SELECT * FROM attention WHERE task_id=?', id), chat: rows('SELECT * FROM chat_messages WHERE task_id=?', id),
      files: rows('SELECT id FROM files WHERE task_id=?', id).map((r) => r.id), calendar: rows('SELECT id FROM calendar_items WHERE task_id=?', id).map((r) => r.id),
      children: rows('SELECT id FROM tasks WHERE parent_task_id=?', id).map((r) => r.id), pitems: rows('SELECT id FROM protocol_items WHERE task_id=?', id).map((r) => r.id),
    };
  }
  function removeTask(d) {
    const id = d.task.id;
    unindex('task', [id]); unindex('note', d.notes.map((n) => n.id)); unindex('chat', d.chat.map((m) => m.id));
    q('DELETE FROM notes WHERE task_id=?').run(id); q('DELETE FROM drafts WHERE task_id=?').run(id); q('DELETE FROM task_emails WHERE task_id=?').run(id);
    q('DELETE FROM decisions WHERE task_id=?').run(id); q('DELETE FROM attention WHERE task_id=?').run(id); q('DELETE FROM chat_messages WHERE task_id=?').run(id);
    q('UPDATE files SET task_id=NULL WHERE task_id=?').run(id); q('UPDATE calendar_items SET task_id=NULL WHERE task_id=?').run(id);
    q('UPDATE tasks SET parent_task_id=NULL WHERE parent_task_id=?').run(id); q('UPDATE protocol_items SET task_id=NULL WHERE task_id=?').run(id);
    q('DELETE FROM tasks WHERE id=?').run(id);
  }
  function restoreTask(d) {
    const tid = reinsert('tasks', d.task);
    if (d.task.parent_task_id && q('SELECT 1 FROM tasks WHERE id=?').get(d.task.parent_task_id)) q('UPDATE tasks SET parent_task_id=? WHERE id=?').run(d.task.parent_task_id, tid);
    for (const n of d.notes) reinsert('notes', { ...n, task_id: tid });
    for (const x of d.drafts) reinsert('drafts', { ...x, task_id: tid });
    for (const x of d.task_emails) reinsert('task_emails', { ...x, task_id: tid }, { orIgnore: true });
    for (const x of d.decisions) reinsert('decisions', { ...x, task_id: tid });
    for (const x of d.attention) reinsert('attention', { ...x, task_id: tid });
    for (const x of d.chat) reinsert('chat_messages', { ...x, task_id: tid });
    updIds('UPDATE files SET task_id=? WHERE task_id IS NULL AND id IN (?)', d.files, tid); updIds('UPDATE calendar_items SET task_id=? WHERE task_id IS NULL AND id IN (?)', d.calendar, tid);
    updIds('UPDATE tasks SET parent_task_id=? WHERE parent_task_id IS NULL AND id IN (?)', d.children, tid); updIds('UPDATE protocol_items SET task_id=? WHERE task_id IS NULL AND id IN (?)', d.pitems, tid);
    return tid;
  }

  // ======== PROJECT  payload: { tasks: 'unassign' | 'move:<project>' | 'delete', facts: 'with-project' | 'move' | 'unassign', protocols: 'with-project' | 'move' | 'unassign' }
  const REST = ['files', 'emails', 'calendar_items', 'knowledge', 'notes'];
  function trashProject(actor, id, payload = {}) {
    const p = store.findProject(id); if (p.is_default) throw bad('אי אפשר למחוק את "לא משויך"');
    const disp = String(payload.tasks || 'unassign');
    let target = defaultProject(), mode = 'unassign';
    if (disp.startsWith('move:')) { const t = store.findProject(disp.slice(5)); if (t.id === p.id) throw bad('פרויקט היעד זהה לפרויקט שנמחק'); target = t.id; mode = 'move'; }
    else if (disp === 'delete') mode = 'delete';
    const factsMode = payload.facts || (mode === 'move' ? 'move' : 'with-project'); const protMode = payload.protocols || (mode === 'move' ? 'move' : 'with-project');
    const factsTo = factsMode === 'move' ? target : defaultProject(), protTo = protMode === 'move' ? target : defaultProject(), rest = mode === 'move' ? target : defaultProject();
    const project = q('SELECT * FROM projects WHERE id=?').get(p.id);
    const taskIds = rows('SELECT id FROM tasks WHERE project_id=?', p.id).map((r) => r.id);
    const snap = { project, mode, target, rest, factsMode, protMode, factsTo, protTo, tasks: [], moved_tasks: [], facts: [], facts_moved: [], protocols: [], protocols_moved: [], moved: {}, filters: [], mentions: [] };
    const sum = { tasks: taskIds.length, facts: 0, protocols: 0 };
    let trashId;
    db.transaction(() => {
      if (mode === 'delete') { for (const t of taskIds) { const d = collectTask(t); removeTask(d); snap.tasks.push(d); } }
      else { snap.moved_tasks = taskIds; q('UPDATE tasks SET project_id=?, updated_at=? WHERE project_id=?').run(target, now(), p.id); }
      const facts = rows('SELECT * FROM project_facts WHERE project_id=? ORDER BY id', p.id); sum.facts = facts.length;
      if (factsMode === 'with-project') { snap.facts = facts; unindex('fact', facts.map((f) => f.id)); q('UPDATE project_facts SET superseded_by=NULL WHERE project_id=?').run(p.id); q('DELETE FROM project_facts WHERE project_id=?').run(p.id); }
      else { snap.facts_moved = facts.map((f) => f.id); q('UPDATE project_facts SET project_id=? WHERE project_id=?').run(factsTo, p.id); }
      snap.profile = rows('SELECT * FROM project_profile WHERE project_id=? ORDER BY id', p.id); snap.pstatus = rows('SELECT * FROM project_status WHERE project_id=? ORDER BY id', p.id);
      q('DELETE FROM project_profile WHERE project_id=?').run(p.id); q('DELETE FROM project_status WHERE project_id=?').run(p.id);
      const prots = rows('SELECT * FROM protocols WHERE project_id=?', p.id); sum.protocols = prots.length;
      if (protMode === 'with-project') { for (const pr of prots) { const items = rows('SELECT * FROM protocol_items WHERE protocol_id=?', pr.id); snap.protocols.push({ protocol: pr, items }); q('DELETE FROM protocol_items WHERE protocol_id=?').run(pr.id); q('DELETE FROM protocols WHERE id=?').run(pr.id); } }
      else { snap.protocols_moved = prots.map((x) => x.id); q('UPDATE protocols SET project_id=? WHERE project_id=?').run(protTo, p.id); }
      for (const t of REST) { try { snap.moved[t] = rows(`SELECT id FROM ${t} WHERE project_id=?`, p.id).map((r) => r.id); q(`UPDATE ${t} SET project_id=? WHERE project_id=?`).run(rest, p.id); } catch { /* table without a project column */ } }
      snap.filters = rows('SELECT id FROM mail_filters WHERE project_id=?', p.id).map((r) => r.id); q('UPDATE mail_filters SET project_id=NULL WHERE project_id=?').run(p.id);
      try { snap.mentions = rows("SELECT * FROM mentions WHERE entity_type='project' AND entity_id=?", p.id); q("DELETE FROM mentions WHERE entity_type='project' AND entity_id=?").run(p.id); } catch { /* none */ }
      q('DELETE FROM projects WHERE id=?').run(p.id);
      const bits = [sum.tasks && `${sum.tasks} משימות${mode === 'delete' ? '' : ' הועברו'}`, sum.facts && `${sum.facts} נתונים`, sum.protocols && `${sum.protocols} פרוטוקולים`].filter(Boolean).join(', ');
      trashId = put(actor, 'project', p.id, p.name_he, snap, bits);
      store.logEvent(actor, 'project', p.id, 'purge', 'name_he', null, `הועבר לסל: ${p.name_he}`, { tasks: mode, ...sum, trash_id: trashId }); seal(trashId);
    })();
    return { id: p.id, title: p.name_he, ...sum, trash_id: trashId, trashed: true, tasks_mode: mode === 'move' ? `הועברו ל-${store.findProject(target).name_he}` : mode === 'delete' ? 'הועברו לסל עם הפרויקט' : 'הועברו ל"לא משויך"' };
  }
  function restoreProject(d) {
    const p = { ...d.project };
    const clash = (n) => rows('SELECT name_he FROM projects').some((x) => x.name_he === n);
    if (clash(p.name_he)) { let n = `${p.name_he} (משוחזר)`, i = 2; while (clash(n)) n = `${p.name_he} (משוחזר ${i++})`; p.name_he = n; }
    const pid = reinsert('projects', p);
    const factMap = new Map();
    for (const f of d.facts || []) factMap.set(f.id, reinsert('project_facts', { ...f, project_id: pid }, { defer: ['superseded_by'] }));
    for (const f of d.facts || []) if (f.superseded_by && factMap.has(f.superseded_by)) q('UPDATE project_facts SET superseded_by=? WHERE id=?').run(factMap.get(f.superseded_by), factMap.get(f.id));
    for (const t of ['profile', 'pstatus']) {
      const table = t === 'profile' ? 'project_profile' : 'project_status'; const m = new Map();
      for (const r of d[t] || []) m.set(r.id, reinsert(table, { ...r, project_id: pid }, { defer: ['superseded_by'] }));
      for (const r of d[t] || []) if (r.superseded_by && m.has(r.superseded_by)) q(`UPDATE ${table} SET superseded_by=? WHERE id=?`).run(m.get(r.superseded_by), m.get(r.id));
    }
    for (const { protocol, items } of d.protocols || []) { const prid = reinsert('protocols', { ...protocol, project_id: pid }); for (const it of items) reinsert('protocol_items', { ...it, protocol_id: prid }); }
    for (const td of d.tasks || []) restoreTask({ ...td, task: { ...td.task, project_id: pid } });
    // what was moved out goes back, but only what is still where the deletion put it (the owner may have moved it since)
    updIds('UPDATE tasks SET project_id=?, updated_at=? WHERE project_id=? AND id IN (?)', d.moved_tasks || [], pid, now(), d.target);
    updIds('UPDATE project_facts SET project_id=? WHERE project_id=? AND id IN (?)', d.facts_moved || [], pid, d.factsTo);
    updIds('UPDATE protocols SET project_id=? WHERE project_id=? AND id IN (?)', d.protocols_moved || [], pid, d.protTo);
    for (const [t, ids] of Object.entries(d.moved || {})) { try { updIds(`UPDATE ${t} SET project_id=? WHERE project_id=? AND id IN (?)`, ids, pid, d.rest); } catch { /* table changed */ } }
    updIds('UPDATE mail_filters SET project_id=? WHERE project_id IS NULL AND id IN (?)', d.filters || [], pid);
    for (const m of d.mentions || []) { try { reinsert('mentions', { ...m, entity_id: pid }, { orIgnore: true }); } catch { /* ignore */ } }
    return { id: pid, title: p.name_he, renamed: p.name_he !== d.project.name_he };
  }

  // ======== PERSON
  const NULLED = [['tasks', 'assignee_id'], ['tasks', 'requester_id'], ['protocol_items', 'owner_person_id']];
  const TO_ASSISTANT = [['tasks', 'created_by'], ['notes', 'author_id'], ['events', 'actor_id'], ['projects', 'created_by'], ['knowledge', 'created_by'], ['project_facts', 'created_by'], ['protocols', 'created_by']];
  function trashPerson(actor, id) {
    const p = store.findPerson(id); if (p.role === 'owner' || p.role === 'assistant') throw bad('אי אפשר למחוק את הבעלים או את העוזר');
    const assistant = store.assistantId(); const person = q('SELECT * FROM people WHERE id=?').get(p.id);
    const snap = { person, nulled: {}, reassigned: {}, participants: [], mentions: [] };
    let trashId;
    db.transaction(() => {
      for (const [t, c] of NULLED) { snap.nulled[`${t}.${c}`] = rows(`SELECT id FROM ${t} WHERE ${c}=?`, p.id).map((r) => r.id); q(`UPDATE ${t} SET ${c}=NULL WHERE ${c}=?`).run(p.id); }
      for (const [t, c] of TO_ASSISTANT) { try { snap.reassigned[`${t}.${c}`] = rows(`SELECT id FROM ${t} WHERE ${c}=?`, p.id).map((r) => r.id); q(`UPDATE ${t} SET ${c}=? WHERE ${c}=?`).run(assistant, p.id); } catch { /* ignore */ } }
      for (const pr of rows('SELECT id, participants FROM protocols')) {
        const parts = JSON.parse(pr.participants || '[]'); const idx = parts.map((x, i) => (x.person_id === p.id ? i : -1)).filter((i) => i >= 0);
        if (idx.length) { snap.participants.push({ id: pr.id, idx }); q('UPDATE protocols SET participants=? WHERE id=?').run(JSON.stringify(parts.map((x) => (x.person_id === p.id ? { ...x, person_id: null } : x))), pr.id); }
      }
      try { snap.mentions = rows("SELECT * FROM mentions WHERE entity_type='person' AND entity_id=?", p.id); q("DELETE FROM mentions WHERE entity_type='person' AND entity_id=?").run(p.id); } catch { /* none */ }
      q('DELETE FROM people WHERE id=?').run(p.id);
      const n = (snap.nulled['tasks.assignee_id'] || []).length + (snap.nulled['tasks.requester_id'] || []).length;
      trashId = put(actor, 'person', p.id, p.name_he, snap, n ? `${n} קישורים למשימות` : '');
      store.logEvent(actor, 'person', p.id, 'purge', 'name_he', null, `הועבר לסל: ${p.name_he}`, { trash_id: trashId }); seal(trashId);
    })();
    return { id: p.id, title: p.name_he, trash_id: trashId, trashed: true };
  }
  function restorePerson(d) {
    const pid = reinsert('people', d.person); const assistant = store.assistantId();
    for (const [key, ids] of Object.entries(d.nulled || {})) { const [t, c] = key.split('.'); updIds(`UPDATE ${t} SET ${c}=? WHERE ${c} IS NULL AND id IN (?)`, ids, pid); }
    for (const [key, ids] of Object.entries(d.reassigned || {})) { const [t, c] = key.split('.'); try { updIds(`UPDATE ${t} SET ${c}=? WHERE ${c}=${assistant} AND id IN (?)`, ids, pid); } catch { /* ignore */ } }
    for (const { id, idx } of d.participants || []) {
      const pr = q('SELECT participants FROM protocols WHERE id=?').get(id); if (!pr) continue;
      const parts = JSON.parse(pr.participants || '[]'); for (const i of idx) if (parts[i] && parts[i].person_id == null) parts[i] = { ...parts[i], person_id: pid };
      q('UPDATE protocols SET participants=? WHERE id=?').run(JSON.stringify(parts), id);
    }
    for (const m of d.mentions || []) { try { reinsert('mentions', { ...m, entity_id: pid }, { orIgnore: true }); } catch { /* ignore */ } }
    return { id: pid, title: d.person.name_he };
  }

  // ======== PROTOCOL
  function trashProtocol(actor, id) {
    const pr = q('SELECT * FROM protocols WHERE id=?').get(id); if (!pr) throw bad('הפרוטוקול לא נמצא');
    let trashId;
    db.transaction(() => {
      const items = rows('SELECT * FROM protocol_items WHERE protocol_id=?', id);
      q('DELETE FROM protocol_items WHERE protocol_id=?').run(id); q('DELETE FROM protocols WHERE id=?').run(id);
      trashId = put(actor, 'protocol', id, pr.title, { protocol: pr, items }, items.length ? `${items.length} סעיפים` : '');
      store.logEvent(actor, 'protocol', id, 'purge', 'title', null, `הועבר לסל: ${pr.title}`, { trash_id: trashId }); seal(trashId);
    })();
    return { id, title: pr.title, trash_id: trashId, trashed: true };
  }
  function restoreProtocol(d) { const prid = reinsert('protocols', d.protocol); for (const it of d.items || []) reinsert('protocol_items', { ...it, protocol_id: prid }); return { id: prid, title: d.protocol.title }; }

  // ======== TASK (public)
  function trashTask(actor, id) {
    const d = collectTask(id); let trashId;
    db.transaction(() => {
      removeTask(d);
      const bits = [d.notes.length && `${d.notes.length} הערות`, d.chat.length && `${d.chat.length} הודעות`].filter(Boolean).join(', ');
      trashId = put(actor, 'task', id, d.task.title, d, bits);
      store.logEvent(actor, 'task', id, 'purge', 'title', null, `הועברה לסל: ${d.task.title}`, { trash_id: trashId }); seal(trashId);
    })();
    return { id, title: d.task.title, trash_id: trashId, trashed: true, token: String(trashId) };
  }

  // ======== CALENDAR ITEM, MAIL FILTER (single rows)
  function trashRow(actor, kind, table, id, title, extra = () => {}) {
    const r = q(`SELECT * FROM ${table} WHERE id=?`).get(id); if (!r) throw missing('הפריט לא נמצא');
    let trashId;
    db.transaction(() => { q(`DELETE FROM ${table} WHERE id=?`).run(id); trashId = put(actor, kind, id, title(r), { row: r }); extra(r, trashId); seal(trashId); })();
    return { id, title: title(r), trash_id: trashId, trashed: true };
  }
  const trashCalendar = (actor, id) => trashRow(actor, 'calendar', 'calendar_items', id, (r) => r.title, (r, tid) => store.logEvent(actor, 'calendar', id, 'delete', null, null, null, { trash_id: tid }));
  const trashFilter = (actor, id) => trashRow(actor, 'filter', 'mail_filters', id, (r) => `${r.kind}: ${r.pattern}`, (r, tid) => store.logEvent(actor, 'filter', id, 'delete', 'pattern', `${r.kind}:${r.pattern}`, null, { trash_id: tid }));

  // ======== CHAT MESSAGE (the row stays hidden with deleted_at, as it always did; the bin keeps the way back, the index forgets it now)
  function trashChat(actor, m) {
    const title = String(m.text || m.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'הודעה';
    unindex('chat', [m.id]);
    return put(actor, 'chat', m.id, title, { id: m.id, author: m.author }, m.author === 'owner' ? 'הודעה שלך' : 'הודעה של העוזר');
  }
  function restoreChat(d) {
    const m = q('SELECT * FROM chat_messages WHERE id=?').get(d.id); if (!m) throw missing('ההודעה כבר לא קיימת');
    q('UPDATE chat_messages SET deleted_at=NULL WHERE id=?').run(d.id);
    try {
      const label = m.author === 'owner' ? (q("SELECT name_he FROM people WHERE role='owner' ORDER BY id LIMIT 1").get()?.name_he || '') : (q("SELECT name_he FROM people WHERE role='assistant' ORDER BY id LIMIT 1").get()?.name_he || '');
      if (!q("SELECT 1 FROM search_index WHERE kind='chat' AND ref_id=?").get(m.id)) q("INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person) VALUES ('', ?, 'chat', ?, NULL, ?, ?)").run(`${m.text} ${m.transcript || ''}`, m.id, m.created_at, label);
    } catch { /* no index */ }
    return { id: m.id, title: String(m.text || '').slice(0, 80) };
  }

  // ======== EMAIL (only mail the owner deleted in Outlook: lib/presence.js). The mail leaves every live place (the email row, its attachment rows and their text chunks, the keyword
  // index, the vectors, the mail list and counts, the assistant's context); tasks created from it STAY and only lose the link (restored with the mail). The raw .msg and the attachment
  // files (encrypted, under files/) stay on disk until the bin item is deleted for good. The Outlook record (ingest_mail) stays, marked gone, so the mail is not taken for new.
  const b64 = (v) => (v == null ? null : Buffer.isBuffer(v) || v instanceof Uint8Array ? { b64: Buffer.from(v).toString('base64') } : v);
  const unb64 = (v) => (v && typeof v === 'object' && v.b64 !== undefined ? Buffer.from(v.b64, 'base64') : v);
  function trashEmail(actor, id, { reason = 'outlook', summary = 'נמחק ב-Outlook' } = {}) {
    const email = q('SELECT * FROM emails WHERE id=?').get(id); if (!email) throw missing('המייל לא נמצא');
    const allFiles = rows('SELECT * FROM files WHERE email_id=?', id);
    const files = allFiles.filter((f) => f.task_id == null), keptFiles = allFiles.filter((f) => f.task_id != null).map((f) => f.id); // a file attached to a task stays with the task
    const fileIds = files.map((f) => f.id);
    const chunks = []; for (const c of chunk(fileIds)) chunks.push(...rows(`SELECT * FROM chunks WHERE file_id IN (${c.map(() => '?').join(',')})`, ...c));
    const snap = {
      reason, email, files, chunks, kept_files: keptFiles,
      task_emails: rows('SELECT * FROM task_emails WHERE email_id=?', id), source_tasks: rows('SELECT id FROM tasks WHERE source_email_id=?', id).map((r) => r.id),
      calendar: rows('SELECT id FROM calendar_items WHERE source_email_id=?', id).map((r) => r.id),
      mentions: hasTable('mentions') ? rows("SELECT * FROM mentions WHERE source_type='email' AND source_id=?", id) : [],
      html: hasTable('email_html') ? q('SELECT * FROM email_html WHERE email_id=?').get(id) || null : null,
      inline: hasTable('email_inline') ? rows('SELECT * FROM email_inline WHERE email_id=?', id).map((r) => ({ ...r, data: b64(r.data) })) : [],
      ingest: rows('SELECT id FROM ingest_mail WHERE email_id=?', id).map((r) => r.id), archive_index: [], archive_vectors: [],
    };
    const refs = [['email', [id]], ['file', fileIds], ['chunk', chunks.map((c) => c.id)]];
    if (email.archived) { // the archive keeps its own keyword index and int8 vectors (lib/archive.js)
      for (const [kind, ids] of refs) for (const rid of ids) {
        try { snap.archive_index.push(...rows('SELECT title, body, kind, ref_id, project_id, ts, person FROM search_archive WHERE kind=? AND ref_id=?', kind, rid)); } catch { /* no archive index */ }
        try { for (const e of rows('SELECT * FROM embeddings WHERE kind=? AND ref_id=? AND archive=1', kind, rid)) { const v = q('SELECT embedding FROM vec_archive WHERE rowid=?').get(BigInt(e.id)); snap.archive_vectors.push({ ...e, vec: v ? b64(v.embedding) : null }); } } catch { /* no vector table */ }
      }
    }
    let trashId;
    db.transaction(() => {
      for (const [kind, ids] of refs) unindex(kind, ids);
      if (email.archived) for (const [kind, ids] of refs) for (const rid of ids) {
        try { q('DELETE FROM search_archive WHERE kind=? AND ref_id=?').run(kind, rid); } catch { /* none */ }
        try { for (const e of rows('SELECT id FROM embeddings WHERE kind=? AND ref_id=? AND archive=1', kind, rid)) { q('DELETE FROM vec_archive WHERE rowid=?').run(BigInt(e.id)); q('DELETE FROM embeddings WHERE id=?').run(e.id); } } catch { /* none */ }
      }
      q('DELETE FROM task_emails WHERE email_id=?').run(id); q('UPDATE tasks SET source_email_id=NULL WHERE source_email_id=?').run(id); q('UPDATE calendar_items SET source_email_id=NULL WHERE source_email_id=?').run(id);
      if (snap.mentions.length) q("DELETE FROM mentions WHERE source_type='email' AND source_id=?").run(id);
      if (snap.html) q('DELETE FROM email_html WHERE email_id=?').run(id);
      if (snap.inline.length) q('DELETE FROM email_inline WHERE email_id=?').run(id);
      updIds('UPDATE files SET email_id=NULL WHERE id IN (?)', keptFiles);
      for (const c of chunk(fileIds)) { const ph = c.map(() => '?').join(','); q(`DELETE FROM chunks WHERE file_id IN (${ph})`).run(...c); q(`DELETE FROM files WHERE id IN (${ph})`).run(...c); }
      q('DELETE FROM emails WHERE id=?').run(id);
      trashId = put(actor, 'email', id, (email.original_subject || email.subject || '(ללא נושא)').trim(), snap, summary);
      updIds('UPDATE ingest_mail SET email_id=NULL, gone_at=?, trash_id=? WHERE id IN (?)', snap.ingest, now(), trashId);
      seal(trashId);
    })();
    return { id, title: email.subject, trash_id: trashId, trashed: true };
  }
  function restoreEmail(d) {
    const eid = reinsert('emails', { ...d.email, file_id: null }); // the search triggers index a live mail again; the semantic indexer re-embeds it
    const fmap = new Map(), cmap = new Map();
    for (const f of d.files || []) fmap.set(f.id, reinsert('files', { ...f, email_id: eid }));
    for (const c of d.chunks || []) if (fmap.has(c.file_id)) cmap.set(c.id, reinsert('chunks', { ...c, file_id: fmap.get(c.file_id) }));
    if (d.email.file_id) q('UPDATE emails SET file_id=? WHERE id=?').run(fmap.get(d.email.file_id) ?? (q('SELECT 1 FROM files WHERE id=?').get(d.email.file_id) ? d.email.file_id : null), eid);
    updIds('UPDATE files SET email_id=? WHERE email_id IS NULL AND id IN (?)', d.kept_files || [], eid);
    for (const x of d.task_emails || []) if (q('SELECT 1 FROM tasks WHERE id=?').get(x.task_id)) reinsert('task_emails', { ...x, email_id: eid }, { orIgnore: true });
    updIds('UPDATE tasks SET source_email_id=? WHERE source_email_id IS NULL AND id IN (?)', d.source_tasks || [], eid);
    updIds('UPDATE calendar_items SET source_email_id=? WHERE source_email_id IS NULL AND id IN (?)', d.calendar || [], eid);
    for (const m of d.mentions || []) { try { reinsert('mentions', { ...m, source_id: eid }, { orIgnore: true }); } catch { /* ignore */ } }
    if (d.html) q('INSERT OR REPLACE INTO email_html (email_id, html, state) VALUES (?,?,?)').run(eid, d.html.html, d.html.state);
    for (const i of d.inline || []) reinsert('email_inline', { ...i, email_id: eid, data: unb64(i.data) });
    const mapRef = (kind, rid) => (kind === 'email' ? eid : kind === 'file' ? fmap.get(rid) : cmap.get(rid));
    for (const r of d.archive_index || []) { const rid = mapRef(r.kind, r.ref_id); if (rid != null) try { q('INSERT INTO search_archive (title, body, kind, ref_id, project_id, ts, person) VALUES (?,?,?,?,?,?,?)').run(r.title, r.body, r.kind, rid, r.project_id, r.ts, r.person); } catch { /* no archive index */ } }
    for (const v of d.archive_vectors || []) {
      const rid = mapRef(v.kind, v.ref_id); if (rid == null || !v.vec) continue;
      try { const nid = q('INSERT INTO embeddings (kind, ref_id, part, src_rowid, project_id, ts, person, title, snippet, archive) VALUES (?,?,?,?,?,?,?,?,?,1)').run(v.kind, rid, v.part, null, v.project_id, v.ts, v.person, v.title, v.snippet).lastInsertRowid; q('INSERT INTO vec_archive (rowid, embedding) VALUES (?, vec_int8(?))').run(BigInt(nid), unb64(v.vec)); } catch { /* no vector table */ }
    }
    // restored by hand while it is still deleted in Outlook: the deletions check must not take it away again (lib/presence.js clears this when Outlook has the mail again)
    updIds('UPDATE ingest_mail SET email_id=?, gone_at=NULL, trash_id=NULL, presence_keep=1 WHERE id IN (?)', d.ingest || [], eid);
    return { id: eid, title: d.email.original_subject || d.email.subject || '' };
  }
  // the raw .msg and attachment files of a finally deleted mail (only when no live row still points at the same path)
  function unlinkEmailFiles(d) {
    const fs = require('fs');
    for (const f of d.files || []) for (const p of [f.path, f.text_path]) {
      if (!p || q('SELECT 1 FROM files WHERE path=? OR text_path=?').get(p, p)) continue;
      try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
  }

  // ---- the bin itself
  function put(actor, kind, entityId, title, snapshot, summary = '') {
    return Number(q('INSERT INTO trash (kind, entity_id, title, snapshot, deleted_at, deleted_by, events_upto, summary) VALUES (?,?,?,?,?,?,?,?)')
      .run(kind, entityId, String(title || '').slice(0, 300), JSON.stringify(snapshot), now(), actor ?? null, lastEvent(), summary || '').lastInsertRowid);
  }
  // the events written by the deletion itself belong to the item too (anonymised with it at the final step)
  const seal = (trashId) => q('UPDATE trash SET events_upto=? WHERE id=?').run(lastEvent(), trashId);
  const getRow = (id) => { const r = q('SELECT * FROM trash WHERE id=?').get(+id); if (!r) throw missing('הפריט לא נמצא בסל (אולי כבר שוחזר או נמחק סופית)'); return r; };
  function view(r, d = days()) {
    const at = purgeAt(r, d);
    return { id: r.id, kind: r.kind, kind_he: KINDS[r.kind] || r.kind, entity_id: r.entity_id, title: r.title, summary: r.summary, deleted_at: r.deleted_at,
      deleted_by: r.deleted_by ? (q('SELECT name_he FROM people WHERE id=?').get(r.deleted_by)?.name_he ?? null) : null,
      purge_at: at, days_left: at ? Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / DAY)) : null };
  }
  function list(f = {}) {
    const d = days(); const kind = f.kind && KINDS[f.kind] ? f.kind : null;
    const items = rows(`SELECT id, kind, entity_id, title, summary, deleted_at, deleted_by FROM trash${kind ? ' WHERE kind=?' : ''} ORDER BY deleted_at DESC, id DESC LIMIT ?`, ...(kind ? [kind] : []), Math.min(+f.limit || 500, 2000)).map((r) => view(r, d));
    const counts = Object.fromEntries(rows('SELECT kind, COUNT(*) n FROM trash GROUP BY kind').map((r) => [r.kind, r.n]));
    return { days: d, total: Object.values(counts).reduce((a, b) => a + b, 0), counts, kinds: KINDS, items };
  }
  const count = () => q('SELECT COUNT(*) n FROM trash').get().n;

  function restore(actor, id) {
    const r = getRow(id); const d = JSON.parse(r.snapshot);
    let res;
    try {
      db.transaction(() => {
        if (r.kind === 'task') { const tid = restoreTask(d); res = { id: tid, title: d.task.title }; }
        else if (r.kind === 'project') res = restoreProject(d);
        else if (r.kind === 'person') res = restorePerson(d);
        else if (r.kind === 'protocol') res = restoreProtocol(d);
        else if (r.kind === 'calendar') res = { id: reinsert('calendar_items', d.row), title: d.row.title };
        else if (r.kind === 'filter') res = { id: reinsert('mail_filters', d.row), title: r.title };
        else if (r.kind === 'chat') res = restoreChat(d);
        else if (r.kind === 'email') res = restoreEmail(d);
        else throw bad('סוג פריט לא מוכר');
        q('DELETE FROM trash WHERE id=?').run(r.id);
        const ev = store.logEvent(actor, EVENT_ENTITY[r.kind], res.id, 'restore', 'title', null, `שוחזר מהסל: ${res.title}`, { trash_id: r.id });
        if (r.kind === 'chat' || r.kind === 'email') quiet(ev);
      })();
    } catch (e) {
      if (/UNIQUE constraint/.test(String(e.message))) throw bad('לא ניתן לשחזר: פריט זהה כבר קיים');
      throw e;
    }
    return { ...res, kind: r.kind, kind_he: KINDS[r.kind], trash_id: r.id, restored: true };
  }

  // PERMANENT: the snapshot goes, the events that mention the item lose their content (the fact that something happened stays), a hidden chat message is blanked
  function destroyRow(r) {
    const d = JSON.parse(r.snapshot);
    const anon = (entity, id) => q('UPDATE events SET field=NULL, old_value=NULL, new_value=NULL, meta=NULL WHERE entity=? AND entity_id=? AND id<=?').run(entity, id, r.events_upto);
    anon(EVENT_ENTITY[r.kind], r.entity_id);
    if (r.kind === 'project') for (const t of d.tasks || []) anon('task', t.task.id);
    if (r.kind === 'chat') {
      const set = ['text=\'\''];
      for (const c of ['transcript', 'rich', 'edited_from', 'reply_quote']) if (cols('chat_messages').has(c)) set.push(`${c}=NULL`);
      q(`UPDATE chat_messages SET ${set.join(', ')} WHERE id=? AND deleted_at IS NOT NULL`).run(d.id);
      try { q('DELETE FROM chat_edits WHERE msg_id=?').run(d.id); } catch { /* none */ }
    }
    q('DELETE FROM trash WHERE id=?').run(r.id);
    if (r.kind === 'email') { q('UPDATE ingest_mail SET trash_id=NULL WHERE trash_id=?').run(r.id); unlinkEmailFiles(d); }
  }
  function destroy(actor, id) {
    const r = getRow(id);
    db.transaction(() => { destroyRow(r); quiet(store.logEvent(actor, 'trash', r.id, 'purge', 'kind', null, `נמחק סופית מהסל: ${KINDS[r.kind] || r.kind}`)); })();
    return { id: r.id, kind: r.kind, title: r.title, purged: true };
  }
  function empty(actor) {
    const all = rows('SELECT * FROM trash');
    db.transaction(() => { for (const r of all) destroyRow(r); if (all.length) quiet(store.logEvent(actor, 'trash', 0, 'empty', 'count', null, `הסל רוקן: ${all.length} פריטים נמחקו סופית`)); })();
    return { purged: all.length };
  }
  // nightly (lib/housekeeping.js): what has been in the bin longer than the setting goes for good; ONE event per batch
  function expire({ dryRun = false, at = Date.now() } = {}) {
    const d = days(); if (d <= 0) return { days: d, purged: 0 };
    const cutoff = new Date(at - d * DAY).toISOString();
    const old = rows('SELECT * FROM trash WHERE deleted_at <= ?', cutoff);
    if (dryRun || !old.length) return { days: d, purged: 0, due: old.length };
    db.transaction(() => { for (const r of old) destroyRow(r); store.logEvent(store.assistantId(), 'trash', 0, 'expire', 'count', null, `${old.length} פריטים שהיו בסל יותר מ־${d} ימים נמחקו סופית`); })();
    return { days: d, purged: old.length };
  }

  return { seal, trashEmail, trashTask, trashProject, trashPerson, trashProtocol, trashCalendar, trashFilter, trashChat, restore, destroy, empty, expire, list, count, get: (id) => view(getRow(id)), days, setDays, KINDS };
}

module.exports = { createTrash, KINDS, DEFAULT_DAYS };
