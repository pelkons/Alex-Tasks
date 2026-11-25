'use strict';
// Calendar: meetings and events (calendar_items) plus the open tasks on their due dates, served as a secret iCalendar feed
// that Outlook can subscribe to ("Add calendar -> From Internet"). Output follows RFC 5545 (CRLF, folding at 75 octets, escaping, VTIMEZONE).
const crypto = require('crypto');
const { now } = require('./db');
const { bad, missing, normDate, normDateTime } = require('./store');

const TZ = 'Asia/Jerusalem';
const siteBase = (db) => require('./config').siteUrl(db);

function createCalendar(db, store) {
  const q = (sql) => db.prepare(sql);
  const getSet = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;

  // ---- items
  const row = (r) => r && ({ ...r, all_day: !!r.all_day });
  const hasTime = (s) => /[T ]\d{1,2}:\d{2}/.test(String(s || ''));
  function addItem(actor, b) {
    const title = String(b.title ?? '').trim();
    if (!title) throw bad('יש להזין כותרת לאירוע');
    const allDay = b.all_day === true || (b.all_day === undefined && !hasTime(b.start));
    const start = allDay ? normDate(String(b.start).split(/[T ]/)[0]) : normDateTime(b.start);
    if (!start) throw bad('יש להזין תאריך התחלה');
    const end = b.end ? (allDay ? normDate(String(b.end).split(/[T ]/)[0]) : normDateTime(b.end)) : null;
    const task = b.task ? store.getTask(+b.task).id : null;
    const project = b.project ? store.findProject(b.project).id : null;
    if (b.email && !q('SELECT 1 FROM emails WHERE id=?').get(+b.email)) throw bad('הדוא״ל לא נמצא');
    // the same meeting mentioned twice (same title and start) is one item
    const dup = q('SELECT id FROM calendar_items WHERE title=? AND start=?').get(title, start);
    if (dup) return row(q('SELECT * FROM calendar_items WHERE id=?').get(dup.id));
    return db.transaction(() => {
      const id = q(`INSERT INTO calendar_items (title, start, end, all_day, location, description, task_id, project_id, source_email_id, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(title, start, end, allDay ? 1 : 0, String(b.location ?? ''), String(b.description ?? ''), task, project, b.email ? +b.email : null, actor, now()).lastInsertRowid;
      store.logEvent(actor, 'calendar', id, 'create', 'title', null, title);
      return row(q('SELECT * FROM calendar_items WHERE id=?').get(id));
    })();
  }
  function getItem(id) { const r = q('SELECT * FROM calendar_items WHERE id=?').get(id); if (!r) throw missing('האירוע לא נמצא'); return r; }
  function updateItem(actor, id, b) {
    const cur = getItem(id);
    const sets = {};
    if (b.title !== undefined) { if (!String(b.title).trim()) throw bad('יש להזין כותרת לאירוע'); sets.title = String(b.title).trim(); }
    if (b.location !== undefined) sets.location = String(b.location);
    if (b.description !== undefined) sets.description = String(b.description);
    if (b.start !== undefined) { const ad = hasTime(b.start) ? 0 : 1; sets.all_day = ad; sets.start = ad ? normDate(String(b.start).split(/[T ]/)[0]) : normDateTime(b.start); }
    if (b.end !== undefined) sets.end = b.end ? ((sets.all_day ?? cur.all_day) ? normDate(String(b.end).split(/[T ]/)[0]) : normDateTime(b.end)) : null;
    const cols = Object.keys(sets);
    if (!cols.length) return row(cur);
    db.transaction(() => {
      q(`UPDATE calendar_items SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => sets[c]), id);
      store.logEvent(actor, 'calendar', id, 'update', cols.join(','), null, JSON.stringify(sets).slice(0, 200));
    })();
    return row(getItem(id));
  }
  function deleteItem(actor, id) {
    getItem(id);
    db.transaction(() => { q('DELETE FROM calendar_items WHERE id=?').run(id); store.logEvent(actor, 'calendar', id, 'delete', null, null, null); })();
    return { ok: true };
  }

  // merged view for the screen: meetings plus open tasks by due date, in a date range (YYYY-MM-DD, inclusive)
  const localDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
  const localTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  // the project of an item: name, color and whether it is the grey "לא משויך" bucket (calendar items may have no project at all)
  const projects = () => new Map(store.listProjects().map((p) => [p.id, p]));
  function range(from, to) {
    const out = [];
    const P = projects();
    for (const r of q('SELECT * FROM calendar_items ORDER BY start').all()) {
      const day = r.all_day ? r.start : localDay(r.start);
      if (day < from || day > to) continue;
      out.push({ kind: 'meeting', id: r.id, title: r.title, date: day, time: r.all_day ? null : localTime(r.start), end_time: r.end && !r.all_day ? localTime(r.end) : null, all_day: !!r.all_day, location: r.location, task_id: r.task_id, project_id: r.project_id, project: P.get(r.project_id)?.name_he || null, project_color: P.get(r.project_id)?.color || null, project_default: !!P.get(r.project_id)?.is_default });
    }
    for (const t of store.listTasks({ open: '1' })) {
      if (!t.due_date || t.due_date < from || t.due_date > to) continue;
      out.push({ kind: 'task', id: t.id, title: t.title, date: t.due_date, time: null, all_day: true, estimated: t.due_source === 'estimated', requester: t.requester, project_id: t.project_id, project: t.project, project_color: t.project_color, project_default: !!t.project_default, late: t.due_date < store.todayIL() });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
  }

  // ---- token and feed
  function token(rotate = false) {
    let t = getSet('calendar_token');
    if (!t || rotate) {
      t = crypto.randomBytes(24).toString('base64url');
      q("INSERT INTO settings (key,value) VALUES ('calendar_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(t);
    }
    return { token: t, url: `${siteBase(db)}/cal/${t}.ics` };
  }
  function tokenOk(candidate) {
    const t = getSet('calendar_token');
    if (!t || !candidate) return false;
    const a = Buffer.from(String(candidate)), b = Buffer.from(t);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  // fold at 75 octets without splitting a UTF-8 character
  function fold(line) {
    if (Buffer.byteLength(line) <= 75) return line;
    const parts = []; let cur = '', bytes = 0, limit = 75;
    for (const ch of line) {
      const n = Buffer.byteLength(ch);
      if (bytes + n > limit) { parts.push(cur); cur = ''; bytes = 0; limit = 74; }
      cur += ch; bytes += n;
    }
    parts.push(cur);
    return parts.join('\r\n ');
  }
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateOnly = (iso) => iso.replace(/-/g, '');
  const localCompact = (iso) => localDay(iso).replace(/-/g, '') + 'T' + localTime(iso).replace(':', '') + '00';
  const nextDay = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + 1)).toISOString().slice(0, 10);

  const VTIMEZONE = [
    'BEGIN:VTIMEZONE', `TZID:${TZ}`,
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'TZNAME:IDT', 'DTSTART:19700327T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:IST', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'];

  function ics(only) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mesimot//Tasks and meetings//HE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc('משימות')}`, `X-WR-TIMEZONE:${TZ}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT4H', 'X-PUBLISHED-TTL:PT4H', ...VTIMEZONE];
    const dtstamp = stamp(new Date());
    const P2 = projects();
    if (!only || only === 'meetings') {
      for (const r of q('SELECT * FROM calendar_items ORDER BY start').all()) {
        const ev = ['BEGIN:VEVENT', `UID:meeting-${r.id}@mesimot`, `DTSTAMP:${dtstamp}`];
        if (r.all_day) { ev.push(`DTSTART;VALUE=DATE:${dateOnly(r.start)}`, `DTEND;VALUE=DATE:${dateOnly(r.end ? nextDay(r.end) : nextDay(r.start))}`); }
        else { ev.push(`DTSTART;TZID=${TZ}:${localCompact(r.start)}`, `DTEND;TZID=${TZ}:${localCompact(r.end || new Date(Date.parse(r.start) + 3600000).toISOString())}`); }
        const proj = r.project_id ? P2.get(r.project_id) : null;
        const tag = proj && !proj.is_default ? `[${proj.name_he}] ` : '';
        ev.push(`SUMMARY:${esc(tag + r.title)}`);
        if (r.location) ev.push(`LOCATION:${esc(r.location)}`);
        const desc = [r.description, r.task_id ? `משימה: ${siteBase(db)}/task/${r.task_id}` : '', r.project_id ? `פרויקט: ${siteBase(db)}/projects/${r.project_id}` : ''].filter(Boolean).join('\n');
        if (desc) ev.push(`DESCRIPTION:${esc(desc)}`);
        ev.push(`CATEGORIES:${['פגישה', proj && !proj.is_default ? proj.name_he : null].filter(Boolean).map(esc).join(',')}`, 'TRANSP:OPAQUE', 'END:VEVENT');
        lines.push(...ev);
      }
    }
    if (!only || only === 'tasks') {
      for (const t of store.listTasks({ open: '1' })) {
        if (!t.due_date) continue;
        const title = `${t.project_default ? '' : `[${t.project}] `}${t.title}${t.requester ? ' · ' + t.requester : ''}${t.due_source === 'estimated' ? ' (משוער)' : ''}`;
        const desc = [`פרויקט: ${t.project}`, t.assignee ? `אחראי: ${t.assignee}` : '', `התקבל: ${(t.source_date || t.created_at).slice(0, 10).split('-').reverse().join('/')}`, t.description ? `\n${t.description.slice(0, 400)}` : '', `\n${siteBase(db)}/task/${t.id}`].filter(Boolean).join('\n');
        lines.push('BEGIN:VEVENT', `UID:task-${t.id}@mesimot`, `DTSTAMP:${dtstamp}`, `DTSTART;VALUE=DATE:${dateOnly(t.due_date)}`, `DTEND;VALUE=DATE:${dateOnly(nextDay(t.due_date))}`,
          `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(desc)}`, `URL:${siteBase(db)}/task/${t.id}`, `CATEGORIES:${['משימה', t.project_default ? null : t.project].filter(Boolean).map(esc).join(',')}`, 'TRANSP:TRANSPARENT', `LAST-MODIFIED:${stamp(t.updated_at)}`, 'END:VEVENT');
      }
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  return { addItem, updateItem, deleteItem, getItem, list: (f = {}) => range(f.from || '0000-01-01', f.to || '9999-12-31'), range, token, tokenOk, ics, fold };
}

module.exports = { createCalendar };
