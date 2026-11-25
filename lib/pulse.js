'use strict';
// Daytime pulse, step A (code only): finds what needs the owner's attention right now. Step B (the assistant, in the runner)
// only runs when something is found. Every item is reported at most once a day (table pulse_log).
const { now } = require('./db');
const { todayIL } = require('./store');

const siteBase = (db) => require('./config').siteUrl(db);
const H = 3600000;
const MAX_ITEMS = 12;
const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

// working days in Israel are Sunday to Thursday: whole working days between two moments
function workingDaysBetween(fromMs, toMs) {
  let n = 0;
  const d = new Date(fromMs);
  d.setUTCHours(12, 0, 0, 0);
  const end = new Date(toMs); end.setUTCHours(12, 0, 0, 0);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 5 && dow !== 6) n++;
  }
  return n;
}

function createPulse(db, store, notify) {
  const q = (sql) => db.prepare(sql);
  const owner = () => store.ownerId();
  const iso = (ms) => new Date(ms).toISOString();

  // ---- the rules
  function collect(at = new Date()) {
    const t = at.getTime();
    const today = todayIL(at);
    const bosses = notify.bossIds();
    const bossName = (id) => store.listPeople().find((p) => p.id === id)?.name_he;
    const items = [];
    const open = store.listTasks({ open: '1' });
    const ownerActed = (taskId, since) => !!q("SELECT 1 FROM events WHERE actor_id=? AND entity='task' AND entity_id=? AND created_at > ? AND action <> 'create' LIMIT 1").get(owner(), taskId, since)
      || !!q('SELECT 1 FROM notes WHERE task_id=? AND author_id=? AND created_at > ? LIMIT 1').get(taskId, owner(), since);

    // 1. a boss is waiting: a task of his, or an email of his, for more than 24 hours with no action by the owner
    for (const tk of open) {
      if (!tk.requester_id || !bosses.includes(tk.requester_id)) continue;
      const since = tk.source_date || tk.created_at;
      if (t - Date.parse(since) < 24 * H) continue;
      if (ownerActed(tk.id, since)) continue;
      items.push({ key: `boss_task:${tk.id}`, kind: 'boss', prio: 1, task: tk.id, text: `בקשה של ${tk.requester} ממתינה מעל 24 שעות בלי פעולה שלך: "${tk.title}" (${tk.status}${tk.due_date ? ', יעד ' + fmt(tk.due_date) : ''})`, link: `${siteBase(db)}/task/${tk.id}` });
    }
    const bossAddrs = new Map();
    for (const p of store.listPeople()) if (bosses.includes(p.id)) for (const e of p.emails) bossAddrs.set(e.toLowerCase(), p.name_he);
    const since14 = iso(t - 14 * 86400000);
    for (const e of q("SELECT * FROM emails WHERE COALESCE(forwarded_date, received_at) >= ? ORDER BY id DESC LIMIT 200").all(since14)) {
      const sender = String(e.forwarded_from || e.from_addr || '');
      const addr = (/<([^>]+)>/.exec(sender)?.[1] || sender).trim().toLowerCase();
      const who = bossAddrs.get(addr);
      if (!who) continue;
      const date = e.forwarded_date || e.received_at;
      if (t - Date.parse(date) < 24 * H) continue;
      if (q('SELECT 1 FROM task_emails WHERE email_id=?').get(e.id)) continue; // a linked task is reported by the rule above
      if (db.prepare("SELECT 1 FROM events WHERE actor_id=? AND created_at > ? AND entity IN ('chat','email') LIMIT 1").get(owner(), date)) continue;
      items.push({ key: `boss_email:${e.id}`, kind: 'boss', prio: 1, text: `מייל של ${who} מעל 24 שעות בלי טיפול: "${e.original_subject || e.subject}"`, link: `${siteBase(db)}/email/${e.id}` });
    }
    // 2. due today and not done
    for (const tk of open) if (tk.due_date === today) items.push({ key: `due_today:${tk.id}`, kind: 'due_today', prio: 2, task: tk.id, text: `יעד היום: "${tk.title}" (${tk.status}${tk.requester ? ', מאת ' + tk.requester : ''})`, link: `${siteBase(db)}/task/${tk.id}` });
    // 3. waiting (ממתין) with no linked email or note for more than 3 working days
    for (const tk of open) {
      if (tk.status !== 'ממתין') continue;
      const stamps = [tk.created_at];
      const n = q('SELECT MAX(created_at) m FROM notes WHERE task_id=?').get(tk.id).m; if (n) stamps.push(n);
      const em = q('SELECT MAX(created_at) m FROM task_emails WHERE task_id=?').get(tk.id).m; if (em) stamps.push(em);
      const st = q("SELECT MAX(created_at) m FROM events WHERE entity='task' AND entity_id=? AND field='status' AND new_value='ממתין'").get(tk.id).m; if (st) stamps.push(st);
      const last = Math.max(...stamps.map(Date.parse));
      const days = workingDaysBetween(last, t);
      if (days <= 3) continue;
      const waitingOn = (tk.assignee && tk.assignee_id !== owner() && tk.assignee) || tk.requester || 'הגורם הרלוונטי';
      items.push({ key: `waiting:${tk.id}`, kind: 'waiting', prio: 3, task: tk.id, text: `אין תשובה מ${waitingOn} כבר ${days} ימי עבודה: "${tk.title}"`, link: `${siteBase(db)}/task/${tk.id}` });
    }
    // 4. overdue
    for (const tk of open) if (tk.due_date && tk.due_date < today) items.push({ key: `overdue:${tk.id}`, kind: 'overdue', prio: 4, task: tk.id, text: `באיחור מאז ${fmt(tk.due_date)}: "${tk.title}" (${tk.status})`, link: `${siteBase(db)}/task/${tk.id}` });
    // 5. questions of the assistant that the owner has not answered for more than 24 hours
    for (const a of q("SELECT * FROM attention WHERE status='open' AND kind='question' AND created_at < ?").all(iso(t - 24 * H))) {
      items.push({ key: `question:${a.id}`, kind: 'question', prio: 5, task: a.task_id || undefined, text: `שאלה פתוחה של אלכס (מעל 24 שעות): ${a.text}`, link: a.task_id ? `${siteBase(db)}/task/${a.task_id}` : siteBase(db) + '/' });
    }
    return items.sort((a, b) => a.prio - b.prio);
  }

  // what is new today (each key is reported at most once a day)
  function fresh(items, at = new Date()) {
    const day = todayIL(at);
    return items.filter((i) => !q('SELECT 1 FROM pulse_log WHERE day=? AND item_key=?').get(day, i.key)).slice(0, MAX_ITEMS);
  }
  function markReported(items, at = new Date()) {
    const day = todayIL(at);
    const ins = q('INSERT OR IGNORE INTO pulse_log (day, item_key, at) VALUES (?,?,?)');
    db.transaction(() => { for (const i of items) ins.run(day, i.key, now()); })();
    q('DELETE FROM pulse_log WHERE day < ?').run(todayIL(new Date(at.getTime() - 10 * 86400000)));
  }

  // the block injected into the assistant's prompt
  function render(items) {
    return items.map((i, n) => `${n + 1}. [${i.kind}] ${i.text}\n   ${i.link}`).join('\n');
  }

  // a pulse only runs on working days, in the daytime, outside quiet hours and Shabbat
  function allowed(at = new Date()) {
    if (notify.isQuiet(at)) return { ok: false, why: 'quiet' };
    const { dow, minutes } = require('./notify').jerusalemParts(at);
    if (dow === 5 || dow === 6) return { ok: false, why: 'weekend' };
    if (minutes < 8 * 60 - 5 || minutes > 18 * 60 + 5) return { ok: false, why: 'night' };
    return { ok: true };
  }

  return { collect, fresh, markReported, render, allowed, workingDaysBetween };
}

module.exports = { createPulse, workingDaysBetween };
