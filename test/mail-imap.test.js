'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');

process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-mailfiles-'));
const imapMod = require('../lib/mail/imap');
const mailLayer = require('../lib/mail');
const email = require('../lib/email');
const { createHousekeeping } = require('../lib/housekeeping');

const free = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 && spawnSync('docker', ['image', 'inspect', 'greenmail/standalone:2.1.3'], { stdio: 'ignore' }).status === 0 && !process.env.MESIMOT_NO_DOCKER_TESTS;
const OWNER = 'owner@example.com', PW = 'pw-test';
const SCOPE = 'INBOX', ALEX_IN = 'Folders/tasks.example.org/Inbox', ALEX_SENT = 'Folders/tasks.example.org/Sent', DONE = 'Labels/Alex-done', OTHER = 'Labels/Other'; // split mode: INBOX is the assistant's own account only
let ports, cid;

const raw = (o) => [
  `From: ${o.from || 'Owner <dana@exconstruct.example>'}`, `To: ${o.to || `owner+alex@example.com`}`, `Subject: ${o.subject || 'FW: סיכום ישיבה'}`, `Message-ID: ${o.mid || `<${o.id}@test>`}`,
  `Date: ${o.date || new Date().toUTCString()}`, ...(o.auth ? [`Authentication-Results: ${o.auth}`] : []), ...(o.extra || []),
  'MIME-Version: 1.0', ...(o.mime ? [o.mime] : ['Content-Type: text/plain; charset=utf-8']), '', o.body || 'לטיפולך', ''].join('\r\n');
const PASS = 'mx.proton.me; dmarc=pass header.from=exconstruct.example; spf=pass; dkim=pass';

async function admin() {
  const c = new ImapFlow({ host: '127.0.0.1', port: ports.imap, secure: false, auth: { user: 'owner', pass: PW }, logger: false });
  await c.connect();
  return c;
}
async function put(folder, o, idate) { const c = await admin(); try { await c.append(folder, raw(o), [], idate ? new Date(idate) : undefined); } finally { await c.logout(); } }
async function count(folder) { const c = await admin(); try { const st = await c.status(folder, { messages: true }); return st.messages; } finally { await c.logout(); } }
async function ids(folder) { const c = await admin(); try { const lock = await c.getMailboxLock(folder); try { const out = []; if (c.mailbox.exists) for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope.messageId); return out; } finally { lock.release(); } } finally { await c.logout(); } }
async function reset() {
  const c = await admin();
  try {
    for (const f of [DONE, 'Trash', OTHER, 'Sent', 'Folders/tasks.example.org', ALEX_IN, ALEX_SENT]) { try { await c.mailboxCreate(f); } catch { /* exists */ } }
    for (const f of ['INBOX', DONE, 'Trash', OTHER, 'Sent', ALEX_IN, ALEX_SENT]) {
      const lock = await c.getMailboxLock(f);
      try { if (c.mailbox.exists) await c.messageDelete('1:*'); } finally { lock.release(); }
    }
  } finally { await c.logout(); }
}
function env(extra = {}) {
  const e = { MAIL_PROVIDER: 'imap', MAIL_IMAP_HOST: '127.0.0.1', MAIL_IMAP_PORT: String(ports.imap), MAIL_IMAP_STARTTLS: '0', MAIL_IMAP_USER: 'owner', MAIL_IMAP_PASS: PW,
    MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: String(ports.smtp), MAIL_SMTP_STARTTLS: '0', MAIL_SMTP_USER: 'owner', MAIL_SMTP_PASS: PW, MAIL_ADDRESS: OWNER, MAIL_OWNER_ADDRESS: OWNER,
    MAIL_IMAP_SCOPE_FOLDERS: `${SCOPE},${ALEX_IN}`, MAIL_IMAP_DONE_FOLDER: DONE, MAIL_IMAP_SENT_FOLDER: ALEX_SENT, MAIL_SENT_MOVE_DELAY_MS: '150', MAIL_SENT_MOVE_TRIES: '6', MAIL_SENT_PENDING_FILE: path.join(os.tmpdir(), 'mesimot-sent-pending-test.json'), ...extra };
  return e;
}
const provider = (extra) => imapMod.create({ ...env(extra) });
const useEnv = (extra) => { for (const [k, v] of Object.entries(env(extra))) process.env[k] = v; mailLayer.reset(); };

test.before(async () => {
  if (!dockerOk) return;
  ports = { imap: await free(), smtp: await free() };
  cid = execFileSync('docker', ['run', '-d', '--rm', '-p', `127.0.0.1:${ports.imap}:3143`, '-p', `127.0.0.1:${ports.smtp}:3025`, '-e', 'GREENMAIL_OPTS=-Dgreenmail.setup.test.imap -Dgreenmail.setup.test.smtp -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=owner:' + PW + '@example.com', 'greenmail/standalone:2.1.3'], { encoding: 'utf8' }).trim();
  for (let i = 0; i < 60; i++) { try { const c = await admin(); await c.logout(); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
});
test.after(() => { if (cid) spawnSync('docker', ['rm', '-f', cid], { stdio: 'ignore' }); });

// ---- no docker needed: the scope guard and the TLS rule
test('scope: only the two label folders can be opened, created or copied into; every other mailbox throws', async () => {
  const calls = [];
  const rawClient = { getMailboxLock: async (p) => { calls.push(['lock', p]); return { release() {} }; }, mailboxOpen: async (p) => calls.push(['open', p]), mailboxCreate: async (p) => calls.push(['create', p]), messageCopy: async (r, d) => calls.push(['copy', d]), search: async () => [], fetch: () => [], fetchOne: async () => null, download: async () => null, messageDelete: async () => true, logout: async () => {}, status: async () => { throw new Error('must not exist'); }, list: async () => { throw new Error('must not exist'); }, messageMove: async () => { throw new Error('must not exist'); } };
  const c = imapMod.scopedClient(rawClient, { open: [SCOPE, ALEX_IN, DONE, ALEX_SENT], copyTo: [], create: [DONE, 'Folders/tasks.example.org', ALEX_IN, ALEX_SENT] });
  await c.getMailboxLock(SCOPE); await c.getMailboxLock(ALEX_IN); await c.getMailboxLock(ALEX_SENT); await c.getMailboxLock(DONE); await c.messageCopy('1', DONE); await c.mailboxCreate(DONE);
  for (const bad of ['All Mail', 'Labels/Other', 'Trash', 'Sent', 'Archive', 'Drafts', 'inbox']) {
    await assert.rejects(() => c.getMailboxLock(bad), imapMod.ScopeError, bad);
    await assert.rejects(() => c.mailboxOpen(bad), imapMod.ScopeError);
    await assert.rejects(() => c.mailboxCreate(bad), imapMod.ScopeError);
    await assert.rejects(() => c.messageCopy('1', bad), imapMod.ScopeError);
  }
  assert.equal(c.status, undefined); assert.equal(c.list, undefined); assert.equal(c.messageMove, undefined);
  assert.deepEqual(calls.map((x) => x[1]), [SCOPE, ALEX_IN, ALEX_SENT, DONE, DONE, DONE], 'nothing else reached the server');
  for (const bad of ['Sent', 'Folders/Other', 'Folders/tasks.example.org/Other']) { await assert.rejects(() => c.getMailboxLock(bad), imapMod.ScopeError, bad); await assert.rejects(() => c.mailboxCreate(bad), imapMod.ScopeError, 'create ' + bad); }
  // Trash is a copy destination only (housekeeping), never a folder that can be opened
  const t = imapMod.scopedClient(rawClient, { open: [SCOPE, DONE], copyTo: ['Trash'] });
  await t.messageCopy('1', 'Trash');
  await assert.rejects(() => t.getMailboxLock('Trash'), imapMod.ScopeError, 'Trash can be copied into but never opened');
});

test('RENAME is allowed for exactly the legacy parent -> the configured parent, nothing else', async () => {
  const calls = [];
  const c = imapMod.scopedClient({ mailboxRename: async (a, b) => calls.push([a, b]) }, { open: [SCOPE], rename: [['Folders/Alex', 'Folders/tasks.example.org']] });
  await c.mailboxRename('Folders/Alex', 'Folders/tasks.example.org');
  for (const [a, b] of [['INBOX', 'x'], ['Folders/Trips', 'Folders/tasks.example.org'], ['Folders/Alex', 'Folders/Other'], ['Labels/Crypto', 'Labels/y']]) await assert.rejects(() => c.mailboxRename(a, b), imapMod.ScopeError, a + ' -> ' + b);
  assert.deepEqual(calls, [['Folders/Alex', 'Folders/tasks.example.org']]);
});

test('the provider itself refuses to open any other folder than INBOX and the done label', async () => {
  const p = imapMod.create({ ...env_nodocker(), MAIL_IMAP_SCOPE_FOLDERS: `${SCOPE},${ALEX_IN}`, MAIL_IMAP_DONE_FOLDER: DONE, MAIL_IMAP_SENT_FOLDER: ALEX_SENT }, { makeClient: () => ({ connect: async () => {}, getMailboxLock: async () => ({ release() {} }), logout: async () => {} }) });
  await p._open(SCOPE);
  await p._open(DONE); await p._open(ALEX_IN); await p._open(ALEX_SENT);
  for (const bad of ['All Mail', 'Labels/Other', 'Trash', 'Sent', 'Folders/tasks.example.org']) await assert.rejects(() => p._open(bad), imapMod.ScopeError, bad);
});
function env_nodocker() { return { MAIL_PROVIDER: 'imap', MAIL_IMAP_HOST: '127.0.0.1', MAIL_IMAP_PORT: '1143', MAIL_IMAP_USER: 'u', MAIL_IMAP_PASS: 'p', MAIL_ADDRESS: OWNER }; }

test('the self-signed certificate is accepted only for loopback and only when MAIL_TLS_INSECURE_LOCAL=1', async () => {
  const seen = [];
  const mk = (s) => imapMod.create(s, { makeClient: (o) => { seen.push(o.tls.rejectUnauthorized); return { connect: async () => {}, getMailboxLock: async () => ({ release() {} }), logout: async () => {} }; } })._open(SCOPE);
  await mk({ ...env_nodocker(), MAIL_TLS_INSECURE_LOCAL: '1' });
  await mk({ ...env_nodocker(), MAIL_TLS_INSECURE_LOCAL: '1', MAIL_IMAP_HOST: 'imap.example.com' });
  await mk({ ...env_nodocker(), MAIL_IMAP_HOST: '127.0.0.1' });
  assert.deepEqual(seen, [false, true, true]);
});

test('authentication: the topmost Authentication-Results header counts; a forged lower one does not', () => {
  const lines = (...ls) => ls.map((l) => ({ key: 'Authentication-Results', line: 'Authentication-Results: ' + l }));
  assert.equal(imapMod.parseAuth(lines('mx.proton.me; dmarc=pass; spf=pass')).dmarc, 'pass');
  assert.equal(imapMod.parseAuth(lines('mx.proton.me; dmarc=fail', 'attacker.example; dmarc=pass')).dmarc, 'fail');
  assert.equal(imapMod.parseAuth([]).dmarc, undefined);
});

// ---- against a real IMAP/SMTP server (GreenMail): Proton-like Labels/ folders
const D = { skip: dockerOk ? false : 'docker or the greenmail/standalone image is not available' };

test('intake: only INBOX of the dedicated account is read, other folders never; DMARC fail, no result and forged results are rejected; internal Proton mail is accepted', D, async () => {
  await reset(); useEnv();
  await put(OTHER, { id: 'other1', subject: 'FW: mail in another folder', auth: PASS });
  await put(SCOPE, { id: 'ok1', auth: PASS });
  await put(SCOPE, { id: 'fail1', auth: 'mx.proton.me; dmarc=fail', subject: 'FW: spoofed' });
  await put(SCOPE, { id: 'none1', subject: 'FW: no auth header' });
  await put(SCOPE, { id: 'forged1', auth: 'mx.proton.me; dmarc=fail', extra: ['Authentication-Results: evil.example; dmarc=pass'], subject: 'FW: forged' });
  await put(SCOPE, { id: 'internal1', from: 'Owner <owner@example.com>', subject: 'FW: from my own proton account', extra: ['X-Pm-Origin: internal'] });
  await put(SCOPE, { id: 'stranger1', from: 'Stranger <x@evil.example>', auth: PASS, subject: 'FW: stranger' });
  const p = provider();
  const list = await p.listNew();
  assert.ok(!list.some((m) => m.message_id === '<other1@test>'), 'another folder was not read');
  assert.equal(list.length, 6);
  const db = open(':memory:'); const store = createStore(db);
  db.prepare("UPDATE settings SET value=? WHERE key='email_allowlist'").run(JSON.stringify(['dana@exconstruct.example', 'owner@example.com']));
  const taken = await email.pollOnce(db, store, () => {}, null);
  const subjects = db.prepare('SELECT subject FROM emails ORDER BY id').all().map((r) => r.subject).sort();
  assert.deepEqual(subjects, ['FW: from my own proton account', 'FW: סיכום ישיבה'].sort(), 'only DMARC pass (or internal Proton mail from the owner) is taken');
  assert.equal(taken.length, 2);
  assert.equal(await count(OTHER), 1, 'another folder is untouched');
});

test('attachments come from MIME parsing; signature images are skipped; the message is stored with its body', D, async () => {
  await reset(); useEnv();
  const pdf = Buffer.from('%PDF-1.4 fake pdf for the test'); const png = Buffer.alloc(900, 1);
  const b = 'BOUND123';
  const mime = `Content-Type: multipart/mixed; boundary="${b}"`;
  const body = [`--${b}`, 'Content-Type: text/plain; charset=utf-8', '', 'שלום, מצורף חוזה', `--${b}`, 'Content-Type: application/pdf; name="חוזה.pdf"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="contract.pdf"', '', pdf.toString('base64'),
    `--${b}`, 'Content-Type: image/png; name="image001.png"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: inline; filename="image001.png"', 'Content-ID: <sig1>', '', png.toString('base64'), `--${b}--`].join('\r\n');
  await put(SCOPE, { id: 'att1', auth: PASS, mime, body, subject: 'FW: חוזה' });
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store);
  db.prepare("UPDATE settings SET value=? WHERE key='email_allowlist'").run(JSON.stringify(['dana@exconstruct.example']));
  await email.pollOnce(db, store, () => {}, knowledge);
  const row = db.prepare('SELECT * FROM emails').get();
  assert.match(row.body_text, /מצורף חוזה/);
  const atts = JSON.parse(row.attachments);
  assert.equal(atts.length, 2);
  assert.ok(atts.find((a) => /contract/.test(a.filename)).file_id, 'the pdf was saved');
  assert.equal(atts.find((a) => /image001/.test(a.filename)).skipped, 'inline', 'the signature image is skipped');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM files').get().c, 1);
});

test('processed state: COPY into Labels/Alex-done (the message stays), independent of \\Seen; nothing is taken twice', D, async () => {
  await reset(); useEnv();
  await put(SCOPE, { id: 'd1', auth: PASS });
  const c = await admin(); try { const lock = await c.getMailboxLock(SCOPE); try { await c.messageFlagsAdd('1:*', ['\\Seen']); } finally { lock.release(); } } finally { await c.logout(); }
  const p = provider();
  assert.equal((await p.listNew()).length, 1, 'a message that is already \\Seen is still taken');
  await p.markDone('<d1@test>');
  assert.deepEqual(await ids(SCOPE), ['<d1@test>'], 'the message stays in the INBOX');
  assert.deepEqual(await ids(DONE), ['<d1@test>']);
  await p.markDone('<d1@test>');
  assert.equal(await count(DONE), 1, 'marking twice does not duplicate');
  assert.equal((await p.listNew()).length, 0, 'done messages are not offered again');
  // removing the input after processing is ignored when the input is the INBOX
  await put(SCOPE, { id: 'd2', auth: PASS });
  await provider({ MAIL_REMOVE_LABEL_AFTER_DONE: '1' }).markDone('<d2@test>');
  assert.deepEqual((await ids(SCOPE)).sort(), ['<d1@test>', '<d2@test>']);
  assert.ok((await ids(DONE)).includes('<d2@test>'));
});

test('housekeeping: after retention and the verified local copy the message goes to Trash and its label is removed (default); mode labels only removes the label; nothing outside scope is touched', D, async () => {
  await reset(); useEnv();
  const old = '2026-01-01T10:00:00Z';
  await put(OTHER, { id: 'h-other', auth: PASS }); // not ours: must stay
  const m1 = { id: 'h1', auth: PASS, subject: 'FW: old forward' };
  const m2 = { id: 'h2', auth: PASS, subject: 'FW: second old forward' };
  for (const m of [m1, m2]) { await put(SCOPE, m, old); await put(DONE, m, old); }
  const db = open(':memory:'); const store = createStore(db);
  const ingest = (id, subject) => { db.prepare("INSERT INTO emails (message_id, subject, received_at, body_text, processed_at) VALUES (?,?,?,?,?)").run(`<${id}@test>`, subject, old, 'גוף', old); };
  ingest('h1', 'FW: old forward');
  const dirs = { data: '/tmp', files: '/tmp', backups: '/tmp', models: '/tmp', runs: '/tmp/r', agentTmp: '/tmp/a', voice: '/tmp/v' };
  const hk = createHousekeeping(db, store, { mail: provider(), dirs });
  let r = await hk.mailboxCleanup({ dryRun: true });
  assert.equal(r.candidates, 2); assert.equal(r.kept.length, 1, 'h2 has no local copy');
  assert.equal(await count(DONE), 2, 'a dry run changes nothing');
  r = await hk.mailboxCleanup();
  assert.deepEqual(r.deleted.map((d) => d.how), ['trash']);
  assert.deepEqual(await ids('Trash'), ['<h1@test>'], 'copied to Trash');
  assert.deepEqual(await ids(SCOPE), ['<h2@test>'], 'h1 left the INBOX, the message without a verified copy stayed');
  assert.deepEqual(await ids(DONE), ['<h2@test>'], 'the done label of h1 was removed');
  assert.equal(await count(OTHER), 1, 'a folder outside the scope is untouched');
  // mode labels: only the done label
  await put(SCOPE, m1, old); await put(DONE, m1, old);
  const db2 = open(':memory:'); db2.prepare("INSERT INTO emails (message_id, subject, received_at, body_text, processed_at) VALUES (?,?,?,?,?)").run('<h1@test>', 'FW: old forward', old, 'גוף', old);
  const before = await count('Trash');
  r = await createHousekeeping(db2, createStore(db2), { mail: provider({ MAIL_HOUSEKEEPING: 'labels' }), dirs }).mailboxCleanup();
  assert.deepEqual(r.deleted.map((d) => d.how), ['labels']);
  assert.equal(await count('Trash'), before, 'nothing new in Trash');
  assert.ok((await ids(SCOPE)).includes('<h1@test>'), 'the INBOX copy stays in labels mode');
});

test('send: SMTP from the owner address to the owner only (digests and alerts)', D, async () => {
  await reset(); useEnv();
  const db = open(':memory:');
  await email.sendOwnerEmail(db, { to: 'dana.levi@mail.example', subject: 'סיכום בוקר', text: 'שלום' }).catch(() => {});
  const ownerEmail = db.prepare("SELECT emails FROM people WHERE role='owner'").get();
  assert.ok(ownerEmail);
  await assert.rejects(() => email.sendOwnerEmail(db, { to: 'stranger@evil.example', subject: 'x', text: 'y' }), /not the owner/);
  // direct provider send to the mailbox of the test user, read back
  await provider().send({ to: OWNER, subject: 'התראת מערכת', text: 'בדיקה' });
  await new Promise((r) => setTimeout(r, 500));
  const c = await admin();
  try { const lock = await c.getMailboxLock('INBOX'); try { let n = 0, subj = ''; for await (const m of c.fetch('1:*', { envelope: true })) { n++; subj = m.envelope.subject; } assert.ok(n >= 1); assert.ok(/התראת מערכת|סיכום בוקר/.test(subj)); } finally { lock.release(); } } finally { await c.logout(); }
});

// ---- Sent handling and the folder layout
test('the Sent folder is opened only through sentClient: a search by our exact Message-ID and From, then a COPY; nothing is listed, fetched, moved or deleted', async () => {
  const log = [];
  const raw = { getMailboxLock: async (p) => { log.push(['lock', p]); return { release() { log.push(['release']); } }; }, search: async (q) => { log.push(['search', JSON.stringify(q)]); return [7]; }, messageCopy: async (r, t) => { log.push(['copy', r, t]); return true; }, logout: async () => {},
    fetch: () => { throw new Error('must not be called'); }, list: () => { throw new Error('must not be called'); }, messageMove: () => { throw new Error('must not be called'); }, messageDelete: () => { throw new Error('must not be called'); } };
  const c = imapMod.sentClient(raw, { source: 'Sent', target: ALEX_SENT, from: 'assistant@proton.example' });
  assert.equal(await c.findAndCopy('<abc@pm.me>'), true);
  assert.deepEqual(log.map((x) => x[0]), ['lock', 'search', 'copy', 'release']);
  assert.deepEqual(JSON.parse(log[1][1]), { header: { 'message-id': '<abc@pm.me>' }, from: 'assistant@proton.example' });
  assert.deepEqual(log[2], ['copy', '7', ALEX_SENT]);
  for (const bad of ['', 'abc', '<a b>', '<a>x', '*', '<>']) await assert.rejects(() => c.findAndCopy(bad), imapMod.ScopeError, bad);
  for (const m of ['fetch', 'getMailboxLock', 'list', 'messageMove', 'messageDelete', 'findAndMove']) assert.equal(c[m], undefined, m + ' does not exist');
});

test('ensureFolders creates exactly the assistant folders; the intake reads both INBOX and Folders/tasks.example.org/Inbox', D, async () => {
  await reset(); useEnv();
  const out = await provider().ensureFolders();
  assert.deepEqual(Object.keys(out).sort(), [DONE, 'Folders/tasks.example.org', ALEX_IN, ALEX_SENT].sort());
  assert.ok(Object.values(out).every((v) => v === 'created' || v === 'exists'), JSON.stringify(out));
  assert.ok(Object.values(await provider().ensureFolders()).every((v) => v === 'exists'), 'idempotent');
  await put(SCOPE, { id: 'in1', auth: PASS, subject: 'FW: before the filter' });
  await put(ALEX_IN, { id: 'in2', auth: PASS, subject: 'FW: after the filter' });
  const p = provider();
  const list = await p.listNew();
  assert.deepEqual(list.map((m) => m.message_id).sort(), ['<in1@test>', '<in2@test>']);
  assert.equal((await p.fetch('<in2@test>')).subject, 'FW: after the filter');
  await p.markDone('<in2@test>');
  assert.deepEqual(await ids(DONE), ['<in2@test>']);
  assert.deepEqual(await ids(ALEX_IN), ['<in2@test>'], 'the message stays in the assistant inbox folder');
  assert.deepEqual((await p.listNew()).map((m) => m.message_id), ['<in1@test>']);
});

test('send: our own Message-ID is set, the copy that Proton puts into Sent a moment later is found (with retries) and filed into Folders/tasks.example.org/Sent; other Sent mail is never touched', D, async () => {
  await reset(); useEnv();
  await put('Sent', { id: 'other-sent', from: 'Owner <owner@example.com>', subject: 'not ours' }); // another sender: must stay in Sent
  const p = provider();
  const sendP = p.send({ to: OWNER, subject: 'סיכום בוקר', text: 'שלום' });
  await new Promise((r) => setTimeout(r, 700)); // the SMTP delivery is done; Proton shows its Sent copy only after a moment
  let mid;
  const c = await admin();
  try { const lock = await c.getMailboxLock('INBOX'); try { for await (const m of c.fetch('1:*', { envelope: true })) mid = m.envelope.messageId; } finally { lock.release(); } } finally { await c.logout(); }
  assert.match(mid, /^<[0-9a-f-]{36}@example\.com>$/, 'our own Message-ID, on the sender domain');
  await put('Sent', { mid, from: 'owner@example.com', subject: 'סיכום בוקר' });
  const res = await sendP;
  assert.equal(res.messageId, mid); assert.equal(res.sentMoved, 'pending', 'the send does not wait for Proton');
  assert.ok(JSON.parse(fs.readFileSync(env().MAIL_SENT_PENDING_FILE, 'utf8'))[mid], 'remembered until moved');
  assert.equal((await p.whenSentSettled())[0], true);
  assert.ok(!(mid in JSON.parse(fs.readFileSync(env().MAIL_SENT_PENDING_FILE, 'utf8'))), 'cleared once moved');
  assert.deepEqual(await ids(ALEX_SENT), [mid], 'our copy is present in Folders/tasks.example.org/Sent');
  assert.deepEqual((await ids('Sent')).sort(), ['<other-sent@test>', mid].sort(), 'Sent keeps everything (as on Proton, where Sent is a system label); nothing is removed from it');
});

test('housekeeping: sent copies older than the retention (90 days default) go to Trash; younger ones stay', D, async () => {
  await reset(); useEnv();
  await put(ALEX_SENT, { mid: '<old-sent@test>', from: 'owner@example.com', subject: 'old digest' }, '2026-01-01T10:00:00Z');
  await put(ALEX_SENT, { mid: '<new-sent@test>', from: 'owner@example.com', subject: 'new digest' });
  const db = open(':memory:');
  const dirs = { data: '/tmp', files: '/tmp', backups: '/tmp', models: '/tmp', runs: '/tmp/r', agentTmp: '/tmp/a', voice: '/tmp/v' };
  const hk = createHousekeeping(db, createStore(db), { mail: provider(), dirs });
  let r = await hk.mailboxCleanup({ dryRun: true });
  assert.equal(r.sent.removed.length, 1); assert.equal(await count(ALEX_SENT), 2, 'dry run changes nothing');
  r = await hk.mailboxCleanup();
  assert.deepEqual(r.sent.removed.map((x) => x.how), ['trash']);
  assert.deepEqual(await ids(ALEX_SENT), ['<new-sent@test>']);
  assert.deepEqual(await ids('Trash'), ['<old-sent@test>']);
});
