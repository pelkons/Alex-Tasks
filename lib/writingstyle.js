'use strict';
// WRITING STYLES (docs/WRITING-STYLES.md): how the owner writes to each person, as RULES THAT CODE CHECKS, not only prompt text.
//  * A style = machine-checkable rules (language, greeting, closing, signature, length, bullets, formality, forbidden / required phrases, emoji, אתה/אתם)
//    + a short Hebrew description for the assistant + a few real examples of his own sent mail.
//  * The RESOLVER picks ONE style for the recipients: person > group > email domain > role > default; mixed recipients -> the MOST formal of them (and it says so).
//  * The GATE: every mail draft of the assistant (`outbox draft|update`, `draft add`, `apply`) is validated here and refused with a Hebrew list of fixes,
//    the guide and real examples, so the assistant rewrites it. The owner's own text is never checked (it is his).
//  * The owner's edits of a draft are stored as style_feedback; repeated patterns become SUGGESTIONS that he accepts or dismisses in Settings.
//    Nothing learned is ever applied to the rules by itself, and the assistant cannot change rules (its change requests become suggestions too).
const { now } = require('./db');
const { bad, HttpError } = require('./store');

const FORMALITY = { casual: 0, neutral: 1, formal: 2 };
const FORMALITY_HE = { casual: 'קליל', neutral: 'עסקי-ענייני', formal: 'רשמי' };
const LANGS = ['he', 'ru', 'en', 'same-as-thread'];
const LANG_HE = { he: 'עברית', ru: 'רוסית', en: 'אנגלית', 'same-as-thread': 'כמו בשרשור' };
const KINDS = ['person', 'group', 'domain', 'role'];
const ROLES = { boss: 'ממונים (הנהלה)', pm: 'מנהלי פרויקטים בצוות', internal: 'עובדי החברה', external: 'אנשי קשר חיצוניים', unknown: 'נמען חדש שלא מוכר במערכת' };
const ROLE_ORDER = ['boss', 'pm', 'internal', 'unknown', 'external'];
// phrases that the level of formality alone already rules out (on top of the style's own list)
const BASE_FORBIDDEN = {
  casual: ['לכבוד', 'בכבוד רב', 'שלום רב', 'אשמח אם תוכל', 'אשמח אם תוכלי', 'אבקש להודיעך', 'הנני', 'הריני', 'נבקשך', 'אודה לך', 'אודה לכם', 'למען הסדר הטוב', 'בהמשך לפנייתך', 'נא אשר קבלת', 'נא לאשר קבלת', 'בתודה מראש'],
  neutral: ['לכבוד', 'בכבוד רב', 'הנני', 'הריני', 'אבקש להודיעך', 'נבקשך', 'למען הסדר הטוב', 'נא אשר קבלת'],
  formal: [],
};
const DEFAULT_RULES = { language: 'same-as-thread', greeting: 'any', greeting_alt: [], closing: 'any', closing_alt: [], signature: false, max_words: null, max_sentences: null, allow_bullets: true, formality: 'neutral', forbidden_phrases: [], required_phrases: [], emoji: false, address: 'any' };
// greeting words: a first line made of these (plus a name) is a greeting
const GREET_WORDS = new Set(['שלום', 'היי', 'הי', 'הייי', 'בוקר', 'טוב', 'ערב', 'צהריים', 'טובים', 'צהרים', 'לכבוד', 'רב', 'לכולם', 'כולם', 'שבוע', 'שבת', 'חג', 'שמח', 'אהלן', 'מה', 'נשמע', 'hi', 'hello', 'dear', 'good', 'morning', 'hey', 'all', 'team', 'привет', 'здравствуйте', 'добрый', 'день']);
const GREET_START = /^(שלום|היי|הי|בוקר טוב|ערב טוב|צהריים טובים|צהרים טובים|לכבוד|אהלן|hi|hello|dear|hey|good morning|привет|здравствуйте|добрый)(?=[\s,.!]|$)/i;
const CLOSE_LINE = /^(בברכה|בכבוד רב|בכבוד|בתודה|תודה מראש|בתודה מראש|שלך|best regards|kind regards|regards|sincerely|с уважением)[,.!\s]*$/i;
const PLURAL_YOU = /(^|[\s,.(])(אתם|לכם|שלכם|אליכם|עליכם|אתכם|מכם|תוכלו|תעדכנו|תשלחו|תאשרו|תבדקו|תחזרו|תעבירו)(?=$|[\s,.!?)])/;
const SINGULAR_YOU = /(^|[\s,.(])(אתה|תוכל|תעדכן|תשלח|תאשר|תבדוק|תחזור|תעביר)(?=$|[\s,.!?)])/;
const BULLET = /^\s*([-–•*▪●]|\d{1,2}[.)])\s+/;
const EMOJI = /\p{Extended_Pictographic}/u;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const norm = (s) => String(s || '').replace(/[֑-ׇ]/g, '').replace(/[״“”]/g, '"').replace(/[׳‘’]/g, "'").replace(/[ ​-‏‪-‮﻿]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const words = (s) => (String(s || '').match(/[\p{L}\p{N}][\p{L}\p{N}'"׳״\-]*/gu) || []).length;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- text analysis (shared by the gate, the feedback and the analysis of the owner's sent mail)
const REPLY_CUT = [/^-{2,}\s*(original message|forwarded message|הודעה מקורית|הודעה שהועברה)/i, /^_{5,}\s*$/, /^on .{5,200}wrote:\s*$/i, /^ב-?\s?.{5,120}כתב(?:ה)?:\s*$/, /^(from|מאת)\s*:\s*\S.{2,200}$/i, /^>/];
const MOBILE = /^(קבל\s*\S*\s*outlook|get outlook for|sent from my|נשלח מ(ה)?(טלפון|אייפון|iphone|סמסונג)|הודעה זו נשלחה מ)/i;
// the owner's own text of a sent mail: quoted earlier mail, mobile footers and banners removed (the signature stays: lines() separates it)
function ownText(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const out = []; let seen = false;
  for (const raw of lines) {
    const l = raw.replace(/[ ​-‏‪-‮﻿]/g, ' ').trim();
    if (seen && REPLY_CUT.some((re) => re.test(l))) break;
    if (MOBILE.test(l) || /^<https?:\/\/\S+>$/.test(l) || /^\[?(cid|image\d*):/i.test(l)) continue;
    if (/^\[?caution:|this email originated from outside/i.test(l)) continue;
    if (l) seen = true;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// split a mail into greeting / body / closing / signature. ownerNames: lowercased first names and full names of the owner (he / en)
function parts(text, ownerNames = []) {
  let L = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const isOwnerLine = (l) => { const n = norm(l).replace(/[,.!\-–]+$/g, '').trim(); return n && words(n) <= 4 && ownerNames.some((o) => n === o || n.startsWith(o + ' ') || n.endsWith(' ' + o)); };
  let signature = null;
  // the signature: the owner's name (and the lines under it: title, phone) at the end
  for (let i = L.length - 1; i >= Math.max(1, L.length - 16); i--) if (isOwnerLine(L[i]) && L.slice(i + 1).every((l) => words(l) <= 8)) { /* name, title, phones, links under it */ const j = i > 1 && CLOSE_LINE.test(L[i - 1]) ? i - 1 : i; signature = L.slice(j).join('\n'); L = L.slice(0, j); break; } // "בברכה," right above the name belongs to the signature block
  let closing = null;
  if (L.length > 1) { const last = L[L.length - 1]; if (CLOSE_LINE.test(last) || (words(last) <= 3 && /^(תודה|תודה רבה|thanks|thank you|спасибо)[,.!\s]*$/i.test(last))) { closing = last; L = L.slice(0, -1); } }
  let greeting = null;
  if (L.length) {
    const first = L[0];
    const tok = norm(first).replace(/[,.!:;]+/g, ' ').split(/\s+/).filter(Boolean);
    const greetTok = tok.filter((t) => GREET_WORDS.has(t)).length;
    if (tok.length && tok.length <= 6 && (GREET_START.test(norm(first)) || (greetTok >= 1 && tok.length - greetTok <= 3) || (tok.length <= 2 && /,\s*$/.test(first) && L.length > 1))) {
      // "דנה, היי" alone on the first line, or "היי דנה, תוכלי ..." where the greeting starts the sentence
      greeting = first; L = L.slice(1);
    } else {
      const m = /^((?:שלום|היי|הי|בוקר טוב|ערב טוב|hi|hello|dear)\s+[^\s,]{2,20}|[^\s,]{2,20},\s*(?:היי|הי|שלום))\s*[,.!]\s*/i.exec(first);
      if (m) { greeting = m[1]; L[0] = first.slice(m[0].length); if (!L[0].trim()) L = L.slice(1); }
    }
  }
  const body = L.join('\n');
  return { greeting, body, closing, signature };
}
// sentences of the body: terminal punctuation, and every line without it
function sentences(body) {
  let n = 0;
  for (const line of String(body || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
    const segs = line.split(/(?<=[.!?…])\s+/).filter((s) => words(s) > 0);
    n += Math.max(1, segs.length);
  }
  return n;
}
function langOf(text) {
  const t = String(text || '').replace(/\S+@\S+|https?:\/\/\S+/g, '');
  const he = (t.match(/[א-ת]/g) || []).length, ru = (t.match(/[Ѐ-ӿ]/g) || []).length, en = (t.match(/[A-Za-z]/g) || []).length;
  const tot = he + ru + en; if (!tot) return null;
  if (he / tot >= 0.5) return 'he'; if (ru / tot >= 0.5) return 'ru'; if (en / tot >= 0.5) return 'en';
  return he >= ru && he >= en ? 'he' : ru >= en ? 'ru' : 'en';
}
// "בוקר טוב ניק," -> "בוקר טוב {first_name}": every word that is not a greeting word is the name
function greetingForm(greeting) {
  if (!greeting) return null;
  const sep = /,/.test(greeting) ? ', ' : ' ';
  const toks = norm(greeting).replace(/[,.!:;]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = []; for (const t of toks) { const g = GREET_WORDS.has(t) ? t : '{first_name}'; if (g === '{first_name}' && out[out.length - 1] === g) continue; out.push(g); }
  // keep the comma where he puts it: "דנה, היי" vs "היי דנה"
  if (out.length >= 2 && out[0] === '{first_name}' && sep === ', ') return `{first_name}, ${out.slice(1).join(' ')}`;
  if (sep === ', ' && out[out.length - 1] === '{first_name}') return out.join(' ');
  return out.join(' ');
}
function metrics(text, ownerNames) {
  const p = parts(text, ownerNames);
  return { ...p, greeting_form: greetingForm(p.greeting), words: words(p.body), sentences: sentences(p.body), bullets: p.body.split('\n').some((l) => BULLET.test(l)), emoji: EMOJI.test(text), lang: langOf(text) };
}

function createStyles({ db, store }) {
  const q = (s) => db.prepare(s);
  const cfg = () => require('./config').get();
  const ownerNames = () => {
    const c = cfg().owner || {}; const out = new Set();
    for (const n of [c.name_he, c.name_en]) { const v = norm(n); if (v) { out.add(v); out.add(v.split(' ')[0]); } }
    for (const p of store.listPeople().filter((x) => x.role === 'owner')) { const v = norm(p.name_he); if (v) { out.add(v); out.add(v.split(' ')[0]); } }
    return [...out].filter((x) => x.length >= 2);
  };
  const ownerDomain = () => String(cfg().owner?.work_email || '').toLowerCase().split('@')[1] || '';
  const internalDomains = () => new Set([ownerDomain(), ...((cfg().internal_domains) || []).map((d) => String(d).toLowerCase())].filter(Boolean));

  // ---------- rows
  const parseRow = (r) => r && ({ ...r, rules: { ...DEFAULT_RULES, ...JSON.parse(r.rules || '{}') }, examples: JSON.parse(r.examples || '[]'), stats: JSON.parse(r.stats || 'null'), is_default: !!r.is_default });
  const rowById = (id) => parseRow(q('SELECT * FROM writing_styles WHERE id=?').get(+id));
  const rowByKey = (k) => parseRow(q('SELECT * FROM writing_styles WHERE key=?').get(String(k)));
  function find(ref) { const r = /^\d+$/.test(String(ref)) ? rowById(ref) : rowByKey(ref); if (!r) throw new HttpError(404, 'הסגנון לא נמצא'); return r; }
  const assignmentsOf = (id) => q('SELECT * FROM style_assignments WHERE style_id=? ORDER BY kind, priority DESC, id').all(id);
  const active = () => q("SELECT * FROM writing_styles WHERE status='active'").all().map(parseRow);

  // ---------- people and recipients
  function peopleIndex() {
    const byEmail = new Map(); const people = store.listPeople();
    for (const p of people) for (const e of p.emails || []) byEmail.set(String(e).toLowerCase(), p);
    // the archive knows more addresses of a person: linked ones, and unlinked ones with exactly the person's English name ("Dana Levi" <d.levi@...>)
    const byEn = new Map(); for (const p of people) { const n = norm(p.name_en); if (n && n.includes(' ')) byEn.set(n, byEn.has(n) ? null : p); }
    try { for (const r of q('SELECT email, name, person_id FROM archive_contacts').all()) { const e = String(r.email).toLowerCase(); if (byEmail.has(e)) continue; const p = r.person_id ? people.find((x) => x.id === r.person_id) : byEn.get(norm(r.name)); if (p) byEmail.set(e, p); } } catch { /* the archive is optional */ }
    return { people, byEmail };
  }
  const bossNames = () => new Set((cfg().bosses || []).map((b) => norm(b.name_he)).filter(Boolean));
  const isBoss = (p) => !!p && (bossNames().has(norm(p.name_he)) || /הממונה של/.test(p.notes || ''));
  const firstName = (p, fallback) => {
    if (p && /[א-ת]/.test(p.name_he || '')) return String(p.name_he).trim().split(/\s+/)[0];
    const n = String(fallback || p?.name_en || '').replace(/["']/g, '').trim(); if (!n || /@/.test(n)) return null;
    const m = /^([^,]+),\s*(\S+)/.exec(n); return m ? m[2] : n.split(/\s+/)[0]; // "Partouche, Keren @ ..." -> Keren
  };
  // one recipient: an address, "Name (a@b)", "Name <a@b>", a bare name ("דנה") or a person id ("#2")
  function recipient(x, idx) {
    const { parseAddr } = require('./outbox');
    const raw = typeof x === 'object' && x ? x : String(x || '').trim();
    const a = typeof raw === 'object' ? { name: raw.name || '', email: String(raw.email || '').toLowerCase() } : parseAddr(raw);
    let person = null;
    if (a.email && a.email.includes('@')) person = idx.byEmail.get(a.email) || null;
    else {
      const name = (a.name || a.email || '').replace(/^#/, '').trim(); a.name = a.name || name; a.email = '';
      if (/^\d+$/.test(name)) person = idx.people.find((p) => p.id === +name) || null;
      else if (name) {
        const n = norm(name); const nf = n.split(' ')[0];
        const cands = idx.people.filter((p) => p.role !== 'assistant' && p.role !== 'owner' && [p.name_he, p.name_en].filter(Boolean).some((v) => { const w = norm(v); return w === n || (n === nf && w.split(' ')[0] === nf); }));
        // a first name shared by several people: the one he writes to most
        const sent = (p) => { try { return (p.emails || []).reduce((s, e) => s + (q('SELECT n_sent FROM archive_contacts WHERE email=?').get(String(e).toLowerCase())?.n_sent || 0), 0) + (p.role === 'pm' ? 1000 : 0) + (isBoss(p) ? 1000 : 0); } catch { return 0; } };
        person = cands.sort((x2, y2) => sent(y2) - sent(x2))[0] || null;
        if (person && !a.email) a.email = (person.emails || [])[0] || '';
      }
    }
    const domain = (a.email.split('@')[1] || '').toLowerCase();
    const roles = [];
    if (isBoss(person)) roles.push('boss');
    if (person && person.role === 'pm') roles.push('pm');
    if (domain && internalDomains().has(domain)) roles.push('internal');
    if (!person) roles.push('unknown');
    if (domain && !internalDomains().has(domain)) roles.push('external');
    return { email: a.email, name: a.name || person?.name_he || '', person: person ? { id: person.id, name_he: person.name_he, style_group: person.style_group || null } : null, first_name: firstName(person, a.name), domain, roles };
  }
  const listOf = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : splitAddr(v));
  function splitAddr(s) { // the outbox splitter, but bare names are allowed here
    const out = []; let cur = '', qt = false, ang = false;
    for (const ch of String(s)) { if (ch === '"') qt = !qt; else if (!qt && ch === '<') ang = true; else if (!qt && ch === '>') ang = false; if (!qt && !ang && /[;,\n]/.test(ch)) { out.push(cur.trim()); cur = ''; } else cur += ch; }
    out.push(cur.trim()); return out.filter(Boolean);
  }

  // ---------- the resolver
  function resolveOne(r, styles) {
    const by = (kind, ref) => styles.map((s) => ({ s, a: s._as.find((a) => a.kind === kind && String(a.ref).toLowerCase() === String(ref).toLowerCase()) })).filter((x) => x.a).sort((x, y) => (y.a.priority || 0) - (x.a.priority || 0))[0]?.s || null;
    let s;
    if (r.person && (s = by('person', r.person.id))) return { style: s, level: 'person', via: `אדם: ${r.person.name_he}` };
    if (r.person && r.person.style_group && (s = by('group', r.person.style_group))) return { style: s, level: 'group', via: `קבוצה: ${r.person.style_group}` };
    if (r.domain) { const segs = r.domain.split('.'); for (let i = 0; i < segs.length - 1; i++) { const d = segs.slice(i).join('.'); if ((s = by('domain', d))) return { style: s, level: 'domain', via: `דומיין: ${d}` }; } }
    for (const role of ROLE_ORDER) if (r.roles.includes(role) && (s = by('role', role))) return { style: s, level: 'role', via: `תפקיד: ${ROLES[role]}` };
    s = styles.find((x) => x.is_default) || null;
    return s ? { style: s, level: 'default', via: 'ברירת מחדל' } : { style: null, level: 'none', via: 'אין סגנון פעיל' };
  }
  const LEVEL_RANK = { person: 0, group: 1, domain: 2, role: 3, default: 4, none: 5 };
  // ctx: { to, cc, reply_email, task, styles (for tests / previews) }
  function resolve(ctx = {}) {
    const idx = peopleIndex();
    let to = listOf(ctx.to).map((x) => recipient(x, idx)); const cc = listOf(ctx.cc).map((x) => recipient(x, idx));
    if (!to.length && ctx.reply_email) { const e = q('SELECT COALESCE(forwarded_from, from_addr) f FROM emails WHERE id=?').get(+ctx.reply_email); if (e && e.f) to = [recipient(e.f, idx)]; }
    if (!to.length && ctx.task) { try { const t = store.getTask(+ctx.task); const p = t.requester_id ? idx.people.find((x) => x.id === t.requester_id) : null; if (p && p.role !== 'owner') to = [recipient({ name: p.name_he, email: (p.emails || [])[0] || '' }, idx)]; } catch { /* no task */ } }
    const styles = (ctx.styles || active()).map((s) => ({ ...s, _as: s._as || assignmentsOf(s.id) }));
    const all = [...to.map((r) => ({ r, field: 'to' })), ...cc.map((r) => ({ r, field: 'cc' }))].filter((x) => x.r.email || x.r.person || x.r.name);
    const per = all.map((x) => ({ ...x, ...resolveOne(x.r, styles) }));
    let pick = null;
    for (const p of per) {
      if (!p.style) continue;
      const f = FORMALITY[p.style.rules.formality] ?? 1, pf = pick ? FORMALITY[pick.style.rules.formality] ?? 1 : -1;
      if (!pick || f > pf || (f === pf && LEVEL_RANK[p.level] < LEVEL_RANK[pick.level] && p.field === 'to')) pick = p;
    }
    if (!pick && !per.length) { const d = styles.find((x) => x.is_default); if (d) pick = { style: d, level: 'default', via: 'ברירת מחדל (אין נמענים)', r: null }; }
    const distinct = [...new Map(per.filter((p) => p.style).map((p) => [p.style.key, p.style])).values()];
    const mixed = distinct.length > 1;
    const style = pick ? pick.style : null;
    if (style) delete style._as;
    return {
      style, level: pick?.level || 'none', via: pick?.via || 'אין סגנון פעיל', mixed,
      note_he: mixed ? `לנמענים יש סגנונות שונים (${distinct.map((s) => `"${s.name_he}"`).join(', ')}): נבחר הרשמי ביותר, "${style.name_he}".` : null,
      recipients: per.map((p) => ({ field: p.field, email: p.r.email, name: p.r.name, first_name: p.r.first_name, person_id: p.r.person?.id || null, style_key: p.style?.key || null, via: p.via })),
      to, cc,
    };
  }

  // ---------- the validator
  const effForbidden = (rules) => [...new Set([...(BASE_FORBIDDEN[rules.formality] || []), ...(rules.forbidden_phrases || [])].map((x) => String(x).trim()).filter(Boolean))];
  function threadLang(ctx) {
    const id = ctx.reply_email || (ctx.task ? (() => { try { return store.getTask(+ctx.task).source_email_id; } catch { return null; } })() : null);
    if (!id) return 'he';
    const e = q('SELECT body_text, subject FROM emails WHERE id=?').get(+id); if (!e) return 'he';
    return langOf(ownText(e.body_text).slice(0, 2000) || e.subject) || 'he';
  }
  const renderGreeting = (tpl, first) => String(tpl).replace(/\{first_name\}/g, first || 'שם');
  function greetingRe(tpl, names) {
    const nameAlt = names.length ? `(?:${names.map((n) => esc(norm(n))).join('|')}|כולם|לכולם|צוות)` : '[^\\s,.!]{2,20}(?:\\s[^\\s,.!]{2,20})?';
    const body = norm(tpl).split('{first_name}').map((s) => esc(s).replace(/,/g, ',?').replace(/\s+/g, '\\s*')).join(nameAlt);
    return new RegExp(`^${body.replace(/^\\s\*|\\s\*$/g, '')}(?=$|[\\s,.!:])`, 'u');
  }
  // returns { violations: [{code, he}], warnings: [], metrics }
  function validate(text, style, ctx = {}) {
    const R = { ...DEFAULT_RULES, ...(style?.rules || {}) };
    const V = [], W = [];
    const add = (code, he) => V.push({ code, he });
    const t = String(text || '');
    const m = metrics(t, ownerNames());
    const nt = norm(t);
    // phrases
    const hit = []; for (const ph of effForbidden(R).sort((a, b) => b.length - a.length)) { const n = norm(ph); if (n && !hit.some((h) => h.includes(n)) && new RegExp(`(^|[^\\p{L}])${esc(n)}(?=$|[^\\p{L}])`, 'u').test(nt)) { hit.push(n); add('forbidden', `להוריד את "${ph}" (לא בסגנון הזה${(BASE_FORBIDDEN[R.formality] || []).includes(ph) ? `: ${FORMALITY_HE[R.formality]}` : ''})`); } }
    for (const ph of R.required_phrases || []) if (ph && !nt.includes(norm(ph))) add('required', `חסר הביטוי "${ph}"`);
    // greeting
    const names = (ctx.to_names || []).filter(Boolean);
    const firstLine = norm(t.split('\n').map((x) => x.trim()).find(Boolean) || '');
    if (R.greeting === 'none') { if (m.greeting || GREET_START.test(firstLine)) add('greeting', `בלי פנייה בפתיחה ("${clip(m.greeting || firstLine, 30)}"): להתחיל ישר בעניין`); }
    else if (R.greeting && R.greeting !== 'any') {
      const forms = [R.greeting, ...(R.greeting_alt || [])].filter((x) => x && x !== 'any' && x !== 'none');
      const noneOk = (R.greeting_alt || []).includes('none') && !m.greeting && !GREET_START.test(firstLine); // "or no greeting at all"
      if (!noneOk && !forms.some((f) => greetingRe(f, names).test(firstLine))) add('greeting', `הפתיחה צריכה להיות "${renderGreeting(R.greeting, names[0])}"${forms.length > 1 || (R.greeting_alt || []).includes('none') ? ` (או: ${[...forms.slice(1).map((f) => `"${renderGreeting(f, names[0])}"`), ...((R.greeting_alt || []).includes('none') ? ['בלי פנייה'] : [])].join(', ')})` : ''}${m.greeting ? `, לא "${clip(m.greeting, 30)}"` : ''}`);
    }
    // closing
    if (R.closing === 'none') { if (m.closing && CLOSE_LINE.test(m.closing)) add('closing', `בלי שורת סיום ("${m.closing}")`); }
    else if (R.closing && R.closing !== 'any') {
      const forms = [R.closing, ...(R.closing_alt || [])].map(norm).filter(Boolean);
      const last = norm(m.closing || String(m.body).split('\n').map((x) => x.trim()).filter(Boolean).pop() || '');
      if (!forms.some((f) => last.startsWith(f) || last.endsWith(f))) add('closing', `לסיים ב-"${R.closing}"`);
    }
    // signature: the organisation adds it to every mail
    if (R.signature === false && m.signature) add('signature', `בלי חתימה ("${clip(m.signature, 30)}"): היא נוספת אוטומטית במייל`);
    if (R.signature === true && !m.signature) add('signature', 'לחתום בשם בסוף');
    // length
    if (!ctx.long) {
      if (R.max_sentences && m.sentences > R.max_sentences) add('length', `לקצר: ${m.sentences} משפטים, בסגנון הזה עד ${R.max_sentences}`);
      if (R.max_words && m.words > Math.round(R.max_words * 1.3)) add('length', `לקצר: ${m.words} מילים, בסגנון הזה בערך עד ${R.max_words}`);
      else if (R.max_words && m.words > R.max_words) W.push(`קצת ארוך (${m.words} מילים, בדרך כלל עד ${R.max_words})`);
    }
    if (R.allow_bullets === false && m.bullets) add('bullets', 'בלי רשימת תבליטים: לכתוב בשורות רגילות');
    if (R.emoji === false && m.emoji) add('emoji', 'בלי אימוג׳י');
    // language
    const want = R.language === 'same-as-thread' ? threadLang(ctx) : R.language;
    if (want && m.lang && m.lang !== want) add('language', `לכתוב ב${LANG_HE[want]}${R.language === 'same-as-thread' ? ' (כמו בשרשור)' : ''}`);
    // אתה / אתם
    const single = (ctx.to_count ?? 1) === 1;
    if (R.address === 'singular' && single && PLURAL_YOU.test(t)) add('address', `לפנות ביחיד (אתה), לא ברבים ("${(PLURAL_YOU.exec(t) || [])[2]}")`);
    if (R.address === 'plural' && SINGULAR_YOU.test(t)) add('address', `לפנות ברבים (אתם), לא ביחיד ("${(SINGULAR_YOU.exec(t) || [])[2]}")`);
    return { violations: V, warnings: W, metrics: { words: m.words, sentences: m.sentences, greeting: m.greeting, closing: m.closing, signature: !!m.signature, lang: m.lang } };
  }

  // ---------- what the assistant reads
  function guide(style, names = []) {
    if (!style) return 'אין סגנון פעיל: לכתוב קצר וענייני.';
    const R = style.rules; const n0 = names[0];
    const L = [`סגנון "${style.name_he}" (${FORMALITY_HE[R.formality] || R.formality}).`];
    if (style.description_he) L.push(style.description_he.trim());
    L.push(`פתיחה: ${R.greeting === 'any' ? 'חופשי' : R.greeting === 'none' ? 'בלי פנייה, ישר לעניין' : `"${renderGreeting(R.greeting, n0)}"${(R.greeting_alt || []).length ? ` (או ${R.greeting_alt.map((g) => (g === 'none' ? 'בלי פנייה' : `"${renderGreeting(g, n0)}"`)).join(', ')})` : ''}`}.`);
    L.push(`סיום: ${R.closing === 'any' ? 'חופשי' : R.closing === 'none' ? 'בלי שורת סיום' : `"${R.closing}"`}. חתימה: ${R.signature === false ? 'בלי (נוספת אוטומטית)' : R.signature === true ? 'בשם' : 'חופשי'}.`);
    const len = [R.max_sentences ? `עד ${R.max_sentences} משפטים` : '', R.max_words ? `בערך עד ${R.max_words} מילים` : ''].filter(Boolean).join(', ');
    if (len) L.push(`אורך: ${len}.`);
    L.push(`שפה: ${LANG_HE[R.language] || R.language}.${R.allow_bullets === false ? ' בלי תבליטים.' : ''}${R.emoji === false ? ' בלי אימוג׳י.' : ''}${R.address === 'singular' ? ' פנייה ביחיד (אתה).' : R.address === 'plural' ? ' פנייה ברבים (אתם).' : ''}`);
    const f = effForbidden(R); if (f.length) L.push(`לא לכתוב: ${f.map((x) => `"${x}"`).join(', ')}.`);
    if ((R.required_phrases || []).length) L.push(`חובה: ${R.required_phrases.map((x) => `"${x}"`).join(', ')}.`);
    return L.join('\n');
  }
  // a sample line made from the rules only (nothing is generated)
  function sample(style, name = 'דנה') {
    const R = style.rules; const L = [];
    if (R.greeting && R.greeting !== 'none' && R.greeting !== 'any') L.push(renderGreeting(R.greeting, name));
    L.push(R.formality === 'casual' ? 'תזכיר לי מה עם התוכניות?' : R.formality === 'formal' ? 'נבקש לקבל את התוכניות המעודכנות עד יום חמישי.' : 'אפשר לקבל את התוכניות המעודכנות עד חמישי?');
    if (R.closing && R.closing !== 'none' && R.closing !== 'any') L.push(R.closing);
    if (R.signature === true) L.push(String(cfg().owner?.name_he || '').split(/\s+/)[0]);
    return L.join('\n');
  }
  // up to n of the owner's own recent SENT mails to these addresses (newest first, quoted text removed, clipped)
  function examples(emails, n = 5, maxChars = 320) {
    const out = []; const seen = new Set();
    const addrs = [...new Set(emails.map((e) => String(e || '').toLowerCase()).filter((e) => e.includes('@')))].slice(0, 6);
    if (!addrs.length) return out;
    const cond = addrs.map(() => 'participants LIKE ?').join(' OR ');
    const rows = q(`SELECT id, COALESCE(mail_date, forwarded_date, received_at) d, subject, body_text, participants FROM emails WHERE direction='sent' AND dup_of IS NULL AND (${cond}) ORDER BY COALESCE(mail_date, forwarded_date, received_at) DESC LIMIT 40`).all(...addrs.map((a) => `%"email":"${a}"%`));
    for (const r of rows) {
      let parts0 = []; try { parts0 = JSON.parse(r.participants || '[]'); } catch { /* ignore */ }
      if (!parts0.some((p) => (p.msg_index ?? 0) === 0 && ['to', 'cc'].includes(p.role) && addrs.includes(String(p.email).toLowerCase()))) continue; // only when HE wrote to them (not a quoted header)
      const own = ownText(r.body_text); const p = parts(own, ownerNames());
      const txt = [p.greeting, p.body, p.closing].filter(Boolean).join('\n').trim();
      if (!txt || words(txt) < 2 || seen.has(norm(txt))) continue;
      seen.add(norm(txt));
      out.push({ email_id: r.id, date: String(r.d || '').slice(0, 10), subject: clip(r.subject, 80), text: txt.length > maxChars ? txt.slice(0, maxChars) + '…' : txt });
      if (out.length >= n) break;
    }
    return out;
  }

  // ---------- feedback (the owner's edits) and the suggestions made from it
  function diffSummary(before, after) {
    const on = ownerNames(); const a = metrics(before, on), b = metrics(after, on);
    const bits = [];
    if (b.sentences < a.sentences) bits.push(`קיצר מ-${a.sentences} ל-${b.sentences} משפטים`); else if (b.sentences > a.sentences) bits.push(`האריך מ-${a.sentences} ל-${b.sentences} משפטים`);
    if (Math.abs(b.words - a.words) >= 5) bits.push(`${a.words}→${b.words} מילים`);
    if (norm(a.greeting) !== norm(b.greeting)) bits.push(b.greeting ? `פתיחה "${clip(a.greeting || '-', 25)}" → "${clip(b.greeting, 25)}"` : `מחק את הפתיחה "${clip(a.greeting, 25)}"`);
    if (norm(a.closing) !== norm(b.closing)) bits.push(b.closing ? `סיום → "${clip(b.closing, 20)}"` : `מחק את הסיום "${clip(a.closing, 20)}"`);
    if (a.signature && !b.signature) bits.push('מחק את החתימה');
    const removed = removedPhrases(before, after).slice(0, 3); if (removed.length) bits.push(`מחק: ${removed.map((x) => `"${x}"`).join(', ')}`);
    return { text: bits.join('; ') || 'שינויי ניסוח קלים', a, b, removed };
  }
  // 2-3 word phrases of the draft that the owner took out (the ones that tell about register)
  function removedPhrases(before, after) {
    const nb = norm(after); const toks = norm(before).replace(/[,.!?:;()]/g, ' ').split(/\s+/).filter(Boolean); const out = [];
    for (const len of [3, 2]) for (let i = 0; i + len <= toks.length; i++) { const ph = toks.slice(i, i + len).join(' '); if (ph.length >= 6 && !nb.includes(ph) && !out.some((o) => o.includes(ph) || ph.includes(o))) out.push(ph); }
    return out.filter((ph) => /אשמח|לכבוד|בכבוד|נא |אבקש|הנני|הריני|אודה|מראש|בברכה|שלום רב|למען|בהמשך ל|תודה רבה|בבקשה|please|kindly/.test(ph));
  }
  function recordFeedback({ outboxId = null, styleKey, recipients, before, after, actor }) {
    if (!styleKey || norm(before) === norm(after)) return null;
    const d = diffSummary(before, after);
    const id = q('INSERT INTO style_feedback (created_at, outbox_id, style_key, recipients, before_text, after_text, summary, actor) VALUES (?,?,?,?,?,?,?,?)')
      .run(now(), outboxId, styleKey, JSON.stringify(recipients || []), String(before), String(after), d.text, actor ?? null).lastInsertRowid;
    try { suggestFromFeedback(styleKey); } catch (e) { console.warn('style suggestions:', e.message); }
    return { id, summary: d.text };
  }
  // the compact "what I changed" for the assistant, for these recipients (newest first)
  function feedbackFor(emails, limit = 5) {
    const addrs = emails.map((e) => String(e || '').toLowerCase()).filter(Boolean);
    if (!addrs.length) return [];
    const rows = q(`SELECT * FROM style_feedback WHERE ${addrs.map(() => 'recipients LIKE ?').join(' OR ')} ORDER BY id DESC LIMIT ?`).all(...addrs.map((a) => `%${a}%`), limit);
    return rows.map((r) => ({ date: String(r.created_at).slice(0, 10), style_key: r.style_key, changed: r.summary, before: clip(r.before_text, 160), after: clip(r.after_text, 160) }));
  }
  // patterns across the owner's edits for one style -> open suggestions (NEVER applied here)
  function suggestFromFeedback(styleKey) {
    const st = rowByKey(styleKey); if (!st) return [];
    const rows = q('SELECT * FROM style_feedback WHERE style_key=? ORDER BY id DESC LIMIT 12').all(styleKey);
    if (rows.length < 2) return [];
    const on = ownerNames(); const ds = rows.map((r) => ({ r, a: metrics(r.before_text, on), b: metrics(r.after_text, on) }));
    const who = (() => { const names = new Set(rows.map((r) => { try { return JSON.parse(r.recipients)[0]?.name || ''; } catch { return ''; } }).filter(Boolean)); return names.size === 1 ? [...names][0] : null; })();
    const out = [];
    const shorter = ds.filter((x) => x.b.sentences < x.a.sentences);
    if (shorter.length >= 2 && shorter.length >= ds.length * 0.6) {
      const target = Math.max(1, Math.round(ds.reduce((s, x) => s + x.b.sentences, 0) / ds.length));
      if (!st.rules.max_sentences || target < st.rules.max_sentences) out.push({ key: `max_sentences:${target}`, text: `בדרך כלל אתה מקצר ל-${target} משפטים${who ? ` ל${who}` : ''} - לעדכן?`, patch: { max_sentences: target } });
    }
    const greets = ds.map((x) => greetingForm(x.b.greeting) || 'none');
    const top = greets.sort((a, b) => greets.filter((g) => g === b).length - greets.filter((g) => g === a).length)[0];
    if (greets.filter((g) => g === top).length >= 2 && top !== st.rules.greeting && ds.some((x) => norm(x.a.greeting) !== norm(x.b.greeting))) out.push({ key: `greeting:${top}`, text: top === 'none' ? `אתה מוחק את הפנייה בפתיחה${who ? ` ל${who}` : ''} - לכתוב בלי פנייה?` : `אתה פותח ב-"${renderGreeting(top, who ? String(who).split(/\s+/)[0] : 'שם')}"${who ? ` ל${who}` : ''} - לעדכן?`, patch: { greeting: top } });
    const removed = {}; for (const x of ds) for (const ph of removedPhrases(x.r.before_text, x.r.after_text)) removed[ph] = (removed[ph] || 0) + 1;
    for (const [ph, n] of Object.entries(removed)) if (n >= 2 && !effForbidden(st.rules).map(norm).includes(ph)) out.push({ key: `forbid:${ph}`, text: `אתה מוחק את "${ph}" (${n} פעמים) - להוסיף לביטויים האסורים?`, patch: { forbidden_add: [ph] } });
    if (ds.filter((x) => x.a.signature && !x.b.signature).length >= 2 && st.rules.signature !== false) out.push({ key: 'signature:false', text: 'אתה מוחק את החתימה - לכתוב בלי חתימה?', patch: { signature: false } });
    for (const s of out) addSuggestion(st.id, 'feedback', s.text, s.patch, { feedback_ids: rows.map((r) => r.id) }, s.key);
    return out;
  }
  function addSuggestion(styleId, source, text, patch, evidence, key) {
    const k = `${styleId}:${key || JSON.stringify(patch)}`;
    if (q("SELECT 1 FROM style_suggestions WHERE dedupe_key=? AND (status='open' OR (status='dismissed' AND decided_at > ?))").get(k, new Date(Date.now() - 30 * 86400000).toISOString())) return null;
    return q('INSERT INTO style_suggestions (style_id, created_at, source, text_he, patch, evidence, status, dedupe_key) VALUES (?,?,?,?,?,?,?,?)').run(styleId, now(), source, text, JSON.stringify(patch), JSON.stringify(evidence || {}), 'open', k).lastInsertRowid;
  }
  const suggestions = (status = 'open') => q('SELECT s.*, w.name_he style_name, w.key style_key FROM style_suggestions s JOIN writing_styles w ON w.id=s.style_id WHERE s.status=? ORDER BY s.id DESC LIMIT 50').all(status).map((r) => ({ id: r.id, style_id: r.style_id, style_key: r.style_key, style_name: r.style_name, source: r.source, text_he: r.text_he, patch: JSON.parse(r.patch), created_at: r.created_at }));
  // OWNER ONLY (the route checks the web session): the one way a learned or requested change reaches the rules
  function decideSuggestion(actor, id, accept) {
    const s = q('SELECT * FROM style_suggestions WHERE id=?').get(+id); if (!s) throw new HttpError(404, 'ההצעה לא נמצאה');
    if (s.status !== 'open') return { status: s.status };
    if (accept) {
      const st = rowById(s.style_id); const p = JSON.parse(s.patch); const rules = { ...st.rules };
      for (const [k, v] of Object.entries(p)) { if (k === 'forbidden_add') rules.forbidden_phrases = [...new Set([...(rules.forbidden_phrases || []), ...v])]; else if (k === 'forbidden_remove') rules.forbidden_phrases = (rules.forbidden_phrases || []).filter((x) => !v.includes(x)); else if (k in DEFAULT_RULES) rules[k] = v; }
      const extra = {}; if (p.description_he !== undefined) extra.description_he = p.description_he; if (p.name_he !== undefined) extra.name_he = p.name_he;
      update(actor, st.id, { rules, ...extra }, { owner: true });
    }
    q('UPDATE style_suggestions SET status=?, decided_at=? WHERE id=?').run(accept ? 'accepted' : 'dismissed', now(), s.id);
    store.logEvent(actor, 'style', s.style_id, accept ? 'suggestion_accept' : 'suggestion_dismiss', 'suggestion', null, s.text_he);
    return { status: accept ? 'accepted' : 'dismissed', style: accept ? view(rowById(s.style_id)) : undefined };
  }

  // ---------- editing (the owner) and change requests (the assistant)
  function cleanRules(r, cur = DEFAULT_RULES) {
    const o = { ...DEFAULT_RULES, ...cur };
    const s = (v) => String(v ?? '').trim();
    if (r.language !== undefined) { if (!LANGS.includes(r.language)) throw bad(`שפה לא מוכרת: ${r.language}`); o.language = r.language; }
    if (r.formality !== undefined) { if (!(r.formality in FORMALITY)) throw bad(`רמת רשמיות לא מוכרת: ${r.formality}`); o.formality = r.formality; }
    for (const k of ['greeting', 'closing']) if (r[k] !== undefined) { const v = s(r[k]) || 'any'; if ([...v].length > 60) throw bad('עד 60 תווים'); o[k] = v; }
    for (const k of ['greeting_alt', 'closing_alt', 'forbidden_phrases', 'required_phrases']) if (r[k] !== undefined) { const arr = (Array.isArray(r[k]) ? r[k] : String(r[k]).split(/\n|,/)).map(s).filter(Boolean); if (arr.length > 60 || arr.some((x) => [...x].length > 80)) throw bad('רשימה ארוכה מדי'); o[k] = [...new Set(arr)]; }
    if (r.signature !== undefined) o.signature = r.signature === 'any' ? 'any' : r.signature === true || r.signature === 'true' || r.signature === 'yes';
    for (const k of ['max_words', 'max_sentences']) if (r[k] !== undefined) { const v = r[k] === null || r[k] === '' ? null : Math.floor(+r[k]); if (v !== null && !(v >= 1 && v <= 2000)) throw bad('אורך לא תקין'); o[k] = v; }
    for (const k of ['allow_bullets', 'emoji']) if (r[k] !== undefined) o[k] = r[k] === true || r[k] === 'true' || r[k] === 1;
    if (r.address !== undefined) { if (!['any', 'singular', 'plural'].includes(r.address)) throw bad('צורת פנייה לא מוכרת'); o.address = r.address; }
    return o;
  }
  function create(actor, b, { source = 'owner' } = {}) {
    const name = String(b.name_he || b.name || '').trim(); if (!name) throw bad('יש להזין שם לסגנון');
    let key = String(b.key || '').trim() || `s${Date.now().toString(36)}`; if (!/^[a-z0-9._:-]{1,60}$/i.test(key)) throw bad('מפתח לא תקין');
    if (rowByKey(key)) { if (b.replace) q('DELETE FROM writing_styles WHERE key=?').run(key); else throw bad('כבר קיים סגנון עם המפתח הזה'); }
    const status = ['active', 'proposed', 'disabled'].includes(b.status) ? b.status : 'proposed';
    const t = now();
    const id = q('INSERT INTO writing_styles (key, name_he, description_he, rules, examples, stats, is_default, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(key, name, String(b.description_he || ''), JSON.stringify(cleanRules(b.rules || {})), JSON.stringify(b.examples || []), b.stats ? JSON.stringify(b.stats) : null, b.is_default ? 1 : 0, status, source, t, t).lastInsertRowid;
    for (const a of b.assignments || []) assign(actor, id, a, { owner: true });
    if (status === 'active' && b.is_default) q('UPDATE writing_styles SET is_default=0 WHERE id<>? AND is_default=1').run(id);
    store.logEvent(actor, 'style', id, 'create', 'name_he', null, name, { source });
    return view(rowById(id));
  }
  function update(actor, id, b, { owner = false } = {}) {
    const cur = find(id);
    if (!owner) return requestChange(actor, cur, b);
    const sets = {};
    if (b.name_he !== undefined) { const v = String(b.name_he).trim(); if (!v) throw bad('יש להזין שם לסגנון'); sets.name_he = v; }
    if (b.description_he !== undefined) sets.description_he = String(b.description_he).slice(0, 1500);
    if (b.rules !== undefined) sets.rules = JSON.stringify(cleanRules(b.rules, cur.rules));
    if (b.status !== undefined) { if (!['active', 'proposed', 'disabled'].includes(b.status)) throw bad('מצב לא מוכר'); sets.status = b.status; }
    if (b.is_default !== undefined) sets.is_default = b.is_default ? 1 : 0;
    if (!Object.keys(sets).length) return view(cur);
    sets.updated_at = now();
    db.transaction(() => {
      q(`UPDATE writing_styles SET ${Object.keys(sets).map((k) => k + '=?').join(',')} WHERE id=?`).run(...Object.values(sets), cur.id);
      const nw = rowById(cur.id);
      // one default: activating a default style retires the previous one
      if (nw.is_default && nw.status === 'active') q("UPDATE writing_styles SET is_default=0, status=CASE WHEN status='active' THEN 'disabled' ELSE status END, updated_at=? WHERE id<>? AND is_default=1").run(now(), cur.id);
      store.logEvent(actor, 'style', cur.id, 'update', Object.keys(sets).filter((k) => k !== 'updated_at').join(','), null, null);
    })();
    return view(rowById(cur.id));
  }
  // the assistant never changes a rule: what it asks for becomes a suggestion for the owner
  function requestChange(actor, cur, b) {
    const patch = {};
    if (b.rules) { const r = cleanRules(b.rules, cur.rules); for (const k of Object.keys(DEFAULT_RULES)) if (JSON.stringify(r[k]) !== JSON.stringify(cur.rules[k]) && b.rules[k] !== undefined) patch[k] = r[k]; }
    if (b.description_he !== undefined) patch.description_he = String(b.description_he).slice(0, 1500);
    if (b.name_he !== undefined) patch.name_he = String(b.name_he).trim();
    if (!Object.keys(patch).length) throw bad('אין שינוי להציע');
    const text = String(b.reason || '').trim() || `שינוי בסגנון "${cur.name_he}": ${Object.keys(patch).join(', ')}`;
    const id = addSuggestion(cur.id, 'assistant', clip(text, 200), patch, {}, `assistant:${JSON.stringify(patch)}`);
    return { suggested: true, suggestion_id: id, note: 'השינוי לא הוחל: הוא ממתין לאישור הבעלים בהגדרות ← סגנונות כתיבה' };
  }
  function assign(actor, id, a, { owner = false } = {}) {
    const st = find(id);
    if (!owner) throw new HttpError(403, 'רק הבעלים משייך סגנונות (בהגדרות)');
    const kind = String(a.kind || ''); if (!KINDS.includes(kind)) throw bad(`סוג שיוך לא מוכר: ${kind}`);
    let ref = String(a.ref ?? '').trim(); if (!ref) throw bad('חסר למי');
    if (kind === 'person') { const p = store.findPerson(/^\d+$/.test(ref) ? +ref : ref); ref = String(p.id); }
    if (kind === 'domain') { ref = ref.toLowerCase().replace(/^.*@/, '').replace(/^www\./, ''); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(ref)) throw bad('דומיין לא תקין'); }
    if (kind === 'role' && !ROLES[ref]) throw bad(`תפקיד לא מוכר. האפשרויות: ${Object.keys(ROLES).join(', ')}`);
    if (kind === 'group' && [...ref].length > 40) throw bad('שם קבוצה עד 40 תווים');
    q('INSERT OR IGNORE INTO style_assignments (style_id, kind, ref, priority, created_at) VALUES (?,?,?,?,?)').run(st.id, kind, ref, +a.priority || 0, now());
    store.logEvent(actor, 'style', st.id, 'assign', kind, null, ref);
    return view(rowById(st.id));
  }
  function unassign(actor, id, aid) {
    const st = find(id); const a = q('SELECT * FROM style_assignments WHERE id=? AND style_id=?').get(+aid, st.id); if (!a) throw new HttpError(404, 'השיוך לא נמצא');
    q('DELETE FROM style_assignments WHERE id=?').run(a.id); store.logEvent(actor, 'style', st.id, 'unassign', a.kind, a.ref, null);
    return view(rowById(st.id));
  }
  function setGroup(actor, personRef, group) {
    const p = store.findPerson(/^\d+$/.test(String(personRef)) ? +personRef : personRef);
    const g = group ? String(group).trim().slice(0, 40) : null;
    q('UPDATE people SET style_group=? WHERE id=?').run(g, p.id); store.logEvent(actor, 'person', p.id, 'update', 'style_group', p.style_group || null, g);
    return { id: p.id, name_he: p.name_he, style_group: g };
  }
  const groups = () => [...new Set([...q("SELECT DISTINCT style_group g FROM people WHERE style_group IS NOT NULL AND style_group<>''").all().map((r) => r.g), ...q("SELECT DISTINCT ref g FROM style_assignments WHERE kind='group'").all().map((r) => r.g)])].sort();

  // ---------- views
  function whoOf(st) {
    const people = store.listPeople();
    return assignmentsOf(st.id).map((a) => ({ id: a.id, kind: a.kind, ref: a.ref, priority: a.priority, label: a.kind === 'person' ? (people.find((p) => String(p.id) === a.ref)?.name_he || `#${a.ref}`) : a.kind === 'role' ? ROLES[a.ref] || a.ref : a.ref,
      members: a.kind === 'group' ? people.filter((p) => p.style_group === a.ref).map((p) => ({ id: p.id, name_he: p.name_he })) : undefined }));
  }
  function view(st, { full = true } = {}) {
    const who = whoOf(st);
    return { id: st.id, key: st.key, name_he: st.name_he, description_he: st.description_he, status: st.status, is_default: st.is_default, source: st.source, rules: st.rules, forbidden_effective: effForbidden(st.rules),
      who, who_he: st.is_default && !who.length ? 'ברירת מחדל: כל מי שאין לו סגנון אחר' : who.map((w) => w.label).join(', ') || 'לא משויך', created_at: st.created_at, updated_at: st.updated_at,
      ...(full ? { examples: st.examples, stats: st.stats, sample: sample(st), guide: guide(st) } : {}) };
  }
  const list = () => q("SELECT * FROM writing_styles ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, is_default DESC, name_he").all().map((r) => view(parseRow(r), { full: false }));

  // ---------- the GATE and `style for`
  function styleFor(ctx) {
    const r = resolve(ctx);
    const emails = [...r.to, ...r.cc].map((x) => x.email).filter(Boolean);
    const names = r.to.map((x) => x.first_name).filter(Boolean);
    const ex = examples(emails, 5);
    return { style: r.style ? { key: r.style.key, name_he: r.style.name_he, formality: r.style.rules.formality, rules: r.style.rules } : null, chosen_by: r.via, mixed: r.mixed, note: r.note_he,
      recipients: r.recipients, guide: guide(r.style, names), sample: r.style ? sample(r.style, names[0]) : null,
      examples: ex.length ? ex : (r.style?.examples || []).slice(0, 3).map((e) => ({ ...e, note: 'דוגמה מהסגנון (אין מיילים קודמים לנמען הזה)' })),
      owner_edits: feedbackFor(emails, 5) };
  }
  const openRun = () => q('SELECT id FROM claude_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1').get()?.id ?? null;
  // ctx: { actor, to, cc, body, reply_email, task, long, what }  ->  { style_key }  or throws 422 with the fixes, the guide and examples
  function check(ctx) {
    const r = resolve(ctx);
    const style = r.style; if (!style) return { style_key: null };
    if (ctx.actor === store.ownerId()) return { style_key: style.key, owner: true }; // his own words are never checked
    const names = r.to.map((x) => x.first_name).filter(Boolean);
    const v = validate(ctx.body, style, { to_names: names, to_count: r.to.length || 1, reply_email: ctx.reply_email, task: ctx.task, long: !!ctx.long });
    if (!v.violations.length) return { style_key: style.key, warnings: v.warnings, note: r.note_he };
    const emails = [...r.to, ...r.cc].map((x) => x.email).filter(Boolean);
    const ex = examples(emails, 5, 220);
    const fb = feedbackFor(emails, 3);
    const msg = [`הטיוטה לא נשמרה: היא לא בסגנון "${style.name_he}" (${r.via}${r.mixed ? '; ' + r.note_he : ''}). לתקן:`, ...v.violations.map((x, i) => `${i + 1}. ${x.he}`), '', 'המדריך:', guide(style, names),
      ...(ex.length ? ['', 'כך הבעלים עצמו כתב להם (החדש ביותר קודם):', ...ex.map((e) => `- ${e.date}: ${e.text.replace(/\n/g, ' / ')}`)] : (style.examples || []).length ? ['', 'דוגמאות מהסגנון:', ...style.examples.slice(0, 3).map((e) => `- ${String(e.text).replace(/\n/g, ' / ')}`)] : []),
      ...(fb.length ? ['', 'מה הבעלים שינה בטיוטות קודמות:', ...fb.map((f) => `- ${f.changed}`)] : []),
      '', `לנסח מחדש ולהריץ שוב את אותה פקודה.${v.violations.some((x) => x.code === 'length') ? ' (רק אם הבעלים ביקש במפורש מייל ארוך: --long)' : ''}`].join('\n');
    try { q('INSERT INTO gate_log (run_id, at, code, task_id, detail, round, outcome) VALUES (?,?,?,?,?,?,?)').run(openRun(), now(), 'style', ctx.task ? +ctx.task : null, clip(`refused: ${ctx.what || 'draft'} → ${style.key}: ${v.violations.map((x) => x.he).join('; ')}`, 600), 0, 'raised'); /* a write-time refusal: a raised violation marked "refused:" */ } catch { /* the log never blocks */ }
    const e = new HttpError(422, msg); e.extra = { style_key: style.key, violations: v.violations, examples: ex }; throw e;
  }
  // "אל: דנה לוי dana@example.com\n..." at the top of a task draft names its recipients
  function draftRecipients(text) {
    const m = /^\s*(?:אל|to)\s*:\s*(.+)$/im.exec(String(text || '').split('\n').slice(0, 2).join('\n'));
    if (!m) return { to: [], body: String(text || '') };
    const raw = m[1].trim(); const em = raw.match(/[^\s<>(),;]+@[^\s<>(),;]+/g) || [];
    const to = em.length ? em.map((e) => { const name = raw.split(e)[0].replace(/[<(,;]+\s*$/, '').trim(); return name ? `${name} (${e})` : e; }) : [raw];
    return { to, body: String(text).replace(m[0], '').replace(/^\s*\n/, '') };
  }
  // the seed: one active base style, so the gate holds before the owner activates proposals (not stiff: the owner's complaint)
  function ensureSeed() {
    if (q('SELECT 1 FROM writing_styles LIMIT 1').get()) return;
    const o = store.ownerId();
    create(o, { key: 'base', name_he: 'בסיס (קצר וענייני)', status: 'active', is_default: true, description_he: 'קצר, ענייני ולא מתנשא. בלי נוסחאות רשמיות, בלי חתימה (נוספת אוטומטית).', rules: { formality: 'neutral', language: 'same-as-thread', greeting: 'any', closing: 'any', signature: false, max_words: 160, allow_bullets: true, emoji: false } }, { source: 'seed' });
    // two generic templates, switched off: the owner turns one on and assigns people to it
    create(o, { key: 'casual', name_he: 'עמית לעבודה (קליל)', status: 'disabled', description_he: 'כמו בצ׳אט: שם, היי, משפט או שניים. בלי נימוסים מיותרים.', rules: { formality: 'casual', greeting: '{first_name}, היי', greeting_alt: ['היי {first_name}', 'none'], closing: 'none', signature: false, max_words: 50, max_sentences: 3, allow_bullets: false, emoji: false, address: 'singular' } }, { source: 'seed' });
    create(o, { key: 'formal', name_he: 'רשמי', status: 'disabled', description_he: 'מכתב מסודר: פנייה, גוף ענייני, סיום. מנומס בלי להתנשא.', rules: { formality: 'formal', greeting: 'שלום {first_name}', greeting_alt: ['שלום רב'], closing: 'בברכה', closing_alt: ['תודה'], signature: false, max_words: 220, allow_bullets: true, emoji: false } }, { source: 'seed' });
  }

  return { resolve, validate, check, styleFor, guide, sample, examples, list, get: (id) => view(find(id)), find, create, update, assign, unassign, setGroup, groups, suggestions, decideSuggestion, addSuggestion,
    recordFeedback, feedbackFor, suggestFromFeedback, diffSummary, draftRecipients, ensureSeed, ownerNames, recipient: (x) => recipient(x, peopleIndex()), peopleIndex, isBoss, internalDomains, ROLES, FORMALITY_HE, LANG_HE };
}

module.exports = { createStyles, ownText, parts, metrics, greetingForm, sentences, langOf, words, norm, BASE_FORBIDDEN, DEFAULT_RULES, FORMALITY, ROLES, CLOSE_LINE, GREET_START };
