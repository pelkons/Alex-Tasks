'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-outbox-'));
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ owner: { name_he: 'דנה', name_en: 'Dana', emails: ['dana@exconstruct.example'], work_email: 'dana@exconstruct.example' } }));
process.env.MESIMOT_CONFIG = path.join(TMP, 'config.json'); process.env.MESIMOT_FILES = path.join(TMP, 'files'); process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(TMP, 'cfg', 'outbox-sign.key');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createOutbox, canon } = require('../lib/outbox');
const { createIngest, createIngestApp } = require('../lib/ingest');
const { createCalendar } = require('../lib/calendar');
const { createImporter } = require('../lib/importer');

const TOKEN = 'agent-token-123'; const ITOKEN = 'ingest-token-0123456789'; const PW = 'correct horse battery'; const TS = '100.106.52.82';
function lib() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const outbox = createOutbox({ db, store }); store.hooks.outboxView = outbox.cardView; store.hooks.outbox = outbox;
  const a = store.assistantId(), owner = store.ownerId();
  db.prepare("INSERT INTO emails (message_id, msgid, from_addr, to_addr, subject, received_at, body_text) VALUES ('m1','orig1@x.example','Yael Rosen <yael@client.example>','dana@exconstruct.example, cc: boss@exconstruct.example','בקשה לאישור תוכניות',?,'שלום')").run('2026-11-24T08:00:00Z');
  db.prepare("INSERT INTO ingest_mail (entry_id, internet_message_id, folder, at, email_id, status, created_at) VALUES ('ENTRY-ORIG','orig1@x.example','inbox','2026-11-24T08:00:00Z',1,'stored',?)").run(new Date().toISOString());
  const calendar = createCalendar(db, store); const importer = createImporter({ db, store, knowledge, chat });
  const ingest = createIngest({ db, store, knowledge, importer, calendar, version: 't' });
  const iapp = createIngestApp({ ingest, outbox, token: ITOKEN });
  return { db, store, chat, outbox, a, owner, iapp };
}
const draft = (L, o = {}) => L.outbox.create(L.a, { to: 'Yael Rosen <yael@client.example>', subject: 'תשובה בעניין התוכניות', body: 'שלום יעל,\nהתוכניות אושרו ויישלחו מחר.\nדנה', ...o });
const enable = (L) => L.outbox.setSettings({ enabled: true });
const card = (L, id) => L.db.prepare("SELECT * FROM chat_messages WHERE outbox_id=? ORDER BY id DESC").get(id);

test('a draft becomes pending and posts ONE full card (from, to, cc, subject, body, attachments, reply-to), bound to a content hash; the kill switch ships OFF', () => {
  const L = lib(); assert.equal(L.outbox.settings().enabled, false, 'ships disabled');
  const d = draft(L, { kind: 'reply_all', reply_email: 1, subject: undefined });
  assert.equal(d.status, 'pending'); assert.equal(d.subject, 'RE: בקשה לאישור תוכניות');
  assert.deepEqual(d.to.map((x) => x.email), ['yael@client.example']); assert.deepEqual(d.cc.map((x) => x.email), ['boss@exconstruct.example']);
  const c = card(L, d.id); assert.equal(L.db.prepare('SELECT COUNT(*) c FROM chat_messages WHERE outbox_id=?').get(d.id).c, 1);
  for (const part of ['מאת: dana@exconstruct.example', 'אל: Yael Rosen <yael@client.example>', 'עותק: boss@exconstruct.example', 'נושא: RE: בקשה לאישור תוכניות', 'התוכניות אושרו ויישלחו מחר.', 'תשובה ל: "בקשה לאישור תוכניות" מאת Yael Rosen', 'אינו אישור']) assert.ok(c.text.includes(part), part);
  assert.equal(c.tg_sent, 0, 'goes to Telegram'); assert.equal(c.outbox_hash, d.content_hash);
  const v = L.chat.decorate(c); assert.equal(v.outbox.status, 'pending'); assert.equal(v.outbox.stale, false);
});

test('validation: recipient syntax, at least one recipient, subject and body, a configured work address', () => {
  const L = lib();
  assert.throws(() => draft(L, { to: 'not-an-email' }), /כתובת לא תקינה/); assert.throws(() => draft(L, { cc: 'a@b' }), /כתובת לא תקינה/);
  assert.throws(() => draft(L, { to: '' }), /נמען/); assert.throws(() => draft(L, { subject: '' }), /נושא/); assert.throws(() => draft(L, { body: '  ' }), /ריק/);
  assert.equal(draft(L, { to: 'a@b.co; "C, D" <c@d.org>' }).to.length, 2); assert.deepEqual(draft(L, { to: 'דנה כהן (dk@x.example), z@y.org' }).to, [{ name: 'דנה כהן', email: 'dk@x.example' }, { name: '', email: 'z@y.org' }]);
});

test('approval: only with the shown hash, only when enabled, binds a signature, refuses a changed draft; a double click is harmless', () => {
  const L = lib(); const d = draft(L);
  assert.throws(() => L.outbox.approve(L.owner, d.id, d.hash_short, 'web'), /מושבתת/, 'disabled by default');
  enable(L);
  assert.throws(() => L.outbox.approve(L.owner, d.id, 'deadbeefdead', 'web'), /הטיוטה השתנתה, אשר שוב/);
  assert.throws(() => L.outbox.approve(L.owner, d.id, '', 'web'), /השתנתה/);
  assert.throws(() => L.outbox.approve(L.a, d.id, d.hash_short, 'web'), /רק הבעלים/, 'the assistant actor cannot approve even through the function');
  const ok = L.outbox.approve(L.owner, d.id, d.hash_short, 'telegram'); assert.equal(ok.status, 'approved'); assert.equal(ok.approved_via, 'telegram');
  const row = L.db.prepare('SELECT * FROM outbox WHERE id=?').get(d.id);
  assert.equal(row.approval_sig, crypto.createHmac('sha256', fs.readFileSync(process.env.MESIMOT_OUTBOX_KEY_FILE, 'utf8').trim()).update(`mesimot-outbox-v1|${d.id}|${row.content_hash}|${row.approved_at}`).digest('hex'));
  assert.equal(L.outbox.approve(L.owner, d.id, d.hash_short, 'web').status, 'approved', 'double click');
});

test('ANY edit after approval resets: pending, approval and signature cleared, a new hash and a NEW card; the old card goes stale; the old button refuses', () => {
  const L = lib(); enable(L); const d = draft(L); const oldHash = d.hash_short; L.outbox.approve(L.owner, d.id, oldHash, 'web');
  const e = L.outbox.update(L.a, d.id, { body: 'שלום יעל, יש שינוי: מחר בצהריים.' });
  assert.equal(e.status, 'pending'); assert.notEqual(e.hash_short, oldHash);
  const row = L.db.prepare('SELECT approved_at, approved_via, approved_hash, approval_sig FROM outbox WHERE id=?').get(d.id); assert.deepEqual(Object.values(row), [null, null, null, null]);
  const cards = L.db.prepare('SELECT * FROM chat_messages WHERE outbox_id=? ORDER BY id').all(d.id); assert.equal(cards.length, 2);
  assert.equal(L.chat.decorate(cards[0]).outbox.stale, true); assert.equal(L.chat.decorate(cards[1]).outbox.stale, false);
  assert.throws(() => L.outbox.approve(L.owner, d.id, oldHash, 'telegram'), /הטיוטה השתנתה, אשר שוב/);
  for (const patch of [{ to: 'other@x.example' }, { cc: 'z@x.example' }, { bcc: 'z@x.example' }, { subject: 'אחר' }]) { L.outbox.approve(L.owner, d.id, L.outbox.get(d.id).hash_short, 'web'); assert.equal(L.outbox.update(L.a, d.id, patch).status, 'pending', JSON.stringify(patch)); }
  // an update that changes nothing keeps the approval
  const cur = L.outbox.get(d.id); L.outbox.approve(L.owner, d.id, cur.hash_short, 'web'); assert.equal(L.outbox.update(L.a, d.id, { subject: cur.subject }).status, 'approved');
});

test('a typed "כן" in the chat is not an approval', () => {
  const L = lib(); enable(L); const d = draft(L);
  L.chat.sendChat(L.owner, { text: 'כן' }); L.chat.sendChat(L.owner, { text: 'שלח' });
  assert.equal(L.outbox.get(d.id).status, 'pending');
});

test('connector flow: approved list, claim once, result sends a confirmation to the chat; failure is reported; unapproved is never listed', () => {
  const L = lib(); enable(L); const d1 = draft(L), d2 = draft(L, { subject: 'לא מאושר' });
  assert.deepEqual(L.outbox.approvedList().items, []);
  L.outbox.approve(L.owner, d1.id, d1.hash_short, 'web');
  const l = L.outbox.approvedList(); assert.equal(l.items.length, 1); const p = l.items[0];
  assert.equal(p.id, d1.id); assert.ok(p.approval_sig && p.content_hash && p.body_html.includes('dir="auto"')); assert.equal(p.from, 'dana@exconstruct.example');
  // the connector recomputes the hash from the fields it received
  const re = canon({ kind: p.kind, from: p.from, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, body_text: p.body_text, body_html: p.body_html, attachments: p.attachments.map((a) => ({ name: a.name, sha256: a.sha256, size: a.size })), orig_entry_id: p.orig_entry_id, orig_internet_message_id: p.orig_internet_message_id });
  assert.equal(crypto.createHash('sha256').update(re).digest('hex'), p.content_hash);
  assert.equal(L.outbox.claim(d1.id).id, d1.id); assert.equal(L.outbox.get(d1.id).status, 'sending');
  assert.throws(() => L.outbox.claim(d1.id), /כבר נתבע|במצב/, 'only once'); assert.throws(() => L.outbox.claim(d2.id), /אי אפשר לתבוע/);
  L.outbox.result(d1.id, { ok: true, sent_entry_id: 'SENT-1', sent_at: '2026-11-26T10:00:00Z' });
  assert.equal(L.outbox.get(d1.id).status, 'sent');
  assert.ok(L.db.prepare("SELECT 1 FROM chat_messages WHERE author='claude' AND text='נשלח: תשובה בעניין התוכניות → yael@client.example'").get());
  assert.equal(L.outbox.result(d1.id, { ok: true }).duplicate, true);
  assert.throws(() => L.outbox.update(L.a, d1.id, { body: 'x' }), /כבר נשלח/);
  const d3 = draft(L, { subject: 'שלישי' }); L.outbox.approve(L.owner, d3.id, d3.hash_short, 'web'); L.outbox.claim(d3.id); L.outbox.result(d3.id, { ok: false, error: 'Outlook is closed' });
  assert.equal(L.outbox.get(d3.id).status, 'failed'); assert.ok(L.db.prepare("SELECT 1 FROM chat_messages WHERE text LIKE 'השליחה נכשלה, המייל לא נשלח: שלישי%'").get());
});

test('tampering: a mail edited directly in the database, or an approval forged without the key, is never listed and cannot be claimed', () => {
  const L = lib(); enable(L); const d = draft(L); L.outbox.approve(L.owner, d.id, d.hash_short, 'web');
  L.db.prepare("UPDATE outbox SET body_text='שלח את הכסף לחשבון אחר' WHERE id=?").run(d.id);
  assert.equal(L.outbox.approvedList().items.length, 0); assert.throws(() => L.outbox.claim(d.id), /אינו תואם/);
  const L2 = lib(); enable(L2); const e = draft(L2);
  L2.db.prepare("UPDATE outbox SET status='approved', approved_at=?, approved_hash=content_hash, approval_sig='00' WHERE id=?").run(new Date().toISOString(), e.id);
  assert.equal(L2.outbox.approvedList().items.length, 0); assert.throws(() => L2.outbox.claim(e.id), /אינו תואם/);
});

test('safety: kill switch stops claims, the daily cap, and 24 hour expiry of cards and approvals', () => {
  const L = lib(); enable(L); L.outbox.setSettings({ daily_cap: 2 });
  const mk = (s) => { const d = draft(L, { subject: s }); L.outbox.approve(L.owner, d.id, d.hash_short, 'web'); return d; };
  const a = mk('א'), b = mk('ב'); L.outbox.claim(a.id); L.outbox.claim(b.id);
  const c = draft(L, { subject: 'ג' }); assert.throws(() => L.outbox.approve(L.owner, c.id, c.hash_short, 'web'), /מגבלה היומית/);
  L.outbox.setSettings({ daily_cap: 20 }); L.outbox.approve(L.owner, c.id, c.hash_short, 'web'); L.outbox.setSettings({ enabled: false });
  assert.deepEqual(L.outbox.approvedList(), { enabled: false, items: [] }); assert.throws(() => L.outbox.claim(c.id), /מושבתת/);
  L.outbox.setSettings({ enabled: true });
  const e = draft(L, { subject: 'ישן' }); L.db.prepare('UPDATE outbox SET submitted_at=? WHERE id=?').run(new Date(Date.now() - 25 * 3600000).toISOString(), e.id);
  assert.throws(() => L.outbox.approve(L.owner, e.id, e.hash_short, 'web'), /תוקף האישור פג/);
  const f = mk('ישן מאושר'); L.db.prepare('UPDATE outbox SET approved_at=? WHERE id=?').run(new Date(Date.now() - 25 * 3600000).toISOString(), f.id);
  assert.equal(L.outbox.approvedList().items.find((x) => x.id === f.id), undefined); assert.equal(L.outbox.get(f.id).status, 'expired');
  assert.throws(() => L.outbox.setSettings({ daily_cap: 0 }), /בין 1 ל-500/);
});

test('the assistant cannot approve: token routes refuse, apply has no approve, the CLI has no approve command; only the owner session (cookie) does', async () => {
  const db = open(':memory:'); auth.setPassword(db, PW); auth.resetFailures();
  const app = build({ db, token: TOKEN, loginDelayMs: 0 }); const bearer = { authorization: `Bearer ${TOKEN}` };
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PW } }); const c = r.cookies.find((x) => x.name === 'mesimot_session'); const cookie = { cookie: `mesimot_session=${c.value}`, 'x-mesimot': '1' };
  await app.inject({ method: 'POST', url: '/api/outbox/settings', headers: cookie, payload: { enabled: true } });
  const mk = await app.inject({ method: 'POST', url: '/api/outbox', headers: bearer, payload: { to: 'a@b.co', subject: 'ש', body: 'גוף' } }); assert.equal(mk.statusCode, 201); const d = mk.json();
  assert.equal(d.status, 'pending'); assert.equal(d.approval_sig, undefined, 'the signature is never shown to the assistant');
  for (const url of [`/api/outbox/${d.id}/approve`]) for (const hash of [d.content_hash, d.hash_short]) assert.equal((await app.inject({ method: 'POST', url, headers: bearer, payload: { hash } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/outbox/settings', headers: bearer, payload: { enabled: true } })).statusCode, 403, 'the assistant cannot flip the kill switch either');
  assert.equal(app.outbox.get(d.id).status, 'pending');
  const ap = await app.inject({ method: 'POST', url: '/api/apply', headers: bearer, payload: { outbox: [{ op: 'approve', id: d.id }] } }); assert.ok(ap.statusCode >= 400); assert.equal(app.outbox.get(d.id).status, 'pending');
  const ok = await app.inject({ method: 'POST', url: '/api/apply', headers: bearer, payload: { outbox: [{ op: 'draft', to: 'x@y.co', subject: 'דרך apply', body: 'טיוטה' }] } }); assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(app.outbox.list().find((x) => x.subject === 'דרך apply').status, 'pending');
  assert.equal((await app.inject({ method: 'POST', url: `/api/outbox/${d.id}/approve`, headers: cookie, payload: { hash: 'nothash123456' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/outbox/${d.id}/approve`, headers: cookie, payload: { hash: d.hash_short } })).json().status, 'approved');
  // source-level guard: only the owner-session route and the Telegram callback call approve; the CLI and apply have no such command
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const callers = ['lib/server.js', 'lib/telegram.js', 'lib/apply.js', 'lib/runner.js', 'lib/ingest.js', 'lib/chat.js', 'lib/proposals.js', 'lib/confirm.js', 'bin/mesimot', 'lib/audit.js'].filter((f) => /outbox\.approve\(/.test(src(f)));
  assert.deepEqual(callers.sort(), ['lib/server.js', 'lib/telegram.js']);
  assert.ok(!/sub === '(approve|send|claim|result|sign)'/.test(src('bin/mesimot').split("case 'outbox'")[1].split("case 'confirm'")[0]), 'no approve or send command in the CLI');
  assert.match(src('lib/server.js'), /ownerSession\(req\); return outbox\.approve/);
});

test('the signing key: a file outside agent/ and files/, mode 600, never in the environment and not readable through the agent\'s permissions', () => {
  const L = lib(); L.outbox.key(); const f = process.env.MESIMOT_OUTBOX_KEY_FILE;
  assert.equal(fs.statSync(f).mode & 0o777, 0o600); assert.ok(fs.readFileSync(f, 'utf8').trim().length >= 64);
  const root = path.join(__dirname, '..'); const def = path.join(require('os').homedir(), '.config', 'mesimot', 'outbox-sign.key');
  for (const dir of [path.join(root, 'agent'), path.join(root, 'files'), path.join(root, 'data')]) assert.ok(!def.startsWith(dir + path.sep), `the default key path is not under ${dir}`);
  const { buildArgs } = require('../lib/agents/claude-code');
  const args = buildArgs({ prompt: 'x', readPaths: [path.join(root, 'agent'), path.join(root, 'files')], writePaths: [path.join(root, 'agent', 'memory')] });
  const allowed = args[args.indexOf('--allowedTools') + 1 + 0] && args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  for (const rule of allowed.filter((x) => /^(Read|Edit|Write)\(/.test(x))) { const p = rule.replace(/^\w+\(/, '').replace(/\/\*\*\)$/, '').replace(/^\/\//, '/'); assert.ok(!def.startsWith(p + '/'), `${rule} must not cover the key`); }
  assert.ok(!Object.keys(process.env).some((k) => /OUTBOX.*(KEY|SECRET)$/.test(k) && k !== 'MESIMOT_OUTBOX_KEY_FILE'));
});

test('connector API on the listener: Bearer + Tailscale address required; approved, claim, result, attachment download', async () => {
  const L = lib(); enable(L); const H = { authorization: `Bearer ${ITOKEN}` };
  const f = path.join(TMP, 'plan.pdf'); fs.writeFileSync(f, 'PDFDATA'); const fid = L.db.prepare("INSERT INTO files (original_name, path, mime, size, source, created_at) VALUES ('תוכנית.pdf',?,'application/pdf',7,'web',?)").run(f, new Date().toISOString()).lastInsertRowid;
  const d = draft(L, { attach: String(fid) }); assert.equal(d.attachments[0].name, 'תוכנית.pdf');
  assert.equal((await L.iapp.inject({ method: 'GET', url: '/outbox/approved', headers: H, remoteAddress: '127.0.0.1' })).statusCode, 403);
  assert.equal((await L.iapp.inject({ method: 'GET', url: '/outbox/approved', remoteAddress: TS })).statusCode, 401);
  assert.equal((await L.iapp.inject({ method: 'GET', url: '/outbox/approved', headers: H, remoteAddress: TS })).json().items.length, 0);
  L.outbox.approve(L.owner, d.id, d.hash_short, 'web');
  const item = (await L.iapp.inject({ method: 'GET', url: '/outbox/approved', headers: H, remoteAddress: TS })).json().items[0]; assert.equal(item.attachments[0].download, `/outbox/${d.id}/attachment/${fid}`); assert.match(item.attachments[0].sha256, /^[0-9a-f]{64}$/);
  const dl = await L.iapp.inject({ method: 'GET', url: item.attachments[0].download, headers: H, remoteAddress: TS }); assert.equal(dl.statusCode, 200); assert.equal(dl.body, 'PDFDATA');
  assert.equal((await L.iapp.inject({ method: 'POST', url: `/outbox/${d.id}/claim`, headers: H, remoteAddress: TS })).statusCode, 200);
  assert.equal((await L.iapp.inject({ method: 'POST', url: `/outbox/${d.id}/claim`, headers: H, remoteAddress: TS })).statusCode, 409);
  const res = await L.iapp.inject({ method: 'POST', url: `/outbox/${d.id}/result`, headers: H, remoteAddress: TS, payload: { ok: true, sent_entry_id: 'E9', sent_at: '2026-11-26T10:00:00Z' } }); assert.equal(res.json().status, 'sent');
  assert.equal((await L.iapp.inject({ method: 'GET', url: `/outbox/${d.id}/attachment/${fid}`, headers: H, remoteAddress: TS })).statusCode, 404, 'files are served only while the mail is approved or sending');
});

test('Telegram: only the owner chat can approve with the card button; a stale button refuses; a long card has no approve button', async () => {
  const { createTelegram } = require('../lib/telegram');
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const outbox = createOutbox({ db, store }); store.hooks.outboxView = outbox.cardView; outbox.setSettings({ enabled: true });
  const calls = []; const fetchImpl = async (url, o = {}) => { const m = /\/bot[^/]+\/(\w+)$/.exec(url); const body = JSON.parse(o.body || '{}'); calls.push({ method: m[1], body }); return { ok: true, json: async () => ({ ok: true, result: m[1] === 'sendMessage' ? { message_id: 500 + calls.length } : m[1] === 'getMe' ? { username: 'b' } : true }) }; };
  const tg = createTelegram({ db, store, knowledge, chat, token: 'TEST', fetchImpl, outbox, filesDir: TMP });
  const OWNER = 777001; await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: OWNER }, text: '/start ' + tg.createBindCode() } });
  const a = store.assistantId(); const d = outbox.create(a, { to: 'a@b.co', subject: 'שלום', body: 'גוף קצר' });
  await tg.deliverPending(); const sent = calls.filter((c) => c.method === 'sendMessage').pop().body;
  const btns = sent.reply_markup.inline_keyboard[0]; assert.deepEqual(btns.map((b) => b.text), ['✅ שלח', '✏️ ערוך', '❌ בטל']); assert.ok(sent.text.includes('גוף קצר') && sent.text.includes('אל: a@b.co'));
  const cb = (data, chat_id = OWNER) => tg.handleUpdate({ update_id: Math.floor(Math.random() * 1e6) + 10, callback_query: { id: 'c' + data, data, message: { chat: { id: chat_id }, message_id: 9 } } });
  await cb(btns[0].callback_data, 4242); assert.equal(outbox.get(d.id).status, 'pending', 'another chat cannot approve');
  const e = outbox.update(a, d.id, { body: 'גוף אחר' }); await cb(btns[0].callback_data); assert.equal(outbox.get(d.id).status, 'pending', 'the old card button refuses');
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && /הטיוטה השתנתה, אשר שוב/.test(c.body.text)));
  await tg.deliverPending(); const fresh = calls.filter((c) => c.method === 'sendMessage').pop().body.reply_markup.inline_keyboard[0][0].callback_data;
  await cb(fresh); assert.equal(outbox.get(d.id).status, 'approved'); assert.equal(outbox.get(d.id).approved_via, 'telegram'); assert.ok(e.hash_short);
  const big = outbox.create(a, { to: 'a@b.co', subject: 'ארוך', body: 'מילה '.repeat(1000) }); await tg.deliverPending();
  const bk = calls.filter((c) => c.method === 'sendMessage').pop().body.reply_markup.inline_keyboard[0]; assert.ok(!bk.some((b) => /obok/.test(b.callback_data || '')), 'no approve button on a card that Telegram cannot show in full'); assert.ok(big.id);
});
