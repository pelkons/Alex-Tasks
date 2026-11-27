'use strict';
// Keyword layer of the search. Returns short snippets only. A vector layer can be merged later by
// rank fusion: every result carries a stable key (kind:id) and a rank.
const { bad, normDate } = require('./store');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MARK_OPEN = '\u0001', MARK_CLOSE = '\u0002';

function buildMatch(q, mode) {
  const toks = String(q || '').split(/\s+/).map((t) => t.replace(/["*]/g, '')).filter((t) => [...t].length >= 3);
  if (!toks.length) throw bad('יש להזין לפחות שלוש אותיות לחיפוש');
  return toks.map((t) => `"${t}"`).join(mode === 'or' ? ' OR ' : ' AND ');
}

// cut a short window around the first highlighted match
function crop(text, width = 150) {
  let t = String(text || '').replace(new RegExp(MARK_CLOSE + MARK_OPEN, 'g'), '').replace(/\s+/g, ' ').trim();
  const i = t.indexOf(MARK_OPEN);
  if (i < 0) return t.length > width ? t.slice(0, width) + '…' : t;
  const start = Math.max(0, i - Math.floor(width / 3));
  let out = t.slice(start, start + width + 20);
  const open = (out.match(new RegExp(MARK_OPEN, 'g')) || []).length, close = (out.match(new RegExp(MARK_CLOSE, 'g')) || []).length;
  if (open > close) out += MARK_CLOSE;
  if (close > open) out = MARK_OPEN + out;
  return (start > 0 ? '…' : '') + out + (start + width + 20 < t.length ? '…' : '');
}

function createSearch(db) {
  const kindsOk = ['task', 'note', 'email', 'chat', 'file', 'chunk', 'knowledge', 'fact', 'protocol', 'protocol_item'];

  // ARCHIVE mail lives in its own index (`search_archive`, same layout as `search_index`). f.mail_archive: '0' = live data only (context for new mail), 'only' = archive only, anything else = both.
  const archiveMode = (f) => (String(f.mail_archive ?? '1') === '0' ? 'exclude' : String(f.mail_archive) === 'only' ? 'only' : 'include');
  const ARCHIVE_KINDS = ['email', 'chunk', 'file'];

  function run(match, f, limit, offset, table = 'search_index') {
    const where = [`${table} MATCH ?`], args = [match];
    if (f.kind) {
      const ks = String(f.kind).split(',').map((x) => x.trim()).filter(Boolean);
      for (const k of ks) if (!kindsOk.includes(k)) throw bad('סוג לא תקין. האפשרויות: ' + kindsOk.join(', '));
      where.push(`kind IN (${ks.map(() => '?').join(',')})`); args.push(...ks);
    }
    if (f.projectId) { where.push('project_id = ?'); args.push(f.projectId); }
    if (f.person) { where.push('person LIKE ?'); args.push(`%${String(f.person).trim()}%`); }
    if (f.from) { where.push('substr(ts,1,10) >= ?'); args.push(normDate(f.from)); }
    if (f.to) { where.push('substr(ts,1,10) <= ?'); args.push(normDate(f.to)); }
    const sql = `SELECT kind, ref_id, project_id, ts, person, title,
        highlight(${table}, 1, '${MARK_OPEN}', '${MARK_CLOSE}') AS sb,
        highlight(${table}, 0, '${MARK_OPEN}', '${MARK_CLOSE}') AS st,
        bm25(${table}) AS rank
      FROM ${table} WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...args, limit, offset);
  }
  // live rows and archive rows of one query, merged by rank (both indexes use the same tokenizer and ranking function)
  function runBoth(match, f, limit, offset) {
    const mode = archiveMode(f);
    const kinds = f.kind ? String(f.kind).split(',').map((x) => x.trim()).filter(Boolean) : null;
    const wantArchive = mode !== 'exclude' && (!kinds || kinds.some((k) => ARCHIVE_KINDS.includes(k)));
    const live = mode === 'only' ? [] : run(match, f, limit + offset, 0);
    if (!wantArchive) return live.slice(offset, offset + limit);
    const arch = run(match, kinds ? { ...f, kind: kinds.filter((k) => ARCHIVE_KINDS.includes(k)).join(',') } : f, limit + offset, 0, 'search_archive').map((r) => ({ ...r, archived: true }));
    return [...live, ...arch].sort((a, b) => a.rank - b.rank).slice(offset, offset + limit);
  }

  const pname = db.prepare('SELECT name_he, color, is_default FROM projects WHERE id=?');
  // a sender recorded as "Moshe Dayan <moshe@x.co>" is shown with the Hebrew name of the person who owns that address
  const people = () => db.prepare('SELECT name_he, emails FROM people').all().map((p) => ({ name: p.name_he, emails: JSON.parse(p.emails || '[]').map((e) => e.toLowerCase()) }));
  function displayPerson(v) {
    const raw = String(v || '').trim();
    if (!raw) return null;
    const em = (/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/.exec(raw) || [])[0];
    if (em) { const hit = people().find((p) => p.emails.includes(em.toLowerCase())); if (hit) return hit.name; return raw.replace(/<[^>]*>/g, '').trim() || em; }
    return raw;
  }
  // one shape for results of every layer (keyword, semantic, fused)
  function buildResult(r) {
    const p = r.project_id ? pname.get(r.project_id) : null;
    let taskId = null, link = '/chat', fileId = null;
    if (r.archived) { // archive mail: no tasks; an attachment result opens the mail it came from (its file may exist only in Outlook)
      let emailId = r.kind === 'email' ? r.ref_id : null;
      if (r.kind === 'chunk') { const c = db.prepare('SELECT c.file_id, f.email_id FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.id=?').get(r.ref_id); fileId = c?.file_id ?? null; emailId = c?.email_id ?? null; }
      if (r.kind === 'file') { fileId = r.ref_id; emailId = db.prepare('SELECT email_id FROM files WHERE id=?').get(r.ref_id)?.email_id ?? null; }
      return { key: `${r.kind}:${r.ref_id}`, kind: r.kind, id: r.ref_id, date: r.ts, person: displayPerson(r.person), project_id: r.project_id, project: p?.name_he ?? null, project_color: p?.color ?? null, project_default: p ? !!p.is_default : false,
        title: r.title || null, snippet: r.plain, html: r.html, rank: r.rank, link: emailId ? `/email/${emailId}` : '/search', task_id: null, file_id: fileId, email_id: emailId, archived: true };
    }
    if (r.kind === 'task') { taskId = r.ref_id; link = `/task/${r.ref_id}`; }
    else if (r.kind === 'note') {
      const n = db.prepare('SELECT task_id, project_id FROM notes WHERE id=?').get(r.ref_id);
      if (n?.task_id) { taskId = n.task_id; link = `/task/${n.task_id}`; } else if (n?.project_id) link = `/projects/${n.project_id}`;
    } else if (r.kind === 'email') {
      const t = db.prepare('SELECT id FROM tasks WHERE source_email_id=? ORDER BY id LIMIT 1').get(r.ref_id);
      link = t ? `/task/${t.id}` : `/email/${r.ref_id}`; taskId = t?.id ?? null;
    } else if (r.kind === 'protocol' || r.kind === 'protocol_item') {
      const it = r.kind === 'protocol_item' ? db.prepare('SELECT protocol_id FROM protocol_items WHERE id=?').get(r.ref_id) : null;
      link = `/protocols/${it ? it.protocol_id : r.ref_id}`;
    } else if (r.kind === 'knowledge' || r.kind === 'fact' || r.kind === 'file' || r.kind === 'chunk') {
      if (r.kind === 'chunk') fileId = db.prepare('SELECT file_id FROM chunks WHERE id=?').get(r.ref_id)?.file_id ?? null;
      if (r.kind === 'file') fileId = r.ref_id;
      link = r.project_id ? `/projects/${r.project_id}` : (fileId ? `/api/files/${fileId}/download` : '/chat');
    }
    return {
      key: `${r.kind}:${r.ref_id}`, kind: r.kind, id: r.ref_id, date: r.ts, person: displayPerson(r.person),
      project_id: r.project_id, project: p?.name_he ?? null, project_color: p?.color ?? null, project_default: p ? !!p.is_default : false,
      title: r.title || null, snippet: r.plain, html: r.html, rank: r.rank, link, task_id: taskId, file_id: fileId,
    };
  }

  function search(f = {}) {
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 10, 1), 100);
    const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
    const proj = f.project ? (/^\d+$/.test(String(f.project)) ? +f.project : (db.prepare('SELECT id FROM projects WHERE name_he=?').get(String(f.project))?.id
      ?? db.prepare('SELECT id, aliases FROM projects').all().find((p) => JSON.parse(p.aliases).includes(String(f.project)))?.id)) : null;
    if (f.project && !proj) throw bad(`פרויקט לא נמצא: ${f.project}`);
    const filt = { ...f, projectId: proj };
    let rows = runBoth(buildMatch(f.q, 'and'), filt, limit, offset);
    let mode = 'and';
    if (!rows.length && String(f.q).trim().split(/\s+/).length > 1) { rows = runBoth(buildMatch(f.q, 'or'), filt, limit, offset); mode = 'or'; }
    const results = rows.map((r) => {
      const hit = (x) => x && x.includes(MARK_OPEN);
      const sn = crop(hit(r.sb) ? r.sb : hit(r.st) ? r.st : (r.sb || r.st || ''));
      const plain = sn.replace(new RegExp(MARK_OPEN, 'g'), '«').replace(new RegExp(MARK_CLOSE, 'g'), '»').replace(/\s+/g, ' ');
      const html = esc(sn).replace(new RegExp(MARK_OPEN, 'g'), '<mark>').replace(new RegExp(MARK_CLOSE, 'g'), '</mark>').replace(/\s+/g, ' ');
      return buildResult({ kind: r.kind, ref_id: r.ref_id, project_id: r.project_id, ts: r.ts, person: r.person, title: r.title, plain, html, rank: r.bm25 ?? r.rank, archived: !!r.archived });
    });
    return { query: f.q, mode, count: results.length, results };
  }

  // keyword + semantic merged with reciprocal rank fusion
  async function searchHybrid(f = {}, semantic) {
    const mode = f.mode || 'hybrid';
    const limit = Math.min(Math.max(parseInt(f.limit, 10) || 10, 1), 100);
    let kw = { results: [], mode: 'and' }, kwErr = null;
    if (mode !== 'semantic') { try { kw = search({ ...f, limit: 60 }); } catch (e) { kwErr = e; if (mode === 'keyword') throw e; } }
    if (mode === 'keyword' || !semantic || !semantic.available()) { if (kwErr) throw kwErr; return { query: f.q, mode: 'keyword', semantic: 'unavailable', count: Math.min(kw.results.length, limit), results: kw.results.slice(0, limit) }; }
    let sem = [], semNote = null;
    try {
      const proj = f.project ? (/^\d+$/.test(String(f.project)) ? +f.project : (db.prepare('SELECT id FROM projects WHERE name_he=?').get(String(f.project))?.id ?? null)) : null;
      if (f.project && !proj) throw bad(`פרויקט לא נמצא: ${f.project}`);
      const rows = await semantic.semantic({ ...f, projectId: proj, archive: archiveMode(f) === 'include' ? null : archiveMode(f) });
      sem = rows.map((e) => buildResult({ kind: e.kind, ref_id: e.ref_id, project_id: e.project_id, ts: e.ts, person: e.person, title: e.title, plain: e.snippet + '…', html: esc(e.snippet) + '…', rank: e.distance, archived: !!e.archive }));
    } catch (e) { if (e.status) throw e; semNote = 'failed'; }
    if (kwErr && !sem.length) throw kwErr;
    const fused = semantic.fuse([{ name: 'keyword', items: kw.results }, { name: 'semantic', items: sem }], limit);
    return { query: f.q, mode: semNote ? 'keyword' : 'hybrid', semantic: semNote || (sem.length ? 'ok' : 'empty'), count: fused.length, results: fused };
  }

  return { search, searchHybrid, buildResult, esc };
}

module.exports = { createSearch };
