'use strict';
// WEB PUSH to the installed web app (docs/PUSH.md). A second phone channel next to Telegram (Telegram is unchanged and stays the main one).
// Any process may queue a notification (push_queue); the runner delivers the queue every few seconds, a process that has something urgent (health, watchdog) delivers at once.
// Privacy: the payload passes through the browser maker's push service (Google for Chrome on Android), so it carries ONLY a short Hebrew title, one short line and a path on this site.
// Never a mail body, never a long text. The VAPID key pair lives outside the repository (~/.config/mesimot/vapid.json, mode 600) and is never printed or logged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now } = require('./db');

// the categories the owner can switch on and off (Settings). urgency/ttl go to the push service; quiet: false = the caller already decided (the same decision as for Telegram)
const CATS = {
  reminders: { label: 'תזכורות ויעדים', hint: 'משימות להיום ובאיחור, פעם ביום בבוקר', def: true, urgency: 'normal', ttl: 12 * 3600 },
  attention: { label: 'דורש תשומת לב', hint: 'בקשה של ממונה שממתינה, פריטים שאלכס מצא', def: true, urgency: 'normal', ttl: 12 * 3600 },
  waiting: { label: 'אלכס מחכה לתשובה', hint: 'שאלה, אישור מחיקה או אישור שליחת מייל', def: true, urgency: 'high', ttl: 12 * 3600 },
  reply: { label: 'תשובה של אלכס בצ׳אט', hint: 'רק כשהאתר לא פתוח מולך', def: false, urgency: 'high', ttl: 3600 },
  system: { label: 'תקלות במערכת', hint: 'התראה קצרה כשמשהו לא עובד', def: true, urgency: 'high', ttl: 6 * 3600 },
  mail: { label: 'מייל חשוב', hint: 'רק מה שאלכס סימן כדחוף', def: true, urgency: 'high', ttl: 12 * 3600 },
};
const TITLE_MAX = 60, BODY_MAX = 110, URL_MAX = 200, TAG_MAX = 64;
const MAX_ATTEMPTS = 5;
const DEDUPE_MS = 20 * 3600000;
const SEEN_MS = 90 * 1000; // the site counts as open when a visible page reported in the last 90 seconds
const CHAT_HOLD_MS = 15 * 60000;

// next to the database key (~/.config/mesimot/vapid.json; the test instance keeps its own next to its throw-away key)
const keyFile = () => process.env.MESIMOT_VAPID_FILE || path.join(path.dirname(require('./dbkey').keyFile(process.env.MESIMOT_DB)), 'vapid.json');

// one line, short, no control characters (a mail body or a long text can never pass through)
function line(s, max) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...t].length > max ? [...t].slice(0, max - 1).join('').trimEnd() + '…' : t;
}
// a path on this site only (never another host)
function safeUrl(u) {
  let s = String(u || '/');
  try { if (/^https?:\/\//i.test(s)) { const x = new URL(s); s = x.pathname + x.search + x.hash; } } catch { s = '/'; }
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) s = '/';
  return s.slice(0, URL_MAX);
}
const safeTag = (t) => String(t || 'alex').replace(/[^\w:.-]+/g, '-').slice(0, TAG_MAX);
// the Topic header of the push service: at most 32 URL-safe characters; a newer message with the same topic replaces an undelivered older one
const topicOf = (tag) => crypto.createHash('sha256').update(tag).digest('base64url').slice(0, 32);
// the JSON that leaves the server. Nothing else is ever sent.
function payload({ title, body, url, tag, cat }) {
  return JSON.stringify({ t: line(title, TITLE_MAX) || 'Alex Tasks', b: line(body, BODY_MAX), u: safeUrl(url), g: safeTag(tag), c: CATS[cat] ? cat : 'system' });
}
function shortAgent(ua) {
  const s = String(ua || '');
  const os_ = /Android/i.test(s) ? 'Android' : /iPhone|iPad|iPod/i.test(s) ? 'iPhone' : /Windows/i.test(s) ? 'Windows' : /Mac OS/i.test(s) ? 'Mac' : /Linux/i.test(s) ? 'Linux' : 'מכשיר';
  const br = /SamsungBrowser/i.test(s) ? 'Samsung' : /Edg\//i.test(s) ? 'Edge' : /Firefox\//i.test(s) ? 'Firefox' : /Chrome\//i.test(s) ? 'Chrome' : /Safari\//i.test(s) ? 'Safari' : '';
  return (br ? `${br} · ${os_}` : os_).slice(0, 40);
}

function createPush(db, { notify = null, sender = null, keys = null, log = () => {}, siteUrl = null } = {}) {
  const q = (sql) => db.prepare(sql);
  const getSet = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
  const setSet = (k, v) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

  // ---- VAPID keys: created once, kept outside the repository with mode 600
  let vapid = keys;
  function loadKeys() {
    if (vapid) return vapid;
    const f = keyFile();
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.publicKey && j.privateKey) return (vapid = j); } catch { /* not yet */ }
    const k = require('web-push').generateVAPIDKeys();
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(f, JSON.stringify({ publicKey: k.publicKey, privateKey: k.privateKey }) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; return loadKeys(); } // another process created it first: use that one
    return (vapid = k);
  }
  const publicKey = () => loadKeys().publicKey;
  function subject() {
    const c = require('./config').get();
    if (c.push_subject) return String(c.push_subject);
    const site = siteUrl || c.site_url || '';
    return /^https:\/\//.test(site) ? site : 'mailto:push@example.invalid'; // a neutral contact, never the owner's own address
  }
  const send = (sub, body, opts) => (sender || require('web-push').sendNotification)(sub, body, { ...opts, vapidDetails: { subject: subject(), publicKey: loadKeys().publicKey, privateKey: loadKeys().privateKey } });

  // ---- categories (Settings)
  const catOn = (c) => { const v = getSet(`push_cat_${c}`); return v === null ? !!CATS[c]?.def : v === '1'; };
  function settings() { const out = {}; for (const c of Object.keys(CATS)) out[c] = catOn(c); return out; }
  function saveSettings(b = {}) { for (const c of Object.keys(CATS)) if (b[c] !== undefined) setSet(`push_cat_${c}`, b[c] ? '1' : '0'); return settings(); }
  const catalog = () => Object.entries(CATS).map(([id, c]) => ({ id, label: c.label, hint: c.hint, on: catOn(id) }));

  // ---- subscriptions
  function subscribe(sub, ua = '') {
    const ep = String(sub?.endpoint || ''); const k = sub?.keys || {};
    if (!/^https:\/\/[^\s]{10,1000}$/.test(ep)) throw Object.assign(new Error('bad endpoint'), { status: 400 });
    if (!/^[\w-]{20,200}={0,2}$/.test(String(k.p256dh || '')) || !/^[\w-]{8,100}={0,2}$/.test(String(k.auth || ''))) throw Object.assign(new Error('bad keys'), { status: 400 });
    q(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, label=excluded.label, disabled_at=NULL, last_error=NULL, fails=0`).run(ep, k.p256dh, k.auth, shortAgent(ua), now());
    return status(ep);
  }
  function unsubscribe(endpoint) { const r = q('DELETE FROM push_subscriptions WHERE endpoint=?').run(String(endpoint || '')); return { removed: r.changes }; }
  const active = () => q('SELECT * FROM push_subscriptions WHERE disabled_at IS NULL ORDER BY id').all();
  function status(endpoint = null) {
    const me = endpoint ? q('SELECT id, label, created_at, last_ok_at, last_error, disabled_at FROM push_subscriptions WHERE endpoint=?').get(String(endpoint)) : null;
    return { subscribed: !!(me && !me.disabled_at), device: me ? { label: me.label, created_at: me.created_at, last_ok_at: me.last_ok_at, last_error: me.last_error } : null, devices: q('SELECT COUNT(*) n FROM push_subscriptions WHERE disabled_at IS NULL').get().n, categories: catalog() };
  }
  function devices() { return q('SELECT id, label, created_at, last_ok_at, last_error, disabled_at FROM push_subscriptions ORDER BY id').all(); }

  // ---- the site is open: a visible page reports every ~30 s (POST /api/push/seen)
  const seen = (at = Date.now()) => setSet('push_seen_at', new Date(at).toISOString());
  const siteVisible = (at = Date.now()) => { const s = getSet('push_seen_at'); return !!s && at - Date.parse(s) < SEEN_MS; };

  // ---- the queue. dedupe: the same event is queued once (20 hours); tag: the phone shows one notification per item (a newer one replaces it silently)
  function enqueue({ cat, title, body = '', url = '/', tag = null, dedupe = null, ref = null, bypassQuiet = false }, at = Date.now()) {
    if (!CATS[cat]) throw new Error('unknown push category: ' + cat);
    if (!catOn(cat)) return null; // switched off: not even queued
    if (dedupe && q('SELECT 1 FROM push_queue WHERE dedupe_key=? AND created_at > ?').get(dedupe, new Date(at - DEDUPE_MS).toISOString())) return null;
    return q('INSERT INTO push_queue (cat, title, body, url, tag, dedupe_key, ref, bypass_quiet, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(cat, line(title, TITLE_MAX), line(body, BODY_MAX), safeUrl(url), safeTag(tag || dedupe || cat), dedupe, ref, bypassQuiet ? 1 : 0, new Date(at).toISOString()).lastInsertRowid;
  }

  // is the item still waiting? (a question that was answered meanwhile is not pushed any more)
  function stillValid(ref) {
    if (!ref) return true;
    const [kind, idS] = String(ref).split(':'); const id = +idS;
    try {
      if (kind === 'confirm') return q("SELECT 1 FROM confirmations WHERE id=? AND status='open'").get(id) != null;
      if (kind === 'outbox') return q("SELECT 1 FROM outbox WHERE id=? AND status='pending'").get(id) != null;
      if (kind === 'proposal') return q("SELECT 1 FROM proposals WHERE id=? AND status='open'").get(id) != null;
      if (kind === 'attention') return q("SELECT 1 FROM attention WHERE id=? AND status='open'").get(id) != null;
      if (kind === 'task') return q('SELECT 1 FROM tasks t JOIN statuses s ON s.id=t.status_id WHERE t.id=? AND s.is_closed=0').get(id) != null;
      if (kind === 'chat') return q('SELECT 1 FROM chat_messages WHERE id=? AND deleted_at IS NULL').get(id) != null;
    } catch { return true; }
    return true;
  }

  const transient = (e) => { const s = e && e.statusCode; return !s || s === 429 || s >= 500; };
  // deliver what is due. Quiet hours and Shabbat (the same setting as e-mail and Telegram) hold an item until they end, unless the caller already decided it may break them.
  let busy = false;
  async function deliver(at = Date.now()) {
    if (busy) return { sent: 0 }; busy = true;
    const res = { sent: 0, dropped: 0, held: 0, removed: 0, failed: 0 };
    try {
      const nowIso = new Date(at).toISOString();
      const rows = q(`SELECT * FROM push_queue WHERE sent_at IS NULL AND dropped IS NULL AND (next_try_at IS NULL OR next_try_at <= ?) AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY id LIMIT 20`).all(nowIso, new Date(at - 120000).toISOString());
      if (!rows.length) return res;
      const quiet = notify ? notify.isQuiet(new Date(at)) : false;
      const subs = active();
      const drop = (r, why) => { q('UPDATE push_queue SET dropped=?, claimed_at=NULL WHERE id=?').run(why, r.id); res.dropped++; };
      for (const r of rows) {
        const cat = CATS[r.cat] || CATS.system;
        if (at - Date.parse(r.created_at) > cat.ttl * 1000) { drop(r, 'expired'); continue; }
        if (!catOn(r.cat) && r.tag !== 'push-test') { drop(r, 'off'); continue; }
        if (quiet && !r.bypass_quiet) { res.held++; continue; }
        if (!stillValid(r.ref)) { drop(r, 'answered'); continue; }
        if (!subs.length) { drop(r, 'no-devices'); continue; }
        // claim it (a second process delivering at the same moment skips it)
        if (!q('UPDATE push_queue SET claimed_at=? WHERE id=? AND sent_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)').run(nowIso, r.id, new Date(at - 120000).toISOString()).changes) continue;
        const done = new Set(JSON.parse(r.done_subs || '[]'));
        const body = payload(r);
        const left = Math.max(60, cat.ttl - Math.round((at - Date.parse(r.created_at)) / 1000));
        let retry = false;
        for (const s of subs) {
          if (done.has(s.id)) continue;
          try {
            await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: left, urgency: cat.urgency, topic: topicOf(r.tag), timeout: 15000 });
            q('UPDATE push_subscriptions SET last_ok_at=?, last_error=NULL, fails=0 WHERE id=?').run(nowIso, s.id); done.add(s.id);
          } catch (e) {
            const code = e && e.statusCode;
            if (code === 404 || code === 410) { q('DELETE FROM push_subscriptions WHERE id=?').run(s.id); res.removed++; log(`push: a device subscription expired (${code}), removed`); continue; } // the browser dropped it: gone for good
            const msg = `${code || 'network'}: ${line(e && (e.body || e.message), 120)}`;
            q('UPDATE push_subscriptions SET last_error=?, fails=fails+1 WHERE id=?').run(msg, s.id);
            if (transient(e)) retry = true; else done.add(s.id); // 400/401/403/413: retrying the same message will not help
            log(`push: send failed ${msg}`);
          }
        }
        const attempts = (r.attempts || 0) + 1;
        if (retry && attempts < MAX_ATTEMPTS) {
          const wait = Math.min(30 * 2 ** (attempts - 1), 900) * 1000; // 30 s, 1, 2, 4 minutes
          q('UPDATE push_queue SET attempts=?, next_try_at=?, done_subs=?, claimed_at=NULL WHERE id=?').run(attempts, new Date(at + wait).toISOString(), JSON.stringify([...done]), r.id); res.failed++;
        } else if (retry) { q("UPDATE push_queue SET attempts=?, dropped='failed', done_subs=?, claimed_at=NULL WHERE id=?").run(attempts, JSON.stringify([...done]), r.id); res.failed++; }
        else { q('UPDATE push_queue SET attempts=?, sent_at=?, done_subs=?, claimed_at=NULL WHERE id=?').run(attempts, nowIso, JSON.stringify([...done]), r.id); res.sent++; }
      }
      q('DELETE FROM push_queue WHERE created_at < ?').run(new Date(at - 14 * 86400000).toISOString());
    } finally { busy = false; }
    return res;
  }

  // a test notification to every device (Settings button, `mesimot push test`): straight out, not held by quiet hours
  async function test(at = Date.now()) {
    if (!active().length) return { sent: 0, devices: 0 };
    const id = q('INSERT INTO push_queue (cat, title, body, url, tag, bypass_quiet, created_at) VALUES (?,?,?,?,?,1,?)').run('system', 'התראת בדיקה', 'ההתראות מ-Alex Tasks מגיעות למכשיר הזה', '/settings', 'push-test', new Date(at).toISOString()).lastInsertRowid;
    await deliver(at); // the test arrives even when a category is switched off
    const r = q('SELECT sent_at, dropped, attempts FROM push_queue WHERE id=?').get(id);
    return { sent: r.sent_at ? 1 : 0, devices: active().length, retrying: !r.sent_at && !r.dropped, failed: r.dropped === 'failed' };
  }

  // ---- what the assistant is waiting for, and its replies: new rows since the last look (a cursor per source; the backlog before the first look is never pushed)
  const QUESTION_KINDS = "('bench_question','question','project_new','project_pick')";
  function scan(at = Date.now()) {
    let cur = {}; try { cur = JSON.parse(getSet('push_cursor') || '{}'); } catch { /* reset */ }
    const max = (t) => q(`SELECT COALESCE(MAX(id),0) m FROM ${t}`).get().m;
    if (cur.chat === undefined) { cur = { chat: max('chat_messages'), proposals: max('proposals'), attention: max('attention') }; setSet('push_cursor', JSON.stringify(cur)); return { started: true }; }
    const out = { queued: 0 };
    const add = (x) => { if (enqueue(x, at)) out.queued++; };
    const recentOwner = (m) => !!q("SELECT 1 FROM chat_messages WHERE author='owner' AND id < ? AND created_at > ?").get(m.id, new Date(Date.parse(m.created_at) - 10 * 60000).toISOString());
    // chat: approval cards (deletion, outgoing mail) and the assistant's replies. A reply written inside a run that is still working waits for the run (as in Telegram)
    const holdSince = new Date(at - CHAT_HOLD_MS).toISOString();
    for (const m of q("SELECT * FROM chat_messages WHERE id > ? AND author='claude' ORDER BY id LIMIT 50").all(cur.chat)) {
      if (m.run_id && q('SELECT 1 FROM claude_runs WHERE id=? AND finished_at IS NULL AND started_at > ?').get(m.run_id, holdSince)) break; // look again later
      cur.chat = m.id;
      if (m.deleted_at || m.superseded) continue;
      const answer = recentOwner(m); // an answer to what the owner just wrote may break quiet hours, as in Telegram
      if (m.confirm_id) { add({ cat: 'waiting', title: 'אלכס מחכה לתשובה', body: 'אישור לפני מחיקה', url: '/chat', tag: 'waiting', dedupe: `confirm:${m.confirm_id}`, ref: `confirm:${m.confirm_id}`, bypassQuiet: answer }); continue; }
      if (m.outbox_id) { add({ cat: 'waiting', title: 'אלכס מחכה לתשובה', body: 'אישור לפני שליחת מייל', url: '/chat', tag: 'waiting', dedupe: `outbox:${m.outbox_id}`, ref: `outbox:${m.outbox_id}`, bypassQuiet: answer }); continue; }
      if (!answer || m.rich || m.proposal_batch || m.import_id) continue; // what the assistant writes on its own is covered by the other categories
      if (siteVisible(at)) continue; // he is looking at the site: no buzz
      const url = m.scope === 'task' && m.task_id ? `/task/${m.task_id}` : m.scope === 'entity' && m.scope_ref ? refPath(m.scope_ref) : '/chat';
      add({ cat: 'reply', title: 'תשובה מאלכס', body: m.text, url, tag: url === '/chat' ? 'reply' : `reply:${url}`, dedupe: `reply:${m.id}`, ref: `chat:${m.id}`, bypassQuiet: true });
    }
    // questions with answer buttons (the same ones Telegram shows one by one)
    for (const p of q(`SELECT id, kind FROM proposals WHERE id > ? ORDER BY id LIMIT 50`).all(cur.proposals)) {
      cur.proposals = p.id;
      if (!new RegExp(`'${p.kind}'`).test(QUESTION_KINDS)) continue;
      add({ cat: 'waiting', title: 'אלכס מחכה לתשובה', body: /^project_/.test(p.kind) ? 'שאלה על פרויקט' : 'שאלה קצרה', url: '/chat', tag: 'waiting', dedupe: `proposal:${p.id}`, ref: `proposal:${p.id}` });
    }
    // the assistant's open questions and suggestions on the site (the daily reminders have their own summary)
    for (const a of q('SELECT id, kind, task_id FROM attention WHERE id > ? ORDER BY id LIMIT 50').all(cur.attention)) {
      cur.attention = a.id;
      if (a.kind === 'question') add({ cat: 'waiting', title: 'אלכס מחכה לתשובה', body: 'שאלה פתוחה', url: a.task_id ? `/task/${a.task_id}` : '/', tag: 'waiting', dedupe: `attention:${a.id}`, ref: `attention:${a.id}` });
      else if (a.kind === 'suggestion') add({ cat: 'attention', title: 'הצעה מאלכס', body: 'יש פריט חדש בתשומת לב', url: a.task_id ? `/task/${a.task_id}` : '/', tag: a.task_id ? `task:${a.task_id}` : 'attention', dedupe: `attention:${a.id}`, ref: `attention:${a.id}` });
    }
    setSet('push_cursor', JSON.stringify(cur));
    return out;
  }
  const refPath = (ref) => { const [k, id] = String(ref).split(':'); return { project: `/projects/${id}`, protocol: `/protocols/${id}`, email: `/email/${id}`, day: '/calendar' }[k] || '/chat'; };

  // ---- hooks called by the code that already decides what to tell the owner (the same places that feed e-mail and Telegram)
  function daily({ overdue = [], soon = [], today }) {
    const dueToday = soon.filter((t) => t.due_date === today);
    const n = overdue.length + dueToday.length; if (!n) return null;
    const parts = []; if (overdue.length) parts.push(`${overdue.length} באיחור`); if (dueToday.length) parts.push(`${dueToday.length} ליעד היום`);
    const one = n === 1 ? (overdue[0] || dueToday[0]) : null;
    return enqueue({ cat: 'reminders', title: one ? (overdue.length ? 'משימה באיחור' : 'יעד היום') : `תזכורת: ${parts.join(', ')}`, body: one ? one.title : [...overdue, ...dueToday].slice(0, 2).map((t) => t.title).join(' · '), url: one ? `/task/${one.id}` : '/', tag: 'daily', dedupe: `daily:${today}` });
  }
  function attentionItems(items, day) { // the daytime pulse found something (the assistant decided it is worth a message)
    const top = items[0]; if (!top) return null;
    const url = top.task ? `/task/${top.task}` : safeUrl(top.link || '/');
    return enqueue({ cat: 'attention', title: items.length > 1 ? `דורש תשומת לב (${items.length})` : 'דורש תשומת לב', body: { boss: 'בקשה של ממונה ממתינה', due_today: 'יעד היום', waiting: 'אין תשובה כבר כמה ימים', overdue: 'משימה באיחור', question: 'שאלה פתוחה של אלכס', meetings: 'הפגישות של היום' }[top.kind] || 'פריט חדש', url, tag: 'attention', dedupe: `pulse:${day}:${items.map((i) => i.key).join(',')}`.slice(0, 300) });
  }
  function urgentMail(list) { // a live e-mail the importer marked urgent (a boss, due today or tomorrow, a direct question)
    const u = list[0]; if (!u) return null;
    return enqueue({ cat: 'mail', title: list.length > 1 ? `מייל חשוב (${list.length})` : 'מייל חשוב', body: `${u.why}: ${u.task.title}`, url: list.length > 1 ? '/' : `/task/${u.task.id}`, tag: list.length > 1 ? 'mail' : `task:${u.task.id}`, dedupe: `mail:${list.map((x) => x.task.id).join(',')}`, ref: list.length > 1 ? null : `task:${u.task.id}` });
  }
  function system(text, { bypassQuiet = true } = {}) { // a health or watchdog alert: the first line only, the caller already applied the quiet-hours rule
    const first = String(text || '').split('\n'); const recovered = /^✅/.test(first[0]);
    const clean = (s) => String(s || '').replace(/^[⚠️✅\s]+/u, '');
    return enqueue({ cat: 'system', title: recovered ? 'חזר לפעול' : 'תקלה במערכת', body: clean(first.length > 1 ? first[0] + ' ' + first[1] : first[0]).replace(/^(עדיין )?תקלה במערכת Alex Tasks:\s*/, '').replace(/^חזר לפעול:\s*/, ''), url: '/settings', tag: 'system', dedupe: `sys:${crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}:${Math.floor(Date.now() / 3600000)}`, bypassQuiet });
  }

  return { CATS, publicKey, subscribe, unsubscribe, status, devices, active, settings, saveSettings, catalog, seen, siteVisible, enqueue, deliver, test, scan, daily, attentionItems, urgentMail, system, stillValid, loadKeys };
}

module.exports = { createPush, CATS, payload, line, safeUrl, safeTag, topicOf, shortAgent, keyFile, TITLE_MAX, BODY_MAX };
