'use strict';
// Meeting minutes: a protocol and its items live in their own tab; items reach the main board only when promoted.
const { now } = require('./db');
const { bad, missing, normDateTime, normDate } = require('./store');
const { ensureContacts } = require('./email');

function createProtocols(db, store, knowledge, calendar = null) {
  const q = (sql) => db.prepare(sql);
  const KINDS = ['action', 'decision', 'info'];
  const STATUSES = ['open', 'done', 'promoted', 'dismissed'];

  const parseSource = (src) => {
    const m = /^(email|file|chat|manual)(?::(\d+))?$/.exec(String(src || 'manual').trim());
    if (!m) throw bad('מקור לא תקין. הפורמט: email:ID, file:ID, chat:ID או manual');
    return { type: m[1], id: m[2] ? +m[2] : null };
  };

  // "Name <a@b> (Company, Role); Other" or an array of objects
  function parseParticipants(v) {
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? parseParticipants(x)[0] : x)).filter(Boolean);
    if (!v) return [];
    return String(v).split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const email = (/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/.exec(s) || [])[0] || '';
      const paren = (/\(([^)]*)\)/.exec(s) || [])[1] || '';
      const [company = '', role = ''] = paren.split(',').map((x) => x.trim());
      const name = s.replace(/\([^)]*\)/g, '').replace(/<[^>]*>/g, '').replace(email, '').replace(/[,]+$/, '').trim();
      return { name, email: email.toLowerCase(), company, role };
    });
  }

  const personByNameOrEmail = (name, email) => {
    const all = store.listPeople();
    const e = (email || '').toLowerCase();
    return (e && all.find((p) => p.emails.map((x) => x.toLowerCase()).includes(e))) || (name && all.find((p) => p.name_he === name)) || null;
  };

  function getProtocol(id) {
    const p = q('SELECT p.*, pr.name_he AS project, pr.color AS project_color, pr.is_default AS project_default FROM protocols p LEFT JOIN projects pr ON pr.id=p.project_id WHERE p.id=?').get(id);
    if (!p) throw missing('הפרוטוקול לא נמצא');
    return { ...p, participants: JSON.parse(p.participants || '[]') };
  }
  const itemRow = (i) => ({ ...i, recommended: !!i.recommended });

  function addItem(actor, protocolId, b) {
    const proto = getProtocol(protocolId);
    const text = String(b.text ?? '').trim();
    if (!text) throw bad('יש להזין טקסט לסעיף');
    const kind = b.kind || 'action';
    if (!KINDS.includes(kind)) throw bad('סוג סעיף לא תקין. האפשרויות: ' + KINDS.join(', '));
    const party = b.party || 'internal';
    if (!['internal', 'external'].includes(party)) throw bad('גורם לא תקין. האפשרויות: internal, external');
    const person = b.owner ? personByNameOrEmail(String(b.owner).trim(), null) : null;
    const idx = (q('SELECT MAX(idx) m FROM protocol_items WHERE protocol_id=?').get(protocolId).m ?? -1) + 1;
    const id = q(`INSERT INTO protocol_items (protocol_id, idx, kind, text, owner_name, owner_person_id, party, due_date, recommended, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(protocolId, idx, kind, text, b.owner ? String(b.owner).trim() : null, person?.id ?? null, party, b.due ? normDate(b.due) : null, b.recommended ? 1 : 0, now()).lastInsertRowid;
    store.logEvent(actor, 'protocol', protocolId, 'item', kind, null, text.slice(0, 200), { item_id: id });
    void proto;
    return itemRow(q('SELECT * FROM protocol_items WHERE id=?').get(id));
  }

  function addProtocol(actor, b) {
    const title = String(b.title ?? '').trim();
    if (!title) throw bad('יש להזין כותרת לפרוטוקול');
    const meeting = normDateTime(b.date ?? b.meeting_at);
    if (!meeting) throw bad('יש להזין תאריך ושעה לפגישה');
    const project = b.project ? store.findProject(b.project) : null;
    const src = parseSource(b.source);
    const parts = parseParticipants(b.participants).map((p) => {
      const person = personByNameOrEmail(p.name, p.email);
      return { ...p, person_id: person?.id ?? null };
    });
    // the same meeting from the same source is one protocol (a retried run must not create a second one)
    const dup = src.id !== null ? q("SELECT id FROM protocols WHERE source_type=? AND source_id=? AND substr(meeting_at,1,10)=substr(?,1,10)").get(src.type, src.id, meeting) : null;
    if (dup) {
      if (!q('SELECT 1 FROM protocol_items WHERE protocol_id=?').get(dup.id) && Array.isArray(b.items)) db.transaction(() => { for (const it of b.items) addItem(actor, dup.id, it); })();
      return show(dup.id);
    }
    return db.transaction(() => {
      const id = q(`INSERT INTO protocols (project_id, meeting_at, title, location, participants, summary_he, source_type, source_id, next_meeting_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(project?.id ?? null, meeting, title, String(b.location ?? ''), JSON.stringify(parts), String(b.summary ?? b.summary_he ?? ''), src.type, src.id, b.next_meeting_at || b.next ? normDateTime(b.next_meeting_at || b.next) : null, actor, now()).lastInsertRowid;
      store.logEvent(actor, 'protocol', id, 'create', 'title', null, title);
      ensureContacts(db, store, parts.filter((p) => p.email).map((p) => ({ name: p.name, email: p.email })));
      for (const it of Array.isArray(b.items) ? b.items : []) addItem(actor, id, it);
      const nm = q('SELECT next_meeting_at FROM protocols WHERE id=?').get(id).next_meeting_at;
      if (nm && calendar) calendar.addItem(actor, { title: `${title} (המשך)`, start: nm, location: String(b.location ?? ''), project: project?.id });
      // known people get their person id now that contacts exist
      const upd = parts.map((p) => ({ ...p, person_id: p.person_id ?? personByNameOrEmail(p.name, p.email)?.id ?? null }));
      q('UPDATE protocols SET participants=? WHERE id=?').run(JSON.stringify(upd), id);
      return show(id);
    })();
  }

  function counts(protocolId) {
    const r = q(`SELECT SUM(kind='action' AND status='open') open_actions, SUM(kind='action' AND status='open' AND recommended=1) recommended, SUM(kind='action') actions, SUM(kind='decision') decisions, SUM(kind='info') infos FROM protocol_items WHERE protocol_id=?`).get(protocolId);
    return { open_actions: r.open_actions || 0, recommended: r.recommended || 0, actions: r.actions || 0, decisions: r.decisions || 0, infos: r.infos || 0 };
  }
  function list({ project } = {}) {
    const rows = project ? q('SELECT id FROM protocols WHERE project_id=? ORDER BY meeting_at DESC').all(store.findProject(project).id) : q('SELECT id FROM protocols ORDER BY meeting_at DESC LIMIT 300').all();
    return rows.map((r) => { const p = getProtocol(r.id); return { ...p, participant_count: p.participants.length, ...counts(r.id) }; });
  }
  function show(id) {
    const p = getProtocol(id);
    const items = q(`SELECT i.*, t.title AS task_title FROM protocol_items i LEFT JOIN tasks t ON t.id=i.task_id WHERE i.protocol_id=? ORDER BY i.recommended DESC, i.idx`).all(id).map(itemRow);
    let source = null;
    if (p.source_type === 'email' && p.source_id) source = q('SELECT id, COALESCE(original_subject, subject) AS subject, body_text AS body, forwarded_from AS sender FROM emails WHERE id=?').get(p.source_id);
    if (p.source_type === 'file' && p.source_id) source = q('SELECT id, original_name AS subject FROM files WHERE id=?').get(p.source_id);
    return { ...p, ...counts(id), participant_count: p.participants.length, items, source };
  }

  function getItem(id) {
    const i = q('SELECT * FROM protocol_items WHERE id=?').get(id);
    if (!i) throw missing('הסעיף לא נמצא');
    return i;
  }
  function updateItem(actor, id, b) {
    const cur = getItem(id);
    const sets = {};
    if (b.text !== undefined) { if (!String(b.text).trim()) throw bad('יש להזין טקסט לסעיף'); sets.text = String(b.text).trim(); }
    if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) throw bad('סוג סעיף לא תקין'); sets.kind = b.kind; }
    if (b.party !== undefined) { if (!['internal', 'external'].includes(b.party)) throw bad('גורם לא תקין'); sets.party = b.party; }
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw bad('סטטוס לא תקין'); sets.status = b.status; }
    if (b.owner !== undefined) { sets.owner_name = b.owner || null; sets.owner_person_id = b.owner ? (personByNameOrEmail(String(b.owner).trim(), null)?.id ?? null) : null; }
    if (b.due !== undefined) sets.due_date = b.due ? normDate(b.due) : null;
    if (b.recommended !== undefined) sets.recommended = b.recommended ? 1 : 0;
    const cols = Object.keys(sets);
    if (!cols.length) return itemRow(cur);
    db.transaction(() => {
      q(`UPDATE protocol_items SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), id);
      store.logEvent(actor, 'protocol', cur.protocol_id, 'item_update', cols.join(','), null, JSON.stringify(sets).slice(0, 200), { item_id: id });
    })();
    return itemRow(getItem(id));
  }
  const setStatus = (actor, id, status) => updateItem(actor, id, { status });

  // an item becomes a main-board task linked to it
  function promote(actor, id) {
    const it = getItem(id);
    if (it.status === 'promoted' && it.task_id) throw bad('הסעיף כבר הועבר למשימות');
    const p = getProtocol(it.protocol_id);
    const chair = p.participants.find((x) => /יו"ר|יושב|מנהל הישיבה|chair/i.test(x.role || ''));
    const chairPerson = chair ? personByNameOrEmail(chair.name, chair.email) : null;
    const input = {
      title: it.text.length > 200 ? it.text.slice(0, 197) + '…' : it.text,
      project: p.project_id ?? undefined,
      description: `מתוך הפרוטוקול "${p.title}" (${String(p.meeting_at).slice(0, 10).split('-').reverse().join('/')})` + (it.owner_name ? `\nאחראי בפרוטוקול: ${it.owner_name}` : ''),
      source_date: p.meeting_at,
      due: it.due_date || undefined,
      due_source: it.due_date ? 'explicit' : undefined,
    };
    if (it.party === 'internal' && it.owner_person_id) input.assignee = it.owner_person_id;
    const reqPerson = it.party === 'external' && it.owner_person_id ? it.owner_person_id : chairPerson?.id;
    if (reqPerson) input.requester = reqPerson;
    return db.transaction(() => {
      const t = store.createTask(actor, input);
      q("UPDATE protocol_items SET status='promoted', task_id=? WHERE id=?").run(t.id, id);
      store.logEvent(actor, 'protocol', p.id, 'promote', 'task', null, String(t.id), { item_id: id, task_id: t.id });
      return { item: itemRow(getItem(id)), task: t };
    })();
  }
  function promoteMany(actor, ids) {
    const out = [], skipped = [];
    for (const id of ids) { try { out.push(promote(actor, +id)); } catch (e) { skipped.push({ id, reason: e.message }); } }
    return { promoted: out.map((o) => ({ item: o.item.id, task: o.task.id })), skipped };
  }
  const forTask = (taskId) => q('SELECT i.id AS item_id, p.id AS protocol_id, p.title FROM protocol_items i JOIN protocols p ON p.id=i.protocol_id WHERE i.task_id=?').get(taskId) || null;
  const forProject = (projectId) => list({ project: projectId });

  return { addProtocol, addItem, list, show, updateItem, done: (a, id) => setStatus(a, id, 'done'), dismiss: (a, id) => setStatus(a, id, 'dismissed'), promote, promoteMany, forTask, forProject, parseParticipants };
}

module.exports = { createProtocols };
