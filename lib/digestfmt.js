'use strict';
// THE one template for digests and long system messages. A digest is a plain object ("rich"):
//   { prefix?, intro?, sections: [ { key, emoji, title, count, items: [ { id?, title, project?, amount?, link?, text? } ], more?: { n, link }, numbered? } ], background? }
// and this module renders it three ways: Telegram HTML (a few short messages), the web bubble (structured, rendered by the page) and a plain-text fallback (what is stored as the message text).
// Change the look here only: emojis, headers, limits, how an item line reads.
const LIMITS = { itemsPerSection: 5, titleChars: 60, messageChars: 1500, projectChars: 14 };
const RLM = '‏'; // every line starts in Hebrew direction
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
// cut at a word boundary
const cut = (s, n = LIMITS.titleChars) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); if (s.length <= n) return s; const c = s.slice(0, n); return c.replace(/\s+\S*$/, '').replace(/[,.;:\-–—]+$/, '') + '…'; };
const amountOf = (s) => { const m = /(\d{1,3}(?:,\d{3})+|\d{3,})(?:\.\d+)?\s*(?:₪|ש"ח|שח|ש״ח)/.exec(String(s || '')); return m ? `${m[1]} ₪` : null; };
const shortProject = (p) => (p ? cut(p, LIMITS.projectChars) : null);

// ---- one item line: "• #177 title — project · amount"
function itemLine(it, mode) {
  const title = cut(it.title ?? it.text ?? '');
  const amt = it.amount || amountOf(it.title); const tail = [shortProject(it.project), amt && !title.includes(String(amt).replace(' ₪', '')) ? amt : null].filter(Boolean).join(' · ');
  if (mode === 'plain') return `• ${it.id ? '#' + it.id + ' ' : ''}${title}${tail ? ' — ' + tail : ''}`;
  const id = it.id ? (it.link ? `<b><a href="${escAttr(it.link)}">#${esc(it.id)}</a></b> ` : `<b>#${esc(it.id)}</b> `) : '';
  const t = it.id || !it.link ? esc(title) : `<a href="${escAttr(it.link)}">${esc(title)}</a>`;
  return `${RLM}• ${id}${t}${tail ? ' — ' + esc(tail) : ''}`;
}
function sectionLines(sec, mode, i0 = 0) {
  const head = `${sec.emoji ? sec.emoji + ' ' : ''}${mode === 'plain' ? sec.title : `<b>${esc(sec.title)}</b>`}${sec.count != null ? (mode === 'plain' ? ` (${sec.count})` : ` <b>(${sec.count})</b>`) : ''}`.replace('</b> <b>(', ' (').replace(')</b></b>', ')</b>');
  const items = (sec.items || []).slice(0, LIMITS.itemsPerSection);
  const lines = [mode === 'plain' ? head : RLM + head];
  items.forEach((it, i) => {
    if (sec.numbered) { const t = cut(it.text ?? it.title, 80); lines.push(mode === 'plain' ? `${i + 1}. ${t}` : `${RLM}${i + 1}. ${esc(t)}${it.link ? ` — <a href="${escAttr(it.link)}">ענה</a>` : ''}`); }
    else lines.push(itemLine(it, mode));
  });
  const more = sec.more || ((sec.items || []).length > LIMITS.itemsPerSection ? { n: sec.items.length - LIMITS.itemsPerSection } : null);
  if (more && more.n > 0) lines.push(mode === 'plain' ? `ועוד ${more.n}` : `${RLM}${more.link ? `<a href="${escAttr(more.link)}">ועוד ${more.n} ←</a>` : `ועוד ${more.n}`}`);
  return lines;
}

// ---- Telegram: HTML, split into short messages (new / waiting for you / questions + calendar + background), each under ~1500 characters
const GROUPS = [['new', 'closed'], ['waiting', 'promises', 'others'], ['questions', 'calendar']];
function telegram(rich) {
  const secs = (rich.sections || []).filter((s) => (s.items && s.items.length) || (s.count != null && s.count > 0));
  const byKey = (keys) => secs.filter((s) => keys.includes(s.key));
  const rest = secs.filter((s) => !GROUPS.flat().includes(s.key));
  const msgs = [];
  const bg = rich.background ? `<blockquote expandable>${RLM}⚙️ <b>עיבוד ברקע</b>\n${RLM}${esc(rich.background)}</blockquote>` : null;
  const groups = [byKey(GROUPS[0]), [...byKey(GROUPS[1]), ...rest], byKey(GROUPS[2])].filter((g) => g.length);
  groups.forEach((g, gi) => {
    let cur = []; const flush = () => { if (cur.length) msgs.push(cur.join('\n\n')); cur = []; };
    if (gi === 0 && rich.intro) cur.push(RLM + esc(rich.intro));
    for (const sec of g) { const block = sectionLines(sec, 'html').join('\n'); if (cur.length && [...cur, block].join('\n\n').length > LIMITS.messageChars) flush(); cur.push(block); }
    if (gi === groups.length - 1 && bg) { if ([...cur, bg].join('\n\n').length > LIMITS.messageChars) flush(); cur.push(bg); }
    flush();
  });
  if (!msgs.length) msgs.push(rich.intro ? RLM + esc(rich.intro) : RLM + 'אין חדש.');
  if (!groups.length && bg) msgs.push(bg);
  return [...(rich.prefix ? [RLM + esc(rich.prefix)] : []), ...msgs];
}
// ---- plain text (the stored fallback: no URLs)
function plain(rich) {
  const out = [];
  if (rich.prefix) out.push(rich.prefix);
  if (rich.intro) out.push(rich.intro);
  for (const sec of rich.sections || []) { if (!((sec.items && sec.items.length) || sec.count)) continue; out.push(sectionLines(sec, 'plain').join('\n')); }
  if (rich.background) out.push(`⚙️ עיבוד ברקע: ${rich.background}`);
  return out.join('\n\n');
}
// ---- web: the page renders the object itself (headers, bullets, links on the titles); this only trims what it shows
function web(rich) {
  return { ...rich, sections: (rich.sections || []).filter((s) => (s.items && s.items.length) || s.count).map((s) => ({ ...s, items: (s.items || []).slice(0, LIMITS.itemsPerSection).map((it) => ({ ...it, title: cut(it.title ?? it.text ?? ''), tail: (() => { const t = cut(it.title ?? it.text ?? ''); const amt = it.amount || amountOf(it.title); return [shortProject(it.project), amt && !t.includes(String(amt).replace(' ₪', '')) ? amt : null].filter(Boolean).join(' · '); })() })), more: s.more || ((s.items || []).length > LIMITS.itemsPerSection ? { n: s.items.length - LIMITS.itemsPerSection } : null) })) };
}
// ---- any other Telegram message (the assistant's replies, the pulse, alerts): HTML-safe, and bare URLs become short links on a label, never a naked "https://..." in the middle of Hebrew
const URL_RE = /https?:\/\/[^\s<>"]+/g;
function linkLabel(u) { const m = /\/(task|email|projects|protocols)\/(\d+)/.exec(u); if (m) return m[1] === 'task' ? `#${m[2]}` : m[1] === 'email' ? `מייל #${m[2]}` : m[1] === 'projects' ? 'פרויקט' : 'פרוטוקול'; if (/\/archive\b/.test(u)) return 'הארכיון'; if (/\/chat\b/.test(u)) return 'הצ׳אט'; if (/\/calendar\b/.test(u)) return 'היומן'; return 'קישור'; }
function htmlize(text) {
  const s = String(text ?? ''); let out = '', last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) { let u = m[0]; const trail = /[.,;:!?)\]]+$/.exec(u); if (trail) u = u.slice(0, -trail[0].length); out += esc(s.slice(last, m.index)) + `<a href="${escAttr(u)}">${esc(linkLabel(u))}</a>` + esc(trail ? trail[0] : ''); last = m.index + m[0].length; }
  return out + esc(s.slice(last));
}
module.exports = { LIMITS, esc, cut, amountOf, itemLine, telegram, plain, web, htmlize, linkLabel };
