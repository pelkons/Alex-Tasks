'use strict';
// WRITING STYLES (lib/writingstyle.js, lib/styleanalysis.js): the resolver's priority order, mixed recipients -> the most formal, every rule of the validator
// with its Hebrew message, the gate on outbox / draft add / apply (refused and accepted), the owner's edits as feedback, suggestions that are never applied by
// themselves, and the measuring of the owner's sent mail. All people, addresses and mails here are FICTIONAL.
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-styles-'));
process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(TMP, 'outbox-sign.key'); process.env.MESIMOT_FILES = path.join(TMP, 'files');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createStyles, metrics, greetingForm, ownText } = require('../lib/writingstyle');
const { createStyleAnalysis } = require('../lib/styleanalysis');
const { build } = require('../lib/server');
const { createGate } = require('../lib/gate');

const TOKEN = 'styles-token-123';
function lib() {
  const db = open(':memory:'); const store = createStore(db); const S = createStyles({ db, store }); S.ensureSeed();
  const o = store.ownerId(), a = store.assistantId();
  const P = (name, emails, extra = {}) => { const p = store.createPerson(o, { name, emails, ...extra }); return p; };
  const ron = store.listPeople().find((p) => p.name_he === 'רון שחר'); store.updatePerson(o, ron.id, { emails: 'ron@exconstruct.example' });
  const avi = store.listPeople().find((p) => p.name_he === 'אבי כהן'); store.updatePerson(o, avi.id, { emails: 'avi@exconstruct.example' });
  const noa = P('נועה ברק', 'noa@studio-arc.example'); const tal = P('טל מור', 'tal@builders.example');
  return { db, store, S, o, a, ron, avi, noa, tal };
}
const casual = (L, extra = {}) => L.S.create(L.o, { key: 'colleague', name_he: 'עמית', status: 'active', rules: { formality: 'casual', greeting: '{first_name}, היי', greeting_alt: ['היי {first_name}'], closing: 'none', max_sentences: 2, allow_bullets: false }, ...extra });

test('resolver: person > group > domain > role > default, only active styles', () => {
  const L = lib();
  assert.equal(L.S.resolve({ to: 'noa@studio-arc.example' }).style.key, 'base', 'nothing assigned: the default');
  const role = L.S.create(L.o, { key: 'newp', name_he: 'חדש', status: 'active', rules: { formality: 'neutral' }, assignments: [{ kind: 'role', ref: 'unknown' }] });
  assert.equal(L.S.resolve({ to: 'someone@nowhere.example' }).level, 'role'); assert.equal(L.S.resolve({ to: 'someone@nowhere.example' }).style.key, role.key);
  const dom = L.S.create(L.o, { key: 'arch', name_he: 'אדריכלים', status: 'active', rules: { formality: 'neutral' }, assignments: [{ kind: 'domain', ref: 'studio-arc.example' }] });
  assert.equal(L.S.resolve({ to: 'noa@studio-arc.example' }).style.key, 'arch'); assert.equal(L.S.resolve({ to: 'x@mail.studio-arc.example' }).level, 'domain', 'a sub-domain matches');
  L.S.create(L.o, { key: 'grp', name_he: 'קבוצה', status: 'active', rules: { formality: 'neutral' }, assignments: [{ kind: 'group', ref: 'יועצים' }] });
  L.S.setGroup(L.o, L.noa.id, 'יועצים');
  assert.equal(L.S.resolve({ to: 'noa@studio-arc.example' }).style.key, 'grp', 'the group beats the domain');
  const pers = casual(L, { assignments: [{ kind: 'person', ref: String(L.noa.id) }] });
  const r = L.S.resolve({ to: 'נועה ברק (noa@studio-arc.example)' }); assert.equal(r.style.key, pers.key); assert.equal(r.via, 'אדם: נועה ברק');
  assert.equal(L.S.resolve({ to: 'נועה' }).style.key, pers.key, 'a bare first name finds the person');
  L.S.update(L.o, pers.id, { status: 'proposed' }, { owner: true });
  assert.equal(L.S.resolve({ to: 'noa@studio-arc.example' }).style.key, 'grp', 'a proposed style is not used');
  assert.equal(L.S.resolve({ to: 'avi@exconstruct.example' }).style.key, 'base');
  L.S.create(L.o, { key: 'mgmt', name_he: 'הנהלה', status: 'active', rules: { formality: 'formal' }, assignments: [{ kind: 'role', ref: 'boss' }] });
  assert.equal(L.S.resolve({ to: 'avi@exconstruct.example' }).style.key, 'mgmt', 'a boss from the configuration');
});

test('resolver: mixed recipients take the MOST formal style and say so', () => {
  const L = lib();
  casual(L, { assignments: [{ kind: 'person', ref: String(L.ron.id) }] });
  L.S.create(L.o, { key: 'mgmt', name_he: 'הנהלה', status: 'active', rules: { formality: 'formal' }, assignments: [{ kind: 'role', ref: 'boss' }] });
  const r = L.S.resolve({ to: 'ron@exconstruct.example', cc: 'avi@exconstruct.example' });
  assert.equal(r.style.key, 'mgmt'); assert.equal(r.mixed, true); assert.match(r.note_he, /נבחר הרשמי ביותר, "הנהלה"/);
  const one = L.S.resolve({ to: 'ron@exconstruct.example' }); assert.equal(one.style.key, 'colleague'); assert.equal(one.mixed, false);
});

test('validator: every rule, with a Hebrew message', () => {
  const L = lib(); const st = L.S.find(casual(L).key);
  const v = (t, ctx = {}) => L.S.validate(t, st, { to_names: ['רון'], to_count: 1, ...ctx }).violations;
  assert.deepEqual(v('רון, היי\nמה עם התוכניות?'), [], 'his own way passes');
  assert.deepEqual(v('היי רון, מה עם התוכניות?'), [], 'an alternative greeting on the same line');
  const bad = v('שלום רון,\nאשמח אם תוכל לשלוח את התוכניות.\nבכבוד רב,\nדנה');
  const codes = bad.map((x) => x.code);
  for (const c of ['forbidden', 'greeting', 'signature']) assert.ok(codes.includes(c), c);
  assert.ok(bad.find((x) => x.code === 'forbidden' && /"אשמח אם תוכל"/.test(x.he))); assert.match(bad.find((x) => x.code === 'greeting').he, /הפתיחה צריכה להיות "רון, היי"/);
  assert.match(bad.find((x) => x.code === 'signature').he, /בלי חתימה/);
  assert.match(v('רון, היי\nאחת. שתיים. שלוש.').find((x) => x.code === 'length').he, /לקצר: 3 משפטים, בסגנון הזה עד 2/);
  assert.deepEqual(v('רון, היי\nאחת. שתיים. שלוש.', { long: true }), [], '--long skips only the length');
  assert.match(v('רון, היי\n- התוכניות').find((x) => x.code === 'bullets').he, /תבליטים/);
  assert.match(v('רון, היי\nמה נשמע? 👍').find((x) => x.code === 'emoji').he, /אימוג׳י/);
  assert.match(v('רון, היי\nתודה.\nבברכה').find((x) => x.code === 'closing').he, /בלי שורת סיום/);
  // the language, the address form, required phrases, a closing that must be there, words (soft then hard)
  const st2 = { rules: { formality: 'neutral', language: 'he', greeting: 'any', closing: 'תודה', signature: 'any', max_words: 10, address: 'singular', required_phrases: ['פרויקט'], forbidden_phrases: [], allow_bullets: true, emoji: true } };
  const v2 = (t) => L.S.validate(t, st2, { to_names: ['רון'], to_count: 1 });
  assert.match(v2('Hi Ron, please send the plans for the project.\nתודה').violations.find((x) => x.code === 'language').he, /לכתוב בעברית/);
  assert.match(v2('רון, תוכלו לשלוח את הפרויקט?\nתודה').violations.find((x) => x.code === 'address').he, /לפנות ביחיד/);
  assert.match(v2('רון, תשלח את התוכניות\nתודה').violations.find((x) => x.code === 'required').he, /חסר הביטוי "פרויקט"/);
  assert.match(v2('רון, תשלח את הפרויקט').violations.find((x) => x.code === 'closing').he, /לסיים ב-"תודה"/);
  assert.equal(v2('רון, תשלח את הפרויקט היום אם אפשר בבקשה רבה כי צריך\nתודה').warnings.length, 1, 'a little long: a warning');
  assert.match(v2('רון, תשלח את הפרויקט היום אם אפשר בבקשה רבה כי אנחנו ממש צריכים את זה מחר\nתודה').violations.find((x) => x.code === 'length').he, /מילים/);
  // greeting "none"
  const st3 = { rules: { formality: 'neutral', greeting: 'none', closing: 'any', signature: 'any' } };
  assert.match(L.S.validate('שלום רון,\nמה המצב?', st3, {}).violations[0].he, /בלי פנייה/);
  // the parts of a mail
  const m = metrics('בוקר טוב ניק,\n\nהגיוס בוטל.\n\nבברכה,\nדנה לוי', ['דנה', 'דנה לוי']); assert.equal(m.greeting, 'בוקר טוב ניק,'); assert.equal(m.closing, null); assert.ok(m.signature, '"בברכה" above the name is the signature block'); assert.equal(m.sentences, 1);
  assert.equal(greetingForm('בוקר טוב ניק,'), 'בוקר טוב {first_name}'); assert.equal(greetingForm('גיל, היי'), '{first_name}, היי');
  assert.equal(ownText('From: Office <o@example.com>\nSent: Tuesday\nשלום רב,\nנשמח לקבל מענה.'), '', 'a bare forward is not his text');
  assert.equal(ownText('הי חנה,\nמצורף.\n\nGet Outlook for Android\n________________________________\nFrom: X\nשלום'), 'הי חנה,\nמצורף.');
});

const { server } = require('./helpers/styles');

test('gate: `style for` gives the style, the guide and his real sent mail (quoted text removed); outbox / draft add / apply refuse a stiff draft and accept his way', async () => {
  const X = server(); const { app, bearer } = X;
  const f = (await app.inject({ method: 'GET', url: '/api/styles/for?to=' + encodeURIComponent('ron@exconstruct.example'), headers: bearer })).json();
  assert.equal(f.style.key, 'colleague'); assert.match(f.guide, /פתיחה: "רון, היי"/); assert.equal(f.examples[0].text, 'רון, היי\nשלחת כבר את התוכניות?', 'the quoted mail is stripped');
  const stiff = { to: 'ron@exconstruct.example', subject: 'תוכניות', body: 'לכבוד רון,\nאשמח אם תוכל לשלוח את התוכניות המעודכנות.\nבכבוד רב,\nדנה' };
  const r = await app.inject({ method: 'POST', url: '/api/outbox', headers: bearer, payload: stiff });
  assert.equal(r.statusCode, 422); const j = r.json();
  assert.match(j.error, /הטיוטה לא נשמרה: היא לא בסגנון "עמית"/); assert.match(j.error, /המדריך:/); assert.match(j.error, /כך הבעלים עצמו כתב להם/); assert.ok(j.violations.length >= 3);
  assert.equal(X.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 0, 'nothing was saved');
  assert.equal(X.db.prepare("SELECT COUNT(*) n FROM gate_log WHERE code='style' AND detail LIKE 'refused:%'").get().n, 1, 'the refusal is logged');
  const ok = await app.inject({ method: 'POST', url: '/api/outbox', headers: bearer, payload: { ...stiff, body: 'רון, היי\nתשלח לי את התוכניות המעודכנות?' } });
  assert.equal(ok.statusCode, 201); assert.equal(ok.json().style_key, 'colleague'); assert.equal(ok.json().style_name, 'עמית', 'the card knows the style');
  const card = X.db.prepare('SELECT * FROM chat_messages WHERE outbox_id=?').get(ok.json().id); assert.equal(app.outbox.cardView(card.outbox_id, card.outbox_hash).style_name, 'עמית');
  // update is checked too
  const up = await app.inject({ method: 'PATCH', url: `/api/outbox/${ok.json().id}`, headers: bearer, payload: { body: 'שלום רון,\nנא אשר קבלת.' } }); assert.equal(up.statusCode, 422);
  // a task draft: "אל:" names the recipient
  const d1 = await app.inject({ method: 'POST', url: `/api/tasks/${X.task.id}/drafts`, headers: bearer, payload: { text: 'אל: רון ron@exconstruct.example\nלכבוד רון, הריני לעדכן.' } }); assert.equal(d1.statusCode, 422);
  const d2 = await app.inject({ method: 'POST', url: `/api/tasks/${X.task.id}/drafts`, headers: bearer, payload: { text: 'אל: רון ron@exconstruct.example\nרון, היי\nמה עם התוכניות?' } }); assert.equal(d2.statusCode, 201); assert.equal(d2.json().style_key, 'colleague');
  // apply: the whole answer is refused, nothing of it is applied
  const ap = await app.inject({ method: 'POST', url: '/api/apply', headers: bearer, payload: { new_tasks: [{ title: 'משימה שלא תיווצר' }], outbox: [{ op: 'draft', ...stiff }] } }); assert.equal(ap.statusCode, 422);
  assert.ok(!X.db.prepare("SELECT 1 FROM tasks WHERE title='משימה שלא תיווצר'").get());
  // the owner's own text is never checked
  const own = await app.inject({ method: 'POST', url: '/api/outbox', headers: await app.ownerH(), payload: stiff }); assert.equal(own.statusCode, 201);
  // style check (dry)
  const chk = (await app.inject({ method: 'POST', url: '/api/styles/check', headers: bearer, payload: stiff })).json(); assert.equal(chk.ok, false); assert.equal(chk.style_key, 'colleague');
});

test('the post-run gate asks again when a refused draft was not written again in the run', async () => {
  const X = server(); const { app, bearer, db, store } = X;
  const runId = db.prepare("INSERT INTO claude_runs (started_at, trigger, events_count) VALUES (?, 'chat', 1)").run(new Date().toISOString()).lastInsertRowid;
  await app.inject({ method: 'POST', url: '/api/outbox', headers: bearer, payload: { to: 'ron@exconstruct.example', subject: 'x', body: 'לכבוד רון, הריני.' } });
  const gate = createGate({ db, store, knowledge: { currentFacts: () => [] } });
  let V = await gate.check(runId, {}); assert.ok(V.some((v) => v.code === 'style'), 'raised');
  await app.inject({ method: 'POST', url: '/api/outbox', headers: bearer, payload: { to: 'ron@exconstruct.example', subject: 'x', body: 'רון, היי\nמה המצב?' } });
  V = await gate.check(runId, {}); assert.ok(!V.some((v) => v.code === 'style'), 'resolved after the redo');
});

test("the owner's edits become feedback and suggestions; nothing learned or asked for is applied without the owner", async () => {
  const X = server(); const { app, bearer, db, S } = X;
  const st = S.find('colleague'); S.update(X.store.ownerId(), st.id, { rules: { max_sentences: 4 } }, { owner: true });
  for (let i = 0; i < 2; i++) {
    const d = (await app.inject({ method: 'POST', url: '/api/outbox', headers: bearer, payload: { to: 'ron@exconstruct.example', subject: 's' + i, body: 'רון, היי\nתבדוק בבקשה את התוכניות. צריך אותן מחר. תודה רבה מראש על העזרה.' } })).json();
    const e = await app.inject({ method: 'PATCH', url: `/api/outbox/${d.id}`, headers: await app.ownerH(), payload: { body: 'רון, היי\nמה עם התוכניות?' } });
    assert.equal(e.statusCode, 200);
  }
  const fb = db.prepare('SELECT * FROM style_feedback').all(); assert.equal(fb.length, 2); assert.match(fb[0].summary, /קיצר מ-3 ל-1 משפטים/);
  const cli = (await app.inject({ method: 'GET', url: '/api/styles/feedback?to=ron@exconstruct.example', headers: bearer })).json(); assert.equal(cli.edits.length, 2); assert.match(cli.edits[0].changed, /קיצר/);
  assert.equal(S.styleFor({ to: 'ron@exconstruct.example' }).owner_edits.length, 2, '`style for` shows them too');
  const sugg = (await app.inject({ method: 'GET', url: '/api/styles', headers: bearer })).json().suggestions;
  const s = sugg.find((x) => x.patch.max_sentences === 1); assert.ok(s, 'a shorter-length suggestion'); assert.match(s.text_he, /בדרך כלל אתה מקצר ל-1 משפטים/);
  assert.equal(S.find('colleague').rules.max_sentences, 4, 'NOT applied by itself');
  // the assistant can neither accept it, nor assign, nor change a rule (its change becomes a suggestion)
  assert.equal((await app.inject({ method: 'POST', url: `/api/style-suggestions/${s.id}/accept`, headers: bearer, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/styles/colleague/assign`, headers: bearer, payload: { kind: 'domain', ref: 'x.example' } })).statusCode, 403);
  const req = await app.inject({ method: 'PATCH', url: '/api/styles/colleague', headers: bearer, payload: { rules: { max_sentences: 20 }, reason: 'אלכס רוצה מיילים ארוכים' } });
  assert.equal(req.statusCode, 202); assert.equal(S.find('colleague').rules.max_sentences, 4);
  // the owner accepts: applied
  const acc = await app.inject({ method: 'POST', url: `/api/style-suggestions/${s.id}/accept`, headers: await app.ownerH(), payload: {} });
  assert.equal(acc.statusCode, 200); assert.equal(S.find('colleague').rules.max_sentences, 1);
  // and the owner edits a style directly
  const own = await app.inject({ method: 'PATCH', url: '/api/styles/colleague', headers: await app.ownerH(), payload: { rules: { forbidden_phrases: ['בהקדם האפשרי'] } } });
  assert.equal(own.statusCode, 200); assert.deepEqual(S.find('colleague').rules.forbidden_phrases, ['בהקדם האפשרי']);
});

test('analysis of the sent mail: measured in code, saved as PROPOSED, never over an active style, resumable', () => {
  const L = lib();
  const ins = L.db.prepare("INSERT INTO emails (message_id, from_addr, to_addr, subject, received_at, mail_date, body_text, direction, participants) VALUES (?,?,?,?,?,?,?, 'sent', ?)");
  const bodies = ['רון, היי\nמה עם התוכניות?', 'רון, היי\nתזכיר לי מחר.', 'היי רון\nשלחתי לך.\n\nבברכה,\nדנה לוי', 'רון, היי\nאפשר לסגור היום?', 'מצורף.'];
  bodies.forEach((b, i) => ins.run('a' + i, 'Dana <dana@exconstruct.example>', 'ron@exconstruct.example', 'נושא ' + i, new Date(Date.now() - i * 86400000).toISOString(), new Date(Date.now() - i * 86400000).toISOString(), b, JSON.stringify([{ role: 'to', name: 'Ron', email: 'ron@exconstruct.example', msg_index: 0 }])));
  const A = createStyleAnalysis({ db: L.db, store: L.store, styles: L.S });
  const t = A.personTargets(['רון שחר'])[0]; const items = A.sent().filter(t.pick);
  assert.equal(items.length, 4, 'a one-word mail says nothing about style'); const st = A.measure(items);
  assert.deepEqual(st.greetings[0], { form: '{first_name}, היי', count: 3 }); assert.equal(st.signature_share, 0.25);
  const rules = A.rulesFrom(st, { kind: 'person' });
  assert.equal(rules.greeting, '{first_name}, היי'); assert.ok(rules.greeting_alt.includes('היי {first_name}')); assert.equal(rules.signature, false); assert.equal(rules.formality, 'casual'); assert.ok(rules.forbidden_phrases.includes('אשמח אם תוכל') || (require('../lib/writingstyle').BASE_FORBIDDEN.casual.includes('אשמח אם תוכל')));
  const saved = A.propose(t, st, rules, A.pickExamples(items, st), { description_he: 'קצר וישיר.', formality: 'casual' });
  const p = L.S.find(saved.key); assert.equal(p.status, 'proposed'); assert.equal(p.examples.length, 3); assert.equal(p.stats.n, 4);
  assert.equal(L.S.resolve({ to: 'ron@exconstruct.example' }).style.key, 'base', 'a proposal is not used before the owner activates it');
  L.S.update(L.o, p.id, { status: 'active' }, { owner: true });
  assert.equal(A.propose(t, st, rules, [], null).kept, true, 'an active style is never overwritten by a new analysis');
  A.mark(t.key, { done: true }); assert.equal(A.progress()[t.key].done, true, 'progress is kept for a resumed run');
});


test('a long signature block under the name (title, phones, links) is not part of what he wrote', () => {
  const m = metrics('דנה, היי\nנצטרך לעדכן את המפרט.\nדנה\nלוי\nמנהלת פרויקטים\n050-0000000 <tel:0500000000>\n|\ndana@example.com <mailto:dana@example.com>\n|\nwww.example.com\nexample', ['דנה', 'דנה לוי']);
  assert.equal(m.body, 'נצטרך לעדכן את המפרט.'); assert.ok(m.signature);
});
