'use strict';
// The "דואר" tab: every email in the system (live Outlook mail, forwarded mail, imported files, the archive of old mail; inbox and sent) in one list.
// Read-only and fast: keyset pagination on the date (covering indexes, no OFFSET, no full scan of the bodies), short reads only (the archive worker is writing to the same database),
// conversations by `thread_key`, and search through the existing hybrid search (keyword + semantic, attachment text, the archive index).
const { bad, missing } = require('./store');
const { readable } = require('./textclean');
const { now } = require('./db');

const DATE = 'COALESCE(e.forwarded_date, e.received_at)';           // the date of a mail (the original date for forwarded mail), the same expression as the indexes
const MAX_PAGE = 100, DEFAULT_PAGE = 40, MAX_SEARCH = 100, MAX_THREAD = 200;
// real attachments only: not the raw .msg of the mail itself, not a picture of the signature that sits inside the body
const HAS_FILES = `EXISTS (SELECT 1 FROM files f WHERE f.email_id = e.id AND f.id <> COALESCE(e.file_id, 0) AND NOT (COALESCE(f.mime,'') LIKE 'image/%' AND EXISTS (SELECT 1 FROM email_inline i WHERE i.email_id = e.id AND i.name = f.original_name)))`;
const IS_LINKED = 'EXISTS (SELECT 1 FROM task_emails te WHERE te.email_id = e.id)';

const enc = (d, id) => Buffer.from(`${d}|${id}`).toString('base64url');
function dec(c) {
  if (!c) return null;
  const s = Buffer.from(String(c), 'base64url').toString(); const i = s.lastIndexOf('|');
  const id = +s.slice(i + 1);
  if (i < 0 || !Number.isInteger(id)) throw bad('מצביע עמוד לא תקין');
  return { d: s.slice(0, i), id };
}
const parseJson = (s, d = []) => { try { return JSON.parse(s || ''); } catch { return d; } };
const dayStart = (d) => `${d}T00:00:00.000Z`, dayEnd = (d) => `${d}T23:59:59.999Z`;
const okDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function createMailList({ db, store, searcher, semantic }) {
  const q = (sql) => db.prepare(sql);
  const people = () => q('SELECT id, name_he, emails, role FROM people').all().map((p) => ({ id: p.id, name: p.name_he, role: p.role, emails: parseJson(p.emails).map((e) => String(e).toLowerCase()) }));

  // ---- display names: "Moshe <m@x.co>" is shown with the Hebrew name of the person who owns the address
  function nameResolver() {
    const byEmail = new Map();
    for (const p of people()) for (const e of p.emails) byEmail.set(e, p.name);
    const split = (s) => { const out = []; let cur = '', depth = 0; for (const ch of String(s || '')) { if (ch === '<') depth++; if (ch === '>') depth = Math.max(0, depth - 1); if ((ch === ',' || ch === ';') && !depth) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
    const one = (raw) => {
      let t = String(raw || '').trim().replace(/^(cc|bcc|to)\s*:\s*/i, ''); if (!t) return null;
      const em = (/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/.exec(t) || [])[0];
      const name = t.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
      if (em && byEmail.has(em.toLowerCase())) return byEmail.get(em.toLowerCase());
      return name && !/@/.test(name) ? name : (em || name || null);
    };
    return { one, many: (s) => split(s).map(one).filter(Boolean) };
  }

  // ---- filters (one builder for the list, the thread's sibling check and the post-filter of search results)
  function filterSql(f, a = 'e') {
    const w = [`${a}.dup_of IS NULL`, `COALESCE(${a}.import_state,'') <> 'container'`], args = [];
    const D = DATE.replace(/e\./g, a + '.');
    if (f.archive === 'only') w.push(`${a}.archived = 1`); else if (f.archive === '0') w.push(`${a}.archived = 0`);
    if (f.folder === 'out') w.push(`${a}.direction = 'sent'`); else if (f.folder === 'in') w.push(`(${a}.direction IS NULL OR ${a}.direction <> 'sent')`);
    if (f.projectId) { w.push(`${a}.project_id = ?`); args.push(f.projectId); }
    if (f.from) { w.push(`${D} >= ?`); args.push(dayStart(f.from)); }
    if (f.to) { w.push(`${D} <= ?`); args.push(dayEnd(f.to)); }
    if (f.noise === '0') w.push(`COALESCE(${a}.import_state,'') <> 'noise'`);
    if (f.person && f.person.length) { w.push('(' + f.person.map(() => `(instr(lower(${a}.from_addr), ?) > 0 OR instr(lower(${a}.to_addr), ?) > 0 OR instr(lower(COALESCE(${a}.forwarded_from,'')), ?) > 0)`).join(' OR ') + ')'); for (const p of f.person) args.push(p, p, p); }
    const has = (sql) => sql.replace(/\be\./g, a + '.');
    if (f.att === '1') w.push(has(HAS_FILES));
    if (f.linked === '1') w.push(has(IS_LINKED)); else if (f.linked === '0') w.push('NOT ' + has(IS_LINKED));
    return { where: w.join(' AND '), args };
  }
  function parseFilters(p = {}) {
    const f = {
      folder: ['in', 'out'].includes(p.folder) ? p.folder : 'all', archive: p.archive === '0' ? '0' : p.archive === 'only' ? 'only' : '1',
      att: p.att === '1' ? '1' : '', linked: p.linked === '1' ? '1' : p.linked === '0' ? '0' : '', noise: p.noise === '0' ? '0' : '',
      from: okDay(p.from) ? p.from : null, to: okDay(p.to) ? p.to : null, projectId: null, person: null,
    };
    if (p.project) {
      try { f.projectId = store.findProject(String(p.project)).id; } catch { throw bad(`פרויקט לא נמצא: ${p.project}`); }
    }
    if (p.person) {
      const s = String(p.person).trim().toLowerCase();
      if (/^\d+$/.test(s)) { const pe = people().find((x) => x.id === +s); if (!pe) throw bad('האדם לא נמצא'); f.person = pe.emails.length ? pe.emails.slice(0, 8) : [pe.name.toLowerCase()]; f.personName = pe.name; }
      else if (s.length >= 2) f.person = [s.slice(0, 80)];
    }
    return f;
  }

  // ---- rows
  const proj = q('SELECT id, name_he, color, is_default FROM projects');
  function projectMap() { return new Map(proj.all().map((p) => [p.id, p])); }
  const COLS = `e.id, e.subject, e.original_subject, e.from_addr, e.to_addr, e.forwarded_from, e.direction, e.archived, e.text_only, e.project_id, e.thread_key, e.received_at, e.import_state, e.noise_reason, ${DATE} AS date`;
  function snippetOf(body) {
    const t = readable(String(body || '').slice(0, 2500), { max: 1200 }).replace(/\s+/g, ' ').replace(/https?:\/\/\S+/g, '').trim();
    return t.length > 160 ? t.slice(0, 160) + '…' : t;
  }
  function decorate(rows, { since = null, hits = null, counts = null } = {}) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id), ph = ids.map(() => '?').join(',');
    const bodies = new Map(q(`SELECT id, substr(body_text, 1, 2500) b FROM emails WHERE id IN (${ph})`).all(...ids).map((r) => [r.id, r.b]));
    const files = new Set(q(`SELECT e.id FROM emails e WHERE e.id IN (${ph}) AND ${HAS_FILES}`).all(...ids).map((r) => r.id));
    const tasks = new Map();
    for (const t of q(`SELECT te.email_id, t.id, t.title, s.is_closed FROM task_emails te JOIN tasks t ON t.id = te.task_id JOIN statuses s ON s.id = t.status_id WHERE te.email_id IN (${ph}) UNION SELECT t.source_email_id, t.id, t.title, s.is_closed FROM tasks t JOIN statuses s ON s.id = t.status_id WHERE t.source_email_id IN (${ph})`).all(...ids, ...ids)
      .sort((x, y) => x.is_closed - y.is_closed || y.id - x.id)) { const cur = tasks.get(t.email_id) || []; if (!cur.some((c) => c.id === t.id)) cur.push({ id: t.id, title: t.title, closed: !!t.is_closed }); tasks.set(t.email_id, cur); }
    const pm = projectMap(), nm = nameResolver();
    return rows.map((r) => {
      const sent = r.direction === 'sent', p = r.project_id ? pm.get(r.project_id) : null, tk = tasks.get(r.id) || [];
      const hit = hits && hits.get(r.id);
      return {
        id: r.id, thread_key: r.thread_key || null, direction: sent ? 'sent' : 'received', archived: !!r.archived, text_only: !!r.text_only,
        subject: (r.original_subject || r.subject || '').trim() || '(ללא נושא)',
        from: nm.one(r.forwarded_from || r.from_addr) || '', to: nm.many(r.to_addr).slice(0, 4), to_more: Math.max(0, nm.many(r.to_addr).length - 4),
        snippet: hit ? hit.snippet : snippetOf(bodies.get(r.id)), snippet_html: hit ? hit.html : null, via: hit ? hit.via : null, via_name: hit ? hit.via_name : null,
        date: r.date, project_id: r.project_id || null, project: p ? p.name_he : null, project_color: p ? p.color : null, project_default: p ? !!p.is_default : false,
        has_files: files.has(r.id), task: tk[0] || null, tasks_n: tk.length, auto: r.import_state === 'noise',
        count: counts ? (counts.get(r.id) || 1) : 1,
        is_new: !!since && !r.archived && !sent && String(r.received_at || '') > since,
      };
    });
  }

  // ---- the list. mode 'threads': one row per conversation (its newest matching mail) + the count; mode 'all': one row per mail. Keyset pagination on (date, id).
  async function list(params = {}) {
    const f = parseFilters(params);
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || DEFAULT_PAGE, 1), MAX_PAGE);
    const cur = dec(params.before);
    const since = params.since ? String(params.since) : null;
    const text = String(params.q || '').trim();
    if (text) return searchAsync(text, f, params, since);
    const { where, args } = filterSql(f);
    const sub = filterSql(f, 'x');
    const threaded = params.mode !== 'all';
    const conds = [where]; const a = [...args];
    if (cur) { conds.push(`(${DATE} < ? OR (${DATE} = ? AND e.id < ?))`); a.push(cur.d, cur.d, cur.id); }
    // a conversation is represented by its newest mail among those that match the filters (a mail without a subject is a conversation of its own)
    if (threaded) conds.push(`(e.thread_key IS NULL OR e.thread_key = '' OR e.id = (SELECT x.id FROM emails x WHERE x.thread_key = e.thread_key AND ${sub.where} ORDER BY COALESCE(x.forwarded_date, x.received_at) DESC, x.id DESC LIMIT 1))`), a.push(...sub.args);
    const rows = q(`SELECT ${COLS} FROM emails e WHERE ${conds.join(' AND ')} ORDER BY ${DATE} DESC, e.id DESC LIMIT ?`).all(...a, limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    let counts = null;
    if (threaded) {
      counts = new Map();
      const cq = q(`SELECT COUNT(*) n FROM emails e WHERE e.thread_key = ? AND ${where}`);
      for (const r of rows) if (r.thread_key) counts.set(r.id, cq.get(r.thread_key, ...args).n);
    }
    const out = { mode: threaded ? 'threads' : 'all', items: decorate(rows, { since, counts }), next: more ? enc(rows[rows.length - 1].date, rows[rows.length - 1].id) : null };
    if (!cur) out.total = q(`SELECT COUNT(*) n FROM emails e WHERE ${where}`).get(...args).n;
    if (!cur && since) out.new_count = q(`SELECT COUNT(*) n FROM emails e WHERE ${where} AND e.archived = 0 AND (e.direction IS NULL OR e.direction <> 'sent') AND e.received_at > ?`).get(...args, since).n;
    return out;
  }

  // ---- search: the existing hybrid search over emails, attachment text and the archive index, then the same filters on the mails found
  async function searchAsync(text, f, params, since) {
    if ([...text].length < 3) throw bad('יש להזין לפחות שלוש אותיות לחיפוש');
    const sp = { q: text, limit: MAX_SEARCH, kind: 'email,chunk,file', mail_archive: f.archive === '0' ? '0' : f.archive === 'only' ? 'only' : '1' };
    if (f.projectId) sp.project = f.projectId;
    if (f.from) sp.from = f.from; if (f.to) sp.to = f.to;
    const res = await searcher.searchHybrid(sp, semantic);
    const order = [], hits = new Map();
    const fileEmail = q('SELECT email_id FROM files WHERE id = ?'), chunkEmail = q('SELECT f.email_id, f.original_name FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id = ?'), fileName = q('SELECT original_name FROM files WHERE id = ?');
    for (const r of res.results) {
      let id = null, via = 'email', name = null;
      if (r.kind === 'email') id = r.id;
      else if (r.kind === 'chunk') { const c = chunkEmail.get(r.id); id = c ? c.email_id : null; name = c ? c.original_name : null; via = 'attachment'; }
      else if (r.kind === 'file') { id = (fileEmail.get(r.id) || {}).email_id; name = (fileName.get(r.id) || {}).original_name; via = 'attachment'; }
      if (!id || hits.has(id)) continue;
      hits.set(id, { snippet: String(r.snippet || '').replace(/[«»]/g, ''), html: r.html, via, via_name: name });
      order.push(id);
    }
    let rows = [];
    if (order.length) {
      const { where, args } = filterSql(f);
      rows = q(`SELECT ${COLS} FROM emails e WHERE e.id IN (${order.map(() => '?').join(',')}) AND ${where}`).all(...order, ...args);
    }
    const pos = new Map(order.map((id, i) => [id, i]));
    rows.sort((x, y) => pos.get(x.id) - pos.get(y.id));
    const items = decorate(rows, { since, hits });
    return { mode: 'search', query: text, items, next: null, total: items.length, capped: res.results.length >= MAX_SEARCH, semantic: res.semantic || null };
  }

  // ---- one conversation: the mail's siblings (same thread key), newest first
  function thread(id, params = {}) {
    const e = q('SELECT id, thread_key FROM emails WHERE id = ?').get(id);
    if (!e) throw missing('הדוא״ל לא נמצא');
    const f = parseFilters({ archive: params.archive === '0' ? '0' : '1' });
    const { where, args } = filterSql(f);
    const rows = e.thread_key
      ? q(`SELECT ${COLS} FROM emails e WHERE e.thread_key = ? AND ${where} ORDER BY ${DATE} DESC, e.id DESC LIMIT ?`).all(e.thread_key, ...args, MAX_THREAD)
      : q(`SELECT ${COLS} FROM emails e WHERE e.id = ?`).all(id);
    return { id, thread_key: e.thread_key || null, items: decorate(rows, { since: params.since ? String(params.since) : null }), capped: rows.length >= MAX_THREAD };
  }

  // ---- people for the autocomplete: the people list first, then correspondents seen only in the archive
  function suggestPeople(text) {
    const s = String(text || '').trim().toLowerCase();
    if (s.length < 2) return [];
    const out = [];
    for (const p of people()) { if (p.name.toLowerCase().includes(s) || p.emails.some((e) => e.includes(s))) out.push({ id: p.id, name: p.name, email: p.emails[0] || null, role: p.role }); if (out.length >= 8) break; }
    if (out.length < 8) {
      const known = new Set(out.map((o) => (o.email || '').toLowerCase()));
      let rows = [];
      try { rows = q("SELECT email, name FROM archive_contacts WHERE person_id IS NULL AND (instr(lower(email), ?) > 0 OR instr(lower(COALESCE(name,'')), ?) > 0) ORDER BY n_received + n_sent DESC LIMIT 8").all(s, s); } catch { /* no archive table */ }
      for (const r of rows) { if (known.has(r.email.toLowerCase()) || out.length >= 8) continue; out.push({ id: null, name: r.name || r.email, email: r.email, role: null }); }
    }
    return out;
  }

  // ---- "since your last visit": the owner's last visit to the tab, kept on the server (settings); consecutive visits within 10 minutes count as one
  const getSet = q('SELECT value FROM settings WHERE key = ?'), putSet = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  function visit({ touch }) {
    const last = (getSet.get('mail_visit_last') || {}).value || null, prev = (getSet.get('mail_visit_prev') || {}).value || null;
    if (!touch) return { since: prev, last_visit: last };
    const t = now();
    if (!last) { putSet.run('mail_visit_last', t); return { since: null }; }
    if (Date.parse(t) - Date.parse(last) > 10 * 60 * 1000) { putSet.run('mail_visit_prev', last); putSet.run('mail_visit_last', t); return { since: last }; }
    putSet.run('mail_visit_last', t);
    return { since: prev };
  }

  return { list, thread, suggestPeople, visit, parseFilters, filterSql };
}

module.exports = { createMailList, DATE };
