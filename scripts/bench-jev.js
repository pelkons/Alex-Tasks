#!/usr/bin/env node
'use strict';
// BENCHMARK (no production change): the Jev decision model against haiku on real mail, with sonnet (effort high) as the gold and the OWNER's answers overriding it where the gold disagrees with what the pipeline decided.
//   node scripts/bench-jev.js sample [--n 80]   stratified sample of real mail (cleaned text) -> $BENCH_DIR/sample.json (real content: never committed)
//   node scripts/bench-jev.js gold               sonnet high, once per mail
//   node scripts/bench-jev.js jev | haiku        the same questions to each model
//   node scripts/bench-jev.js owner              ONE chat card with up to 20 quick questions where gold != pipeline
//   node scripts/bench-jev.js report             metrics -> benchmarks table + docs/BENCHMARK-JEV.md (aggregate numbers only)
// Env: MESIMOT_DB (a COPY of the live database), BENCH_DIR (default /tmp/bench), JEV_URL / JEV_SECRET (from ~/.config/mesimot/jev.env).
process.env.MESIMOT_SEMANTIC = '0';
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = process.env.BENCH_DIR || '/tmp/bench'; fs.mkdirSync(DIR, { recursive: true });
const J = (f) => path.join(DIR, f); const load = (f, d = null) => { try { return JSON.parse(fs.readFileSync(J(f), 'utf8')); } catch { return d; } }; const save = (f, v) => fs.writeFileSync(J(f), JSON.stringify(v));
const argv = process.argv.slice(2); const step = argv[0]; const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const envFile = (f) => { const o = {}; try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch { /* none */ } return o; };
const JEV = { ...envFile(path.join(os.homedir(), '.config', 'mesimot', 'jev.env')), ...process.env };
const KINDS = ['noise', 'fyi', 'action'];
const pool = async (items, n, fn) => { const out = new Array(items.length); let i = 0; await Promise.all([...Array(n)].map(async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; };
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

// ---------------- the questions (the same definitions for every model)
const DEF = {
  kind: { noise: 'automatic or bulk mail: newsletter, receipt, system notice, marketing, calendar reply', fyi: 'information only: nothing for the recipient\'s team to do', action: 'someone asks the recipient\'s team to do something, or a decision or reply is needed from them' },
  needs_task: 'Does the owner\'s team need to do something because of this email, something worth tracking as a task?',
  ours: { ours: 'the owner\'s own team must act', others: 'someone else must act or is already handling it', none: 'no action involved' },
  fact: 'Does the email contain project facts worth saving for later (dates, amounts, quantities, decisions, plan numbers, who is responsible)?',
  deadline: 'Does the email mention a deadline or a due date for something?',
};
const noulQ = (instr) => ({ type: 'noul', instructions: instr });
function jevQuestions(ctx) {
  const q = {
    kind: { type: 'choice', instructions: `What kind of email is this for ${ctx.owner}'s team?`, criteria: { ...DEF.kind } },
    needs_task: noulQ(DEF.needs_task),
    ours_vs_others: { type: 'choice', instructions: `If something must be done because of this email, whose job is it? (${ctx.owner}'s team vs someone else)`, criteria: { ...DEF.ours } },
    project: { type: 'choice', instructions: 'Which project is this email about?', criteria: Object.fromEntries([...ctx.projects, 'unclear'].map((p) => [p, null])) },
    fact_worthy: noulQ(DEF.fact), deadline_mentioned: noulQ(DEF.deadline),
  };
  ctx.candidates.forEach((c, i) => { q[`related_${i + 1}`] = noulQ(`Is this email about the following open task (same matter, a follow-up, an answer, or a change to it)? Task: "${c.title}" (project: ${c.project || '-'}, due: ${c.due || '-'})`); });
  return q;
}
function llmPrompt(ctx, e) {
  return `You label ONE email for ${ctx.owner}'s team. Answer with ONLY one JSON object, no other text.
Keys:
"kind": one of noise | fyi | action  (${KINDS.map((k) => `${k} = ${DEF.kind[k]}`).join('; ')})
"needs_task": true|false  (${DEF.needs_task})
"ours_vs_others": one of ours | others | none  (${Object.entries(DEF.ours).map(([k, v]) => `${k} = ${v}`).join('; ')})
"project": exactly one of the project names below, or "unclear"
${ctx.candidates.map((c, i) => `"related_${i + 1}": true|false  (is the email about the open task: "${c.title}" (project: ${c.project || '-'}, due: ${c.due || '-'})?)`).join('\n')}
"fact_worthy": true|false  (${DEF.fact})
"deadline_mentioned": true|false  (${DEF.deadline})

Projects: ${ctx.projects.join(' | ')}

EMAIL (${e.header}):
${e.text}`;
}
const ownerName = () => require('../lib/config').get().owner.name_he || 'the owner';

// ---------------- sample
async function sample() {
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createThreads } = require('../lib/threads');
  const { createSearch } = require('../lib/search'); const { createSemantic } = require('../lib/semantic'); const { createEntities } = require('../lib/entities'); const { createContext } = require('../lib/context'); const { clean } = require('../lib/textclean');
  const db = open(); const store = createStore(db); const knowledge = createKnowledge(db, store); const threads = createThreads(db, store, knowledge);
  const ctxer = createContext({ db, store, knowledge, threads, searcher: createSearch(db), semantic: createSemantic(db, {}), entities: createEntities(db, store) });
  const per = Math.ceil((+opt('n', 80)) / 5); const rnd = seeded(20261126); const q = (s, ...a) => db.prepare(s).all(...a);
  const projOf = (e) => (e.project_id && store.listProjects().find((p) => p.id === e.project_id)?.name_he) || q('SELECT p.name_he n FROM task_emails te JOIN tasks t ON t.id=te.task_id JOIN projects p ON p.id=t.project_id WHERE te.email_id=? LIMIT 1', e.id)[0]?.n || null;
  const strata = {
    relevant_task: "SELECT * FROM emails e WHERE triage='relevant' AND direction='received' AND length(body_text) > 150 AND EXISTS (SELECT 1 FROM task_emails te WHERE te.email_id=e.id AND te.relation='created')",
    relevant_notask: "SELECT * FROM emails e WHERE triage='relevant' AND direction='received' AND import_state='done' AND length(body_text) > 150 AND NOT EXISTS (SELECT 1 FROM task_emails te WHERE te.email_id=e.id)",
    fyi: "SELECT * FROM emails e WHERE triage='fyi' AND length(body_text) > 60",
    noise: "SELECT * FROM emails e WHERE triage='noise' AND length(body_text) > 40",
    sent: "SELECT * FROM emails e WHERE direction='sent' AND import_state IN ('done','dup','noise') AND length(body_text) > 40",
  };
  const out = []; const projectNames = store.listProjects().filter((p) => !p.is_default).map((p) => p.name_he);
  for (const [name, sql] of Object.entries(strata)) {
    const rows = q(sql).map((r) => ({ r, p: projOf(r) })).sort(() => rnd() - 0.5); const pick = []; const seen = new Map();
    for (const x of rows) { const k = x.p || '-'; if ((seen.get(k) || 0) < Math.max(2, Math.ceil(per / 6))) { pick.push(x); seen.set(k, (seen.get(k) || 0) + 1); } if (pick.length >= per) break; }
    for (const x of rows) { if (pick.length >= per) break; if (!pick.includes(x)) pick.push(x); }
    for (const { r, p } of pick) {
      const decisions = q('SELECT action FROM decisions WHERE email_id=?', r.id).map((d) => d.action); const created = q("SELECT task_id FROM task_emails WHERE email_id=? AND relation='created'", r.id).length;
      const linked = q('SELECT t.id, t.title, pr.name_he project, t.due_date due FROM task_emails te JOIN tasks t ON t.id=te.task_id JOIN projects pr ON pr.id=t.project_id WHERE te.email_id=? LIMIT 2', r.id);
      let required = []; try { required = (await ctxer.gather({ emails: [r] }, { strict: false })).required; } catch { /* no context */ }
      const cand = [...linked.map((t) => ({ id: t.id, title: t.title, project: t.project, due: t.due }))]; for (const t of required) { if (cand.length >= 3) break; if (!cand.some((c) => c.id === t.id)) { const row = q('SELECT t.id, t.title, pr.name_he project, t.due_date due FROM tasks t JOIN projects pr ON pr.id=t.project_id WHERE t.id=?', t.id)[0]; if (row) cand.push({ id: row.id, title: row.title, project: row.project, due: row.due }); } }
      const body = clean(r.body_text || '', { max: 12000 });
      const pipelineKind = r.triage === 'noise' ? 'noise' : (created || decisions.some((d) => ['update', 'close', 'advance'].includes(d))) ? 'action' : 'fyi';
      out.push({ id: r.id, stratum: name, subject: r.original_subject || r.subject || '', sender: String(r.forwarded_from || r.from_addr || '').replace(/<[^>]*>/g, '').trim(), date: String(r.mail_date || r.received_at || '').slice(0, 10), header: `From: ${r.forwarded_from || r.from_addr}\nTo: ${r.to_addr || ''}\nSubject: ${r.original_subject || r.subject || ''}\nDate: ${String(r.mail_date || r.received_at || '').slice(0, 10)}${r.direction === 'sent' ? '\n(sent by the owner)' : ''}`, text: body.slice(0, 14000), chars: body.length,
        pipeline: { kind: pipelineKind, needs_task: created > 0, project: p || 'unclear', stratum_triage: r.triage }, candidates: cand.slice(0, 3) });
    }
  }
  save('sample.json', { projects: projectNames, owner: ownerName(), items: out }); console.log(`sample: ${out.length} mails`, Object.fromEntries(Object.keys(strata).map((s) => [s, out.filter((o) => o.stratum === s).length])), 'projects:', new Set(out.map((o) => o.pipeline.project)).size);
}

// ---------------- running a model
const parseJson = (t) => { const m = /\{[\s\S]*\}/.exec(String(t || '')); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };
async function runLlm(file, model, effort, conc) {
  const S = load('sample.json'); const res = load(file, {}); const { createAgent } = require('../lib/agents'); const agent = createAgent('claude-code');
  const todo = S.items.filter((e) => !res[e.id]); console.log(`${file}: ${todo.length} to do (${model} ${effort})`);
  await pool(todo, conc, async (e) => {
    const ctx = { owner: S.owner, projects: S.projects, candidates: e.candidates }; const t0 = Date.now();
    const r = await agent.run({ prompt: llmPrompt(ctx, e), workdir: DIR, allowedCommands: [], readPaths: [], writePaths: [], model, effort, maxTurns: 3, timeoutMs: 600000 });
    res[e.id] = { answer: parseJson(r.text), ms: Date.now() - t0, cost: r.usage?.cost_usd ?? null, in: r.usage?.input_tokens ?? null, out: r.usage?.output_tokens ?? null, error: r.error || null }; save(file, res);
    process.stdout.write(res[e.id].answer ? '.' : 'x');
  }); console.log('\ndone');
}
async function runJev() {
  const S = load('sample.json'); const res = load('jev.json', {}); const model = opt('model', 'typesafe/jev'); const file = model === 'typesafe/jev' ? 'jev.json' : `jev-${model.replace(/\W+/g, '_')}.json`; const out = file === 'jev.json' ? res : load(file, {});
  const todo = S.items.filter((e) => !out[e.id]); console.log(`${file}: ${todo.length} to do`);
  await pool(todo, 4, async (e) => {
    const ctx = { owner: S.owner, projects: S.projects, candidates: e.candidates }; const t0 = Date.now(); let r, j = null, err = null;
    for (let a = 0; a < 3 && !j; a++) { try { r = await fetch(JEV.JEV_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-secret': JEV.JEV_SECRET }, body: JSON.stringify({ model, state: `${e.header}\n\n${e.text}`, questions: jevQuestions(ctx) }), signal: AbortSignal.timeout(60000) }); const body = await r.json(); if (r.ok && body.result) j = body.result; else err = JSON.stringify(body).slice(0, 200); } catch (x) { err = x.message; } if (!j) await new Promise((z) => setTimeout(z, 1500 * (a + 1))); }
    const ans = {}; if (j) for (const [k, v] of Object.entries(j.answers || {})) ans[k] = v.type === 'noul' ? { value: v.noul >= 0.5, conf: Math.max(v.noul, 1 - v.noul), p: v.noul } : { value: v.choice, conf: v.confidence ?? Math.max(...Object.values(v.probabilities || { x: 1 })) };
    out[e.id] = { answer: j ? ans : null, ms: Date.now() - t0, in: j?.usage?.input_tokens ?? null, out: j?.usage?.output_tokens ?? null, error: j ? null : err }; save(file, out); process.stdout.write(j ? '.' : 'x');
  }); console.log('\ndone');
}

// ---------------- the owner's card
async function owner() {
  const S = load('sample.json'); const gold = load('gold.json', {}); const cases = [];
  const norm = (a) => (a ? { kind: a.kind, needs_task: !!a.needs_task, project: a.project } : null);
  for (const e of S.items) { const g = norm(gold[e.id]?.answer); if (!g) continue; for (const f of ['needs_task', 'kind', 'project']) if (String(g[f]) !== String(e.pipeline[f])) { cases.push({ e, f, g: g[f], p: e.pipeline[f] }); break; } }
  const order = { needs_task: 0, kind: 1, project: 2 }; cases.sort((a, b) => order[a.f] - order[b.f]); const pick = cases.slice(0, 20);
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createChat } = require('../lib/chat'); const { createKnowledge } = require('../lib/knowledge'); const db = open(process.env.BENCH_LIVE_DB || process.env.MESIMOT_DB); const store = createStore(db);
  const proposals = require('../lib/proposals').createProposals({ db, store, chat: createChat(db, store, createKnowledge(db, store)) });
  const he = { noise: 'אוטומטי / ידיעון (לא רלוונטי)', fyi: 'לידיעה בלבד, בלי פעולה', action: 'דורש פעולה' };
  // a suggested task title (haiku, one short call) for the cases where the model says a task is needed
  const titles = {}; const { createAgent } = require('../lib/agents'); const agent = createAgent('claude-code');
  for (const c of pick.filter((x) => x.f === 'needs_task' && x.g === true)) { try { const r = await agent.run({ prompt: `Write ONE short task title in Hebrew (at most 8 words, starts with a verb) for ${S.owner}'s team, for the task this email requires. Answer with the title only.\n\n${c.e.header}\n\n${c.e.text.slice(0, 3000)}`, workdir: DIR, allowedCommands: [], readPaths: [], writePaths: [], model: 'haiku', effort: 'low', maxTurns: 2, timeoutMs: 120000 }); titles[c.e.id] = String(r.text || '').trim().split('\n')[0].replace(/^["'״]|["'״]$/g, '').slice(0, 90); } catch { /* no title */ } }
  const spec = (c) => {
    if (c.f === 'needs_task') { const yes = 'כן, צריך משימה', no = 'לא, רק מידע (אין משימה)'; return { ask: 'האם נדרשת משימה עבורך או עבור הצוות שלך בעקבות המייל הזה?', left: c.p ? 'המערכת החליטה: נפתחה משימה' : 'המערכת החליטה: אין משימה', right: c.g ? 'המודל אומר: כן, נדרשת משימה' : 'המודל אומר: אין צורך במשימה, רק מידע', approve_label: c.g ? yes : no, reject_label: c.p ? yes : no, suggested_title: c.g ? (titles[c.e.id] || null) : null }; }
    if (c.f === 'kind') return { ask: 'מה הסוג של המייל הזה?', left: `המערכת החליטה: ${he[c.p]}`, right: `המודל אומר: ${he[c.g]}`, approve_label: he[c.g], reject_label: he[c.p] };
    return { ask: 'לאיזה פרויקט שייך המייל הזה?', left: `המערכת החליטה: ${c.p}`, right: `המודל אומר: ${c.g}`, approve_label: `הפרויקט: ${c.g}`, reject_label: `הפרויקט: ${c.p}` };
  };
  const items = pick.map((c) => ({ kind: 'bench_question', target_id: c.e.id, text: spec(c).ask, reason: null, payload: JSON.stringify({ bench: 'jev1', email_id: c.e.id, field: c.f, gold: c.g, pipeline: c.p, ...spec(c) }) }));
  const bid = proposals.createBatch('bench', 'כמה שאלות קצרות לבדיקת איכות סיווג המיילים', items); save('owner.json', { batch: bid, n: items.length, cases: pick.map((c) => ({ id: c.e.id, f: c.f })) }); console.log(`owner card: batch ${bid}, ${items.length} questions (of ${cases.length} disagreements)`);
}
// owner's answers override the gold (read from the live database)
function ownerOverrides() {
  const o = load('owner.json'); if (!o || !process.env.BENCH_LIVE_DB) return {};
  const { open } = require('../lib/db'); const db = open(process.env.BENCH_LIVE_DB); const ov = {};
  for (const p of db.prepare("SELECT status, payload FROM proposals WHERE batch=? AND kind='bench_question'").all(o.batch)) { if (p.status === 'open') continue; const pl = JSON.parse(p.payload); (ov[pl.email_id] ||= {})[pl.field] = p.status === 'rejected' ? pl.pipeline : pl.gold; }
  return ov;
}

// ---------------- report
function report() {
  const S = load('sample.json'); const gold = load('gold.json', {}); const hk = load('haiku.json', {}); const jv = load('jev.json', {}); const ov = ownerOverrides(); const nOv = Object.keys(ov).length;
  const G = (e, f) => (ov[e.id] && ov[e.id][f] !== undefined ? ov[e.id][f] : gold[e.id]?.answer?.[f]); const ok = (x) => x !== undefined && x !== null;
  const QS = [['kind', 'סוג'], ['needs_task', 'דורש משימה'], ['ours_vs_others', 'שלנו/אחרים'], ['project', 'פרויקט'], ['related', 'קשור למשימה'], ['fact_worthy', 'ראוי כעובדה'], ['deadline_mentioned', 'מועד יעד']];
  const rows = []; const cell = (fn) => { const a = fn.filter(ok); return a.length; };
  const stat = (name) => {
    const per = { n: 0, hk: 0, jv: 0, jv9: 0, jv9n: 0 }; const ems = S.items.filter((e) => gold[e.id]?.answer);
    const pairs = [];
    for (const e of ems) {
      const keys = name === 'related' ? e.candidates.map((_, i) => `related_${i + 1}`) : [name];
      for (const k of keys) { const g = G(e, k); if (!ok(g)) continue; const h = hk[e.id]?.answer?.[k]; const j = jv[e.id]?.answer?.[k]; pairs.push({ e, g, h, j }); }
    }
    const eq = (a, b) => String(a) === String(b);
    const n = pairs.length; const hv = pairs.filter((p) => ok(p.h)); const jvv = pairs.filter((p) => ok(p.j));
    const acc = (list, f) => (list.length ? list.filter(f).length / list.length : null); const hi = jvv.filter((p) => p.j.conf >= 0.9);
    const pipe = pairs.filter((p) => name in (p.e.pipeline || {})); const layered = pairs.filter((p) => ok(p.j) || ok(p.h)).map((p) => (ok(p.j) && p.j.conf >= 0.9 ? p.j.value : p.h)); const layOk = pairs.filter((p) => ok(p.j) || ok(p.h)).filter((p, i) => eq(p.g, layered[i])).length;
    let best = null; if (jvv.length && typeof jvv[0].j.p === 'number') for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98]) { const a = acc(jvv, (p) => eq(p.g, p.j.p >= t)); if (best == null || a > best.acc) best = { t, acc: a }; }
    return { n, pipeline: pipe.length ? acc(pipe, (p) => eq(p.g, p.e.pipeline[name])) : null, layered: layered.length ? layOk / layered.length : null, best, haiku: acc(hv, (p) => eq(p.g, p.h)), jev: acc(jvv, (p) => eq(p.g, p.j.value)), jev90: acc(hi, (p) => eq(p.g, p.j.value)), cov90: jvv.length ? hi.length / jvv.length : null, haiku_on_covered: acc(hi.filter((p) => ok(p.h)), (p) => eq(p.g, p.h)), pairs };
  };
  const per = Object.fromEntries(QS.map(([q]) => [q, stat(q)]));
  const avg = (o, k) => { const v = Object.values(o).map((x) => x[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const sum = (o, k) => Object.values(o).reduce((a, x) => a + (+x[k] || 0), 0); const n = S.items.length;
  const cost = { sonnet_gold_per_email: sum(gold, 'cost') / Math.max(1, Object.keys(gold).length), haiku_per_email: sum(hk, 'cost') / Math.max(1, Object.keys(hk).length), haiku_ms: avg(hk, 'ms'), jev_ms: avg(jv, 'ms'), jev_in_tokens: avg(jv, 'in'), jev_out_tokens: avg(jv, 'out'), haiku_in: avg(hk, 'in'), haiku_out: avg(hk, 'out') };
  // email level: the core decisions at once (kind, needs_task, project, related) -- Jev answers at >=0.9 on ALL of them, else escalate to haiku
  const core = ['kind', 'needs_task', 'project']; const em = S.items.filter((e) => gold[e.id]?.answer && jv[e.id]?.answer);
  const confAll = em.filter((e) => [...core, ...e.candidates.map((_, i) => `related_${i + 1}`)].every((k) => jv[e.id].answer[k] && jv[e.id].answer[k].conf >= 0.9));
  const coreOk = (e, src) => core.every((k) => String(src(e, k)) === String(G(e, k))); const rel = (e, src) => e.candidates.every((_, i) => String(src(e, `related_${i + 1}`)) === String(G(e, `related_${i + 1}`)));
  const jevAns = (e, k) => jv[e.id].answer[k]?.value; const hkAns = (e, k) => hk[e.id]?.answer?.[k];
  const emailLevel = { emails: em.length, coverage90: em.length ? confAll.length / em.length : null, jev90_core_acc: confAll.length ? confAll.filter((e) => coreOk(e, jevAns)).length / confAll.length : null, jev90_core_related_acc: confAll.length ? confAll.filter((e) => coreOk(e, jevAns) && rel(e, jevAns)).length / confAll.length : null, haiku_core_acc: em.filter((e) => hk[e.id]?.answer).length ? em.filter((e) => hk[e.id]?.answer && coreOk(e, hkAns)).length / em.filter((e) => hk[e.id]?.answer).length : null };
  const gk = (e) => G(e, 'kind'); const nz = em.filter((e) => jv[e.id].answer.kind && jv[e.id].answer.kind.value === 'noise' && jv[e.id].answer.kind.conf >= 0.9); const goldNoise = em.filter((e) => gk(e) === 'noise');
  const noiseGate = { jev_noise_at_90: nz.length, share_of_mail: em.length ? nz.length / em.length : null, precision: nz.length ? nz.filter((e) => gk(e) === 'noise').length / nz.length : null, recall_of_gold_noise: goldNoise.length ? nz.filter((e) => gk(e) === 'noise').length / goldNoise.length : null, gold_noise: goldNoise.length };
  const byStratum = {}; for (const s of ['relevant_task', 'relevant_notask', 'fyi', 'noise', 'sent']) { const L = em.filter((e) => e.stratum === s); const C = L.filter((e) => confAll.includes(e)); byStratum[s] = { n: L.length, cov90: L.length ? C.length / L.length : null, acc: C.length ? C.filter((e) => coreOk(e, jevAns)).length / C.length : null }; }
  // the production design: Jev first, escalate to haiku when any core answer is below 0.9; (the cost of Jev is in tokens: priced by the caller)
  const cov = emailLevel.coverage90 ?? 0; const design = { jev_share: cov, escalated_share: 1 - cov, haiku_cost_per_email: cost.haiku_per_email, expected_llm_cost_per_email: (1 - cov) * cost.haiku_per_email, baseline_haiku_only: cost.haiku_per_email, error_rate_jev_part: emailLevel.jev90_core_acc == null ? null : 1 - emailLevel.jev90_core_acc, error_rate_haiku_part: emailLevel.haiku_core_acc == null ? null : 1 - emailLevel.haiku_core_acc,
    expected_error_rate: (emailLevel.jev90_core_acc == null || emailLevel.haiku_core_acc == null) ? null : cov * (1 - emailLevel.jev90_core_acc) + (1 - cov) * (1 - emailLevel.haiku_core_acc) };
  const results = { n, owner_overrides: nOv, gold_cost_total: sum(gold, 'cost'), per: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { n: v.n, pipeline: v.pipeline, layered: v.layered, jev_best_threshold: v.best, haiku: v.haiku, jev: v.jev, jev_conf90: v.jev90, coverage90: v.cov90, haiku_on_jev_covered: v.haiku_on_covered }])), cost, email_level: emailLevel, by_stratum: byStratum, noise_gate: noiseGate, design, failures: { jev: Object.values(jv).filter((x) => !x.answer).length, haiku: Object.values(hk).filter((x) => !x.answer).length, gold: Object.values(gold).filter((x) => !x.answer).length } };
  const { open } = require('../lib/db'); const db = open(process.env.BENCH_LIVE_DB || process.env.MESIMOT_DB);
  db.prepare('INSERT INTO benchmarks (name, created_at, config, results) VALUES (?,?,?,?)').run('jev-vs-haiku', new Date().toISOString(), JSON.stringify({ n, gold: 'sonnet/high', jev: 'typesafe/jev', haiku: 'haiku/medium' }), JSON.stringify(results));
  const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`); const usd = (x) => (x == null ? 'n/a' : `$${x.toFixed(4)}`);
  const md = [`# Jev vs haiku: decision benchmark on real mail`, '', `Aggregate numbers only (no mail content, names or projects). ${n} real emails, stratified (relevant with a task, relevant without a task, fyi, noise, the owner's sent mail), cleaned text capped near 6K tokens. Gold: sonnet at high effort, once per email${nOv ? `; the owner's answers override the gold on ${nOv} emails` : '; owner answers pending (gold only)'}. Same seven questions for both models.`, '',
    '| question | n | pipeline acc | haiku acc | Jev acc | Jev acc at conf>=0.9 | Jev coverage at >=0.9 | Jev>=0.9 else haiku | Jev best threshold (noul) |', '|---|---|---|---|---|---|---|---|---|', ...QS.map(([k]) => `| ${k} | ${per[k].n} | ${pct(per[k].pipeline)} | ${pct(per[k].haiku)} | ${pct(per[k].jev)} | ${pct(per[k].jev90)} | ${pct(per[k].cov90)} | ${pct(per[k].layered)} | ${per[k].best ? `p>=${per[k].best.t}: ${pct(per[k].best.acc)}` : '-'} |`), '',
    `Noise gate (Jev says noise at conf>=0.9, haiku skipped): ${noiseGate.jev_noise_at_90} of ${em.length} emails (${pct(noiseGate.share_of_mail)}), precision ${pct(noiseGate.precision)}, recall of the gold noise ${pct(noiseGate.recall_of_gold_noise)} (${noiseGate.gold_noise} gold-noise emails).`, '',
    `Email level (kind + needs_task + project all at conf>=0.9): coverage ${pct(emailLevel.coverage90)}, accuracy of those ${pct(emailLevel.jev90_core_acc)} (with related_task too: ${pct(emailLevel.jev90_core_related_acc)}); haiku on all emails: ${pct(emailLevel.haiku_core_acc)}.`, '',
    `Cost and latency per email: haiku ${usd(cost.haiku_per_email)}, ${Math.round(cost.haiku_ms || 0)} ms; sonnet gold ${usd(cost.sonnet_gold_per_email)}; Jev ${Math.round(cost.jev_in_tokens || 0)} input and ${Math.round(cost.jev_out_tokens || 0)} output tokens, ${Math.round(cost.jev_ms || 0)} ms (priced by Workers AI credits, not measured in dollars here).`, '',
    '| stratum | n | Jev coverage at >=0.9 | accuracy of covered |', '|---|---|---|---|', ...Object.entries(byStratum).map(([s, v]) => `| ${s} | ${v.n} | ${pct(v.cov90)} | ${pct(v.acc)} |`), '',
    `## Production design (recommendation)\n\n${(() => { const first = QS.map(([k]) => k).filter((k) => per[k].jev90 != null && per[k].jev90 >= 0.97 && (per[k].cov90 || 0) >= 0.35); const weak = QS.map(([k]) => k).filter((k) => !first.includes(k)); return `1. **Keep a small LLM (haiku) as the decision model**: it matches the gold better than Jev on kind, needs_task, ours_vs_others and fact_worthy (${['kind', 'needs_task', 'ours_vs_others', 'fact_worthy'].map((k) => `${k} ${pct(per[k].haiku)} vs ${pct(per[k].jev)}`).join(', ')}) and costs ${usd(cost.haiku_per_email)} per email on cleaned text, ${Math.round(cost.haiku_ms || 0)} ms.\n2. **Jev as a first layer only where it is both confident and accurate**: ${first.length ? first.map((k) => `${k} (accuracy ${pct(per[k].jev90)} at conf>=0.9, answers ${pct(per[k].cov90)} of the cases)`).join(', ') : 'no question qualifies'}; every other case is escalated to haiku. For ${weak.join(', ')} Jev is below that bar (confidence >=0.9 covers only ${weak.map((k) => `${k} ${pct(per[k].cov90)}`).join(', ')}), so those always go to haiku.\n3. **Noise gate**: Jev kind=noise at conf>=0.9 skips the LLM for ${pct(noiseGate.share_of_mail)} of this sample at ${pct(noiseGate.precision)} precision (recall of the gold noise ${pct(noiseGate.recall_of_gold_noise)}).\n4. **Expected cost and error**: since needs_task/kind/fact must be answered by haiku for nearly every email, the LLM call is saved only for the noise gate (${pct(noiseGate.share_of_mail)}): about ${usd((1 - (noiseGate.share_of_mail || 0)) * cost.haiku_per_email)} per email against ${usd(cost.haiku_per_email)} (Jev adds ~${Math.round(cost.jev_in_tokens || 0)} tokens in and ~${Math.round(cost.jev_out_tokens || 0)} out per call on Workers AI credits). Expected error on the core decisions stays that of haiku (${pct(1 - (emailLevel.haiku_core_acc || 0))} on the combined kind + needs_task + project, against the gold${nOv ? ' corrected by the owner' : ''}), the pipeline's own decisions agree with the gold at kind ${pct(per.kind.pipeline)}, needs_task ${pct(per.needs_task.pipeline)}.\n5. The decisive cost in production is the size of the prompt and the number of gate retries, not the classification call: this benchmark uses ~${Math.round((S.items.reduce((a, e) => a + e.chars, 0) / S.items.length))} characters of cleaned text per email.`; })()}`, '',
    `Failures (no parsable answer): Jev ${results.failures.jev}, haiku ${results.failures.haiku}, gold ${results.failures.gold}.`, ''].join('\n');
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'BENCHMARK-JEV.md'), md); console.log(md);
}

(async () => {
  if (step === 'sample') await sample();
  else if (step === 'gold') await runLlm('gold.json', 'sonnet', 'high', 3);
  else if (step === 'haiku') await runLlm('haiku.json', 'haiku', 'medium', 4);
  else if (step === 'jev') await runJev();
  else if (step === 'owner') await owner();
  else if (step === 'report') report();
  else console.log('usage: bench-jev.js sample|gold|haiku|jev|owner|report');
})().catch((e) => { console.error(e); process.exit(1); });
