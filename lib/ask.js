'use strict';
// `mesimot ask "<question>"`: retrieval for Q&A. The question is expanded with a small Hebrew construction-domain synonym list (a document
// says "שנאי / התמורה" where the owner says "חדר טרפו / ערך"), every phrasing is searched (keyword + semantic), the lists are fused with
// reciprocal rank fusion, restricted to the detected project (with a weaker unrestricted pass for files not yet linked), and the answer
// comes back with file name, page and the chunk text, plus the attachments of the emails found.
const { keywords } = require('./context');

// groups of words that mean the same thing in this domain; the curator may extend them (settings key ask_synonyms, JSON array of arrays)
const SYNONYMS = [
  ['טרפו', 'שנאי', 'שנאים', 'חדר שנאים', 'חח"י', 'חברת החשמל', 'חשמל'],
  ['ערך', 'סכום', 'תמורה', 'מחיר', 'עלות', 'שווי', 'תשלום', 'ש"ח', '₪'],
  ['חוזה', 'הסכם', 'התקשרות', 'חוזה מכר', 'נספחים'],
  ['מועד', 'תאריך', 'מסירה', 'לוח זמנים', 'עד ליום'],
  ['היתר', 'היתר בנייה', 'רישיון בנייה', 'טופס 4'],
  ['קבלן', 'קבלן ראשי', 'מבצע', 'קבלן שלד'],
  ['יועץ', 'מתכנן', 'אדריכל', 'מהנדס'],
  ['ערבות', 'בטוחה', 'ערבות בנקאית', 'פיקדון'],
  ['שטח', 'מ"ר', 'מטר רבוע', 'גודל'],
  ['קומות', 'קומה', 'מפלסים'],
  ['דירות', 'יחידות דיור', 'יח"ד'],
  ['פיצוי', 'קנס', 'פיצוי מוסכם', 'עיכוב'],
  ['תוכנית', 'תב"ע', 'תכנית', 'תוכנית בניין עיר'],
  ['מגרש', 'חלקה', 'גוש', 'תא שטח'],
  ['בטון', 'יציקה', 'יציקות'],
  ['פיגומים', 'פיגום', 'התקנת פיגומים'],
];
const PREFIX = /^(?:ה|ב|ל|מ|ו|ש|כ|וה|לה|מה|שה|בה|וב|ול|ומ)(?=.{3,})/u;
const stripPrefix = (w) => w.replace(PREFIX, '');

function createAsk({ db, store, knowledge, searcher, semantic, trace }) {
  const groups = () => {
    let extra = [];
    try { extra = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='ask_synonyms'").get()?.value || '[]'); } catch { /* ignore */ }
    return [...SYNONYMS, ...extra.filter((g) => Array.isArray(g) && g.length > 1)];
  };
  const norm = (s) => String(s).toLowerCase();
  const groupOf = (tok) => groups().find((g) => g.some((w) => norm(w) === norm(tok) || norm(w) === norm(stripPrefix(tok)) || (norm(w).includes(' ') === false && norm(stripPrefix(tok)).startsWith(norm(w)) && norm(w).length >= 4)));

  // up to 6 phrasings: the original, then each synonym group alone with the other keywords
  function expand(question) {
    const toks = keywords(question, 12);
    const out = [{ q: String(question).trim(), why: 'original' }];
    const used = [];
    for (const t of toks) { const g = groupOf(t); if (g && !used.includes(g)) used.push(g); }
    const rest = toks.filter((t) => !groupOf(t)).slice(0, 4);
    for (const g of used) {
      const alts = g.filter((w) => !toks.some((t) => norm(stripPrefix(t)) === norm(w))).slice(0, 4);
      if (alts.length) out.push({ q: [...rest, ...alts].join(' '), why: `synonyms: ${g.slice(0, 3).join('/')}` });
    }
    if (used.length > 1) out.push({ q: used.map((g) => g.slice(0, 2).join(' ')).join(' '), why: 'domain terms only' });
    if (rest.length) out.push({ q: rest.join(' '), why: 'keywords only' });
    const seen = new Set();
    return out.filter((x) => x.q && !seen.has(x.q) && seen.add(x.q)).slice(0, 6);
  }

  const detectProject = (text) => {
    const hay = norm(text);
    const hits = store.listProjects().filter((p) => !p.is_default && [p.name_he, ...p.aliases].some((n) => n && n.length >= 3 && hay.includes(norm(n))));
    return hits.length === 1 ? hits[0] : null;
  };

  async function ask({ q: question, project = null, limit = 10 }) {
    question = String(question || '').trim();
    if (!question) { const e = new Error('נדרשת שאלה'); e.status = 400; throw e; }
    const proj = project ? store.findProject(project) : detectProject(question);
    const phrasings = expand(question);
    const score = new Map(); // key -> {r, s}
    const bump = (r, rank, w) => { const e = score.get(r.key) || { r, s: 0, hits: 0 }; e.s += w / (60 + rank); e.hits++; score.set(r.key, e); };
    const kinds = 'chunk,fact,knowledge,email,note,task,protocol_item,file';
    for (const ph of phrasings) {
      for (const scoped of proj ? [true, false] : [false]) {
        let res; try { res = await searcher.searchHybrid({ q: ph.q, limit: 25, kind: kinds, ...(scoped ? { project: proj.id } : {}) }, semantic); } catch { continue; }
        res.results.forEach((r, i) => bump(r, i, (scoped ? 1 : proj ? 0.6 : 1) * (ph.why === 'original' ? 1.2 : 1)));
      }
    }
    const top = [...score.values()].sort((a, b) => b.s - a.s).slice(0, Math.min(Math.max(+limit || 10, 1), 25));
    const fileOf = db.prepare('SELECT f.id, f.original_name, f.summary, f.email_id FROM files f WHERE f.id=?');
    const chunk = db.prepare('SELECT id, file_id, idx, page, text FROM chunks WHERE id=?');
    const results = top.map(({ r, s, hits }) => {
      const out = { kind: r.kind, id: r.id, project: r.project, date: r.date ? String(r.date).slice(0, 10) : null, score: +(s * 1000).toFixed(1), matched_phrasings: hits, title: r.title, snippet: r.snippet };
      if (r.kind === 'chunk') {
        const c = chunk.get(r.id), f = c && fileOf.get(c.file_id);
        if (c && f) Object.assign(out, { file_id: f.id, file: f.original_name, page: c.page, chunk_index: c.idx, email_id: f.email_id, text: String(c.text).replace(/\s+/g, ' ').slice(0, 900), open: `mesimot show chunk ${c.id}` });
      }
      return out;
    });
    // current project facts that match the question words, and the attachments of every email found
    const toks = keywords(question, 12).map(stripPrefix);
    const facts = proj ? knowledge.currentFacts(proj.id).map((f) => { const h = `${f.key} ${f.value}`; const syn = phrasings.filter((p) => p.why.startsWith('synonyms')).flatMap((p) => p.q.split(' ')).filter((w) => w.length > 2); return { f, n: toks.filter((t) => h.includes(t)).length * 2 + syn.filter((w) => h.includes(w)).length }; }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.f).slice(0, 8).map((f) => ({ key: f.key, value: f.value, as_of: f.as_of_date, source: `${f.source_type}${f.source_id ? ':' + f.source_id : ''}` })) : [];
    const emailIds = [...new Set(results.filter((x) => x.kind === 'email').map((x) => x.id).concat(results.map((x) => x.email_id).filter(Boolean)))];
    const attachments = emailIds.flatMap((id) => db.prepare('SELECT id, original_name, summary, (SELECT COUNT(*) FROM chunks WHERE file_id=files.id) AS chunks FROM files WHERE email_id=?').all(id).map((f) => ({ email_id: id, file_id: f.id, name: f.original_name, summary: f.summary || null, chunks: f.chunks, open: `mesimot show file ${f.id}` })));
    const payload = { question, project: proj ? { id: proj.id, name: proj.name_he } : null, phrasings: phrasings.map((p) => p.q), project_facts: facts, results, attachments_of_found_emails: attachments };
    trace?.log('ask', question, { phrasings: payload.phrasings, project: proj?.id ?? null, results: results.length, files: results.filter((x) => x.file_id).map((x) => x.file_id), emails: emailIds });
    return payload;
  }
  return { ask, expand, SYNONYMS };
}
module.exports = { createAsk, SYNONYMS };
