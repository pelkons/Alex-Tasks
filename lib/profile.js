'use strict';
// The PROJECT PASSPORT and the LATEST STATUS PER PROCESS (lib/profile.js).
// Passport: a few structured fields (buildings, floors, new units, existing units, track, commercial areas, contractor, architect).
// Status: one current line per process (design / permit / construction / marketing); a project can be in several at once.
// Every value is a dated row with a source (email:ID, file:ID, protocol:ID, chat:ID, or the owner) and a history: rows are never deleted, an older
// value is kept with superseded_by. The rules are enforced HERE, not trusted to the assistant:
//   * newer wins: a value whose as_of is OLDER than the current one is stored as history only and never replaces it;
//   * the owner wins: the owner's own edit (on the site) always becomes current and is marked; the assistant can never replace an owner's passport value
//     (its value is kept as history), and replaces an owner's process status only with a strictly NEWER dated status;
//   * the assistant must give a real source (the email / file / protocol / chat message must exist) and a date: nothing without evidence.
// Facts of the project card get a TOPIC once (design, permit, construction, finance, marketing, people, other) for the grouped list on the project page.
const { now } = require('./db');
const { bad, normDate } = require('./store');

const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

const FIELDS = {
  buildings: { he: 'בניינים', kind: 'int', hint: 'מספר הבניינים' },
  floors: { he: 'קומות', kind: 'floors', hint: 'קומות לכל בניין, למשל "8, 12"' },
  units_new: { he: 'דירות חדשות', kind: 'int', hint: 'יח"ד שנבנות' },
  units_existing: { he: 'דירות קיימות היום', kind: 'int', hint: 'התחדשות עירונית: יח"ד קיימות' },
  track: { he: 'מסלול', kind: 'text', hint: 'למשל תמ"א 38/2, פינוי-בינוי, בנייה חדשה' },
  commercial: { he: 'מסחר / שטחים אחרים', kind: 'text', hint: 'מסחר, משרדים, מבני ציבור' },
  contractor: { he: 'קבלן ראשי', kind: 'text', hint: 'קבלן הביצוע' },
  architect: { he: 'אדריכל', kind: 'text', hint: 'משרד האדריכלים' },
};
const PROCESSES = { design: 'תכנון', permit: 'רישוי / עירייה', construction: 'ביצוע', marketing: 'שיווק' };
const TOPICS = { design: 'תכנון', permit: 'רישוי', construction: 'ביצוע', finance: 'כספים וחשבונות', marketing: 'שיווק', people: 'אנשים ויועצים', other: 'אחר' };
const SOURCE_TYPES = ['email', 'file', 'protocol', 'chat', 'manual'];
// CLI / API spellings of the fields (kebab or snake, plus a few Hebrew-minded aliases)
const FIELD_ALIASES = { 'units-new': 'units_new', 'units-existing': 'units_existing', units: 'units_new', apartments: 'units_new', existing: 'units_existing', type: 'track', renewal: 'track' };
const PROCESS_ALIASES = { planning: 'design', 'תכנון': 'design', permitting: 'permit', municipality: 'permit', 'רישוי': 'permit', 'עירייה': 'permit', 'היתר': 'permit', execution: 'construction', build: 'construction', 'ביצוע': 'construction', sales: 'marketing', 'שיווק': 'marketing' };

// a first topic from the words of the fact (used when nobody classified it): the KEY decides first, then the value
const TOPIC_RULES = [
  ['marketing', /שיווק|מכירות|מכירה|מכר|רוכש|רוכשים|לקוח|דייר|דיירים|הדמי|מחירון|שינויי דיירים|פנטהאוז/],
  ['finance', /חשבון|חשבונות|תשלום|תמורה|₪|ש"ח|מע"מ|מע״מ|ערבות|ערבויות|תקציב|עלות|הצעת מחיר|בנק|מיסים|מסים|היטל|קנס|פיצוי|אינדקס|הצמדה|חשבונית/],
  ['permit', /היתר|רישוי|רישום|עירי|ועדה|טופס 4|טופס4|אכלוס|תב"ע|תב״ע|תכנית מפורטת|תוכנית מפורטת|גוש|חלקה|זיקת הנאה|הערת אזהרה|כיבוי אש|פיקוד העורף|הג"א|רשות|מכון בקרה|חח"י|חח״י|חברת החשמל|תאגיד|בזק/],
  ['people', /^(יועץ|יועצת|אדריכל|מהנדס|מהנדסת|איש קשר|אנשי קשר|מנהל|מנהלת|אחראי|אחראית|עו"ד|עו״ד|עורך דין|מתכנן|מתכננת|מפקח|מפקחת|בקר|נציג|ממונה|קבלן(?!.*(מצב|סטטוס)))|טלפון|נייד|@|איש הקשר/],
  ['design', /תכנון|תוכני|תכנית|אדריכלות|שרטוט|גיליון|פרט|תיאום|מפלס|חתך|חזית|מתכנן|קונסטרוקציה|הנדסי|SD|סט מכר/],
  ['construction', /ביצוע|שלד|יציקה|יציקות|בטיחות|אתר|ברזל|עבודות|עבודה|פיקוח|קבלן|מיזוג|חשמל|אינסטלציה|גמר|טיח|ריצוף|אלומיניום|עוגנים|חפירה|דיפון|לו"ז|לוח זמנים|מסירה|ליקויים/],
];
function guessTopic(key, value = '') {
  for (const s of [String(key || ''), String(value || '')]) for (const [t, re] of TOPIC_RULES) if (re.test(s)) return t;
  return 'other';
}

function createProfile(db, store) {
  const q = (sql) => db.prepare(sql);

  const fieldOf = (f) => { const k = String(f || '').trim().toLowerCase().replace(/-/g, '_'); const n = FIELD_ALIASES[String(f || '').trim().toLowerCase()] || k; if (!FIELDS[n]) throw bad(`שדה דרכון לא מוכר: ${f}. האפשרויות: ${Object.keys(FIELDS).join(', ')}`); return n; };
  const processOf = (p) => { const k = String(p || '').trim().toLowerCase(); const n = PROCESS_ALIASES[k] || PROCESS_ALIASES[String(p || '').trim()] || k; if (!PROCESSES[n]) throw bad(`תהליך לא מוכר: ${p}. האפשרויות: ${Object.keys(PROCESSES).join(', ')}`); return n; };

  // "email:12", "file:7", "protocol:3", "chat:44", "owner" / "manual"
  function parseSource(src, { owner }) {
    const raw = String(src ?? '').trim();
    if (!raw || raw === 'owner' || raw === 'manual') {
      if (!owner) throw bad('חסר מקור (--source email:ID | file:ID | protocol:ID | chat:ID): כל ערך בדרכון ובסטטוס חייב מקור אמיתי');
      return { type: 'manual', id: null };
    }
    const m = /^(email|file|protocol|chat):(\d+)$/.exec(raw);
    if (!m) throw bad('מקור לא תקין. הפורמט: email:ID, file:ID, protocol:ID, chat:ID');
    const table = { email: 'emails', file: 'files', protocol: 'protocols', chat: 'chat_messages' }[m[1]];
    if (!q(`SELECT 1 FROM ${table} WHERE id=?`).get(+m[2])) throw bad(`המקור ${raw} לא נמצא במערכת`);
    return { type: m[1], id: +m[2] };
  }
  function normValue(field, v) {
    const s = String(v ?? '').trim().replace(/\s+/g, ' ');
    if (!s) return '';
    const kind = FIELDS[field].kind;
    if (kind === 'int') {
      const n = s.replace(/[,\s]/g, '').replace(/(יח"ד|יח״ד|דירות|בניינים|בניין|מבנים)$/u, '');
      if (!/^\d{1,5}$/.test(n)) throw bad(`${FIELDS[field].he}: יש להזין מספר שלם (התקבל "${s}")`);
      return String(+n);
    }
    if (kind === 'floors') {
      if (!/\d/.test(s)) throw bad(`${FIELDS[field].he}: יש להזין מספר קומות, למשל "8" או "8, 12"`);
      const t = s.replace(/\s*קומות$/u, '');
      // a plain list of numbers ("8 ו-12", "8/12", "8; 12") becomes "8, 12"; any other wording is kept as written
      return /^\d+(?:\s*(?:,|;|\/|ו-?|\+)\s*\d+)*$/u.test(t) ? t.split(/\s*(?:,|;|\/|ו-?|\+)\s*/u).join(', ') : t;
    }
    if ([...s].length > 200) throw bad(`${FIELDS[field].he}: עד 200 תווים`);
    return s;
  }

  // ---- the generic dated slot (one per project + key) with newer-wins and owner-wins
  const T = {
    profile: { table: 'project_profile', col: 'field', entity: 'profile', ownerLock: 'always' },
    status: { table: 'project_status', col: 'process', entity: 'pstatus', ownerLock: 'unless_newer' },
  };
  const current = (t, pid, key) => q(`SELECT * FROM ${t.table} WHERE project_id=? AND ${t.col}=? AND superseded_by IS NULL`).get(pid, key);
  function put(t, actor, pid, key, value, b) {
    const owner = actor === store.ownerId() || !!b.by_owner;
    const asOf = b.as_of || b.as_of_date ? normDate(b.as_of || b.as_of_date) : (owner ? todayISO() : null);
    if (!asOf) throw bad('חסר תאריך (--as-of YYYY-MM-DD): התאריך של המקור, לא של היום');
    if (asOf > todayISO()) throw bad(`התאריך ${asOf} עתידי: as_of הוא תאריך המקור`);
    if (!owner && value === '') throw bad('רק הבעלים יכול לנקות ערך');
    const src = parseSource(b.source, { owner });
    const cur = current(t, pid, key);
    const ins = (supersededBy) => q(`INSERT INTO ${t.table} (project_id, ${t.col}, value, as_of_date, source_type, source_id, by_owner, created_by, created_at, superseded_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, key, value, asOf, src.type, src.id, owner ? 1 : 0, actor, now(), supersededBy).lastInsertRowid;
    const row = (id) => q(`SELECT * FROM ${t.table} WHERE id=?`).get(id);
    return db.transaction(() => {
      // the same value again: only a newer date (and the owner's mark) moves forward
      if (cur && cur.value === value) {
        const sets = [];
        if (asOf > cur.as_of_date) sets.push(['as_of_date', asOf], ['source_type', src.type], ['source_id', src.id]);
        if (owner && !cur.by_owner) sets.push(['by_owner', 1]);
        if (sets.length) {
          q(`UPDATE ${t.table} SET ${sets.map(([c]) => c + '=?').join(',')} WHERE id=?`).run(...sets.map(([, v]) => v), cur.id);
          store.logEvent(actor, t.entity, cur.id, 'update', 'as_of_date', cur.as_of_date, asOf, { project_id: pid, key });
        }
        return { result: 'confirmed', row: row(cur.id) };
      }
      let history = false, why = null;
      if (cur && !owner) {
        if (cur.by_owner && (t.ownerLock === 'always' || asOf <= cur.as_of_date)) { history = true; why = 'owner_value'; }
        else if (asOf < cur.as_of_date) { history = true; why = 'older'; }
      }
      const id = ins(history ? cur.id : null);
      if (cur && !history) q(`UPDATE ${t.table} SET superseded_by=? WHERE id=?`).run(id, cur.id);
      store.logEvent(actor, t.entity, id, 'create', key, cur ? cur.value : null, value, { project_id: pid, key, replaced: history ? null : (cur?.id ?? null), history_only: history });
      return { result: history ? (why === 'owner_value' ? 'kept_owner_value' : 'history_only') : (cur ? 'replaced' : 'created'), row: row(id) };
    })();
  }

  // b: { project, buildings, floors, units_new, units_existing, track, commercial, contractor, architect, as_of, source }
  function setProfile(actor, b) {
    const pid = store.findProject(b.project ?? b.project_id).id;
    const vals = [];
    for (const [k, v] of Object.entries(b)) {
      if (['project', 'project_id', 'as_of', 'as_of_date', 'source', 'by_owner', 'note'].includes(k) || v === undefined || v === null) continue;
      const f = fieldOf(k);
      vals.push([f, normValue(f, v)]);
    }
    if (!vals.length) throw bad(`לא הוזן אף שדה. השדות: ${Object.keys(FIELDS).join(', ')}`);
    const out = {};
    for (const [f, v] of vals) { const r = put(T.profile, actor, pid, f, v, b); out[f] = r.result; }
    return { project_id: pid, results: out, profile: getProfile(pid).fields };
  }
  // b: { project, process, text, as_of, source }
  function setStatus(actor, b) {
    const pid = store.findProject(b.project ?? b.project_id).id;
    const proc = processOf(b.process);
    const text = String(b.text ?? b.value ?? '').trim().replace(/\s+/g, ' ');
    if ([...text].length > 300) throw bad('שורת סטטוס עד 300 תווים: שורה אחת קצרה');
    const r = put(T.status, actor, pid, proc, text, b);
    return { project_id: pid, process: proc, result: r.result, status: decorate(T.status, r.row) };
  }

  // ---- reading
  function sourceInfo(type, id) {
    if (!id) return { type, id: null, label: type === 'manual' ? 'הבעלים' : type };
    if (type === 'email') { const e = q('SELECT COALESCE(original_subject, subject) s, COALESCE(forwarded_date, received_at) d FROM emails WHERE id=?').get(id); return { type, id, label: e ? `מייל: ${e.s || ''}`.trim() : `מייל ${id}`, link: `/email/${id}` }; }
    if (type === 'file') { const f = q('SELECT original_name n FROM files WHERE id=?').get(id); return { type, id, label: f ? `קובץ: ${f.n}` : `קובץ ${id}`, link: `/api/files/${id}/download?inline=1` }; }
    if (type === 'protocol') { const p = q('SELECT title FROM protocols WHERE id=?').get(id); return { type, id, label: p ? `פרוטוקול: ${p.title}` : `פרוטוקול ${id}`, link: `/protocols/${id}` }; }
    if (type === 'chat') return { type, id, label: 'הודעה בצ׳אט', link: null };
    return { type, id, label: type };
  }
  const decorate = (t, r) => r && ({ id: r.id, key: r[t.col], value: r.value, as_of: r.as_of_date, by_owner: !!r.by_owner, source: sourceInfo(r.source_type, r.source_id), created_at: r.created_at, current: r.superseded_by === null });
  function getProfile(projectId, { history = false } = {}) {
    const pid = typeof projectId === 'number' ? projectId : store.findProject(projectId).id;
    const fields = Object.entries(FIELDS).map(([k, d]) => {
      const cur = current(T.profile, pid, k);
      const hist = history ? q('SELECT * FROM project_profile WHERE project_id=? AND field=? AND superseded_by IS NOT NULL ORDER BY as_of_date DESC, id DESC').all(pid, k).map((r) => decorate(T.profile, r)) : undefined;
      return { field: k, label: d.he, hint: d.hint, kind: d.kind, ...(cur && cur.value !== '' ? decorate(T.profile, cur) : { value: null, cleared: !!cur }), ...(hist ? { history: hist } : {}) };
    });
    const statuses = Object.entries(PROCESSES).map(([k, he]) => {
      const cur = current(T.status, pid, k);
      const hist = history ? q('SELECT * FROM project_status WHERE project_id=? AND process=? AND superseded_by IS NOT NULL ORDER BY as_of_date DESC, id DESC').all(pid, k).map((r) => decorate(T.status, r)) : undefined;
      return { process: k, label: he, ...(cur && cur.value !== '' ? decorate(T.status, cur) : { value: null, cleared: !!cur }), ...(hist ? { history: hist } : {}) };
    });
    const v = Object.fromEntries(fields.map((f) => [f.field, f.value]));
    return { project_id: pid, fields, statuses, headline: headline(v) };
  }
  // "2 בניינים: 8 ו-12 קומות" / "בניין אחד, 8 קומות"
  function headline(v) {
    const raw = v.floors ? String(v.floors) : '';
    const fl = /^\d+(?:, \d+)*$/.test(raw) ? raw.split(', ') : null;
    const floors = !raw ? '' : !fl ? `קומות: ${raw}` : (fl.length === 1 ? `${fl[0]} קומות` : `${fl.slice(0, -1).join(', ')} ו-${fl[fl.length - 1]} קומות`);
    const b = v.buildings ? +v.buildings : null;
    if (b) return b === 1 ? `בניין אחד${floors ? ', ' + floors : ''}` : `${b} בניינים${floors ? ': ' + floors : ''}`;
    return floors;
  }
  function history(projectId, kind, key) {
    const pid = store.findProject(projectId).id;
    const t = kind === 'status' ? T.status : T.profile;
    const k = kind === 'status' ? processOf(key) : fieldOf(key);
    return q(`SELECT * FROM ${t.table} WHERE project_id=? AND ${t.col}=? ORDER BY as_of_date DESC, id DESC`).all(pid, k).map((r) => decorate(t, r));
  }
  // a short text block for the assistant's prompts
  function promptLine(pid) {
    const p = getProfile(pid);
    const f = p.fields.filter((x) => x.value).map((x) => `${x.label}=${x.value} (${x.as_of}${x.by_owner ? ', owner' : ''})`).join('; ') || '(empty)';
    const s = p.statuses.filter((x) => x.value).map((x) => `${x.key}: ${x.value} (${x.as_of}${x.by_owner ? ', owner' : ''})`).join(' | ') || '(none yet)';
    return `passport: ${f}\n   latest status per process: ${s}`;
  }

  // ---- fact topics
  function setFactTopic(actor, b) {
    const topic = String(b.topic || '').trim();
    if (!TOPICS[topic]) throw bad(`נושא לא מוכר: ${topic}. האפשרויות: ${Object.keys(TOPICS).join(', ')}`);
    let ids;
    if (b.id || b.fact) ids = [+(b.id || b.fact)];
    else { const pid = store.findProject(b.project ?? b.project_id).id; ids = q('SELECT id FROM project_facts WHERE project_id=? AND key=?').all(pid, String(b.key || '').trim()).map((r) => r.id); }
    if (!ids.length || ids.some((x) => !q('SELECT 1 FROM project_facts WHERE id=?').get(x))) throw bad('הנתון לא נמצא');
    // the whole key (its history too) gets the topic: one key, one group
    const keys = q(`SELECT DISTINCT project_id, key FROM project_facts WHERE id IN (${ids.join(',')})`).all();
    let n = 0;
    for (const k of keys) n += q('UPDATE project_facts SET topic=? WHERE project_id=? AND key=? AND COALESCE(topic,\'\')<>?').run(topic, k.project_id, k.key, topic).changes;
    return { updated: n, topic };
  }
  // facts nobody classified get a first topic from their words (run on demand and after the backfill)
  function fillTopics(projectId = null) {
    const rows = q(`SELECT id, project_id, key, value FROM project_facts WHERE topic IS NULL${projectId ? ' AND project_id=?' : ''}`).all(...(projectId ? [projectId] : []));
    const byKey = new Map();
    for (const r of rows) { const k = `${r.project_id}|${r.key}`; if (!byKey.has(k)) byKey.set(k, q('SELECT topic FROM project_facts WHERE project_id=? AND key=? AND topic IS NOT NULL LIMIT 1').get(r.project_id, r.key)?.topic || guessTopic(r.key, r.value)); q('UPDATE project_facts SET topic=? WHERE id=?').run(byKey.get(k), r.id); }
    return rows.length;
  }

  return { FIELDS, PROCESSES, TOPICS, setProfile, setStatus, getProfile, history, promptLine, setFactTopic, fillTopics, guessTopic, fieldOf, processOf };
}

module.exports = { createProfile, FIELDS, PROCESSES, TOPICS, guessTopic };
