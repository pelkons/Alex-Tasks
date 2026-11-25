'use strict';
// Entity resolution with retroactive linking. People and projects the owner names casually start as "partial" (a bare first name,
// a vague project like "דוגמית"). A later email or file reveals who or what they are; resolving then completes the record (or merges it
// into the full one) and re-links everything that referred to it: tasks, mentions, facts, knowledge, protocols. Every resolution is
// ONE event with enough in its meta to be undone completely.
const { now } = require('./db');
const { bad } = require('./store');

const PERSON_REFS = [['tasks', 'requester_id'], ['tasks', 'assignee_id'], ['tasks', 'created_by'], ['notes', 'author_id'], ['events', 'actor_id'], ['projects', 'created_by'],
  ['knowledge', 'created_by'], ['calendar_items', 'created_by'], ['protocols', 'created_by'], ['protocol_items', 'owner_person_id'], ['project_facts', 'created_by']];
const PROJECT_REFS = [['tasks', 'project_id'], ['notes', 'project_id'], ['emails', 'project_id'], ['files', 'project_id'], ['knowledge', 'project_id'], ['calendar_items', 'project_id'], ['protocols', 'project_id'], ['project_facts', 'project_id']];
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a Hebrew word may carry a one-letter prefix (ל/ב/מ/ה/ו/כ/ש): "לגלעד", "מגלעד"
const wordRe = (w) => new RegExp(`(?<![\\p{L}\\p{N}])[ובלמהכש]?${esc(w)}(?![\\p{L}\\p{N}])`, 'iu');

function createEntities(db, store) {
  const q = (sql) => db.prepare(sql);
  const bareFirst = (name) => String(name).trim().split(/\s+/)[0];

  // ---------- mentions
  function addMention(type, id, sourceType, sourceId, surface = '') {
    q('INSERT OR IGNORE INTO mentions (entity_type, entity_id, source_type, source_id, surface, created_at) VALUES (?,?,?,?,?,?)').run(type, id, sourceType, sourceId, String(surface).slice(0, 120), now());
  }
  const partialPeople = () => q("SELECT id, name_he, name_en, emails FROM people WHERE status='partial'").all();
  const partialProjects = () => q('SELECT id, name_he, aliases FROM projects WHERE partial=1').all();
  // every partial person or vague project named in a piece of text
  function scanText(sourceType, sourceId, text) {
    const t = String(text || '');
    if (!t.trim()) return 0;
    let n = 0;
    for (const p of partialPeople()) {
      const names = [p.name_he, bareFirst(p.name_he), p.name_en].filter(Boolean);
      const hit = names.find((x) => [...String(x)].length >= 2 && wordRe(x).test(t));
      if (hit) { addMention('person', p.id, sourceType, sourceId, hit); n++; }
    }
    for (const p of partialProjects()) {
      const hit = [p.name_he, ...JSON.parse(p.aliases)].find((x) => x && [...String(x)].length >= 2 && wordRe(x).test(t));
      if (hit) { addMention('project', p.id, sourceType, sourceId, hit); n++; }
    }
    return n;
  }
  // installed as store.hooks.mention: called when a task or note is created (and from chat)
  function onWrite(kind, id, o) {
    if (kind === 'task') {
      if (o.requester && q("SELECT 1 FROM people WHERE id=? AND status='partial'").get(o.requester)) addMention('person', o.requester, 'task', id, 'מאת');
      if (o.assignee && q("SELECT 1 FROM people WHERE id=? AND status='partial'").get(o.assignee)) addMention('person', o.assignee, 'task', id, 'אחראי');
      if (o.project && q('SELECT 1 FROM projects WHERE id=? AND partial=1').get(o.project)) addMention('project', o.project, 'task', id, 'פרויקט');
      scanText('task', id, `${o.title || ''} ${o.description || ''}`);
    } else if (kind === 'note' || kind === 'chat' || kind === 'knowledge') scanText(kind, id, o.text);
  }
  store.hooks.mention = onWrite;

  // existing text that names a partial person or vague project (chat, tasks, notes, knowledge) and the structural links
  function backfill() {
    let n = 0;
    for (const m of q('SELECT id, text FROM chat_messages').all()) n += scanText('chat', m.id, m.text);
    for (const t of q('SELECT id, title, description, requester_id, assignee_id, project_id FROM tasks').all()) {
      onWrite('task', t.id, { title: t.title, description: t.description, requester: t.requester_id, assignee: t.assignee_id, project: t.project_id });
    }
    for (const m of q('SELECT id, text FROM notes').all()) n += scanText('note', m.id, m.text);
    for (const k of q('SELECT id, title, body FROM knowledge').all()) n += scanText('knowledge', k.id, `${k.title} ${k.body}`);
    return { mentions: q('SELECT COUNT(*) c FROM mentions').get().c, scanned_hits: n };
  }

  function personCard(id) {
    const p = store.listPeople().find((x) => x.id === +id);
    if (!p) throw bad('איש לא נמצא');
    const tasks = q(`SELECT t.id, t.title, s.name_he status, pr.name_he project, CASE WHEN t.requester_id=? THEN 'requester' ELSE 'assignee' END AS role
      FROM tasks t JOIN statuses s ON s.id=t.status_id JOIN projects pr ON pr.id=t.project_id WHERE t.requester_id=? OR t.assignee_id=? ORDER BY s.is_closed, t.id DESC LIMIT 60`).all(p.id, p.id, p.id);
    return { ...p, tasks, mentions: mentionList('person', p.id) };
  }
  function mentionList(type, id) {
    return q('SELECT * FROM mentions WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 80').all(type, id).map((m) => {
      let text = '';
      if (m.source_type === 'task') text = q('SELECT title FROM tasks WHERE id=?').get(m.source_id)?.title || '';
      else if (m.source_type === 'chat') text = q('SELECT text FROM chat_messages WHERE id=?').get(m.source_id)?.text || '';
      else if (m.source_type === 'note') text = q('SELECT text FROM notes WHERE id=?').get(m.source_id)?.text || '';
      else if (m.source_type === 'knowledge') text = q('SELECT title FROM knowledge WHERE id=?').get(m.source_id)?.title || '';
      else if (m.source_type === 'email') text = q('SELECT COALESCE(original_subject, subject) s FROM emails WHERE id=?').get(m.source_id)?.s || '';
      const taskId = m.source_type === 'task' ? m.source_id : m.source_type === 'note' ? q('SELECT task_id FROM notes WHERE id=?').get(m.source_id)?.task_id : null;
      return { ...m, text: String(text).slice(0, 140), task_id: taskId || null };
    });
  }

  // ---------- moving references (recorded, so the whole resolution can be undone)
  function moveRefs(refs, fromId, toId, tx = {}) {
    const moved = {};
    for (const [table, col] of refs) {
      const ids = q(`SELECT id FROM ${table} WHERE ${col}=?`).all(fromId).map((r) => r.id);
      if (!ids.length) continue;
      if (table === 'tasks') q(`UPDATE tasks SET ${col}=?, updated_at=? WHERE ${col}=?`).run(toId, tx.at || now(), fromId);
      else q(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`).run(toId, fromId);
      moved[`${table}.${col}`] = ids;
    }
    return moved;
  }
  const affectedTasks = (type, id, moved) => {
    const ids = new Set();
    for (const [k, v] of Object.entries(moved)) if (k.startsWith('tasks.') && !/created_by/.test(k)) v.forEach((x) => ids.add(x));
    for (const m of q('SELECT source_type, source_id FROM mentions WHERE entity_type=? AND entity_id=?').all(type, id)) {
      if (m.source_type === 'task') ids.add(m.source_id);
      if (m.source_type === 'note') { const t = q('SELECT task_id FROM notes WHERE id=?').get(m.source_id)?.task_id; if (t) ids.add(t); }
    }
    return [...ids];
  };
  function noteTasks(actor, ids, text) {
    const out = [];
    const hook = store.hooks.mention; store.hooks.mention = null; // the note names the old record: it is not a new mention of it
    try { for (const id of ids) { try { out.push(store.addNote(actor, { task: id, text }).id); } catch { /* task gone */ } } } finally { store.hooks.mention = hook; }
    return out;
  }
  const label = (p) => `${p.name_he}${p.role_text ? ', ' + p.role_text : ''}${p.company ? ' (' + p.company + ')' : ''}`;

  // ---------- people
  // into: merge the partial record into a full one; otherwise the fields complete it in place
  function resolvePerson(actor, fromV, o = {}) {
    const from = store.findPerson(fromV);
    if (from.role === 'owner' || from.role === 'assistant') throw bad('לא ניתן לאחד את הבעלים או את העוזר');
    const fields = {};
    for (const k of ['name', 'emails', 'company', 'role_text', 'notes', 'name_en']) if (o[k] !== undefined && o[k] !== '') fields[k] = o[k];
    if (o.email && !fields.emails) fields.emails = [o.email];
    if (!o.into) {
      if (!Object.keys(fields).length) throw bad('יש לציין פרטים להשלמה (שם, דוא״ל, חברה, תפקיד) או איש לאיחוד');
      if (fields.emails) fields.emails = [...new Set([...JSON.parse(from.emails), ...[].concat(fields.emails)])];
      const noteIds = [];
      db.transaction(() => {
        store.updatePerson(actor, from.id, { ...fields, status: o.status || 'full' });
        const cur = store.listPeople().find((p) => p.id === from.id);
        const ids = affectedTasks('person', from.id, {});
        noteIds.push(...noteTasks(actor, ids, `עודכן: ${from.name_he} = ${label(cur)}`));
        store.logEvent(actor, 'person', from.id, 'resolve', 'person', from.name_he, cur.name_he, { in_place: true, note_ids: noteIds, tasks: ids });
      })();
      return { person: store.listPeople().find((p) => p.id === from.id), merged: false, relinked_tasks: affectedTasks('person', from.id, {}).length };
    }
    const into = store.findPerson(o.into);
    if (into.id === from.id) throw bad('לא ניתן לאחד איש לתוך עצמו');
    if (into.role === 'owner' && from.role !== 'contact') throw bad('לא ניתן לאחד');
    let result;
    db.transaction(() => {
      const fromRow = { ...q('SELECT * FROM people WHERE id=?').get(from.id) };
      // what the full record learns from the partial one and from the new details
      const learn = { ...fields };
      const mails = [...new Set([...JSON.parse(into.emails), ...JSON.parse(fromRow.emails), ...[].concat(fields.emails || [])])];
      if (mails.length !== JSON.parse(into.emails).length) learn.emails = mails;
      if (!into.company && !learn.company && fromRow.company) learn.company = fromRow.company;
      if (!into.role_text && !learn.role_text && fromRow.role_text) learn.role_text = fromRow.role_text;
      if (!into.name_en && !learn.name_en && !store.hasHebrew(fromRow.name_he)) learn.name_en = fromRow.name_he;
      if (fromRow.notes && !String(into.notes).includes(fromRow.notes)) learn.notes = into.notes ? `${into.notes}\n${fromRow.notes}` : fromRow.notes;
      if (Object.keys(learn).length) store.updatePerson(actor, into.id, { ...learn, status: 'full' });
      else if (into.status !== 'full') store.updatePerson(actor, into.id, { status: 'full' });
      const moved = moveRefs(PERSON_REFS, from.id, into.id);
      const mentionIds = q("SELECT id FROM mentions WHERE entity_type='person' AND entity_id=?").all(from.id).map((r) => r.id);
      q("UPDATE OR IGNORE mentions SET entity_id=? WHERE entity_type='person' AND entity_id=?").run(into.id, from.id);
      const leftover = q("SELECT id FROM mentions WHERE entity_type='person' AND entity_id=?").all(from.id).map((r) => r.id); // duplicates of an existing mention
      q("DELETE FROM mentions WHERE entity_type='person' AND entity_id=?").run(from.id);
      const prot = [];
      for (const pr of q('SELECT id, participants FROM protocols').all()) {
        const parts = JSON.parse(pr.participants || '[]');
        if (parts.some((x) => x.person_id === from.id)) { prot.push(pr.id); q('UPDATE protocols SET participants=? WHERE id=?').run(JSON.stringify(parts.map((x) => (x.person_id === from.id ? { ...x, person_id: into.id } : x))), pr.id); }
      }
      const ids = affectedTasks('person', into.id, moved);
      const intoNow = store.listPeople().find((p) => p.id === into.id);
      const noteIds = noteTasks(actor, ids, `עודכן: ${from.name_he} = ${label(intoNow)}`);
      q('DELETE FROM entity_decisions WHERE entity_type=? AND entity_id=?').run('person', from.id);
      q('DELETE FROM people WHERE id=?').run(from.id);
      store.logEvent(actor, 'person', into.id, 'resolve', 'person', from.name_he, intoNow.name_he, { from_row: fromRow, moved, mentions: mentionIds, mentions_dropped: leftover, protocols: prot, note_ids: noteIds, tasks: ids });
      result = { person: intoNow, merged: true, from: from.name_he, relinked_tasks: ids.length, moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])) };
    })();
    return result;
  }

  // ---------- projects
  function resolveProject(actor, fromV, o = {}) {
    const from = store.findProject(fromV);
    if (from.is_default) throw bad('לא ניתן לאחד את הפרויקט "' + from.name_he + '" לתוך פרויקט אחר');
    if (!o.into) {
      const upd = {};
      for (const k of ['name', 'description']) if (o[k] !== undefined && o[k] !== '') upd[k] = o[k];
      if (o.aliases !== undefined) upd.aliases = [...new Set([...JSON.parse(from.aliases), ...[].concat(typeof o.aliases === 'string' ? o.aliases.split(/[,،]/) : o.aliases).map((x) => String(x).trim()).filter(Boolean)])];
      if (!Object.keys(upd).length) throw bad('יש לציין פרטים להשלמה (שם, כינויים, תיאור) או פרויקט לאיחוד');
      db.transaction(() => {
        store.updateProject(actor, from.id, { ...upd, partial: 0 });
        const cur = store.getProject(from.id);
        const ids = affectedTasks('project', from.id, { 'tasks.project_id': q('SELECT id FROM tasks WHERE project_id=?').all(from.id).map((r) => r.id) });
        const noteIds = noteTasks(actor, ids, `עודכן: הפרויקט "${from.name_he}" הוא ${cur.name_he}${cur.aliases.length ? ' (כינויים: ' + cur.aliases.join(', ') + ')' : ''}`);
        store.logEvent(actor, 'project', from.id, 'resolve', 'project', from.name_he, cur.name_he, { in_place: true, note_ids: noteIds, tasks: ids });
      })();
      return { project: store.getProject(from.id), merged: false };
    }
    const into = store.findProject(o.into);
    if (into.id === from.id) throw bad('לא ניתן למזג פרויקט לתוך עצמו');
    let result;
    db.transaction(() => {
      const fromRow = { ...q('SELECT * FROM projects WHERE id=?').get(from.id) };
      const aliasesBefore = into.aliases;
      const moved = moveRefs(PROJECT_REFS, from.id, into.id);
      const aliases = [...new Set([...JSON.parse(into.aliases), from.name_he, ...JSON.parse(from.aliases), ...[].concat(o.aliases || [])].map((x) => String(x).trim()).filter(Boolean))].filter((a) => a.toLowerCase() !== into.name_he.toLowerCase());
      q('UPDATE projects SET aliases=?, partial=0 WHERE id=?').run(JSON.stringify(aliases), into.id);
      // two current values for one key: the newer wins, the other becomes history
      const superseded = [];
      for (const { key } of q('SELECT key FROM project_facts WHERE project_id=? AND superseded_by IS NULL GROUP BY key HAVING COUNT(*)>1').all(into.id)) {
        const rows = q('SELECT id FROM project_facts WHERE project_id=? AND key=? AND superseded_by IS NULL ORDER BY as_of_date DESC, id DESC').all(into.id, key);
        for (const r of rows.slice(1)) { q('UPDATE project_facts SET superseded_by=? WHERE id=?').run(rows[0].id, r.id); superseded.push(r.id); }
      }
      const mentionIds = q("SELECT id FROM mentions WHERE entity_type='project' AND entity_id=?").all(from.id).map((r) => r.id);
      q("UPDATE OR IGNORE mentions SET entity_id=? WHERE entity_type='project' AND entity_id=?").run(into.id, from.id);
      const leftover = q("SELECT id FROM mentions WHERE entity_type='project' AND entity_id=?").all(from.id).map((r) => r.id);
      q("DELETE FROM mentions WHERE entity_type='project' AND entity_id=?").run(from.id);
      const ids = affectedTasks('project', into.id, moved);
      const noteIds = noteTasks(actor, ids, `עודכן: הפרויקט "${from.name_he}" הוא ${into.name_he}`);
      q('DELETE FROM entity_decisions WHERE entity_type=? AND entity_id=?').run('project', from.id);
      q('DELETE FROM projects WHERE id=?').run(from.id);
      store.logEvent(actor, 'project', into.id, 'resolve', 'project', from.name_he, into.name_he, { from_row: fromRow, moved, aliases_before: aliasesBefore, superseded, mentions: mentionIds, mentions_dropped: leftover, note_ids: noteIds, tasks: ids });
      result = { merged: from.name_he, into: store.getProject(into.id), moved_tasks: (moved['tasks.project_id'] || []).length, moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])) };
    })();
    return result;
  }

  // "not the same": remembered per identity, so the same stranger is not proposed again
  function markNotSame(actor, type, id, identity, reason) {
    q('INSERT INTO entity_decisions (entity_type, entity_id, identity, verdict, reason, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(entity_type, entity_id, identity) DO UPDATE SET verdict=excluded.verdict, reason=excluded.reason')
      .run(type, +id, String(identity).toLowerCase(), 'not_same', reason ?? null, now());
  }
  const isNotSame = (type, id, identity) => !!q("SELECT 1 FROM entity_decisions WHERE entity_type=? AND entity_id=? AND identity=? AND verdict='not_same'").get(type, +id, String(identity).toLowerCase());

  return { addMention, scanText, onWrite, backfill, personCard, mentionList, resolvePerson, resolveProject, markNotSame, isNotSame, PERSON_REFS, PROJECT_REFS };
}

module.exports = { createEntities, wordRe, PERSON_REFS, PROJECT_REFS };
