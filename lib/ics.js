'use strict';
// Meeting invitations in code (no model): the VEVENT of a text/calendar part becomes a calendar item.
function unfold(t) { return String(t || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/); }
function unesc(v) { return String(v || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }
// "20261217T100000Z" (UTC) or "20261217T120000" with TZID (taken as local Jerusalem) or all-day "20261217" -> { date, time }
function when(line) {
  const m = /^(DTSTART|DTEND)([^:]*):(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/i.exec(line); if (!m) return null;
  const [, , params, y, mo, d, hh, mi, , z] = m;
  if (hh === undefined) return { date: `${y}-${mo}-${d}`, time: null };
  if (z) { const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi)); const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(dt).reduce((a, x) => ({ ...a, [x.type]: x.value }), {}); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` }; }
  void params; return { date: `${y}-${mo}-${d}`, time: `${hh}:${mi}` };
}
function parse(text) {
  const lines = unfold(text); const method = (lines.find((l) => /^METHOD:/i.test(l)) || '').split(':')[1]?.trim().toUpperCase() || 'REQUEST';
  const events = []; let cur = null;
  for (const l of lines) {
    if (/^BEGIN:VEVENT/i.test(l)) cur = {}; else if (/^END:VEVENT/i.test(l)) { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      if (/^SUMMARY/i.test(l)) cur.title = unesc(l.slice(l.indexOf(':') + 1));
      else if (/^LOCATION/i.test(l)) cur.location = unesc(l.slice(l.indexOf(':') + 1));
      else if (/^UID/i.test(l)) cur.uid = l.slice(l.indexOf(':') + 1).trim();
      else if (/^DTSTART/i.test(l)) cur.start = when(l); else if (/^DTEND/i.test(l)) cur.end = when(l);
      else if (/^STATUS/i.test(l)) cur.status = l.slice(l.indexOf(':') + 1).trim().toUpperCase();
    }
  }
  return { method, events: events.filter((e) => e.title && e.start) };
}
module.exports = { parse };
