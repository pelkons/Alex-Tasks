'use strict';
// Mail provider layer. One interface for the assistant's mailbox, two providers:
//   agentmail  the AgentMail HTTP API (default)
//   imap       generic IMAP + SMTP; made for the local Proton Mail Bridge (labels as folders under Labels/), STRICTLY scoped to two folders
//
//   provider.name, provider.address
//   listNew({known})          -> [{ message_id, from, to, subject, timestamp, labels, authentication_results }]   new messages not yet taken
//   fetch(id)                 -> full message: { message_id, from, to, subject, text, html, timestamp, labels, authentication_results, attachments:[{filename, content_type, size, inline, content_id, attachment_id}] }
//   attachment(id, attId)     -> Buffer
//   addLabel(id, label)       -> mark as taken ('mesimot')
//   markDone(id)              -> processed ('mesimot-done'); never depends on \Seen
//   list()                    -> [{ message_id, labels, timestamp, subject, from, to }]   for housekeeping
//   remove(id, opts)          -> delete or archive (provider specific, never touches mail outside our scope on imap)
//   send({to, subject, text}) -> only the owner is ever a recipient (checked by the caller)
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_FILE = process.env.MESIMOT_MAIL_ENV_FILE || path.join(os.homedir(), '.config', 'mesimot', 'env');
function fileEnv() {
  const out = {};
  // tests (node --test) must never pick up the real mailbox credentials from the user's env file
  if (process.env.NODE_TEST_CONTEXT && !process.env.MESIMOT_MAIL_ENV_FILE) return out;
  try { for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) { const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch { /* no file */ }
  return out;
}
// environment first, then ~/.config/mesimot/env
const settings = (env = process.env) => ({ ...fileEnv(), ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('MAIL_'))) });

// Every outgoing email is signed by the assistant (owner's requirement). Override with MAIL_SIGNATURE ("\n" for new lines).
const DEFAULT_SIGNATURE = 'Best regards,\nAlex O.\nAI Assistant';
function signature(s) { return (s.MAIL_SIGNATURE || DEFAULT_SIGNATURE).replace(/\\n/g, '\n'); }
function withSignature(text, s) {
  const sig = signature(s);
  const body = String(text || '').replace(/\s+$/, '');
  return body.endsWith(sig) ? body : `${body}\n\n${sig}\n`;
}

function create(env = process.env, deps = {}) {
  const s = settings(env);
  const name = (s.MAIL_PROVIDER || 'agentmail').toLowerCase();
  let p;
  if (name === 'imap') p = require('./imap').create(s, deps);
  else if (name === 'agentmail') p = require('./agentmail').create(s, deps);
  else throw new Error(`unknown MAIL_PROVIDER "${name}" (agentmail | imap)`);
  const send = p.send.bind(p);
  p.send = (msg) => send({ ...msg, text: withSignature(msg.text, s) });
  return p;
}
let cached = null, cachedFallback;
const get = () => (cached ||= create());
// An optional second, intake-only provider (MAIL_FALLBACK_PROVIDER=agentmail) for mail people still send to the old address; sending and
// everything else uses the primary. It switches itself off after MAIL_FALLBACK_UNTIL (an ISO date).
function fallback(now = Date.now()) {
  const s = settings();
  const name = (s.MAIL_FALLBACK_PROVIDER || '').toLowerCase();
  if (!name || name === (s.MAIL_PROVIDER || 'agentmail').toLowerCase()) return null;
  if (s.MAIL_FALLBACK_UNTIL && now > Date.parse(s.MAIL_FALLBACK_UNTIL)) return null;
  return (cachedFallback ||= create({ ...process.env, MAIL_PROVIDER: name }));
}
const all = () => [get(), fallback()].filter(Boolean);
const byName = (n) => all().find((p) => p.name === n) || get();
const reset = () => { cached = null; cachedFallback = undefined; };
module.exports = { create, get, fallback, all, byName, reset, settings, withSignature, signature };
