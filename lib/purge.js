'use strict';
// Permanent deletion of a PROJECT (with a disposition for what it holds), a PERSON and a PROTOCOL. Reached only through a confirmation the owner answers (lib/confirm.js).
const { now } = require('./db');
const { bad } = require('./store');

function createPurge({ db, store, taskdel }) {
  const q = (sql) => db.prepare(sql);
  const defaultProject = () => q('SELECT id FROM projects WHERE is_default=1').get().id;

  // payload: { tasks: 'unassign' | 'move:<project id|name>' | 'delete', facts: 'with-project' | 'move' | 'unassign', protocols: 'with-project' | 'move' | 'unassign' }
  function project(actor, id, payload = {}) {
    const p = store.findProject(id); if (p.is_default) throw bad('אי אפשר למחוק את "לא משויך"');
    const disp = String(payload.tasks || 'unassign');
    let target = defaultProject(), mode = 'unassign';
    if (disp.startsWith('move:')) { const t = store.findProject(disp.slice(5)); if (t.id === p.id) throw bad('פרויקט היעד זהה לפרויקט שנמחק'); target = t.id; mode = 'move'; }
    else if (disp === 'delete') mode = 'delete';
    const factsMode = payload.facts || (mode === 'move' ? 'move' : 'with-project'); const protMode = payload.protocols || (mode === 'move' ? 'move' : 'with-project');
    const sum = { tasks: 0, facts: 0, protocols: 0 };
    const taskIds = q('SELECT id FROM tasks WHERE project_id=?').all(p.id).map((r) => r.id);
    db.transaction(() => {
      if (mode === 'delete') { for (const t of taskIds) taskdel.purge(actor, t); } else { q('UPDATE tasks SET project_id=?, updated_at=? WHERE project_id=?').run(target, now(), p.id); }
      sum.tasks = taskIds.length;
      sum.facts = q('SELECT COUNT(*) c FROM project_facts WHERE project_id=?').get(p.id).c;
      if (factsMode === 'with-project') q('DELETE FROM project_facts WHERE project_id=?').run(p.id); else q('UPDATE project_facts SET project_id=? WHERE project_id=?').run(factsMode === 'move' ? target : defaultProject(), p.id);
      q('DELETE FROM project_profile WHERE project_id=?').run(p.id); q('DELETE FROM project_status WHERE project_id=?').run(p.id); // the passport and the statuses describe THIS project: they go with it
      sum.protocols = q('SELECT COUNT(*) c FROM protocols WHERE project_id=?').get(p.id).c;
      if (protMode === 'with-project') { for (const pr of q('SELECT id FROM protocols WHERE project_id=?').all(p.id)) { q('DELETE FROM protocol_items WHERE protocol_id=?').run(pr.id); q('DELETE FROM protocols WHERE id=?').run(pr.id); } }
      else q('UPDATE protocols SET project_id=? WHERE project_id=?').run(protMode === 'move' ? target : defaultProject(), p.id);
      // everything else keeps living: files, emails, notes, calendar items, knowledge follow the tasks (or become unassigned); the facts and protocols were handled above
      const rest = mode === 'move' ? target : defaultProject();
      for (const t of ['files', 'emails', 'calendar_items', 'knowledge', 'notes']) { try { q(`UPDATE ${t} SET project_id=? WHERE project_id=?`).run(rest, p.id); } catch { /* table without a project column */ } }
      q('UPDATE mail_filters SET project_id=NULL WHERE project_id=?').run(p.id);
      try { q("DELETE FROM mentions WHERE entity_type='project' AND entity_id=?").run(p.id); } catch { /* none */ }
      q('DELETE FROM projects WHERE id=?').run(p.id);
      store.logEvent(actor, 'project', p.id, 'purge', 'name_he', null, `נמחק לצמיתות: ${p.name_he}`, { tasks: mode, ...sum });
    })();
    return { id: p.id, title: p.name_he, ...sum, tasks_mode: mode === 'move' ? `הועברו ל-${store.findProject(target).name_he}` : mode === 'delete' ? 'נמחקו' : 'הועברו ל"לא משויך"' };
  }

  function person(actor, id) {
    const p = store.findPerson(id); if (p.role === 'owner' || p.role === 'assistant') throw bad('אי אפשר למחוק את הבעלים או את העוזר');
    const assistant = store.assistantId();
    db.transaction(() => {
      for (const [t, c] of [['tasks', 'assignee_id'], ['tasks', 'requester_id'], ['protocol_items', 'owner_person_id']]) q(`UPDATE ${t} SET ${c}=NULL WHERE ${c}=?`).run(p.id);
      for (const [t, c] of [['tasks', 'created_by'], ['notes', 'author_id'], ['events', 'actor_id'], ['projects', 'created_by'], ['knowledge', 'created_by'], ['project_facts', 'created_by'], ['protocols', 'created_by']]) { try { q(`UPDATE ${t} SET ${c}=? WHERE ${c}=?`).run(assistant, p.id); } catch { /* ignore */ } }
      for (const pr of q('SELECT id, participants FROM protocols').all()) { const parts = JSON.parse(pr.participants || '[]'); if (parts.some((x) => x.person_id === p.id)) q('UPDATE protocols SET participants=? WHERE id=?').run(JSON.stringify(parts.map((x) => (x.person_id === p.id ? { ...x, person_id: null } : x))), pr.id); }
      try { q("DELETE FROM mentions WHERE entity_type='person' AND entity_id=?").run(p.id); } catch { /* none */ }
      q('DELETE FROM people WHERE id=?').run(p.id);
      store.logEvent(actor, 'person', p.id, 'purge', 'name_he', null, `נמחק לצמיתות: ${p.name_he}`);
    })();
    return { id: p.id, title: p.name_he };
  }

  function protocol(actor, id) {
    const pr = q('SELECT * FROM protocols WHERE id=?').get(id); if (!pr) throw bad('הפרוטוקול לא נמצא');
    db.transaction(() => { q('UPDATE tasks SET parent_task_id=parent_task_id WHERE 0').run(); q('DELETE FROM protocol_items WHERE protocol_id=?').run(id); q('DELETE FROM protocols WHERE id=?').run(id); store.logEvent(actor, 'protocol', id, 'purge', 'title', null, `נמחק לצמיתות: ${pr.title}`); })();
    return { id, title: pr.title };
  }
  return { project, person, protocol };
}
module.exports = { createPurge };
