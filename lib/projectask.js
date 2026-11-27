'use strict';
// NEW PROJECTS: the assistant may not create one. When it believes a new project exists (mail, chat, protocol) it PROPOSES it; the owner answers one
// question "פרויקט חדש? «name»" (site card + Telegram, through the proposals path) and the answer is remembered:
//   yes            -> the project is created (proposed name and aliases) and everything that waited for the decision is linked to it
//   no + project Y -> the name becomes an alias of Y (future mail resolves to Y by itself) and the waiting items move to Y
//   no + not a project -> the name (normalized, with variants) is stored as rejected: never proposed again, later mentions resolve to "no project" silently
// While waiting, items stay in the default (unassigned) project marked "ממתין לאישור פרויקט"; nothing is lost. One pending name is asked ONCE.
const { now } = require('./db');
const { bad } = require('./store');
const { wordRe } = require('./entities');

const HEB_PREFIX = /^[ובלמהכש]/;
const ITEM_TABLES = { task: 'tasks', email: 'emails', file: 'files', knowledge: 'knowledge', protocol: 'protocols', calendar: 'calendar_items', fact: 'project_facts', note: 'notes' };
const CREATE_PHRASE = /(?:פרויקט\s+חדש|(?:צור|צרי|פתח|פתחי|תפתח|תפתחי|תוסיף|תוסיפי|הוסף|הוסיפי|לפתוח|ליצור|להוסיף)\s+(?:את\s+)?(?:ה)?פרויקט)/u;

// normalized form of a name: lower case, no quotes/punctuation, one space, no leading word "פרויקט"
function norm(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/["'`׳״“”‘’()\[\]{}«».,;:!?]/g, '').replace(/[-_/\\|–—]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:פרויקט|project)\s+/u, '').trim();
}
// every spelling that counts as "the same name": the normalized form, without spaces, and without a one-letter Hebrew prefix on the first word ("בדוגמית" = "דוגמית")
function variants(s) {
  const n = norm(s); if (!n) return [];
  const out = new Set([n, n.replace(/\s+/g, '')]);
  const words = n.split(' ');
  if (words[0].length >= 4 && HEB_PREFIX.test(words[0])) { const w = [words[0].slice(1), ...words.slice(1)].join(' '); out.add(w); out.add(w.replace(/\s+/g, '')); }
  return [...out];
}

function createProjectAsk({ db, store, proposals, entities = null }) {
  const q = (sql) => db.prepare(sql);
  const J = (s, d = []) => { try { return JSON.parse(s); } catch { return d; } };
  const defaultId = () => store.defaultProjectId ? store.defaultProjectId() : q('SELECT id FROM projects WHERE is_default=1 ORDER BY id LIMIT 1').get().id;
  const get = (id) => { const r = q('SELECT * FROM project_proposals WHERE id=?').get(+id); if (!r) throw bad('הצעת הפרויקט לא נמצאה'); return r; };
  const view = (r) => r && { ...r, aliases: J(r.aliases) };

  // ---- is this name already known?  { kind: 'project'|'pending'|'rejected', ... } or null
  function lookup(name, aliases = []) {
    const mine = new Set([name, ...aliases].flatMap(variants)); if (!mine.size) return null;
    const hit = (xs) => xs.some((x) => variants(x).some((v) => mine.has(v)));
    for (const p of q('SELECT * FROM projects').all()) if (!p.is_default && hit([p.name_he, ...J(p.aliases)])) return { kind: 'project', project: store.getProject(p.id) };
    for (const v of mine) { const r = q('SELECT * FROM rejected_project_names WHERE norm=?').get(v); if (r) return { kind: 'rejected', rejected: r }; }
    for (const p of q("SELECT * FROM project_proposals WHERE status='open' ORDER BY id").all()) if (hit([p.name, ...J(p.aliases)])) return { kind: 'pending', pending: p };
    return null;
  }
  // used by store.findProject: a pending name resolves to the unassigned project (the item then waits for the owner's answer)
  const pendingByName = (s) => { const r = lookup(s); return r && r.kind === 'pending' ? r.pending : null; };

  // ---- items waiting for the answer
  function attach(ppId, entity, id) {
    if (!ITEM_TABLES[entity] || !Number.isInteger(+id) || +id <= 0) return false;
    if (!q(`SELECT 1 FROM ${ITEM_TABLES[entity]} WHERE id=?`).get(+id)) return false;
    q('INSERT OR IGNORE INTO pending_project_items (pp_id, entity, entity_id, created_at) VALUES (?,?,?,?)').run(+ppId, entity, +id, now()); return true;
  }
  const unassigned = (table, id) => { const r = q(`SELECT project_id FROM ${table} WHERE id=?`).get(id); return !!r && (r.project_id === null || r.project_id === defaultId()); };
  // what the code can see by itself: the source email with its tasks and files, and unassigned tasks/protocols/knowledge/emails that name the project (or an alias)
  function sweep(pp) {
    const names = [pp.name, ...J(pp.aliases)].filter((x) => [...String(x)].length >= 2); let n = 0;
    const m = /^email:(\d+)$/.exec(pp.source || '');
    if (m) {
      const eid = +m[1];
      if (attach(pp.id, 'email', eid)) n++;
      for (const t of q('SELECT id FROM tasks WHERE source_email_id=?').all(eid).concat(q('SELECT task_id id FROM task_emails WHERE email_id=?').all(eid))) if (unassigned('tasks', t.id) && attach(pp.id, 'task', t.id)) n++;
      for (const f of q('SELECT id FROM files WHERE email_id=?').all(eid)) if (unassigned('files', f.id) && attach(pp.id, 'file', f.id)) n++;
    }
    const mention = (text) => names.some((x) => wordRe(x).test(String(text || '')));
    const dflt = defaultId();
    for (const t of q('SELECT id, title, description FROM tasks WHERE project_id=?').all(dflt)) if (mention(`${t.title} ${t.description}`) && attach(pp.id, 'task', t.id)) n++;
    for (const t of q('SELECT id, title, summary_he FROM protocols WHERE project_id IS NULL OR project_id=?').all(dflt)) if (mention(`${t.title} ${t.summary_he}`) && attach(pp.id, 'protocol', t.id)) n++;
    for (const t of q('SELECT id, title, body FROM knowledge WHERE project_id IS NULL OR project_id=?').all(dflt)) if (mention(`${t.title} ${t.body}`) && attach(pp.id, 'knowledge', t.id)) n++;
    for (const t of q('SELECT id, COALESCE(original_subject, subject) s FROM emails WHERE project_id IS NULL OR project_id=?').all(dflt)) if (mention(t.s) && attach(pp.id, 'email', t.id)) n++;
    return n;
  }
  const itemsOf = (ppId) => q('SELECT entity, entity_id FROM pending_project_items WHERE pp_id=? ORDER BY entity, entity_id').all(ppId);
  // called after a run: unassigned tasks that name a pending project are marked as waiting for it
  function sweepAll() { let n = 0; for (const pp of q("SELECT * FROM project_proposals WHERE status='open'").all()) n += sweep(pp); return n; }

  function relink(pp, projectId, actor) {
    const moved = {};
    db.transaction(() => {
      for (const it of itemsOf(pp.id)) {
        const table = ITEM_TABLES[it.entity];
        if (!unassigned(table, it.entity_id)) continue; // already assigned elsewhere by the owner: leave it
        if (it.entity === 'task') store.updateTask(actor, it.entity_id, { project: projectId });
        else q(`UPDATE ${table} SET project_id=? WHERE id=?`).run(projectId, it.entity_id);
        (moved[it.entity] = moved[it.entity] || []).push(it.entity_id);
      }
      q('DELETE FROM pending_project_items WHERE pp_id=?').run(pp.id);
    })();
    return moved;
  }
  const countOf = (moved) => Object.values(moved).reduce((a, v) => a + v.length, 0);
  const closeAttention = (pp, status) => { if (pp.attention_id) q('UPDATE attention SET status=? WHERE id=? AND status=?').run(status, pp.attention_id, 'open'); };

  // ---- the one-line context shown with the question
  function contextOf(source, given) {
    if (given) return String(given).slice(0, 200);
    const m = /^(email|chat|protocol|file|task):(\d+)$/.exec(source || ''); if (!m) return source ? `מתוך: ${String(source).slice(0, 160)}` : '';
    const id = +m[2];
    if (m[1] === 'email') {
      const e = q('SELECT from_addr, forwarded_from, original_subject, subject FROM emails WHERE id=?').get(id); if (!e) return '';
      const raw = String(e.forwarded_from || e.from_addr || ''); const mm = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw); const who = ((mm ? mm[1] : '').replace(/["']/g, '').trim() || (mm ? mm[2] : raw)).trim();
      return `מתוך: ${String(e.original_subject || e.subject || '').slice(0, 110)}${who ? ' · ' + who.slice(0, 50) : ''}`;
    }
    if (m[1] === 'protocol') return `מתוך: פרוטוקול ${q('SELECT title FROM protocols WHERE id=?').get(id)?.title || '#' + id}`.slice(0, 200);
    if (m[1] === 'task') return `מתוך: משימה ${q('SELECT title FROM tasks WHERE id=?').get(id)?.title || '#' + id}`.slice(0, 200);
    if (m[1] === 'file') return `מתוך: קובץ ${q('SELECT original_name FROM files WHERE id=?').get(id)?.original_name || '#' + id}`.slice(0, 200);
    return 'מתוך: הודעה בצ׳אט';
  }

  // ---- PROPOSE (the assistant's only way to a new project)
  // result.status: pending_approval (asked now or already waiting) | exists (the name is a known project/alias) | rejected (the owner said it is not a project) | created (the owner himself asked for it in chat)
  function propose(actor, b = {}) {
    const name = String(b.name ?? b.name_he ?? '').trim().replace(/\s+/g, ' ');
    if (!name || !norm(name)) throw bad('יש להזין שם לפרויקט המוצע');
    if (name.length > 120) throw bad('השם ארוך מדי');
    const aliases = [...new Set((Array.isArray(b.aliases) ? b.aliases : String(b.aliases ?? '').split(/[,،\n]/)).map((x) => String(x).trim()).filter((x) => x && norm(x) && norm(x) !== norm(name)))].slice(0, 12);
    const source = b.from ? String(b.from).trim().slice(0, 80) : (b.source ? String(b.source).slice(0, 80) : null);
    // the owner's own words in chat ("פתח פרויקט X") are the owner's decision: no question
    const cm = /^chat:(\d+)$/.exec(source || '');
    if (cm) {
      const msg = q("SELECT text FROM chat_messages WHERE id=? AND author='owner'").get(+cm[1]);
      if (msg && CREATE_PHRASE.test(msg.text) && variants(name).some((v) => norm(msg.text).includes(v)) && !lookup(name, aliases)) {
        const p = store.createProject(store.ownerId(), { name, aliases, description: b.description });
        return { status: 'created', project: p, message: `הבעלים ביקש במפורש בצ׳אט: הפרויקט "${p.name_he}" נוצר (מספר ${p.id}).` };
      }
    }
    const known = lookup(name, aliases);
    if (known?.kind === 'project') return { status: 'exists', project: known.project, message: `"${name}" כבר מוכר כפרויקט ${known.project.id} "${known.project.name_he}": שייכו אליו (--project ${known.project.id}), אין צורך להציע.` };
    if (known?.kind === 'rejected') return { status: 'rejected', message: `הבעלים כבר קבע ש"${known.rejected.name}" אינו פרויקט. לא מציעים שוב: השאירו בלי פרויקט (unassigned) ללא שאלה.` };
    if (known?.kind === 'pending') {
      const pp = known.pending;
      const merged = [...new Set([...J(pp.aliases), ...aliases, ...(norm(pp.name) !== norm(name) ? [name] : [])])].filter((x) => norm(x) !== norm(pp.name));
      q('UPDATE project_proposals SET aliases=? WHERE id=?').run(JSON.stringify(merged), pp.id);
      for (const spec of String(b.attach ?? '').split(',')) { const [en, id] = spec.trim().split(':'); attach(pp.id, en, id); }
      if (source && /^(email|task|file):\d+$/.test(source)) { const [en, id] = source.split(':'); attach(pp.id, en, id); }
      sweep(get(pp.id));
      return { status: 'pending_approval', deduped: true, proposal: view(get(pp.id)), message: `השאלה על "${pp.name}" כבר נשלחה לבעלים וממתינה לתשובה (לא נשאלת שוב). הפריטים שציינתם נרשמו כממתינים; השאירו אותם ללא פרויקט.` };
    }
    // a new question
    let ppId, batchId;
    db.transaction(() => {
      ppId = q('INSERT INTO project_proposals (name, norm, aliases, source, context, created_by, created_at) VALUES (?,?,?,?,?,?,?)').run(name, norm(name), JSON.stringify(aliases), source, contextOf(source, b.context), actor, now()).lastInsertRowid;
      const pp = get(ppId);
      for (const spec of String(b.attach ?? '').split(',')) { const [en, id] = spec.trim().split(':'); attach(ppId, en, id); }
      sweep(pp);
      const ask = `פרויקט חדש? «${name}»`;
      batchId = proposals.createBatch('project', ask, [{ kind: 'project_new', target_id: ppId, text: ask, reason: pp.context || null,
        payload: JSON.stringify({ ask, context: pp.context, aliases, approve_label: '✅ כן, להוסיף', reject_label: '❌ לא' }) }]);
      const proposalId = q("SELECT id FROM proposals WHERE batch=? AND kind='project_new'").get(batchId).id;
      const att = q('INSERT INTO attention (kind, text, created_at) VALUES (?,?,?)').run('question', `${ask}${pp.context ? ' · ' + pp.context : ''}`, now()).lastInsertRowid;
      q('UPDATE project_proposals SET proposal_id=?, attention_id=? WHERE id=?').run(proposalId, att, ppId);
    })();
    return { status: 'pending_approval', proposal: view(get(ppId)), batch: batchId, message: `נשלחה שאלה לבעלים: פרויקט חדש? «${name}». עד לתשובה השאירו את הפריטים בלי פרויקט (הם מסומנים "ממתין לאישור פרויקט"). אל תיצרו את הפרויקט בעצמכם.` };
  }

  // ---- the owner's answers
  function accept(ppId, actor = store.ownerId()) {
    const pp = get(ppId); if (pp.status !== 'open') return view(pp);
    let project, moved;
    db.transaction(() => {
      const known = lookup(pp.name, J(pp.aliases));
      try { project = known?.kind === 'project' ? known.project : store.createProject(actor, { name: pp.name, aliases: J(pp.aliases) }); }
      catch (e) { project = store.findProject(pp.name); }
      moved = relink(pp, project.id, actor);
      q("UPDATE project_proposals SET status='created', result_project_id=?, decided_at=? WHERE id=?").run(project.id, now(), pp.id);
      closeAttention(pp, 'accepted');
      store.logEvent(actor, 'project', project.id, 'update', 'pending_items', null, countOf(moved), { project_proposal: pp.id, moved });
    })();
    return { project: store.getProject(project.id), moved: countOf(moved), proposal: view(get(pp.id)) };
  }
  // "no": the second step. Up to 4 likely existing projects + "not a project"
  function candidates(pp) {
    const words = new Set([pp.name, pp.context, ...J(pp.aliases)].flatMap((s) => norm(s).split(' ')).filter((w) => w.length >= 3));
    const ctxText = norm(`${pp.name} ${pp.context}`);
    const rows = store.listProjects().filter((p) => !p.is_default && p.status !== 'סגור');
    const used = new Map(q('SELECT project_id id, COUNT(*) n, MAX(updated_at) m FROM tasks GROUP BY project_id').all().map((r) => [r.id, r]));
    const score = (p) => { const text = norm(`${p.name_he} ${(p.aliases || []).join(' ')}`); let s = 0; for (const w of text.split(' ')) if (w.length >= 3 && (words.has(w) || ctxText.includes(w))) s += 3; const u = used.get(p.id); if (u) s += Math.min(2, u.n / 20) + (Date.now() - Date.parse(u.m) < 30 * 86400000 ? 1 : 0); return s; };
    return rows.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s || b.p.id - a.p.id).slice(0, 4).map((x) => ({ id: x.p.id, name: x.p.name_he }));
  }
  function askWhere(ppId) {
    const pp = get(ppId); if (pp.status !== 'open') return view(pp);
    const options = candidates(pp);
    if (!options.length) return reject(ppId);
    const ask = `«${pp.name}» שייך לפרויקט קיים?`;
    const first = q('SELECT batch FROM proposals WHERE id=?').get(pp.proposal_id);
    const id = q('INSERT INTO proposals (batch, kind, target_id, text, created_at, payload, tg_sent) VALUES (?,?,?,?,?,?,0)').run(first.batch, 'project_pick', pp.id, ask, now(),
      JSON.stringify({ ask, context: pp.context, options, none_label: '🚫 לא פרויקט' })).lastInsertRowid;
    return { step: 'pick', proposal_id: id, options };
  }
  function alias(ppId, projectV, actor = store.ownerId()) {
    const pp = get(ppId); if (pp.status !== 'open') return view(pp);
    const target = store.findProject(projectV); if (target.is_default) throw bad('לא ניתן לצרף כינוי לפרויקט "לא משויך"');
    let moved;
    db.transaction(() => {
      const names = [pp.name, ...J(pp.aliases)].filter((x) => norm(x) !== norm(target.name_he));
      const merged = [...new Set([...J(target.aliases), ...names])];
      store.updateProject(actor, target.id, { aliases: merged });
      moved = relink(pp, target.id, actor);
      q("UPDATE project_proposals SET status='alias', result_project_id=?, decided_at=? WHERE id=?").run(target.id, now(), pp.id);
      closeAttention(pp, 'accepted');
    })();
    return { project: store.getProject(target.id), moved: countOf(moved), proposal: view(get(pp.id)) };
  }
  function reject(ppId) {
    const pp = get(ppId); if (pp.status !== 'open') return view(pp);
    db.transaction(() => {
      for (const n of [pp.name, ...J(pp.aliases)]) for (const v of variants(n)) q('INSERT OR IGNORE INTO rejected_project_names (norm, name, pp_id, created_at) VALUES (?,?,?,?)').run(v, pp.name, pp.id, now());
      q('DELETE FROM pending_project_items WHERE pp_id=?').run(pp.id); // the items simply stay unassigned
      q("UPDATE project_proposals SET status='rejected', decided_at=? WHERE id=?").run(now(), pp.id);
      closeAttention(pp, 'dismissed');
    })();
    return { proposal: view(get(pp.id)), moved: 0 };
  }
  // closes the owner's question rows (both steps) when the answer came from elsewhere
  function closeQuestions(ppId, result) { q("UPDATE proposals SET status='applied', decided_at=?, result=? WHERE target_id=? AND kind IN ('project_new','project_pick') AND status='open'").run(now(), result, ppId); }

  // ---- the gate's guard: a project the assistant wrote DIRECTLY (not through the API) during a run is turned back into a proposal
  function revertDirect(projectId) {
    const p = q('SELECT * FROM projects WHERE id=?').get(projectId); if (!p || p.is_default) return null;
    const dflt = defaultId(); const refs = entities ? entities.PROJECT_REFS : [['tasks', 'project_id'], ['emails', 'project_id'], ['files', 'project_id'], ['knowledge', 'project_id'], ['calendar_items', 'project_id'], ['protocols', 'project_id'], ['notes', 'project_id']];
    let out;
    db.transaction(() => {
      const aliases = J(p.aliases); const held = [];
      for (const [table, col] of refs) {
        if (table === 'project_facts') { for (const r of q('SELECT id FROM project_facts WHERE project_id=?').all(p.id)) held.push(['fact', r.id]); }
        const ent = Object.entries(ITEM_TABLES).find(([, t]) => t === table)?.[0];
        for (const r of q(`SELECT id FROM ${table} WHERE ${col}=?`).all(p.id)) if (ent) held.push([ent, r.id]);
        if (table === 'tasks') q(`UPDATE tasks SET ${col}=? WHERE ${col}=?`).run(dflt, p.id); else q(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`).run(dflt, p.id);
      }
      q("DELETE FROM mentions WHERE entity_type='project' AND entity_id=?").run(p.id);
      q('DELETE FROM projects WHERE id=?').run(p.id);
      const known = lookup(p.name_he, aliases);
      const r = known?.kind === 'pending' ? { status: 'pending_approval', proposal: view(known.pending) } : known ? { status: known.kind } : propose(store.assistantId(), { name: p.name_he, aliases });
      if (r.proposal) for (const [en, id] of held) attach(r.proposal.id, en, id);
      store.logEvent(store.assistantId(), 'project', p.id, 'delete', 'name_he', p.name_he, null, { reverted_direct_creation: true });
      out = { name: p.name_he, ...r };
    })();
    return out;
  }

  // ---- display helpers
  const pendingFor = (entity, id) => q("SELECT pp.id, pp.name FROM pending_project_items i JOIN project_proposals pp ON pp.id=i.pp_id WHERE i.entity=? AND i.entity_id=? AND pp.status='open' LIMIT 1").get(entity, +id) || null;
  const list = (status) => q(status ? 'SELECT * FROM project_proposals WHERE status=? ORDER BY id DESC' : 'SELECT * FROM project_proposals ORDER BY id DESC').all(...(status ? [status] : [])).map((r) => ({ ...view(r), items: itemsOf(r.id).length }));
  const rejectedNames = () => q('SELECT name, MIN(created_at) at FROM rejected_project_names GROUP BY name ORDER BY at DESC').all();
  return { propose, accept, askWhere, alias, reject, closeQuestions, lookup, pendingByName, attach, sweep, sweepAll, revertDirect, pendingFor, list, rejectedNames, get: (id) => view(get(id)), norm, variants };
}

module.exports = { createProjectAsk, norm, variants, CREATE_PHRASE };
