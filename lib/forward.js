'use strict';
// Parse the original sender/date out of a forwarded email body (Outlook and Gmail, Hebrew and English).
const { jerusalemToISO } = require('./dates');

const HE_MONTHS = {
  'ינואר': 1, 'ינו': 1, 'פברואר': 2, 'פבר': 2, 'מרץ': 3, 'מרס': 3, 'אפריל': 4, 'אפר': 4, 'מאי': 5, 'יוני': 6, 'יולי': 7,
  'אוגוסט': 8, 'אוג': 8, 'ספטמבר': 9, 'ספט': 9, 'אוקטובר': 10, 'אוק': 10, 'נובמבר': 11, 'נוב': 11, 'דצמבר': 12, 'דצמ': 12,
};
const EN_MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const KEYS = {
  from: ['from', 'מאת', 'שולח'],
  date: ['sent', 'date', 'נשלח', 'תאריך', 'נשלחה'],
  to: ['to', 'אל', 'נמען'],
  cc: ['cc', 'עותק', 'עותק מוסתר'],
  subject: ['subject', 'נושא'],
};
const KEY_LOOKUP = {};
for (const [k, arr] of Object.entries(KEYS)) for (const a of arr) KEY_LOOKUP[a] = k;

function clean(text) {
  return String(text || '')
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n');
}

function headerLine(line) {
  const m = /^[\s>*_]*([A-Za-zא-ת ]{2,14}?)\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*(.*)$/.exec(line);
  if (!m) return null;
  const key = KEY_LOOKUP[m[1].trim().toLowerCase()];
  return key ? { key, value: m[2].replace(/\*+/g, '').trim() } : null;
}

function parseAddress(v0) {
  const v = String(v0 || '').replace(/<mailto:[^>]*>/gi, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const addr = ((/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/.exec(v) || [])[0] || '').replace(/^['"-]+|['"]+$/g, '');
  let name = v.replace(/\[mailto:[^\]]*\]/gi, '').replace(/<[^>]*>/g, '').replace(addr, '').replace(/["'`]/g, '').replace(/[()[\]]/g, '').trim();
  name = name.replace(/\s{2,}/g, ' ');
  if (!name) name = addr;
  return { name, addr, text: addr && name !== addr ? `${name} <${addr}>` : (addr || name) };
}

// split on a separator outside quotes and angle brackets
function splitTop(str, sep) {
  const out = []; let cur = '', q = false, a = false;
  for (const ch of str) {
    if (ch === '"') q = !q; else if (ch === '<' && !q) a = true; else if (ch === '>' && !q) a = false;
    if (ch === sep && !q && !a) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.filter((x) => x.trim());
}

const EMAIL_G = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;

// "Name‏ <a@b>; Other <c@d>, third@e" -> [{name, email}]. Names may be empty; an entry may have no address (Exchange display names)
function splitAddresses(v) {
  const out = [];
  const one = (piece) => {
    const a = parseAddress(piece);
    if (!a.addr && !a.name) return;
    out.push({ name: a.name && a.name !== a.addr ? a.name : '', email: (a.addr || '').toLowerCase() });
  };
  for (const seg of String(v || '').replace(/<mailto:[^>]*>/gi, '').split(';')) {
    const t = seg.trim();
    if (!t) continue;
    if ((t.match(EMAIL_G) || []).length > 1) for (const piece of splitTop(t, ',')) one(piece.trim());
    else one(t);
  }
  return out;
}

function parseDate(raw) {
  if (!raw) return null;
  let s = clean(raw).replace(/\s+/g, ' ');
  // time
  let hh = null, mm = 0;
  const t = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm|a\.m\.|p\.m\.)?/.exec(s);
  if (t) {
    hh = +t[1]; mm = +t[2];
    const ap = (t[3] || '').toLowerCase();
    if (ap.startsWith('p') && hh < 12) hh += 12;
    if (ap.startsWith('a') && hh === 12) hh = 0;
    s = s.replace(t[0], ' ');
  }
  let y, mo, d;
  let m;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  else {
    const ym = /\b(20\d{2})\b/.exec(s);
    if (!ym) return null;
    y = +ym[1];
    const rest = s.replace(ym[0], ' ');
    // month name, English or Hebrew (optionally with a one-letter prefix such as ב)
    const words = rest.split(/[\s,.׳'’]+/).filter(Boolean);
    for (const w0 of words) {
      const w = w0.toLowerCase();
      if (EN_MONTHS[w]) { mo = EN_MONTHS[w]; break; }
      const he = w0.replace(/^[בל]/, '');
      if (HE_MONTHS[w0]) { mo = HE_MONTHS[w0]; break; }
      if (HE_MONTHS[he]) { mo = HE_MONTHS[he]; break; }
    }
    if (!mo) return null;
    const dm = /\b(\d{1,2})\b/.exec(rest);
    if (!dm) return null;
    d = +dm[1];
  }
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return jerusalemToISO(y, mo, d, hh ?? 0, mm);
}

const FORWARD_SUBJECT = /^\s*((fw|fwd|re)\s*:|הועבר\s*:|העבר\s*:|הודעה שהועברה)\s*/i;
function stripSubjectPrefixes(subj) {
  let s = String(subj || '').trim();
  for (let i = 0; i < 5 && FORWARD_SUBJECT.test(s); i++) s = s.replace(FORWARD_SUBJECT, '').trim();
  return s;
}

// per-message thread (newest first) and the flat participant list with the message each one belongs to
function threadOf(chain) {
  const thread = chain.map((c, i) => ({ index: i, from_name: (c.from_name && c.from_name !== c.from_addr) ? c.from_name : '', from_email: (c.from_addr || '').toLowerCase(), date: c.date || null, subject: c.subject || null, to: c.to || [], cc: c.cc || [] }));
  const participants = [];
  for (const m of thread) {
    participants.push({ role: 'from', name: m.from_name, email: m.from_email, msg_index: m.index });
    for (const x of m.to) participants.push({ role: 'to', name: x.name, email: x.email, msg_index: m.index });
    for (const x of m.cc) participants.push({ role: 'cc', name: x.name, email: x.email, msg_index: m.index });
  }
  return { thread, participants };
}

function parseForwarded(body, outerSubject) {
  const lines = clean(body).split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const h = headerLine(lines[i]);
    if (!h || h.key !== 'from') continue;
    const block = { from: h.value, date: null, subject: null, start: i };
    let j = i + 1, seen = 0, lastKey = 'from';
    for (; j < lines.length && j <= i + 10; j++) {
      const line = lines[j];
      if (!line.trim()) { if (seen) break; continue; }
      const hh = headerLine(line);
      if (hh) { block[hh.key] = hh.value; lastKey = hh.key; seen++; }
      else if (lastKey === 'subject' || lastKey === 'to' || lastKey === 'cc') block[lastKey] = (block[lastKey] || '') + ' ' + line.trim();
      else break;
    }
    if (block.date) {
      block.bodyStart = j;
      blocks.push(block);
      i = j - 1;
    }
  }
  if (!blocks.length) return { forwarded: false, from_name: null, from_addr: null, from: null, date: null, subject: stripSubjectPrefixes(outerSubject), body: clean(body).trim(), chain: [] };
  const chain = blocks.map((b) => {
    const a = parseAddress(b.from);
    return { from: a.text, from_name: a.name, from_addr: a.addr, date: parseDate(b.date), date_raw: b.date, subject: b.subject || null, to: splitAddresses(b.to), cc: splitAddresses(b.cc) };
  });
  const top = blocks[0];
  const a = parseAddress(top.from);
  const end = blocks[1] ? blocks[1].start : lines.length;
  return {
    forwarded: true,
    from_name: a.name, from_addr: a.addr, from: a.text,
    date: parseDate(top.date),
    subject: top.subject ? stripSubjectPrefixes(top.subject) : stripSubjectPrefixes(outerSubject),
    body: lines.slice(top.bodyStart, end).join('\n').trim(),
    chain,
    ...threadOf(chain),
  };
}

// a single message taken straight from real headers (.eml/.msg or the outer mail)
function threadFromHeaders({ from_name, from_addr, from, to = [], cc = [], date, subject }) {
  const f = from && !from_addr ? parseAddress(from) : { name: from_name, addr: from_addr };
  return threadOf([{ from_name: f.name && f.name !== f.addr ? f.name : '', from_addr: f.addr || from_addr || '', date: date || null, subject: subject || null, to: splitAddresses(to.join(';')), cc: splitAddresses(cc.join(';')) }]);
}

const isForwardSubject = (s) => /^\s*(fw|fwd)\s*:|^\s*(הועבר|העבר)\s*:|^\s*הודעה שהועברה/i.test(String(s || ''));

module.exports = { threadFromHeaders, threadOf, splitAddresses, parseForwarded, parseDate, parseAddress, isForwardSubject, stripSubjectPrefixes };
