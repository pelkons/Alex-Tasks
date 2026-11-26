'use strict';
// Installation settings that are specific to one owner and one domain. Nothing owner-specific is hardcoded in the code:
// it comes from config/mesimot.config.json (see config/mesimot.config.example.json), or the file named by MESIMOT_CONFIG,
// with environment variables overriding the few that matter (MESIMOT_SITE_URL, MESIMOT_PUBLIC_URL, MESIMOT_INBOX).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = {
  site_url: 'http://127.0.0.1:8110',
  public_url: '',
  mirror_url: '', // optional second address (a Cloudflare Worker mirror) for networks that block the main domain
  tunnel_id: '',
  agent_models: {}, // per adapter: { default: {model, effort}, jobs: { pulse: {model, effort, fallback} } }
  timezone: 'Asia/Jerusalem',
  inbox: '',
  owner: { name_he: 'הבעלים', name_en: 'Owner', emails: [], work_email: '' },
  assistant: { name_he: 'אלכס', name_en: 'Alex' },
  team: [],      // [{ name_he, name_en, role: 'pm'|'contact', emails: [] }]
  bosses: [],    // [{ name_he, name_en, emails: [] }]: marked "הממונה"; their requests get priority and immediate questions
  allowlist: [], // addresses whose mail the assistant takes (the owner's own); empty = the owner's addresses
  digest_to: '',
  outbox: { signature: '' }, // text block appended to every outgoing mail; empty by default (mail goes out as the owner; his Outlook may add its own signature)
};

let cache = null;
function load(file) {
  const p = file || process.env.MESIMOT_CONFIG || path.join(ROOT, 'config', 'mesimot.config.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* none: defaults */ }
  const c = { ...DEFAULTS, ...raw, outbox: { ...DEFAULTS.outbox, ...(raw.outbox || {}) }, owner: { ...DEFAULTS.owner, ...(raw.owner || {}) }, assistant: { ...DEFAULTS.assistant, ...(raw.assistant || {}) } };
  c.site_url = (process.env.MESIMOT_SITE_URL || c.site_url).replace(/\/$/, '');
  c.public_url = (process.env.MESIMOT_PUBLIC_URL ?? c.public_url ?? '').replace(/\/$/, '');
  c.inbox = process.env.MESIMOT_INBOX || c.inbox;
  c.mirror_url = String(c.mirror_url || '').replace(/\/$/, '');
  c.owner.work_email = c.owner.work_email || c.owner.emails[0] || '';
  c.digest_to = c.digest_to || c.owner.emails[c.owner.emails.length - 1] || '';
  if (!c.allowlist.length) c.allowlist = c.owner.emails;
  return c;
}
const get = () => (cache ||= load());
// the base URL for links the SYSTEM writes (Telegram, email, calendar): the main address, or the mirror when the owner chose it in Settings
function siteUrl(db) {
  const c = get();
  try { if (c.mirror_url && db && db.prepare("SELECT value FROM settings WHERE key='links_use_mirror'").get()?.value === '1') return c.mirror_url; } catch { /* no db */ }
  return c.site_url;
}
const reload = (file) => (cache = load(file));
module.exports = { get, reload, load, siteUrl, DEFAULTS };
