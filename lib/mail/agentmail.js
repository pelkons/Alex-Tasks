'use strict';
// AgentMail provider: the HTTP API (the previous implementation, moved behind the interface). The key is read from ~/.config/agentmail/env at call time.
const fs = require('fs');
const os = require('os');
const path = require('path');

function create(s, { fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const inbox = require('../config').get().inbox;
  const BASE = `https://api.agentmail.to/v0/inboxes/${inbox}/messages`;
  const key = () => {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.config', 'agentmail', 'env'), 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?AGENTMAIL_API_KEY\s*=\s*['"]?([^'"\s]+)/.exec(line);
      if (m) return m[1];
    }
    throw new Error('AgentMail key not found');
  };
  async function am(method, url, body) {
    const res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`AgentMail ${method} ${res.status}`);
    return res.json();
  }
  const enc = encodeURIComponent;
  return {
    name: 'agentmail', address: inbox, housekeepingMode: 'delete', am, BASE,
    async listNew() { return (await am('GET', BASE + '?limit=50')).messages || []; },
    async fetch(id) { return am('GET', `${BASE}/${enc(id)}`); },
    async attachment(id, attId) {
      const info = await am('GET', `${BASE}/${enc(id)}/attachments/${enc(attId)}`);
      const res = await fetchImpl(info.download_url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`download ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async addLabel(id, label) { await am('PATCH', `${BASE}/${enc(id)}`, { add_labels: [label] }); },
    async markDone(id) { await am('PATCH', `${BASE}/${enc(id)}`, { add_labels: ['mesimot-done'] }); },
    async list() {
      const out = []; let token = '';
      for (let i = 0; i < 100; i++) {
        const r = await am('GET', `${BASE}?limit=100${token ? '&page_token=' + enc(token) : ''}`);
        out.push(...(r.messages || []));
        token = r.next_page_token || '';
        if (!token) break;
      }
      return out;
    },
    async remove(id) { await am('DELETE', `${BASE}/${enc(id)}`); return { removed: 'deleted' }; },
    async send({ to, subject, text }) { return am('POST', `https://api.agentmail.to/v0/inboxes/${inbox}/messages/send`, { to: [to], subject, text }); },
  };
}
module.exports = { create };
