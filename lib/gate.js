'use strict';
// The VALIDATION GATE: correctness is enforced by code, not trusted to the agent's rules. After every assistant run the runner calls
// check(); each violation becomes a specific Hebrew question that quotes the source text, the assistant answers through `mesimot apply`
// (at most 2 rounds). What is still open after that is accepted, but becomes an attention item and a "דורש בדיקה" badge on the task.
// Every violation and its outcome is logged in gate_log (shown on the activity screen, counted per invariant).
const { now } = require('./db');
const { wordRe } = require('./entities');
const { keywords } = require('./context');

const CODES = {
  project: 'שיוך לפרויקט', project_direct: 'פרויקט חדש רק באישור הבעלים', requester: 'מאת (שולח)', dates: 'תאריכים', people: 'אנשים שנזכרו', language: 'שפה', duplicate: 'כפילות',
  email_report: 'דיווח בצ׳אט על מייל', notfound: 'חיפוש מלא לפני "לא מצאתי"', attachments: 'קבצים מצורפים', facts: 'כרטיס הפרויקט', protocol: 'פרוטוקול', task_chat: 'שיחה על משימה', message: 'הודעה', summary: 'תקציר פרויקט', memory: 'זיכרון',
};
const NOTFOUND_RE = /(לא\s+מצאתי|אין\s+לי\s+(?:את|מידע|נתון|גישה|מסמך|ערך|שום)|לא\s+מופיע|אין\s+בידי|לא\s+נמצא\s+(?:אצלי|במערכת)|איני\s+יודע|אני\s+לא\s+יודע|אין\s+לי\s+את\s+החוזה|רק\s+את\s+המיילים)/;
const NEXT_STEP_RE = /(כדאי\s+לשאול|אפשר\s+לשאול|לשאול\s+את|תוכלו?\s+(?:להעלות|לשלוח)|העלו|העלה|שלחו|שלח\s+לי|אשמח\s+(?:אם|לקבל)|אפתח\s+משימ|לפתוח\s+משימ|משימת\s+מעקב|מי\s+ש(?:יכול|מחזיק)|נא\s+(?:לשלוח|להעלות)|לבקש\s+מ)/;
const CYR = /[Ѐ-ӿ]/;
const HEB = /[א-ת]/;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const quoteAt = (text, idx, len = 110) => clip(String(text).slice(Math.max(0, idx - 40), idx + len), len + 40);
const STOP_NAMES = new Set(['אני', 'אתה', 'הוא', 'היא', 'אנחנו', 'תבדוק', 'תבדקי', 'צריך', 'צריכה', 'יש', 'אין', 'כל', 'מי', 'מה', 'זה', 'זו', 'גם', 'אם', 'כי', 'לא', 'את', 'של', 'על', 'עם', 'אלכס', 'היום', 'מחר', 'אתמול', 'נא', 'בבקשה', 'תודה', 'שלום', 'היי']);
const LATIN_NOISE = /^(best|kind|warm|with|thanks|thank|regards|sincerely|dear|hi|hello|sent|from|to|cc|subject|date|please|brgds)\b/i;
const VERBS = '(?:ביקש|ביקשה|ביקשו|מבקש|מבקשת|מבקשים|אמר|אמרה|שאל|שאלה|רוצה|רוצים|הציע|הציעה|כתב|כתבה|דרש|דרשה|ממתין|ממתינה)';
const PROJ_PATTERN = /(?:^|[\s,;(])(?:מ|ב|ל|ה)?פרויקט\s+([\p{L}\p{N}"'׳״.\-]+(?:\s+[\p{L}\p{N}"'׳״.\-]+)?)/gu;
const ID_PATTERNS = [/\b\d{3}\.\d{3,4}\b/g, /מגרש(?:ים)?\s*\d+(?:\s*(?:ו-?|,|ו)\s*\d+)*/gu];

// addresses of the owner's own organisation and of the assistant's mailbox are not outside senders (domains come from the configuration)
const internalAddr = (email) => { const c = require('./config').get(); const dom = (a) => String(a || '').toLowerCase().split('@')[1] || ''; const doms = new Set([...c.owner.emails, c.owner.work_email, c.inbox, ...(c.internal_domains || []).map((d) => '@' + d)].map(dom).filter(Boolean)); return doms.has(dom(email)) || /agentmail\./i.test(email); };

function createGate({ db, store, knowledge, entities = null, searcher = null, semantic = null, projectAsk = null }) {
  const q = (sql) => db.prepare(sql);
  const stop = (n) => STOP_NAMES.has(n) || store.listPeople().some((p) => (p.role === 'owner' || p.role === 'assistant') && String(p.name_he).split(/\s+/)[0] === n);
  const isDefault = (t) => !!t.project_default;
  const log = (runId, code, taskId, detail, round, outcome) => q('INSERT INTO gate_log (run_id, at, code, task_id, detail, round, outcome) VALUES (?,?,?,?,?,?,?)').run(runId, now(), code, taskId ?? null, String(detail).slice(0, 600), round, outcome);

  // ---------- cheap code matchers
  function projectCandidates(text) {
    const t = String(text || '');
    const projects = store.listProjects().filter((p) => !p.is_default);
    const out = new Map(); // id -> why
    for (const p of projects) {
      const hit = [p.name_he, ...p.aliases].find((n) => n && [...String(n)].length >= 3 && wordRe(n).test(t));
      if (hit) out.set(p.id, { project: p, why: `השם או הכינוי "${hit}" מופיע במקור` });
    }
    for (const re of ID_PATTERNS) for (const m of t.matchAll(re)) {
      for (const p of projects) {
        const hay = `${p.name_he} ${p.aliases.join(' ')} ${knowledge.currentFacts(p.id).map((f) => `${f.key} ${f.value}`).join(' ')}`;
        const num = m[0].match(/\d+(?:\.\d+)?/g) || [];
        if (num.some((n) => hay.includes(n)) && !out.has(p.id)) out.set(p.id, { project: p, why: `המזהה "${m[0]}" מופיע בפרויקט` });
      }
    }
    const named = []; let skipped = 0; // names that wait for the owner's answer or that he rejected are not asked about again
    for (const m of t.matchAll(PROJ_PATTERN)) {
      const x = m[1].replace(/[,.;:]+$/, '').trim();
      const words = x.split(/\s+/);
      const hit = projects.find((p) => [p.name_he, ...p.aliases].some((n) => n && (String(n).toLowerCase() === x.toLowerCase() || String(n).toLowerCase() === words[0].toLowerCase())));
      if (hit) { if (!out.has(hit.id)) out.set(hit.id, { project: hit, why: `נכתב "פרויקט ${words[0]}"` }); }
      else if (!stop(words[0])) { if (projectAsk && projectAsk.lookup(words[0])) skipped++; else named.push({ name: words[0], quote: quoteAt(t, m.index) }); }
    }
    return { existing: [...out.values()], named, skipped };
  }
  const peopleIndex = () => store.listPeople().filter((p) => p.role !== 'owner' && p.role !== 'assistant');
  function namesIn(text) {
    const t = String(text || '');
    const found = [];
    for (const p of peopleIndex()) {
      const first = String(p.name_he).trim().split(/\s+/)[0];
      const forms = [p.name_he, first, p.name_en].filter((x) => x && [...String(x)].length >= 3);
      let idx = -1;
      for (const f of forms) { const m = wordRe(f).exec(t); if (m) { idx = m.index; break; } }
      if (idx >= 0) found.push({ person: p, quote: quoteAt(t, idx) });
    }
    return found;
  }
  // "<name> מפרויקט/מחברת ..." and the clause before a verb of asking: names nobody has created yet
  function unknownNames(text, { verbs = true } = {}) {
    const t = String(text || '');
    const known = store.listPeople();
    const isKnown = (n) => known.some((p) => [p.name_he, String(p.name_he).split(/\s+/)[0], p.name_en].filter(Boolean).some((x) => x.toLowerCase() === n.toLowerCase()));
    const out = new Map();
    for (const m of t.matchAll(/(?<![\p{L}])([\p{L}'"׳]{2,}(?:\s[\p{L}'"׳]{2,})?)\s+מ(?:פרויקט|חברת|משרד|הרשות|עיריית)\s+/gu)) {
      const parts = m[1].split(/\s+/);
      const name = parts.length === 2 && isKnown(parts[1]) ? parts[1] : parts[0];
      if (!stop(name) && HEB.test(name) && !isKnown(name)) out.set(name, quoteAt(t, m.index));
    }
    if (verbs) for (const m of t.matchAll(new RegExp(`(?:^|[.!?\\n]\\s*)([\\p{L}'"׳]{2,})\\s+(?:מ\\S+\\s+\\S+[,\\s]+)?(?:[^.\\n]{0,60}?)${VERBS}`, 'gu'))) {
      const name = m[1];
      if (!stop(name) && HEB.test(name) && !isKnown(name) && !/^(ה|ש|ו)/.test(name) && !out.has(name)) out.set(name, quoteAt(t, m.index));
    }
    for (const m of t.matchAll(/^\s*([A-Z][a-z]+ [A-Z][a-z]+)\s*$/gm)) if (!LATIN_NOISE.test(m[1]) && !isKnown(m[1])) out.set(m[1], quoteAt(t, m.index));
    return [...out.entries()].map(([name, quote]) => ({ name, quote }));
  }
  // who is asking in a chat message: "גלעד ביקש ...", "אבי מ... ביקש ..."
  function namedRequester(text) {
    const t = String(text || '');
    const m = new RegExp(`^\\s*([\\p{L}'"׳]{2,}(?:\\s[\\p{L}'"׳]{2,})?)\\s+[^.\\n]{0,70}?${VERBS}`, 'u').exec(t) || new RegExp(`(?<![\\p{L}])([\\p{L}'"׳]{2,})\\s+(?:מ\\S+\\s+\\S+[,\\s]+)?${VERBS}`, 'u').exec(t);
    if (!m) return null;
    const first = m[1].split(/\s+/)[0];
    if (stop(first)) return null;
    const hit = store.listPeople().filter((p) => p.role !== 'owner' && p.role !== 'assistant').find((p) => [p.name_he, String(p.name_he).split(/\s+/)[0], p.name_en].filter(Boolean).some((x) => x.toLowerCase() === first.toLowerCase() || x.toLowerCase() === m[1].toLowerCase()));
    return { name: first, person: hit || null, quote: quoteAt(t, m.index) };
  }
  const senderOf = (e) => {
    const raw = String(e.forwarded_from || e.from_addr || '');
    const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw);
    return { name: (m ? m[1] : '').replace(/["']/g, '').trim(), email: (m ? m[2] : raw).trim().toLowerCase(), raw };
  };
  const jaccard = (a, b) => { const A = new Set(keywords(a, 12)), B = new Set(keywords(b, 12)); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };

  // ---------- checks
  // source: { emails: [row], chats: [{id,text,created_at}], files: [row] }
  async function check(runId, source = {}, { round = 0 } = {}) {
    const emails = source.emails || [], chats = source.chats || [], files = source.files || [];
    const run = q('SELECT * FROM claude_runs WHERE id=?').get(runId);
    const assistant = store.assistantId();
    const evs = q("SELECT entity_id, action FROM events WHERE run_id=? AND entity='task' AND actor_id=? AND action IN ('create','update','decision')").all(runId, assistant);
    const created = new Set(evs.filter((e) => e.action === 'create').map((e) => e.entity_id));
    const touched = [...new Set(evs.map((e) => e.entity_id))];
    const V = [];
    const add = (code, taskId, question, key) => V.push({ code, task_id: taskId ?? null, question, key: key || `${code}:${taskId ?? '-'}` });
    const srcText = [...emails.map((e) => `${e.original_subject || e.subject || ''}\n${String(e.body_text || '').slice(0, 5000)}`), ...chats.map((c) => c.text), ...files.map((f) => `${f.original_name}`)].join('\n\n');
    const chatText = chats.map((c) => c.text).join('\n');
    const sourceOf = (t) => {
      const em = emails.find((e) => e.id === t.source_email_id) || (emails.length === 1 ? emails[0] : null);
      return em ? { kind: 'email', email: em, text: `${em.original_subject || em.subject || ''}\n${String(em.body_text || '').slice(0, 5000)}` } : chats.length ? { kind: 'chat', text: chatText, chats } : { kind: 'none', text: '' };
    };
    const task = (id) => { try { return store.getTask(id); } catch { return null; } };

    // a person created in this run with only a first name and no email is a PARTIAL person: set by code, not left to the agent
    for (const e of q("SELECT entity_id FROM events WHERE run_id=? AND entity='person' AND action='create' AND actor_id=?").all(runId, assistant)) {
      const p = q('SELECT * FROM people WHERE id=?').get(e.entity_id);
      if (p && p.role === 'contact' && p.status === 'full' && String(p.name_he).trim().split(/\s+/).length < 2 && JSON.parse(p.emails || '[]').length === 0) {
        q("UPDATE people SET status='partial' WHERE id=?").run(p.id);
        log(runId, 'people', null, `"${p.name_he}" נוצר עם שם פרטי בלבד, בלי דוא״ל: סומן כחלקי בקוד`, round, 'autofixed');
      }
    }
    // a NEW PROJECT is never created by the assistant: one written around the API is turned back into a question to the owner by code, and the run is told
    if (projectAsk && run) {
      for (const p of q('SELECT id, name_he FROM projects WHERE created_by=? AND is_default=0 AND created_at>=?').all(assistant, run.started_at || run.created_at || '')) {
        let r = null; try { r = projectAsk.revertDirect(p.id); } catch { /* keep going */ }
        if (r) { log(runId, 'project_direct', null, `הפרויקט "${p.name_he}" נוצר ישירות על ידי העוזר: הוחזר להצעה לבעלים (${r.status})`, round, 'autofixed'); add('project_direct', null, `הפרויקט "${p.name_he}" נוצר על ידי העוזר, ואסור: פרויקט חדש נוצר רק באישור הבעלים. הקוד ביטל אותו והעביר את הפריטים ללא פרויקט (${r.status === 'pending_approval' ? 'נשלחה שאלה לבעלים' : r.status}). להבא: mesimot project propose "<שם>" --aliases <כינויים> --from email:<id> ואל תשייכו לפרויקט עד לתשובה.`, `project_direct:${p.id}`); }
      }
      try { projectAsk.sweepAll(); } catch { /* optional */ }
    }
    for (const id of touched) {
      const t = task(id);
      if (!t || t.status_closed) continue;
      const isNew = created.has(id);
      const src = sourceOf(t);
      const text = src.text || `${t.title}\n${t.description || ''}`;
      const qt = (s) => `"${clip(s, 170)}"`;

      // 1. project
      if (isDefault(t)) {
        const hasReason = t.unassigned_reason && q("SELECT 1 FROM attention WHERE task_id=? AND kind='question' AND status='open'").get(id);
        if (!hasReason && !(projectAsk && projectAsk.pendingFor('task', id))) {
          const c = projectCandidates(`${t.title}\n${t.description || ''}\n${text}`);
          const bits = [];
          if (c.existing.length) bits.push(`פרויקטים קיימים שמתאימים: ${c.existing.slice(0, 4).map((x) => `${x.project.id} "${x.project.name_he}" (${x.why})`).join('; ')}`);
          if (c.named.length) bits.push(`נזכר פרויקט שעוד לא קיים: ${c.named.slice(0, 2).map((n) => `"${n.name}" (במקור: ${qt(n.quote)})`).join('; ')} - אסור ליצור אותו בעצמכם: הציעו אותו לבעלים (mesimot project propose "<שם>" --aliases <כינויים> --from email:<id>) והשאירו את המשימה ללא פרויקט עד לתשובתו`);
          if (!(c.skipped && !c.existing.length && !c.named.length)) // only a pending / rejected name: the task stays unassigned, no question
            add('project', id, `המשימה ${id} "${clip(t.title, 80)}" נוצרה בלי פרויקט (לא משויך).${src.kind !== 'none' ? ` במקור נכתב: ${qt(text)}.` : ''} לאיזה פרויקט היא שייכת? ${bits.join('. ')}${bits.length ? '.' : ''} אם באמת אין פרויקט, ציינו unassigned_reason וצרו שאלה לבעלים (mesimot attention add --kind question --task ${id}).`);
        }
      }
      // 5. language (created or updated)
      const lang = `${t.title} ${t.description || ''}`;
      const latin = (lang.match(/[A-Za-z]{3,}/g) || []).length;
      if (CYR.test(lang)) add('language', id, `בכותרת או בתיאור של המשימה ${id} יש כתב קירילי: "${clip(lang, 120)}". כל מה שנכתב באתר צריך להיות בעברית. נסחו מחדש בעברית.`);
      else if (!HEB.test(t.title) && /[A-Za-z]{3,}/.test(t.title)) add('language', id, `כותרת המשימה ${id} אינה בעברית: "${t.title}". נסחו אותה בעברית (לטינית רק בשמות, קודים ודגמים).`);
      else if (latin >= 5 && latin > (lang.match(/[א-ת]{2,}/g) || []).length) add('language', id, `התיאור של המשימה ${id} כמעט כולו בלועזית. נסחו אותו בעברית.`);
      if (!isNew) continue;

      // 3. dates: source_date and due_source are filled by code; a missing due date needs the assistant's judgement
      if (!t.source_date) {
        const when = src.kind === 'email' ? (src.email.forwarded_date || src.email.received_at) : (src.kind === 'chat' ? src.chats[0].created_at : t.created_at);
        q('UPDATE tasks SET source_date=? WHERE id=?').run(when, id); log(runId, 'dates', id, `source_date הושלם בקוד: ${when}`, round, 'autofixed');
      }
      if (t.due_date && !t.due_source) { q("UPDATE tasks SET due_source='estimated' WHERE id=?").run(id); log(runId, 'dates', id, 'due_source הושלם בקוד: estimated', round, 'autofixed'); }
      if (!t.due_date) add('dates', id, `למשימה ${id} "${clip(t.title, 80)}" אין תאריך יעד. קבעו יעד (מפורש אם נכתב${src.kind !== 'none' ? ` במקור: ${qt(text)}` : ''}, אחרת משוער לפי הדחיפות) עם due_source, והוסיפו הערה על ההערכה.`);

      // 2. requester
      if (!t.requester_id) add('requester', id, `למשימה ${id} "${clip(t.title, 80)}" לא הוגדר "מאת". ${src.kind === 'email' ? `השולח המקורי של המייל: ${senderOf(src.email).raw}.` : `במקור נכתב: ${qt(text)}.`} מי ביקש? (אם זה איש חדש, צרו אותו; אם הבעלים עצמו - הבעלים).`);
      else if (src.kind === 'email') {
        const s = senderOf(src.email);
        const exp = store.listPeople().find((p) => p.emails.includes(s.email));
        if (exp && exp.id !== t.requester_id && exp.role !== 'owner') add('requester', id, `המשימה ${id} נוצרה ממייל שנשלח במקור על ידי ${exp.name_he} (${s.email}), אבל "מאת" הוא ${t.requester}. תקנו את "מאת" לשולח המקורי, או הסבירו מדוע לא.`);
        else if (!exp && s.email && !internalAddr(s.email) && !q('SELECT 1 FROM people WHERE id=? AND (emails LIKE ? OR name_he=?)').get(t.requester_id, `%${s.email}%`, s.name || '\u0000')) {
          // the sender is unknown and the requester is someone else: ask
          add('requester', id, `השולח המקורי של המייל הוא ${s.raw}, ולא ${t.requester}. אם זה איש חדש, צרו אותו כאיש קשר ושייכו אליו את המשימה; אם "מאת" נכון, הסבירו.`);
        }
      } else if (src.kind === 'chat') {
        const nr = namedRequester(chatText);
        if (nr && nr.person && nr.person.id !== t.requester_id) add('requester', id, `בהודעה נכתב: ${qt(nr.quote)}. "מאת" במשימה ${id} הוא ${t.requester}, אבל מי שביקש הוא ${nr.person.name_he}. תקנו.`);
        else if (nr && !nr.person && t.requester_id === store.ownerId()) add('requester', id, `בהודעה נכתב: ${qt(nr.quote)}. "${nr.name}" אינו ברשימת האנשים, ו"מאת" במשימה ${id} הוא הבעלים. צרו את "${nr.name}" כאיש חלקי (mesimot person add --name ${nr.name} --status partial) והגדירו אותו כ"מאת".`);
      }

      // 6. duplicates of OPEN tasks
      for (const o of store.listTasks({ open: '1' }).filter((x) => x.id !== id)) {
        const sim = jaccard(t.title, o.title);
        if (sim < 0.6) continue;
        const decided = q("SELECT 1 FROM decisions WHERE run_id=? AND task_id=?").get(runId, o.id) || q("SELECT 1 FROM entity_decisions WHERE entity_type='dup' AND entity_id=? AND identity=?").get(id, `of:${o.id}`);
        if (!decided) add('duplicate', id, `המשימה החדשה ${id} "${clip(t.title, 80)}" דומה מאוד (${Math.round(sim * 100)}%) למשימה הפתוחה ${o.id} "${clip(o.title, 80)}" (${o.status}). החליטו במפורש: למזג (לסגור את אחת ולרשום סיבה), לקשר, או לציין שהן שונות (dup_checks: [{"task": ${id}, "of": ${o.id}, "verdict": "different", "reason": "..."}] או decisions על ${o.id}).`, `duplicate:${id}:${o.id}`);
      }
    }

    // 4. people named in the source: linked (requester/assignee/mention/participant) or dismissed, unknown ones created as partial
    // (import runs: people are created from the mail headers and linked by code; naming every person in a mail is not asked, it only cost re-prompts)
    if (srcText.trim() && (created.size || touched.length) && !(run && run.trigger === 'import')) {
      const linkedIds = new Set();
      for (const id of touched) { const t = task(id); if (t) { if (t.requester_id) linkedIds.add(t.requester_id); if (t.assignee_id) linkedIds.add(t.assignee_id); } }
      for (const e of emails) { for (const x of JSON.parse(e.participants || '[]')) { const pe = q('SELECT id FROM people WHERE emails LIKE ?').get(`%${String(x.email || '').toLowerCase()}%`); if (pe && x.email) linkedIds.add(pe.id); } }
      const mentioned = (pid) => q("SELECT 1 FROM mentions WHERE entity_type='person' AND entity_id=? AND ((source_type='chat' AND source_id IN (" + (chats.map((c) => c.id).join(',') || '0') + ")) OR (source_type='email' AND source_id IN (" + (emails.map((e) => e.id).join(',') || '0') + ")) OR (source_type='task' AND source_id IN (" + (touched.join(',') || '0') + ')))').get(pid);
      const dismissed = (name) => q("SELECT 1 FROM entity_decisions WHERE entity_type='name' AND entity_id=? AND identity=?").get(runId, String(name).toLowerCase());
      let n = 0;
      for (const f of namesIn(srcText)) {
        if (linkedIds.has(f.person.id) || mentioned(f.person.id) || dismissed(f.person.name_he) || dismissed(String(f.person.name_he).split(/\s+/)[0])) continue;
        if (++n > 3) break;
        add('people', null, `במקור נזכר ${f.person.name_he} (${[f.person.role_text, f.person.company].filter(Boolean).join(', ') || 'איש קשר'}): "${f.quote}". הוא לא קושר לאף משימה. קשרו אותו (מאת / אחראי / mentions) או אשרו שאינו רלוונטי (dismiss_names: [{"name": "${f.person.name_he}", "reason": "..."}]).`, `people:${f.person.id}`);
      }
      for (const u of unknownNames(chatText || srcText, { verbs: !!chatText }).slice(0, 3)) {
        if (dismissed(u.name) || store.listPeople().some((p) => String(p.name_he).split(/\s+/)[0] === u.name)) continue;
        add('people', null, `במקור נכתב: "${u.quote}". "${u.name}" לא קיים ברשימת האנשים. צרו אותו כאיש חלקי עם מה שידוע (mesimot person add --name ${u.name} --status partial --role-text "..."), קשרו אותו, או אשרו שאינו רלוונטי (dismiss_names).`, `people:new:${u.name}`);
      }
    }

    // 7. email source: chat report, attachments looked at, project facts attempted
    if (emails.length && run && !['reconcile', 'curator', 'pulse'].includes(run.trigger)) {
      const reported = run.trigger === 'import' || q("SELECT 1 FROM chat_messages WHERE author='claude' AND created_at >= ?").get(run.started_at); // imports report through the morning digest, not per thread
      if (!reported) add('email_report', null, `בעקבות המייל ${emails.map((e) => e.id).join(', ')} לא נשלח דיווח בצ׳אט. דווחו בקצרה: מה למדתם, מה נסגר או עודכן, מה נפתח (chat_message ב-apply).`);
      // every non-signature attachment ends with a summary, a project link and facts checked (facts_checked is set by `apply` files[] / facts with source file:ID)
      for (const e of emails) for (const f of q('SELECT id, original_name, project_id, summary, facts_checked, text_status, (SELECT COUNT(*) FROM chunks WHERE file_id=files.id) AS n FROM files WHERE email_id=? AND id <> COALESCE((SELECT file_id FROM emails WHERE id=?), 0)').all(e.id, e.id)) { // the exported mail file itself is the email, not an attachment
        const lacks = [];
        if (!f.summary) lacks.push('תקציר (2 עד 4 שורות)');
        if (!f.project_id || store.listProjects().find((p) => p.id === f.project_id)?.is_default) lacks.push('שיוך לפרויקט');
        if (!f.facts_checked) lacks.push('בדיקת נתונים לכרטיס הפרויקט (facts עם source "file:' + f.id + '" או facts_checked: true)');
        if (lacks.length) add('attachments', null, `הקובץ המצורף "${f.original_name}" (file ${f.id}, ${f.n} חלקי טקסט) של המייל ${e.id} חסר: ${lacks.join(', ')}. קראו אותו (mesimot show file ${f.id}; בקובץ גדול קראו לפי קטעים עם show chunk)${knowledge.textPoor(f.id) ? ' הטקסט שחולץ ממנו דל (תמונה, שרטוט או סריקה): פתחו את הקובץ עצמו עם כלי Read על view_path שמופיע ב-show file ותארו מה רואים.' : ''} ושלחו ב-apply: "files": [{"id": ${f.id}, "project": ..., "summary": "...", "facts_checked": true}] ו-"facts" עם הערכים החוזיים, התאריכים, מספרי המגרש/התוכנית והצדדים (עם source "file:${f.id}" וכן הסעיף או העמוד).`, `attachments:${f.id}`);
      }
      if (!run.facts_checked) add('facts', null, `לא נבדקו נתונים לכרטיס הפרויקט מהמייל ${emails.map((e) => e.id).join(', ')}. הוציאו ממנו נתונים מתוארכים (facts: [...] ב-apply) או ציינו במפורש שאין (facts: [] ו-facts_checked: true).`);
    }

    // 8. protocols created in this run
    for (const e of q("SELECT entity_id FROM events WHERE run_id=? AND entity='protocol' AND action='create'").all(runId)) {
      const bad = q("SELECT id, text FROM protocol_items WHERE protocol_id=? AND kind='action' AND COALESCE(owner_name,'')='' AND owner_person_id IS NULL").all(e.entity_id);
      if (bad.length) add('protocol', null, `בפרוטוקול ${e.entity_id} יש ${bad.length} סעיפי פעולה בלי אחראי: ${bad.slice(0, 3).map((b) => `"${clip(b.text, 60)}"`).join(', ')}. ציינו אחראי לכל סעיף, או סמנו owner "לא ידוע" במפורש.`, `protocol:${e.entity_id}`);
    }
    // 9. DON'T GIVE UP: a chat reply that says "not found / I don't have" is accepted only after the full search ladder (read from run_trace, not from the
    // agent's word): ask with expansions, the project card, the attachment chunks of the related emails and projects, the chat history, 3+ distinct phrasings.
    // If everything was tried and it is still not found, the reply must offer the next best step (who to ask, what to upload, a follow-up task).
    if (run && run.trigger === 'chat' && chats.length) {
      const replies = q("SELECT text FROM chat_messages WHERE author='claude' AND created_at >= ?").all(run.started_at).map((r) => r.text).join('\n');
      if (NOTFOUND_RE.test(replies)) {
        const tr = q('SELECT kind, arg, extra FROM run_trace WHERE run_id=?').all(runId).map((r) => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : null }));
        const asks = tr.filter((r) => r.kind === 'ask');
        const projects = new Set(asks.map((a) => a.extra?.project).filter(Boolean));
        for (const c of projectCandidates(chatText).existing) projects.add(c.project.id);
        const emailIds = new Set(asks.flatMap((a) => a.extra?.emails || []));
        const relevant = [...(emailIds.size ? q(`SELECT id, original_name, email_id FROM files WHERE email_id IN (${[...emailIds].join(',')})`).all() : []), ...(projects.size ? q(`SELECT id, original_name, email_id FROM files WHERE project_id IN (${[...projects].join(',')})`).all() : [])]
          .filter((f, i, a) => a.findIndex((x) => x.id === f.id) === i).map((f) => ({ ...f, n: q('SELECT COUNT(*) n FROM chunks WHERE file_id=?').get(f.id).n })).filter((f) => f.n > 0).slice(0, 12);
        const seen = new Set([...asks.flatMap((a) => a.extra?.files || []), ...tr.filter((r) => r.kind === 'open_file').map((r) => +r.arg), ...tr.filter((r) => r.kind === 'open_chunk').map((r) => q('SELECT file_id FROM chunks WHERE id=?').get(+r.arg)?.file_id).filter(Boolean)]);
        const phr = new Set([...asks.flatMap((a) => a.extra?.phrasings || []), ...tr.filter((r) => r.kind === 'search').map((r) => r.arg)].map((x) => String(x).trim().toLowerCase()));
        const missing = [];
        if (!asks.length) missing.push('הריצו `mesimot ask "<השאלה>"` (הוא מרחיב את השאלה במילים נרדפות, כמו טרפו/שנאי ו-ערך/תמורה, ומחפש במיילים, בקבצים ובכרטיס הפרויקט)');
        if (projects.size && !asks.some((a) => a.extra?.project) && !tr.some((r) => r.kind === 'fact_list' || r.kind === 'project_show')) missing.push('קראו את כרטיס הפרויקט (`mesimot project show <פרויקט>` או `mesimot fact list --project ...`)');
        const unseen = relevant.filter((f) => !seen.has(f.id));
        if (unseen.length) missing.push(`לא נפתחו קבצים מצורפים רלוונטיים: ${unseen.map((f) => `${f.email_id ? `למייל ${f.email_id} ` : ''}מצורף קובץ ${f.id} "${clip(f.original_name, 50)}" (${f.n} חלקים)`).join('; ')}. חפשו בהם (\`mesimot ask\`, \`mesimot show file ID\`) לפני שאתם עונים`);
        if (!tr.some((r) => r.kind === 'chat_list')) missing.push('עברו על היסטוריית הצ׳אט (`mesimot chat list`): ייתכן שהתשובה כבר נאמרה');
        if (phr.size < 3) missing.push(`נוסו רק ${phr.size} ניסוחי חיפוש שונים. נסו לפחות 3 (מילים נרדפות, שם הפרויקט, מספרי מגרש/תוכנית)`);
        if (missing.length) add('notfound', null, `ענית שלא מצאת / שאין לך את המידע, אבל סולם החיפוש לא הושלם (לפי יומן הריצה):\n- ${missing.join('\n- ')}\nבצעו את הצעדים החסרים. אם נמצא: ענו, ציינו קובץ ועמוד, ושמרו נתון בכרטיס הפרויקט (facts עם source file:ID). רק אם עדיין אין: כתבו זאת ביושר.`, 'notfound:ladder');
        else if (!NEXT_STEP_RE.test(replies)) add('notfound', null, 'כל שלבי החיפוש בוצעו והמידע לא נמצא. תשובה כזו חייבת לכלול את הצעד הבא הטוב ביותר: את מי לשאול, איזה מסמך להעלות, או הצעה לפתוח משימת מעקב. הוסיפו אותו להודעה.', 'notfound:next');
      }
    }
    // 10. TASK-SCOPED CHAT: a message written in a task card gets a reply in that task's thread; the changes go to THAT task (another task only when the reply says so);
    // a reply that claims a change must be backed by an action; "send to everyone" is not enabled: drafts and an honest answer instead.
    if (run && run.trigger === 'chat' && run.pinned_task_id) {
      const tid = run.pinned_task_id, T = task(tid);
      const owners = q("SELECT text FROM chat_messages WHERE author='owner' AND scope='task' AND task_id=? AND created_at >= ?").all(tid, run.started_at).map((r) => r.text).join('\n');
      const replies = q("SELECT text FROM chat_messages WHERE author='claude' AND scope='task' AND task_id=? AND created_at >= ?").all(tid, run.started_at).map((r) => r.text).join('\n');
      if (!replies.trim()) add('task_chat', tid, `בכרטיס המשימה ${tid}${T ? ` "${clip(T.title, 60)}"` : ''} נכתבה הודעה אליך ולא נשלחה תשובה בשיחה של המשימה. ענו (mesimot chat send --text "...": התשובה נכנסת אוטומטית לשיחה של המשימה): ציינו בדיוק מה שונה, או ענו על השאלה.`, 'task_chat:reply');
      else {
        const evs2 = q("SELECT entity_id, action, field FROM events WHERE run_id=? AND entity='task' AND actor_id=?").all(runId, assistant);
        const others = [...new Set(evs2.filter((e) => e.entity_id !== tid).map((e) => e.entity_id))];
        const unnamed = others.filter((id) => !new RegExp(`(^|\\D)${id}(\\D|$)`).test(replies) && !(task(id) && replies.includes(clip(task(id).title, 25).replace('…', ''))));
        if (unnamed.length) add('task_chat', tid, `בשיחה על משימה ${tid} שונו גם משימות אחרות (${unnamed.join(', ')}) ובתשובה לא נאמר זאת. שינוי במשימה אחרת מותר רק כשהבעלים ביקש, והתשובה חייבת לציין אותה במפורש (מספר וכותרת). אם לא התכוונתם, בטלו את השינוי.`, 'task_chat:others');
        const claims = /(עדכנתי|שיניתי|הזזתי|דחיתי|הקדמתי|הוספתי|סגרתי|שייכתי|שיבצתי|פיצלתי|רשמתי|העברתי|מחקתי|הסרתי)/.test(replies);
        const did = evs2.some((e) => e.entity_id === tid) || q("SELECT 1 FROM events WHERE run_id=? AND actor_id=? AND entity IN ('note','draft','task','outbox')").get(runId, assistant);
        if (claims && !did) add('task_chat', tid, `בתשובה כתוב ששיניתם משהו במשימה ${tid}, אבל לא נרשמה שום פעולה על המשימה בהרצה הזו. בצעו את השינוי בפועל (mesimot apply / task update / note add), או תקנו את התשובה.`, 'task_chat:claim');
        if (/(שלח|תשלח|שלחי|תזכיר|תעדכן|תכתוב)[^\n]{0,40}(לכולם|לכל מי|לנמענים|לאנשים|למי שמוזכר|לצד השני)/.test(owners)) {
          const drafted = q('SELECT 1 FROM drafts WHERE task_id=? AND created_at >= ?').get(tid, run.started_at);
          if (!drafted || !/(עדיין לא|טרם|לא מופעל|לא זמין|אינו מופעל)/.test(replies)) add('task_chat', tid, 'הבעלים ביקש לשלוח משהו לאנשים אחרים. המערכת לא שולחת דוא״ל לאף אחד חוץ מהבעלים (עדיין לא מופעל). ענו זאת במפורש, והכינו טיוטה לכל נמען (mesimot draft add --task ' + tid + ' --text "אל: שם <כתובת>\\n...") עם שמות וכתובות מהמשתתפים במיילים של המשימה, כדי שהבעלים יעתיק.', 'task_chat:outward');
        }
      }
    }
    // 11. ENTITY-SCOPED CHAT (project / person / protocol / calendar day): a reply in that thread, and a claimed change is backed by a logged action
    if (run && run.trigger === 'chat' && run.pinned_ref && !run.pinned_task_id) {
      const ref = run.pinned_ref;
      const replies = q("SELECT text FROM chat_messages WHERE author='claude' AND scope='entity' AND scope_ref=? AND created_at >= ?").all(ref, run.started_at).map((r) => r.text).join('\n');
      if (!replies.trim()) add('entity_chat', null, `בשיחה של ${ref} נכתבה הודעה אליך ולא נשלחה תשובה בשיחה הזו. ענו (mesimot chat send --text "...": התשובה נכנסת אוטומטית לשיחה): ציינו בדיוק מה שונה (ישן -> חדש), או ענו על השאלה.`, 'entity_chat:reply');
      else {
        const claims = /(עדכנתי|שיניתי|הזזתי|דחיתי|הקדמתי|הוספתי|שייכתי|העברתי|מיזגתי|מחקתי|הסרתי|שיניתי את השם|צבעתי|רשמתי|תיקנתי)/.test(replies);
        const did = q("SELECT 1 FROM events WHERE run_id=? AND actor_id=? AND entity<>'chat'").get(runId, assistant);
        if (claims && !did) add('entity_chat', null, `בתשובה כתוב ששיניתם משהו ב-${ref}, אבל לא נרשמה שום פעולה בהרצה הזו. בצעו את השינוי בפועל (mesimot apply / CLI) או תקנו את התשובה. מחיקה לצמיתות נעשית רק דרך mesimot confirm ... ואישור הבעלים.`, 'entity_chat:claim');
      }
    }
    return V;
  }

  // ---------- the loop's bookkeeping
  const keyOf = (v) => `${v.code}|${v.key}`;
  function questionText(violations, round) {
    return `TRIGGER: validation gate, round ${round} of 2 (no one is waiting). The code checked what you just did and found problems. Each one quotes the source. Re-check and fix ALL of them in ONE \`mesimot apply\` call (or the CLI), then finish with \`mesimot run-summary\`. Do not repeat things already done.\n\n${violations.map((v, i) => `${i + 1}. [${CODES[v.code] || v.code}] ${v.question}`).join('\n\n')}`;
  }
  // after the last round: accept, but make it visible
  function accept(runId, violations, round) {
    // an import run never adds attention items per email: what stays open is logged and summarised once in the import digest
    const inImport = q("SELECT 1 FROM claude_runs WHERE id=? AND import_id IS NOT NULL").get(runId);
    for (const v of violations) {
      log(runId, v.code, v.task_id, v.question, round, 'accepted');
      if (v.task_id) q('UPDATE tasks SET needs_review=1 WHERE id=?').run(v.task_id);
      if (inImport) continue;
      const text = `דורש בדיקה (${CODES[v.code] || v.code}): ${clip(v.question, 260)}`;
      if (!q("SELECT 1 FROM attention WHERE status='open' AND text=?").get(text)) q('INSERT INTO attention (kind, text, task_id, created_at) VALUES (?,?,?,?)').run('question', text, v.task_id, now());
    }
  }
  const logRaised = (runId, violations, round) => { for (const v of violations) log(runId, v.code, v.task_id, v.question, round, 'raised'); };
  const logResolved = (runId, prev, now2, round) => {
    const still = new Set(now2.map(keyOf));
    for (const v of prev) if (!still.has(keyOf(v))) log(runId, v.code, v.task_id, v.question, round, 'resolved');
  };
  function stats(days = 30) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return q("SELECT code, SUM(outcome='raised' AND round=0) AS raised, SUM(outcome='resolved') AS resolved, SUM(outcome='accepted') AS accepted, SUM(outcome='autofixed') AS autofixed FROM gate_log WHERE at >= ? GROUP BY code ORDER BY raised DESC").all(since).map((r) => ({ ...r, label: CODES[r.code] || r.code }));
  }

  // ---------- other jobs: pulse message, curator
  function checkMessage(text, items) {
    const V = [];
    const lines = String(text).split('\n').filter((l) => l.trim());
    if (CYR.test(text)) V.push({ code: 'message', key: 'cyr', question: 'ההודעה מכילה כתב קירילי. כתבו אותה מחדש בעברית בלבד.' });
    else if (!HEB.test(text)) V.push({ code: 'message', key: 'lang', question: 'ההודעה אינה בעברית. כתבו אותה בעברית.' });
    if (lines.length > 5) V.push({ code: 'message', key: 'long', question: `ההודעה ארוכה (${lines.length} שורות). קצרו ל-1 עד 4 שורות, הכי חשוב קודם.` });
    if (items.length && !/\/(task|email|projects)\/\d+/.test(text)) V.push({ code: 'message', key: 'links', question: 'בהודעה אין קישורים. הוסיפו לכל פריט את הקישור שניתן (כתובת מלאה).' });
    return V;
  }
  function checkCurator(runId, { wordsAfter, limit }) {
    const V = [];
    const run = q('SELECT started_at FROM claude_runs WHERE id=?').get(runId);
    for (const p of store.listProjects().filter((x) => x.status === 'פעיל' && !x.is_default)) {
      const upd = q("SELECT 1 FROM events WHERE run_id=? AND entity='project' AND entity_id=? AND field='summary_he'").get(runId, p.id);
      if (!upd) V.push({ code: 'summary', task_id: null, key: `summary:${p.id}`, question: `התקציר של הפרויקט ${p.id} "${p.name_he}" לא רוענן. כתבו תקציר מעודכן (3 עד 6 שורות) ב-projects של apply.` });
      else if (CYR.test(p.summary_he || '')) V.push({ code: 'summary', task_id: null, key: `summary:${p.id}`, question: `התקציר של הפרויקט ${p.id} מכיל כתב קירילי. כתבו אותו בעברית.` });
    }
    if (wordsAfter > limit * 1.3) V.push({ code: 'memory', task_id: null, key: 'memory', question: `קבצי הזיכרון עדיין ארוכים (${wordsAfter} מילים, היעד כ-${limit}). קצרו אותם: מזגו כפילויות והסירו פריטים לא עדכניים.` });
    // (the curator no longer posts to the chat: its report is the run summary)
    return V;
  }

  return { check, checkMessage, checkCurator, questionText, accept, logRaised, logResolved, log, stats, projectCandidates, namesIn, unknownNames, namedRequester, jaccard, CODES };
}

module.exports = { createGate, CODES };
