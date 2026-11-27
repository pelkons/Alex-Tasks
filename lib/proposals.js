'use strict';
// Bulk proposals the owner approves in the chat ("אשר הכל" / per item): task merges, closures and downgrades after an import, people merges and removals.
// Nothing is applied silently: a proposal is only a row until the owner decides; applying goes through the normal store functions (logged, undoable).
const { now } = require('./db');
const { bad, missing } = require('./store');

const KINDS = { bench_question: 'שאלת בדיקה', task_merge: 'מיזוג כפילות', task_close: 'סגירה (כבר טופל)', task_info: 'לידיעה בלבד', task_notours: 'לא באחריות הצוות', filter_add: 'כלל סינון', question: 'שאלה', person_merge: 'מיזוג אנשים', person_remove: 'הסרת איש קשר' };

function createProposals({ db, store, chat }) {
  const q = (sql) => db.prepare(sql);
  const statusId = (name) => q('SELECT id FROM statuses WHERE name_he=?').get(name)?.id;

  // one batch = one chat card; items: [{kind, target_id, other_id, text, reason}]
  function createBatch(kind, title, items) {
    if (!items.length) return null;
    const bid = db.transaction(() => {
      const id = q('INSERT INTO proposal_batches (kind, title, created_at) VALUES (?,?,?)').run(kind, title, now()).lastInsertRowid;
      for (const it of items) q('INSERT INTO proposals (batch, kind, target_id, other_id, text, reason, created_at, payload, tg_sent) VALUES (?,?,?,?,?,?,?,?,?)').run(id, it.kind, it.target_id, it.other_id ?? null, it.text, it.reason ?? null, now(), it.payload ?? null, ['bench_question', 'question'].includes(it.kind) ? 0 : 1); // question cards go to Telegram one by one
      const mid = q(`INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, proposal_batch) VALUES ('claude','web',?,'[]','[]',?,1,?)`).run(`${title}: ${items.length} הצעות לאישור`, now(), id).lastInsertRowid;
      q('UPDATE proposal_batches SET chat_message_id=? WHERE id=?').run(mid, id);
      return id;
    })();
    return bid;
  }
  // ---- what the owner needs to see to answer a question about an email: who wrote it, when, which project, the subject, the CLEANED text, the attachments, a link
  const dmyHm = (iso) => { try { return new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(',', ''); } catch { return ''; } };
  function emailIdOf(p) {
    try { const pl = JSON.parse(p.payload || '{}'); if (pl.email_id) return +pl.email_id; } catch { /* no payload */ }
    if (p.kind === 'question' && p.other_id && q('SELECT 1 FROM emails WHERE id=?').get(p.other_id)) return p.other_id;
    if (/^task_/.test(p.kind)) return q('SELECT source_email_id e FROM tasks WHERE id=?').get(p.target_id)?.e || null;
    return null;
  }
  function emailContext(id) {
    const e = q('SELECT * FROM emails WHERE id=?').get(id); if (!e) return null;
    const { clean } = require('./textclean'); const S = require('./config').siteUrl(db);
    const raw = String(e.forwarded_from || e.from_addr || ''); const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw); const addr = (m ? m[2] : raw).trim().toLowerCase(); const disp = (m ? m[1] : '').replace(/["']/g, '').trim();
    const person = addr && store.listPeople().find((x) => x.emails.map((v) => String(v).toLowerCase()).includes(addr));
    const proj = (e.project_id && q('SELECT name_he FROM projects WHERE id=?').get(e.project_id)?.name_he) || q('SELECT p.name_he n FROM task_emails te JOIN tasks t ON t.id=te.task_id JOIN projects p ON p.id=t.project_id WHERE te.email_id=? LIMIT 1').get(e.id)?.n || null;
    const body = clean(e.body_text || '', { max: 4000 }).trim(); let excerpt = body.slice(0, 420); if (body.length > 420) excerpt = excerpt.replace(/\s+\S*$/, '') + '…';
    const atts = q('SELECT original_name FROM files WHERE email_id=? AND id<>COALESCE(?,0) ORDER BY id LIMIT 12').all(e.id, e.file_id).map((f) => f.original_name);
    return { id: e.id, sender: person?.name_he || disp || addr, when: dmyHm(e.mail_date || e.forwarded_date || e.received_at), project: proj, subject: e.original_subject || e.subject || '', excerpt, full: body, attachments: atts, link: `${S}/email/${e.id}` };
  }
  const withContext = (p) => {
    const out = { ...p, kind_he: KINDS[p.kind] || p.kind }; let pl = {}; try { pl = JSON.parse(p.payload || '{}'); } catch { /* none */ }
    const eid = emailIdOf(p); if (eid) out.email = emailContext(eid);
    if (p.kind === 'question' && !pl.ask) Object.assign(out, { ask: p.text, approve_label: 'כן, נכון', reject_label: 'לא, לא נכון' });
    if (pl.summary) out.summary = pl.summary;
    if (pl.ask) Object.assign(out, { ask: pl.ask, left: pl.left, right: pl.right, approve_label: pl.approve_label, reject_label: pl.reject_label, suggested_title: pl.suggested_title || null });
    return out;
  };
  const batch = (id) => {
    const b = q('SELECT * FROM proposal_batches WHERE id=?').get(id); if (!b) throw missing('ההצעות לא נמצאו');
    const items = q('SELECT * FROM proposals WHERE batch=? ORDER BY kind, id').all(id).map(withContext).map((it, i, arr) => ({ ...it, seq: i + 1, of: arr.length }));
    const n = (s) => items.filter((x) => x.status === s).length;
    return { ...b, items, open: n('open'), applied: n('applied'), rejected: n('rejected'), failed: n('failed') };
  };

  const note = (actor, taskId, text) => { try { store.addNote(actor, { task: taskId, text }); } catch { /* ignore */ } };
  // apply one proposal now (by the assistant actor so the activity log and undo work as for everything else)
  function applyOne(p) {
    const a = store.assistantId();
    switch (p.kind) {
      case 'task_merge': {
        const keep = store.getTask(p.other_id), dup = store.getTask(p.target_id);
        note(a, keep.id, `מוזגה אליה כפילות: משימה ${dup.id} "${dup.title}" (אושר על ידי הבעלים)`);
        note(a, dup.id, `כפילות של משימה ${keep.id} (אושר על ידי הבעלים)`);
        store.updateTask(a, dup.id, { status: statusId('בוטל') });
        return `נסגרה כפילות ${dup.id} לטובת ${keep.id}`;
      }
      case 'task_close': { note(a, p.target_id, `נסגרה: ${p.reason || 'כבר טופל'} (אושר על ידי הבעלים)`); store.updateTask(a, p.target_id, { status: statusId('הושלם') }); return 'הושלמה'; }
      case 'task_info': case 'task_notours': { note(a, p.target_id, `${p.kind === 'task_info' ? 'לידיעה בלבד, אין פעולה' : 'לא באחריות הצוות'}: ${p.reason || ''} (אושר על ידי הבעלים)`); store.updateTask(a, p.target_id, { status: statusId('בוטל') }); return 'הוסרה מהרשימה'; }
      case 'person_merge': store.mergePerson(a, p.target_id, p.other_id); return 'מוזג';
      case 'person_remove': {
        const person = store.findPerson(p.target_id);
        if (person.role === 'owner' || person.role === 'assistant') throw bad('לא ניתן להסיר את הבעלים או את העוזר');
        try { db.transaction(() => { q("DELETE FROM mentions WHERE entity_type='person' AND entity_id=?").run(person.id); q('DELETE FROM people WHERE id=?').run(person.id); store.logEvent(a, 'person', person.id, 'delete', 'name_he', person.name_he, null, { removed_by_approval: true }); })(); }
        catch (e) { throw bad('האיש בשימוש (משימות, הערות או פרוטוקולים) ולכן לא הוסר'); }
        return 'הוסר';
      }
      case 'filter_add': { const f = JSON.parse(p.payload || '{}'); require('./filters').createFilters({ db, store }).add(store.ownerId(), f); return 'נוסף כלל סינון'; }
      case 'question': { try { require('./feedback').createFeedback({ db, store }).record(store.ownerId(), { item_type: 'email', item_id: p.other_id || p.target_id, verdict: 'up', reason: 'אישור שאלה' }); } catch { /* optional */ } return 'תודה'; }
      case 'bench_question': return 'נרשמה תשובה'; // answers to benchmark questions only record the owner's verdict (read by scripts/bench-jev.js); no side effects
      default: throw bad('סוג הצעה לא מוכר');
    }
  }
  function decide(id, action) {
    const p = q('SELECT * FROM proposals WHERE id=?').get(id); if (!p) throw missing('ההצעה לא נמצאה');
    if (p.status !== 'open') return p;
    if (action === 'reject') {
      q("UPDATE proposals SET status='rejected', decided_at=? WHERE id=?").run(now(), id);
      if (p.kind === 'question') { try { require('./feedback').createFeedback({ db, store }).record(store.ownerId(), { item_type: 'email', item_id: p.other_id || p.target_id, verdict: 'down', reason: 'היה צריך משימה' }); } catch { /* optional */ } }
      return q('SELECT * FROM proposals WHERE id=?').get(id);
    }
    let status = 'applied', result;
    try { result = applyOne(p); } catch (e) { status = 'failed'; result = e.message; }
    q('UPDATE proposals SET status=?, decided_at=?, result=? WHERE id=?').run(status, now(), result, id);
    // approving a downgrade / merge is the owner saying "this should not have been a task": it is feedback too (and may lead to a filter suggestion)
    const reasonOf = { task_info: 'לא משימה', task_notours: 'משימה של מישהו אחר', task_merge: 'כפילות' }[p.kind];
    if (status === 'applied' && reasonOf) { try { require('./feedback').createFeedback({ db, store, proposals: { createBatch } }).record(store.ownerId(), { item_type: 'task', item_id: p.target_id, verdict: 'down', reason: reasonOf }); } catch { /* optional */ } }
    return q('SELECT * FROM proposals WHERE id=?').get(id);
  }
  // approve all open items of the batch (or only the listed ids); a merge target that was already closed by another item is skipped by its own error
  function approveBatch(batchId, ids = null) {
    const open = q("SELECT id FROM proposals WHERE batch=? AND status='open' ORDER BY id").all(batchId).map((r) => r.id).filter((id) => !ids || ids.includes(id));
    return open.map((id) => decide(id, 'approve'));
  }
  return { emailContext, withContext, createBatch, batch, decide, approveBatch, KINDS };
}
module.exports = { createProposals, KINDS };
