'use strict';
// Project passport + latest status per process (lib/profile.js): storage with history, a real source and date, newer wins, the owner's edit wins,
// the API / CLI / apply paths, fact topics, and the gate question when a mail speaks about them.
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-prof-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const { open, now } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createApply } = require('../lib/apply');
const { createGate } = require('../lib/gate');
const { guessTopic } = require('../lib/profile');

function setup() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const a = store.assistantId(), owner = store.ownerId();
  const p = store.createProject(owner, { name: 'מגדל הדוגמה' });
  const mail = (subject, body, date) => db.prepare('INSERT INTO emails (message_id, from_addr, to_addr, subject, original_subject, received_at, forwarded_date, body_text, project_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('m' + Math.random(), 'Ron <ron@vendor.example>', 'o@x.example', subject, subject, date + 'T08:00:00Z', date + 'T08:00:00Z', body, p.id).lastInsertRowid;
  return { db, store, knowledge, chat, prof: knowledge.profile, a, owner, p, mail };
}

test('passport: a value needs a real source and its date; numbers are numbers; the headline reads like a sentence', () => {
  const S = setup(); const e1 = S.mail('תכנון', '2 בניינים, 8 ו-12 קומות, 58 יח"ד', '2026-11-10');
  assert.throws(() => S.prof.setProfile(S.a, { project: S.p.id, units_new: 58, as_of: '2026-11-10' }), /מקור/);
  assert.throws(() => S.prof.setProfile(S.a, { project: S.p.id, units_new: 58, as_of: '2026-11-10', source: 'email:9999' }), /לא נמצא/);
  assert.throws(() => S.prof.setProfile(S.a, { project: S.p.id, units_new: 58, source: `email:${e1}` }), /תאריך/);
  assert.throws(() => S.prof.setProfile(S.a, { project: S.p.id, units_new: 'הרבה', as_of: '2026-11-10', source: `email:${e1}` }), /מספר שלם/);
  assert.throws(() => S.prof.setProfile(S.a, { project: S.p.id, units_new: 58, as_of: '2099-01-01', source: `email:${e1}` }), /עתידי/);
  assert.throws(() => S.prof.setProfile(S.a, { project: S.p.id, colour: 'x', as_of: '2026-11-10', source: `email:${e1}` }), /לא מוכר/);
  const r = S.prof.setProfile(S.a, { project: S.p.id, buildings: 2, floors: '8 ו-12', units_new: '58 יח"ד', as_of: '10/11/2026', source: `email:${e1}` });
  assert.deepEqual(r.results, { buildings: 'created', floors: 'created', units_new: 'created' });
  const pr = S.prof.getProfile(S.p.id);
  const f = Object.fromEntries(pr.fields.map((x) => [x.field, x]));
  assert.equal(f.units_new.value, '58'); assert.equal(f.floors.value, '8, 12'); assert.equal(f.units_existing.value, null);
  assert.equal(f.units_new.as_of, '2026-11-10'); assert.equal(f.units_new.source.type, 'email'); assert.equal(f.units_new.source.link, `/email/${e1}`);
  assert.equal(pr.headline, '2 בניינים: 8 ו-12 קומות');
});

test('newer wins: an older value is history only, a newer one replaces, the same value with a newer date only confirms', () => {
  const S = setup(); const old = S.mail('a', 'x', '2026-10-01'), mid = S.mail('b', 'x', '2026-11-01'), nw = S.mail('c', 'x', '2026-11-20');
  S.prof.setProfile(S.a, { project: S.p.id, units_new: 60, as_of: '2026-11-01', source: `email:${mid}` });
  assert.equal(S.prof.setProfile(S.a, { project: S.p.id, units_new: 52, as_of: '2026-10-01', source: `email:${old}` }).results.units_new, 'history_only');
  assert.equal(S.prof.getProfile(S.p.id).fields.find((x) => x.field === 'units_new').value, '60');
  assert.equal(S.prof.setProfile(S.a, { project: S.p.id, units_new: 58, as_of: '2026-11-20', source: `email:${nw}` }).results.units_new, 'replaced');
  assert.equal(S.prof.setProfile(S.a, { project: S.p.id, units_new: 58, as_of: '2026-11-25', source: `email:${nw}` }).results.units_new, 'confirmed');
  const cur = S.prof.getProfile(S.p.id).fields.find((x) => x.field === 'units_new'); assert.equal(cur.value, '58'); assert.equal(cur.as_of, '2026-11-25');
  const h = S.prof.history(S.p.id, 'field', 'units_new');
  assert.equal(h.length, 3); assert.equal(h.filter((x) => x.current).length, 1);
  // statuses: the same rule per process, and processes are independent
  const st = (process, text, as_of, src) => S.prof.setStatus(S.a, { project: S.p.id, process, text, as_of, source: `email:${src}` }).result;
  assert.equal(st('construction', 'שלד בקומה 5', '2026-11-01', mid), 'created');
  assert.equal(st('permit', 'בקשה להיתר שינויים הוגשה', '2026-11-20', nw), 'created');
  assert.equal(st('construction', 'שלד בקומה 3', '2026-10-01', old), 'history_only');
  assert.equal(st('construction', 'שלד בקומה 7', '2026-11-20', nw), 'replaced');
  const s2 = Object.fromEntries(S.prof.getProfile(S.p.id).statuses.map((x) => [x.process, x.value]));
  assert.deepEqual(s2, { design: null, permit: 'בקשה להיתר שינויים הוגשה', construction: 'שלד בקומה 7', marketing: null });
  assert.throws(() => S.prof.setStatus(S.a, { project: S.p.id, process: 'sales-ish', text: 'x', as_of: '2026-11-20', source: `email:${nw}` }), /תהליך לא מוכר/);
  assert.equal(S.prof.processOf('שיווק'), 'marketing');
});

test('the owner wins: his passport value is never replaced by the assistant; his status only by a strictly newer one; he can clear', () => {
  const S = setup(); const e = S.mail('a', 'x', '2026-11-26');
  const o = S.prof.setProfile(S.owner, { project: S.p.id, units_existing: 24 });
  assert.equal(o.results.units_existing, 'created');
  const cur = () => S.prof.getProfile(S.p.id).fields.find((x) => x.field === 'units_existing');
  assert.equal(cur().by_owner, true); assert.equal(cur().source.type, 'manual');
  assert.equal(S.prof.setProfile(S.a, { project: S.p.id, units_existing: 30, as_of: '2026-11-26', source: `email:${e}` }).results.units_existing, 'kept_owner_value');
  assert.equal(cur().value, '24');
  // statuses: the owner's line stays against the same day or older, a strictly newer source replaces it
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  S.prof.setStatus(S.owner, { project: S.p.id, process: 'marketing', text: 'נמכרו 40 דירות', as_of: '2026-11-20' });
  assert.equal(S.prof.setStatus(S.a, { project: S.p.id, process: 'marketing', text: 'נמכרו 35 דירות', as_of: '2026-11-20', source: `email:${e}` }).result, 'kept_owner_value');
  assert.equal(S.prof.setStatus(S.a, { project: S.p.id, process: 'marketing', text: 'נמכרו 44 דירות', as_of: '2026-11-26', source: `email:${e}` }).result, 'replaced');
  assert.ok(today >= '2026-11-26');
  // only the owner clears; the field then reads as unknown
  assert.throws(() => S.prof.setProfile(S.a, { project: S.p.id, units_existing: '', as_of: '2026-11-26', source: `email:${e}` }), /רק הבעלים/);
  S.prof.setProfile(S.owner, { project: S.p.id, units_existing: '' });
  assert.equal(cur().value, null); assert.equal(cur().cleared, true);
});

test('fact topics: new facts get one (given, inherited or guessed), the whole key moves together; undo of a passport value restores the old one', () => {
  const S = setup();
  assert.equal(guessTopic('היתר שינויים', ''), 'permit'); assert.equal(guessTopic('חשבון 10/26', ''), 'finance'); assert.equal(guessTopic('יועץ חשמל', 'נדב'), 'people');
  assert.equal(guessTopic('סטטוס שלד', ''), 'construction'); assert.equal(guessTopic('אחראית מכירות', ''), 'marketing'); assert.equal(guessTopic('משהו', 'כלום'), 'other');
  const f1 = S.knowledge.setFact(S.a, { project: S.p.id, key: 'סט תוכניות', value: 'סט 19/11', as_of: '2026-11-19', source: 'chat' }).fact;
  assert.equal(f1.topic, 'design');
  S.prof.setFactTopic(S.a, { project: S.p.id, key: 'סט תוכניות', topic: 'marketing' });
  const f2 = S.knowledge.setFact(S.a, { project: S.p.id, key: 'סט תוכניות', value: 'סט 25/11', as_of: '2026-11-25', source: 'chat' }).fact;
  assert.equal(f2.topic, 'marketing', 'a new value keeps the key topic');
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM project_facts WHERE key='סט תוכניות' AND topic='marketing'").get().c, 2);
  assert.throws(() => S.prof.setFactTopic(S.a, { id: f2.id, topic: 'nope' }), /נושא לא מוכר/);
  S.db.prepare('UPDATE project_facts SET topic=NULL').run(); assert.equal(S.prof.fillTopics(S.p.id), 2);
  // undo
  const e = S.mail('a', 'x', '2026-11-26'), e0 = S.mail('b', 'x', '2026-11-01');
  S.prof.setProfile(S.a, { project: S.p.id, architect: 'משרד א', as_of: '2026-11-01', source: `email:${e0}` });
  S.prof.setProfile(S.a, { project: S.p.id, architect: 'משרד ב', as_of: '2026-11-26', source: `email:${e}` });
  const { createUndo } = require('../lib/undo'); const undo = createUndo(S.db, S.store, S.knowledge);
  const ev = S.db.prepare("SELECT id FROM events WHERE entity='profile' AND action='create' ORDER BY id DESC LIMIT 1").get();
  undo.undoEvent(S.owner, ev.id);
  assert.equal(S.prof.getProfile(S.p.id).fields.find((x) => x.field === 'architect').value, 'משרד א');
});

test('apply: profile, statuses, fact_topics and profile_checked in one call; a bad source rejects the whole call', () => {
  const S = setup(); const e = S.mail('a', 'x', '2026-11-24');
  const ap = createApply(S.db, S.store, S.knowledge, S.chat, { addProtocol() {} }, { addItem() {} });
  const runId = S.chat.startRun('chat', 1);
  const f = S.knowledge.setFact(S.a, { project: S.p.id, key: 'דבר', value: 'x', as_of: '2026-11-01', source: 'chat' }).fact;
  assert.throws(() => ap.apply(S.a, { profile: [{ project: S.p.id, units_new: 10, as_of: '2026-11-24', source: 'email:424242' }] }), /לא נמצא/);
  assert.equal(S.prof.getProfile(S.p.id).fields.find((x) => x.field === 'units_new').value, null);
  const r = ap.apply(S.a, { email: e, profile: [{ project: S.p.id, units_new: 58, buildings: 1, as_of: '2026-11-24' }], statuses: [{ project: S.p.id, process: 'design', text: 'תכנון מפורט הושלם', as_of: '2026-11-24' }], fact_topics: [{ topic: 'finance', ids: [f.id] }] });
  assert.equal(r.ok, true); assert.deepEqual(r.statuses, ['created']);
  const pr = S.prof.getProfile(S.p.id);
  assert.equal(pr.fields.find((x) => x.field === 'units_new').source.id, e, 'the payload email is the default source');
  assert.equal(pr.headline, 'בניין אחד');
  assert.equal(S.db.prepare('SELECT topic FROM project_facts WHERE id=?').get(f.id).topic, 'finance');
  assert.equal(S.db.prepare('SELECT profile_checked FROM claude_runs WHERE id=?').get(runId).profile_checked, 1);
  S.chat.finishRun(runId, {});
});

test('gate: a processed mail about floors / a permit asks for the passport or statuses until it is updated or declared unchanged', async () => {
  const S = setup();
  const gate = createGate({ db: S.db, store: S.store, knowledge: S.knowledge });
  const e = S.mail('היתר', 'הוועדה המקומית אישרה את ההיתר. 2 בניינים, 12 קומות.', '2026-11-24');
  const em = S.db.prepare('SELECT * FROM emails WHERE id=?').get(e);
  const runId = S.chat.startRun('batch', 1);
  S.db.prepare('UPDATE claude_runs SET facts_checked=1 WHERE id=?').run(runId);
  S.chat.sendChat(S.a, { text: 'דיווח' }, { agent: true });
  let v = await gate.check(runId, { emails: [em] });
  assert.ok(v.some((x) => x.code === 'profile'), 'asked about the passport / status');
  assert.match(v.find((x) => x.code === 'profile').question, /statuses/);
  S.db.prepare('UPDATE claude_runs SET profile_checked=1 WHERE id=?').run(runId);
  v = await gate.check(runId, { emails: [em] });
  assert.ok(!v.some((x) => x.code === 'profile'));
  // a mail with nothing of the kind is not asked about
  const quiet = S.db.prepare('SELECT * FROM emails WHERE id=?').get(S.mail('תודה', 'תודה רבה, נדבר מחר', '2026-11-24'));
  const run2 = S.chat.startRun('batch', 1); S.db.prepare('UPDATE claude_runs SET facts_checked=1 WHERE id=?').run(run2); S.chat.sendChat(S.a, { text: 'דיווח' }, { agent: true });
  assert.ok(!(await gate.check(run2, { emails: [quiet] })).some((x) => x.code === 'profile'));
});

test('API and CLI: the owner edits on the site (marked), the assistant writes through `mesimot project profile|status` with a source; the page carries everything', async () => {
  const S = setup(); const e = S.mail('a', 'x', '2026-11-24');
  const { build } = require('../lib/server'); const auth = require('../lib/auth'); auth.setPassword(S.db, 'pw pw pw pw pw pw');
  const app = build({ db: S.db, token: 'tok', loginDelayMs: 0 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const cli = (...args) => new Promise((res) => execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'mesimot'), ...args], { env: { ...process.env, MESIMOT_URL: url, MESIMOT_TOKEN: 'tok' } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, out: stdout, err: stderr })));
  try {
    let r = await cli('project', 'profile', String(S.p.id), '--units-new', '58', '--floors', '8, 12', '--buildings', '2', '--as-of', '2026-11-24', '--source', `email:${e}`);
    assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).results.units_new, 'created');
    r = await cli('project', 'profile', String(S.p.id), '--units-existing', '24', '--as-of', '2026-11-24');
    assert.notEqual(r.code, 0); assert.match(r.err, /מקור/);
    r = await cli('project', 'status', String(S.p.id), '--process', 'construction', '--text', 'שלד בקומה 7', '--as-of', '2026-11-24', '--source', `email:${e}`);
    assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).result, 'created');
    r = await cli('project', 'status', String(S.p.id));
    assert.equal(JSON.parse(r.out).find((x) => x.process === 'construction').value, 'שלד בקומה 7');
    r = await cli('project', 'profile', String(S.p.id));
    assert.equal(JSON.parse(r.out).headline, '2 בניינים: 8 ו-12 קומות');
    // the owner on the site: no source needed, marked as his, wins
    const l = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw pw pw pw pw pw' } }); const ow = { cookie: `mesimot_session=${l.cookies[0].value}`, 'x-mesimot': '1' };
    const w = await app.inject({ method: 'POST', url: `/api/projects/${S.p.id}/profile`, headers: ow, payload: { units_new: 60 } });
    assert.equal(w.statusCode, 200, w.body);
    r = await cli('project', 'profile', String(S.p.id), '--units-new', '58', '--as-of', '2026-11-24', '--source', `email:${e}`);
    assert.equal(JSON.parse(r.out).results.units_new, 'kept_owner_value');
    const pg = (await app.inject({ method: 'GET', url: `/api/projects/${S.p.id}/page`, headers: ow })).json();
    const un = pg.profile.fields.find((x) => x.field === 'units_new'); assert.equal(un.value, '60'); assert.equal(un.by_owner, true);
    assert.ok(pg.topics && pg.topics.finance && Array.isArray(pg.facts_history) && Array.isArray(pg.people));
    const st = await app.inject({ method: 'POST', url: `/api/projects/${S.p.id}/status`, headers: ow, payload: { process: 'marketing', text: 'השיווק נפתח' } });
    assert.equal(st.json().result, 'created');
  } finally { await app.close(); }
});
