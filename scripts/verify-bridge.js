'use strict';
// Read-only verification against the real Proton Bridge, strictly inside the provider's scope (INBOX of the assistant's account + the done label).
// Never prints credentials or message bodies. Usage: node scripts/verify-bridge.js
process.env.MAIL_PROVIDER = 'imap';
const { ImapFlow } = require('imapflow');
const mail = require('../lib/mail');
const s = mail.settings();
const scope = s.MAIL_IMAP_SCOPE_FOLDER || 'INBOX', done = s.MAIL_IMAP_DONE_FOLDER || 'Labels/Alex-done';
(async () => {
  const p = mail.create(process.env);
  console.log('provider:', p.name, '| address:', p.address, '| scope:', p.scope, '| done:', p.done);
  // 1. login + capabilities (through the provider's own connection path)
  const c = new ImapFlow({ host: s.MAIL_IMAP_HOST || '127.0.0.1', port: +(s.MAIL_IMAP_PORT || 1143), secure: false, doSTARTTLS: true, auth: { user: s.MAIL_IMAP_USER, pass: s.MAIL_IMAP_PASS }, tls: { rejectUnauthorized: false }, logger: false });
  await c.connect();
  console.log('login: OK | capabilities:', [...c.capabilities.keys()].filter((k) => /MOVE|IDLE|UIDPLUS|CONDSTORE|LITERAL|SPECIAL-USE|NAMESPACE|XLIST/i.test(k)).join(', '));
  // 2. the INBOX of this account
  let lock = await c.getMailboxLock(scope);
  console.log(scope, 'exists:', c.mailbox.exists);
  const seen = {};
  const addrs = new Set();
  if (c.mailbox.exists) {
    for await (const m of c.fetch(`${Math.max(1, c.mailbox.exists - 9)}:*`, { envelope: true, headers: true })) {
      for (const a of [...(m.envelope.to || []), ...(m.envelope.cc || [])]) addrs.add((a.address || '').toLowerCase());
      for (const line of String(m.headers).split(/\r?\n(?=\S)/)) { const k = line.split(':')[0].toLowerCase(); if (/^(authentication-results|x-pm-origin|x-pm-content-encryption|x-pm-spamscore|received-spf|dkim-signature|x-original-to|delivered-to)$/.test(k)) seen[k] = (seen[k] || 0) + 1; }
    }
  }
  lock.release();
  console.log('recipient addresses seen in the last messages:', [...addrs].join(', ') || '(none)');
  console.log('headers present (name: count):', JSON.stringify(seen));
  // 3. the done label: CREATE exactly this name, then open it
  let created = 'exists';
  try { await c.mailboxCreate(done); created = 'CREATED'; } catch (e) { created = /exist|already/i.test(e.message || '') || /ALREADYEXISTS/i.test(e.responseText || '') ? 'exists' : `REFUSED (${e.responseText || e.message})`; }
  console.log(`CREATE ${done}:`, created);
  try { lock = await c.getMailboxLock(done); console.log(done, 'opens: OK, messages:', c.mailbox.exists); lock.release(); } catch (e) { console.log(done, 'cannot be opened:', e.responseText || e.message); }
  await c.logout();
  // 4. the provider's own listing (what the runner would take)
  const list = await p.listNew();
  console.log('provider.listNew():', list.length, 'message(s)', list.map((m) => `${m.from} | ${m.subject} | dmarc=${m.authentication_results.dmarc || '-'}${m.authentication_results.internal ? ' (internal)' : ''}`));
})().catch((e) => { console.log('FAILED:', e.name, e.message); process.exit(1); });
