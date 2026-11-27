'use strict';
// Context gathering in code: for every incoming item (email, chat message, file) find what is already known about it,
// so the assistant decides about related tasks instead of only adding new ones. See docs/ARCHITECTURE.md (context gathering).
const { wordRe } = require('./entities');
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));
const day = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const STOP = new Set(['את', 'של', 'על', 'עם', 'לא', 'כי', 'אם', 'גם', 'או', 'זה', 'זו', 'הוא', 'היא', 'אני', 'אנחנו', 'יש', 'אין', 'כל', 'מה', 'מי', 'the', 'and', 'for', 'with', 'that', 'this']);

function keywords(text, n = 7) {
  const seen = new Set(), out = [];
  for (const w of String(text || '').replace(/[^\p{L}\p{N}.\-]+/gu, ' ').split(/\s+/)) {
    const t = w.replace(/^[.\-]+|[.\-]+$/g, '');
    if ([...t].length < 3 || STOP.has(t.toLowerCase()) || /^\d{1,2}$/.test(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out.sort((a, b) => b.length - a.length).slice(0, n);
}

function createContext({ db, store, knowledge, threads, searcher, semantic, entities = null }) {
  const q = (sql) => db.prepare(sql);
  const aliasProjects = (text) => {
    const hay = String(text || '').toLowerCase();
    return store.listProjects().filter((p) => !p.is_default && [p.name_he, ...p.aliases].some((n) => n && hay.includes(String(n).toLowerCase())));
  };
  const since = () => new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);


  // ---- entity resolution: partial people and vague projects that may be named in the incoming emails and files
  const asList = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
  function itemFacts(kind, row) {
    if (kind === 'email') {
      const parts = asList(row.participants).map((x) => ({ name: x.name || '', email: String(x.email || '').toLowerCase() }));
      const fromm = /^(.*?)\s*<([^>]+)>\s*$/.exec(String(row.forwarded_from || row.from_addr || ''));
      if (fromm) parts.push({ name: fromm[1].replace(/["']/g, '').trim(), email: fromm[2].toLowerCase() });
      else if (row.forwarded_from || row.from_addr) parts.push({ name: '', email: String(row.forwarded_from || row.from_addr).toLowerCase() });
      const body = String(row.body_text || '');
      return { key: `email:${row.id}`, label: `email ${row.id}`, parts, text: `${row.original_subject || row.subject || ''}\n${body.slice(0, 4000)}`, signature: body.slice(-900), subject: row.original_subject || row.subject || '' };
    }
    const chunk = q('SELECT text FROM chunks WHERE file_id=? ORDER BY idx LIMIT 2').all(row.id).map((c) => c.text).join('\n');
    return { key: `file:${row.id}`, label: `file ${row.id}`, parts: [], text: `${row.original_name}\n${chunk}`.slice(0, 4000), signature: chunk.slice(-900), subject: row.original_name };
  }
  function entityCandidates(items) {
    const out = { people: [], projects: [] };
    if (!entities) return out;
    const people = store.listPeople();
    for (const p of people.filter((x) => x.status === 'partial' && x.role !== 'owner' && x.role !== 'assistant')) {
      const first = String(p.name_he).trim().split(/\s+/)[0];
      const firstEn = String(p.name_en || '').trim().split(/\s+/)[0];
      const roleTokens = String(p.role_text || '').split(/\s+/).filter((w) => [...w].length >= 2);
      const idents = new Map(); // identity -> where it was seen
      for (const it of items) {
        for (const part of it.parts) {
          const nameHit = part.name && ((first && wordRe(first).test(part.name)) || (firstEn && wordRe(firstEn).test(part.name)));
          const mailHit = part.email && p.emails.includes(part.email);
          if (nameHit || mailHit) idents.set((part.email || part.name).toLowerCase(), `${it.label}: participant "${part.name || ''}${part.email ? ' <' + part.email + '>' : ''}"`);
        }
        if (first && wordRe(first).test(it.signature)) idents.set(`sig:${first}`, `${it.label}: signature/closing mentions "${first}"`);
        else if (first && wordRe(first).test(it.text) && ![...idents.keys()].some((k) => k.startsWith('sig:'))) idents.set(`body:${first}`, `${it.label}: the text mentions "${first}"`);
        if (roleTokens.length >= 2 && roleTokens.every((w) => wordRe(w).test(it.text))) idents.set(`role:${p.role_text}`, `${it.label}: the text contains the role "${p.role_text}"`);
      }
      const fresh = [...idents.entries()].filter(([k]) => !entities.isNotSame('person', p.id, k));
      if (!fresh.length) continue;
      const tasks = q('SELECT id, title FROM tasks WHERE requester_id=? OR assignee_id=? ORDER BY id DESC LIMIT 5').all(p.id, p.id);
      const ments = entities.mentionList('person', p.id).slice(0, 4).map((m) => `${m.source_type} ${m.source_id}: ${clip(m.text, 90)}`);
      const same = people.filter((x) => x.status !== 'partial' && x.id !== p.id && x.role !== 'assistant' && first && wordRe(first).test(x.name_he)).slice(0, 4);
      out.people.push({ id: p.id, name: p.name_he, identities: [...idents.keys()], line: `[partial person ${p.id}] "${p.name_he}" | known: ${[p.role_text, p.company, p.emails.join(',')].filter(Boolean).join(' / ') || 'only the first name'} | missing: ${p.missing.join(', ')} | seen: ${ments.join(' // ') || '-'} | tasks: ${tasks.map((t) => `${t.id} ${clip(t.title, 50)}`).join('; ') || '-'} | possible match: ${fresh.map(([, w]) => w).join(' ; ')}${same.length ? ' | FULL people with the same first name (merge into one of them if it is him): ' + same.map((x) => `${x.id} ${x.name_he}${x.company ? ' (' + x.company + ')' : ''}`).join('; ') : ''}`, taskIds: tasks.map((t) => t.id) });
    }
    for (const p of store.listProjects().filter((x) => x.partial)) {
      const names = [p.name_he, ...p.aliases].filter((n) => n && [...String(n)].length >= 3);
      const hit = items.map((it) => { const n = names.find((x) => wordRe(x).test(it.text)); return n ? { it, n } : null; }).filter(Boolean);
      const fresh = hit.filter((h) => !entities.isNotSame('project', p.id, h.it.key));
      if (!fresh.length) continue;
      const tasks = q('SELECT id, title FROM tasks WHERE project_id=? ORDER BY id DESC LIMIT 5').all(p.id);
      const facts = knowledge.currentFacts(p.id).map((f) => `${f.key}=${f.value}`).slice(0, 6);
      const others = store.listProjects().filter((x) => !x.partial && !x.is_default && x.id !== p.id && fresh.some((h) => [x.name_he, ...x.aliases].some((n) => n && wordRe(n).test(h.it.text)))).slice(0, 3);
      out.projects.push({ id: p.id, name: p.name_he, identities: fresh.map((h) => h.it.key), line: `[vague project ${p.id}] "${p.name_he}" (aliases: ${p.aliases.join(', ') || '-'}) | facts: ${facts.join('; ') || '-'} | tasks: ${tasks.map((t) => `${t.id} ${clip(t.title, 50)}`).join('; ') || '-'} | named in: ${fresh.map((h) => `${h.it.label} as "${h.n}"`).join('; ')}${others.length ? ' | FULL projects also named there (merge into one of them if it is the same): ' + others.map((x) => `${x.id} ${x.name_he}`).join('; ') : ''}`, taskIds: tasks.map((t) => t.id) });
    }
    return out;
  }

  // strict (daily import threads): only a REAL link needs a decision: the same thread (rank 1), a project number in the task text (2), shared non-owner participants (3).
  // Project-level, search-hit and unresolved-name matches are shown as context only.
  async function gather({ emails = [], chats = [], files = [] }, { strict = false } = {}) {
    const tasks = new Map(); // id -> {..., why:[], rank}
    const items = new Map(); // key -> {kind,id,date,gist,rank}
    const addTask = (t, why, rank) => {
      if (t.status_closed) return;
      const c = tasks.get(t.id);
      if (!c) tasks.set(t.id, { id: t.id, title: t.title, status: t.status, due: t.due_date, due_source: t.due_source, project: t.project, project_id: t.project_id, requester: t.requester, assignee: t.assignee, why: [why], rank });
      else { if (!c.why.includes(why)) c.why.push(why); c.rank = Math.min(c.rank, rank); }
    };
    const taskRow = (id) => { try { return store.getTask(id); } catch { return null; } };
    const addItem = (it) => { if (!items.has(it.key)) items.set(it.key, it); };
    const projects = new Set();

    async function fts(label, text) {
      const kw = keywords(text);
      if (!kw.length) return;
      let res;
      try { res = await searcher.searchHybrid({ q: kw.join(' '), from: since(), limit: 12, kind: 'task,email,knowledge,chat,note', mail_archive: '0' }, semantic); } catch { return; }
      res.results.forEach((r, i) => {
        const rank = 4 + Math.min(i, 3) * 0.1;
        if (r.kind === 'task') { const t = taskRow(r.id); if (t) { addTask(t, `search hit for ${label}`, rank); if (t.project_id) projects.add(t.project_id); } }
        else if (r.kind === 'email') {
          for (const x of q('SELECT task_id FROM task_emails WHERE email_id=?').all(r.id)) { const t = taskRow(x.task_id); if (t) addTask(t, `linked to email ${r.id} found by search`, rank + 0.5); }
          addItem({ key: `email:${r.id}`, kind: 'email', id: r.id, date: r.date, gist: `${r.title || ''} — ${clip(r.snippet, 120)}`, rank });
        } else if (r.kind === 'note' && r.task_id) { const t = taskRow(r.task_id); if (t) addTask(t, `note found by search`, rank + 0.5); }
        else addItem({ key: `${r.kind}:${r.id}`, kind: r.kind, id: r.id, date: r.date, gist: `${r.title ? r.title + ' — ' : ''}${clip(r.snippet, 140)}${r.project ? ' [' + r.project + ']' : ''}`, rank: rank + 1 });
      });
      // old mail from the ARCHIVE (never processed, no tasks): at most 3 keyword hits, ranked below everything current so that it can never flood the context
      try {
        const old = await searcher.searchHybrid({ q: kw.join(' '), limit: 3, kind: 'email', mail_archive: 'only', mode: 'keyword' }, semantic);
        old.results.forEach((r, i) => addItem({ key: `email:${r.id}`, kind: 'email', id: r.id, date: r.date, gist: `[ארכיון] ${r.title || ''} — ${clip(r.snippet, 120)}`, rank: 7 + i * 0.1 }));
      } catch { /* the archive is optional context */ }
    }

    for (const e of emails) {
      for (const c of threads.candidateTasks(e.id)) { const t = taskRow(c.id); if (t) { addTask(t, c.reasons.join('; '), c.reasons[0].includes('same thread') ? 1 : 2); if (t.project_id) projects.add(t.project_id); } }
      for (const r of threads.relatedEmails(e.id).slice(0, 8)) {
        const row = q('SELECT * FROM emails WHERE id=?').get(r.id);
        addItem({ key: `email:${r.id}`, kind: 'email', id: r.id, date: r.date, gist: `${r.archived ? '[ארכיון] ' : ''}${r.subject} — מאת ${r.from || '?'} — ${threads.emailGist(row)}${r.tasks.length ? ' [tasks: ' + r.tasks.map((t) => `${t.id} ${t.status} (${t.relation})`).join(', ') + ']' : ''}`, rank: r.archived ? 2 : 1 });
      }
      for (const p of aliasProjects(`${e.original_subject || e.subject || ''} ${String(e.body_text || '').slice(0, 800)}`)) projects.add(p.id);
      await fts(`email ${e.id}`, `${e.original_subject || e.subject || ''} ${threads.emailGist(e)}`);
    }
    for (const c of chats) {
      for (const p of aliasProjects(c.text)) projects.add(p.id);
      await fts(`chat message ${c.id}`, c.text);
    }
    for (const f of files) {
      const chunk = q('SELECT text FROM chunks WHERE file_id=? ORDER BY idx LIMIT 1').get(f.id);
      for (const p of aliasProjects(`${f.original_name} ${chunk?.text || ''}`)) projects.add(p.id);
      await fts(`file ${f.id}`, `${f.original_name} ${chunk?.text || ''}`);
    }
    // partial people and vague projects possibly named in the emails and files: their tasks need a decision too (the thread continues)
    const ecand = entityCandidates([...emails.map((e) => itemFacts('email', e)), ...files.map((f) => itemFacts('file', f))]);
    for (const c of [...ecand.people, ...ecand.projects]) for (const tid of c.taskIds) { const t = taskRow(tid); if (t) { addTask(t, `${c.line.startsWith('[partial') ? 'requester/assignee' : 'project'} is the unresolved ${c.line.startsWith('[partial') ? 'person' : 'project'} "${c.name}" that this item may be about`, strict ? 5 : 1.5); if (t.project_id) projects.add(t.project_id); } }
    // open tasks of the projects involved (context; lowest rank)
    for (const pid of projects) for (const t of store.listTasks({ project: String(pid), open: '1' }).slice(0, 8)) addTask(t, 'open task of the same project', 6);

    const taskList = [...tasks.values()].sort((a, b) => a.rank - b.rank || b.id - a.id).slice(0, 15);
    const itemList = [...items.values()].sort((a, b) => a.rank - b.rank || String(b.date).localeCompare(String(a.date))).slice(0, 15);
    const strong = strict ? 3 : (emails.length || files.length ? 6 : 4.9); // chat: only the stronger relations need a decision
    const required = taskList.filter((t) => t.rank <= strong).slice(0, emails.length ? 10 : 6);

    const fmtTask = (t) => `[task ${t.id}] ${t.title} | project: ${t.project} | status: ${t.status} | due: ${t.due ? day(t.due) + (t.due_source === 'estimated' ? ' (est)' : '') : '-'} | from: ${t.requester || '-'} | to: ${t.assignee || '-'} | why related: ${t.why.join('; ')}${required.includes(t) ? ' | DECISION REQUIRED' : ''}`;
    // the project card: current dated facts of the involved projects, so keys are reused consistently
    // the project card: the facts most relevant to THIS text in full (so values are reused and updated consistently), the other keys as names only (the rest: `mesimot fact list --project ID`)
    const hayAll = [...emails.map((e) => `${e.subject || ''} ${e.original_subject || ''} ${String(e.body_text || '').slice(0, 4000)}`), ...chats.map((c) => c.text), ...files.map((f) => f.original_name)].join(' ').toLowerCase();
    const kws = keywords(hayAll, 24).map((w) => w.toLowerCase());
    // at most 3 projects get a card (the ones the text names most); the rest are reachable with `mesimot fact list --project`
    const projRank = [...projects].map((pid) => { const pr = store.listProjects().find((x) => x.id === pid); const names = pr ? [pr.name_he, ...pr.aliases].filter(Boolean).map((n) => String(n).toLowerCase()) : []; return { pid, n: names.reduce((a, n) => a + (hayAll.split(n).length - 1), 0) }; }).sort((a, b) => b.n - a.n).slice(0, 3).map((x) => x.pid);
    const cards = projRank.map((pid) => {
      const pr = store.listProjects().find((x) => x.id === pid);
      const facts = knowledge.currentFacts(pid);
      const scored = facts.map((f, i) => ({ f, sc: kws.filter((w) => `${f.key} ${f.value}`.toLowerCase().includes(w)).length * 3 + (String(f.as_of_date || '') >= new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10) ? 1 : 0) + i / 1e6 }));
      const top = scored.filter((x) => x.sc >= 1).sort((a, b) => b.sc - a.sc).slice(0, 12).map((x) => x.f);
      const topKeys = new Set(top.map((f) => f.key));
      const otherKeys = facts.filter((f) => !topKeys.has(f.key)).map((f) => f.key).slice(0, 30);
      return `[project ${pid}] ${pr ? pr.name_he : ''}: ${facts.length ? top.map((f) => `${f.key} = ${clip(f.value, 160)}${f.unit ? ' ' + f.unit : ''} (as of ${day(f.as_of_date)})`).join('; ') || '(no fact matches this text)' : '(card is empty)'}${otherKeys.length ? `\n   other keys on the card (${facts.length - top.length} facts; read with \`mesimot fact list --project ${pid}\`): ${otherKeys.join(' | ')}` : ''}`;
    });
    // attachments of the emails found and of the involved projects: the assistant must SEE that a document exists before it says it has none
    const emailIds = [...new Set([...emails.map((e) => e.id), ...itemList.filter((i) => i.kind === 'email').map((i) => i.id)])];
    const attRows = [...(emailIds.length ? q(`SELECT f.id, f.original_name, f.summary, f.email_id, f.project_id, f.text_status, (SELECT COUNT(*) FROM chunks c WHERE c.file_id=f.id) AS n FROM files f WHERE f.email_id IN (${emailIds.join(',')}) AND f.id NOT IN (SELECT file_id FROM emails WHERE file_id IS NOT NULL) ORDER BY f.id`).all() : []),
      ...(projects.size ? q(`SELECT f.id, f.original_name, f.summary, f.email_id, f.project_id, f.text_status, (SELECT COUNT(*) FROM chunks c WHERE c.file_id=f.id) AS n FROM files f WHERE f.project_id IN (${[...projects].join(',')}) ORDER BY f.id DESC LIMIT 15`).all() : [])];
    const seenF = new Set(), seenSha = new Set(), attList = attRows.filter((f) => { if (seenF.has(f.id)) return false; seenF.add(f.id); const sha = q('SELECT sha256 FROM files WHERE id=?').get(f.id)?.sha256; if (sha && seenSha.has(sha)) return false; if (sha) seenSha.add(sha); return true; }).slice(0, 12);
    const attBlock = attList.length ? `\nATTACHED FILES of these emails and projects (their text is searchable: \`mesimot ask "..."\`, \`mesimot show file ID\`, \`mesimot show chunk ID\`). NEVER say you do not have a document or a number when a file below may hold it: open it first.
${attList.map((f) => `[file ${f.id}]${f.email_id ? ` attached to email ${f.email_id}` : ''}${f.project_id ? `, project ${f.project_id}` : ''}: "${f.original_name}", ${f.n} chunks${f.text_status && f.text_status !== 'ok' ? `, text status: ${f.text_status}` : ''}${knowledge.textPoor(f.id) ? ' [TEXT POOR: look at the file itself — `mesimot show file ' + f.id + '` gives view_path for the Read tool]' : ''}${f.summary ? ' — ' + clip(f.summary.replace(/\s+/g, ' '), 220) : ' — NO SUMMARY YET'}`).join('\n')}\n` : '';
    const block = `== מה כבר ידוע (what is already known about the incoming items; found by code, not by you) ==
Related OPEN tasks (${taskList.length}). For each one marked DECISION REQUIRED you must give a decision (close / advance / update / no_change) with a short Hebrew reason, in ONE \`mesimot apply\` call:
${taskList.length ? taskList.map(fmtTask).join('\n') : '(none: this looks like a new matter)'}

Related earlier items (context only; read the facts, do not repeat them):
${itemList.length ? itemList.map((i) => `[${i.kind} ${i.id}, ${day(i.date)}] ${i.gist}`).join('\n') : '(none)'}

Project card(s) of the projects involved (current facts, each with the date of its source). REUSE these keys; extract NEW or CHANGED facts from the incoming items into the "facts" array of your apply call, with as_of = the date of the source (the email's original date, or today for chat), never the date you processed it:
${cards.length ? cards.join('\n') : '(no project identified yet: identify it, then add facts)'}
${attBlock}${ecand.people.length || ecand.projects.length ? `
UNRESOLVED PEOPLE / PROJECTS that these items may be about (found by code). For EACH one you must give a verdict in the "resolutions" array of your \`mesimot apply\` call (DECISION REQUIRED): {"type": "person"|"project", "id": N, "action": "merge" (it IS that existing full record: add "into": ID) | "complete" (it is the same person/project and the new item gives the details: add name, email, company, role_text or, for a project, name/aliases/description) | "not_same" (a different person/project), "reason": "..."}. ALWAYS pass every detail the item reveals in the resolution itself (name, email, company, role_text: read them from the signature, e.g. \"מנהל פרויקט דוגמית\" / \"חברת XYZ\"), also with action merge, so the full record ends up complete. A resolution re-links everything that referred to the partial record (tasks, mentions, facts) automatically and adds a note to the affected tasks. Decide about the related tasks in the same call.
${[...ecand.people, ...ecand.projects].map((c) => c.line).join('\n')}` : ''}`;
    return { block, required: required.map((t) => ({ id: t.id, title: t.title, rank: t.rank })), requiredEntities: [...ecand.people.map((c) => ({ type: 'person', id: c.id, name: c.name, identities: c.identities })), ...ecand.projects.map((c) => ({ type: 'project', id: c.id, name: c.name, identities: c.identities }))], tasks: taskList.length, items: itemList.length };
  }

  return { gather, keywords };
}

module.exports = { createContext, keywords };
