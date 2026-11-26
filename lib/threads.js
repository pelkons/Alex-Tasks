'use strict';
// Email threads: a normalized subject key plus project numbers, and the tasks linked to the emails of a thread.
const { now } = require('./db');
const { missing } = require('./store');

const PREFIX = /^\s*(?:(?:fw|fwd|re|sv|aw)\s*:|השב\s*:|הועבר\s*:|העבר\s*:|תשובה\s*:|תגובה\s*:|הודעה שהועברה\s*:?)\s*/i;
const NUMBER = /\b\d{3}\.\d{3,5}\b/g; // project numbers such as 100.2000

function normalizeSubject(subject) {
  let s = String(subject || '').replace(/[‎‏‪-‮]/g, '').trim();
  for (let i = 0; i < 8 && PREFIX.test(s); i++) s = s.replace(PREFIX, '').trim();
  return s.replace(/\s+/g, ' ').toLowerCase();
}

function threadInfo(...subjects) {
  const key = normalizeSubject(subjects.find((x) => x && String(x).trim()) || '');
  const numbers = [...new Set(subjects.flatMap((x) => String(x || '').match(NUMBER) || []))];
  return { key, numbers, thread_key: key + numbers.map((n) => ' #' + n).join('') };
}

const RELATIONS = ['created', 'updated', 'closed', 'info'];

function createThreads(db, store, knowledge) {
  const q = (sql) => db.prepare(sql);
  const ownerAddrs = () => {
    const out = new Set();
    for (const p of store.listPeople()) if (p.role === 'owner') p.emails.forEach((e) => out.add(e.toLowerCase()));
    return out;
  };
  const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

  function setKeysLocal(emailId) {
    const e = q('SELECT subject, original_subject FROM emails WHERE id=?').get(emailId);
    if (!e) return;
    const t = threadInfo(e.original_subject, e.subject);
    q('UPDATE emails SET thread_key=?, project_numbers=? WHERE id=?').run(t.key, JSON.stringify(t.numbers), emailId);
  }

  const emailDate = 'COALESCE(e.forwarded_date, e.received_at)';

  // emails of the same thread (same subject key or a shared project number), newest first, with their tasks
  function relatedEmails(emailId) {
    const e = q('SELECT thread_key, project_numbers FROM emails WHERE id=?').get(emailId);
    if (!e) throw missing('הדוא״ל לא נמצא');
    const nums = parse(e.project_numbers);
    const rows = q(`SELECT e.id, e.subject, COALESCE(e.original_subject, e.subject) AS title, e.forwarded_from AS from_sender, ${emailDate} AS date, e.thread_key, e.project_numbers
      FROM emails e WHERE e.id <> ? ORDER BY ${emailDate} DESC`).all(emailId).filter((r) => (e.thread_key && r.thread_key === e.thread_key) || parse(r.project_numbers).some((n) => nums.includes(n))); // an empty subject key is never a link
    return rows.map((r) => ({ id: r.id, subject: r.title, from: r.from_sender, date: r.date, same_subject: !!e.thread_key && r.thread_key === e.thread_key,
      tasks: q(`SELECT t.id, t.title, s.name_he AS status, te.relation, t.due_date FROM task_emails te JOIN tasks t ON t.id=te.task_id JOIN statuses s ON s.id=t.status_id WHERE te.email_id=?`).all(r.id) }));
  }

  // open tasks that a new email may continue, advance or close, with the reason
  function candidateTasks(emailId) {
    const em = q('SELECT * FROM emails WHERE id=?').get(emailId);
    if (!em) throw missing('הדוא״ל לא נמצא');
    const nums = parse(em.project_numbers);
    const owner = ownerAddrs();
    const mine = new Set(parse(em.participants).map((p) => (p.email || '').toLowerCase()).filter((x) => x && !owner.has(x)));
    const out = new Map();
    const add = (t, reason, rank) => { const c = out.get(t.id); if (!c) out.set(t.id, { id: t.id, title: t.title, status: t.status, due_date: t.due_date, project: t.project, reasons: [reason], rank }); else { c.reasons.push(reason); c.rank = Math.min(c.rank, rank); } };
    const open = store.listTasks({ open: '1' });
    const byId = new Map(open.map((t) => [t.id, t]));
    for (const r of relatedEmails(emailId)) for (const t of r.tasks) if (byId.has(t.id)) add(byId.get(t.id), r.same_subject ? `linked to an earlier email of the same thread (email ${r.id})` : `linked to an email with the same project number (email ${r.id})`, r.same_subject ? 1 : 2);
    for (const t of open) {
      if (nums.some((n) => t.title.includes(n) || (t.description || '').includes(n))) add(t, 'project number in the task text', 2);
      const linked = q('SELECT e.participants FROM task_emails te JOIN emails e ON e.id=te.email_id WHERE te.task_id=?').all(t.id);
      const theirs = new Set(linked.flatMap((x) => parse(x.participants)).map((p) => (p.email || '').toLowerCase()).filter((x) => x && !owner.has(x)));
      const overlap = [...mine].filter((x) => theirs.has(x));
      if (overlap.length >= 2) add(t, `shares ${overlap.length} participants with the task's emails`, 3);
    }
    return [...out.values()].sort((a, b) => a.rank - b.rank || b.id - a.id).slice(0, 8);
  }

  function emailThread(emailId) {
    const e = knowledge.emailShow(emailId);
    return { email: { id: e.id, subject: e.original_subject || e.subject, from: e.forwarded_from, date: e.forwarded_date, thread_key: e.thread_key, project_numbers: parse(e.project_numbers),
      tasks: q(`SELECT t.id, t.title, s.name_he AS status, te.relation FROM task_emails te JOIN tasks t ON t.id=te.task_id JOIN statuses s ON s.id=t.status_id WHERE te.email_id=?`).all(emailId) },
      related: relatedEmails(emailId), candidate_open_tasks: candidateTasks(emailId) };
  }

  function emailGist(row) {
    const { parseForwarded } = require('./forward');
    try {
      const p = parseForwarded(row.body_text, row.subject);
      const line = (p.forwarded ? p.body : row.body_text).split('\n').map((x) => x.trim()).find((x) => x.length > 12 && !/^(\[|cid:|https?:)/i.test(x)) || '';
      return line.length > 160 ? line.slice(0, 160) + '…' : line;
    } catch { return ''; }
  }

  // the correspondence of one task: every linked email, newest first, one line each
  function taskCorrespondence(taskId) {
    const { parseForwarded } = require('./forward');
    return q(`SELECT te.relation, te.created_at AS linked_at, e.id, COALESCE(e.original_subject, e.subject) AS subject, e.forwarded_from AS from_sender, ${emailDate} AS date, e.body_text, e.thread
      FROM task_emails te JOIN emails e ON e.id=te.email_id WHERE te.task_id=? ORDER BY ${emailDate} DESC`).all(taskId).map((r) => {
      let line = '';
      try { const p = parseForwarded(r.body_text, r.subject); line = (p.forwarded ? p.body : r.body_text).split('\n').map((x) => x.trim()).find((x) => x.length > 12 && !/^(\[|cid:|https?:)/i.test(x)) || ''; } catch { /* ignore */ }
      const th = parse(r.thread)[0];
      const owner = th?.from_email && store.listPeople().find((pp) => pp.emails.map((e) => e.toLowerCase()).includes(th.from_email.toLowerCase()));
      const files = q('SELECT id, original_name AS name, mime, summary, project_id, facts_checked, (SELECT COUNT(*) FROM chunks WHERE file_id=files.id) AS chunks FROM files WHERE email_id=? ORDER BY id').all(r.id);
      return { files, from_name: owner ? owner.name_he : null, email_id: r.id, relation: r.relation, subject: r.subject, from: r.from_sender, from_email: th?.from_email || null, date: r.date, summary: line.length > 150 ? line.slice(0, 150) + '…' : line };
    });
  }

  return { emailGist, threadInfo, setKeys: setKeysLocal, linkTaskEmail: store.linkTaskEmail, relatedEmails, candidateTasks, emailThread, taskCorrespondence, RELATIONS };
}

// usable without a store (intake code)
function setKeys(db, emailId) {
  const e = db.prepare('SELECT subject, original_subject FROM emails WHERE id=?').get(emailId);
  if (!e) return;
  const t = threadInfo(e.original_subject, e.subject);
  db.prepare('UPDATE emails SET thread_key=?, project_numbers=? WHERE id=?').run(t.key, JSON.stringify(t.numbers), emailId);
}

module.exports = { setKeys, createThreads, threadInfo, normalizeSubject, RELATIONS };
