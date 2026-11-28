'use strict';
// Reminders (code only, no assistant) and notifications: attention items, a short Hebrew email digest to the owner,
// quiet hours and Shabbat. Email goes only to the owner's address, never to anyone else.
const { now } = require('./db');

const DEFAULTS = { notify_email: '1', notify_telegram: '1', quiet_start: '22:00', quiet_end: '07:00', shabbat: '1', digest_to: require('./config').get().digest_to };
const CFG = require('./config').get();
const siteBase = (db) => require('./config').siteUrl(db);
const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

function jerusalemParts(d = new Date()) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) o[p.type] = p.value;
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday), minutes: +o.hour * 60 + +o.minute, date: `${o.year}-${o.month}-${o.day}` };
}
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

function createNotify(db, store, { sendEmail } = {}) {
  const q = (sql) => db.prepare(sql);
  const get = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? DEFAULTS[k];
  const set = (k, v) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

  function settings() {
    return { notify_email: get('notify_email') === '1', notify_telegram: get('notify_telegram') === '1', quiet_start: get('quiet_start'), quiet_end: get('quiet_end'), shabbat: get('shabbat') === '1', digest_to: get('digest_to') };
  }
  function saveSettings(b) {
    const bool = (v) => (v ? '1' : '0');
    if (b.notify_email !== undefined) set('notify_email', bool(b.notify_email));
    if (b.notify_telegram !== undefined) set('notify_telegram', bool(b.notify_telegram));
    if (b.shabbat !== undefined) set('shabbat', bool(b.shabbat));
    for (const k of ['quiet_start', 'quiet_end']) if (b[k] !== undefined) { if (!/^\d{1,2}:\d{2}$/.test(b[k])) throw new Error('bad time'); set(k, b[k]); }
    return settings();
  }

  // quiet hours (22:00-07:00) and Shabbat (Friday 16:00 to Saturday 20:00), Asia/Jerusalem
  function isQuiet(d = new Date()) {
    const { dow, minutes } = jerusalemParts(d);
    const qs = toMin(get('quiet_start')), qe = toMin(get('quiet_end'));
    if (qs > qe ? (minutes >= qs || minutes < qe) : (minutes >= qs && minutes < qe)) return true;
    if (get('shabbat') === '1') {
      if (dow === 5 && minutes >= 16 * 60) return true;
      if (dow === 6 && minutes < 20 * 60) return true;
    }
    return false;
  }

  function enqueue({ title, body = '', link = null, urgency = 'digest', dedupe = null }) {
    if (dedupe && q("SELECT 1 FROM notifications WHERE dedupe_key=? AND created_at > ?").get(dedupe, new Date(Date.now() - 20 * 3600000).toISOString())) return null;
    return q('INSERT INTO notifications (title, body, link, urgency, dedupe_key, created_at) VALUES (?,?,?,?,?,?)').run(title, body, link, urgency, dedupe, now()).lastInsertRowid;
  }

  const hooks = {}; // hooks.daily: the web push summary of the daily reminders (lib/push.js), set by the runner
  const bossIds = () => store.listPeople().filter((p) => /הממונה/.test(p.notes || '')).map((p) => p.id);

  // code-only daily job: attention items for overdue, stale and due-soon tasks, and a digest of what is urgent
  function runDaily(today = jerusalemParts().date) {
    const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const open = store.listTasks({ open: '1' });
    const stale = new Date(Date.now() - 3 * 86400000).toISOString();
    const make = (kind, t, text) => {
      const key = `${kind}:${t.id}`;
      if (q("SELECT 1 FROM attention WHERE status='open' AND text LIKE ? AND task_id=?").get(`${text.slice(0, 12)}%`, t.id)) return false;
      q('INSERT INTO attention (kind, text, task_id, created_at) VALUES (?,?,?,?)').run('reminder', text, t.id, now());
      void key; return true;
    };
    const lists = { overdue: [], stale: [], soon: [], urgentToday: [] };
    for (const t of open) {
      if (t.due_date && t.due_date < today) { lists.overdue.push(t); make('overdue', t, `באיחור: ${t.title} (יעד ${fmt(t.due_date)})`); }
      else if (t.due_date && (t.due_date === today || t.due_date === tomorrow)) { lists.soon.push(t); make('soon', t, `${t.due_date === today ? 'היום' : 'מחר'} יעד: ${t.title}`); }
      if (t.status === 'בטיפול' && t.updated_at < stale) { lists.stale.push(t); make('stale', t, `ללא התקדמות 3 ימים: ${t.title}`); }
      if (t.priority === 'דחוף' && t.due_date === today) lists.urgentToday.push(t);
    }
    // reminders of tasks that were closed meanwhile are no longer needed
    q("UPDATE attention SET status='dismissed' WHERE status='open' AND kind='reminder' AND task_id IN (SELECT t.id FROM tasks t JOIN statuses s ON s.id=t.status_id WHERE s.is_closed=1)").run();
    if (hooks.daily) { try { hooks.daily({ overdue: lists.overdue, soon: lists.soon, today }); } catch { /* a push must never break the reminders */ } }
    const urgent = [...new Map([...lists.overdue, ...lists.urgentToday].map((t) => [t.id, t])).values()];
    if (urgent.length || lists.soon.length || lists.stale.length) {
      const line = (t) => `• ${t.title}${t.requester ? ' · מאת ' + t.requester : ''}${t.due_date ? ' · עד ' + fmt(t.due_date) : ''}\n  ${siteBase(db)}/task/${t.id}`;
      const parts = [];
      if (lists.overdue.length) parts.push(`באיחור (${lists.overdue.length}):\n` + lists.overdue.slice(0, 8).map(line).join('\n'));
      const soon = lists.soon.filter((t) => !lists.overdue.includes(t));
      if (soon.length) parts.push(`יעד היום או מחר (${soon.length}):\n` + soon.slice(0, 8).map(line).join('\n'));
      if (lists.stale.length) parts.push(`בטיפול בלי התקדמות 3 ימים (${lists.stale.length}):\n` + lists.stale.slice(0, 5).map(line).join('\n'));
      enqueue({ title: 'סיכום בוקר: משימות שדורשות תשומת לב', body: parts.join('\n\n'), link: siteBase(db) + '/', urgency: 'digest', dedupe: `digest:${today}` });
    }
    return { overdue: lists.overdue.length, stale: lists.stale.length, soon: lists.soon.length };
  }

  // a question of the assistant about a boss's request is urgent enough for an immediate email
  function onAttention(row) {
    if (row.kind !== 'question' || !row.task_id) return;
    const t = store.getTask(row.task_id);
    if (t.requester_id && bossIds().includes(t.requester_id)) {
      enqueue({ title: `שאלה של אלכס לגבי בקשה של ${t.requester}`, body: `${row.text}\n\n${t.title}\n${siteBase(db)}/task/${t.id}`, link: `${siteBase(db)}/task/${t.id}`, urgency: 'urgent', dedupe: `q:${row.id}` });
    }
  }

  // send what is waiting, unless it is quiet time; digests wait for the next morning, urgent items for the end of the quiet time
  async function flush(d = new Date()) {
    const s = settings();
    if (!s.notify_email || isQuiet(d)) return 0;
    const rows = q('SELECT * FROM notifications WHERE sent_at IS NULL ORDER BY id').all();
    if (!rows.length) return 0;
    const lastDigest = q("SELECT created_at FROM notifications WHERE urgency='digest' AND sent_at IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    const today = jerusalemParts(d).date;
    const digests = rows.filter((r) => r.urgency === 'digest' && !(lastDigest && jerusalemParts(new Date(lastDigest.created_at)).date === today));
    const urgents = rows.filter((r) => r.urgency === 'urgent');
    const send = [...digests, ...urgents];
    if (!send.length) { q('UPDATE notifications SET sent_at=? WHERE sent_at IS NULL AND urgency=\'digest\'').run(now()); return 0; }
    const subject = urgents.length && !digests.length ? urgents[0].title : (digests[0] ? digests[0].title : urgents[0].title);
    const text = send.map((r) => (send.length > 1 ? `${r.title}\n\n` : '') + r.body).join('\n\n———\n\n') + `\n\nלפתיחת המערכת: ${siteBase(db)}`;
    await sendEmail({ to: s.digest_to, subject, text });
    q(`UPDATE notifications SET sent_at=? WHERE id IN (${rows.map(() => '?').join(',')})`).run(now(), ...rows.map((r) => r.id));
    return send.length;
  }

  return { settings, saveSettings, isQuiet, enqueue, runDaily, onAttention, flush, bossIds, hooks };
}

module.exports = { createNotify, DEFAULTS, jerusalemParts };
