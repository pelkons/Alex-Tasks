'use strict';
// The HTTP side of the MCP server: the same local API and the same assistant token as the CLI (bin/mesimot). No business logic here.
const { readEnvFile } = require('../envfile');

// kinds: 'validation' (before any HTTP call), 'refused' (HTTP 4xx), 'unreachable' (no connection or HTTP 5xx)
class ToolError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
const UNREACHABLE = (why) => `The server is not reachable right now (${why}). Nothing was changed. Try once more; if it fails again, finish and say so in run_summary.`;

function qs(o) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v === true ? '1' : String(v));
  const s = p.toString();
  return s ? '?' + s : '';
}

function createApi({ base = process.env.MESIMOT_URL || 'http://127.0.0.1:8110', token, runId = process.env.MESIMOT_RUN_ID || '', timeoutMs = 120000, fetchImpl = fetch } = {}) {
  const tok = () => token || process.env.MESIMOT_TOKEN || readEnvFile().MESIMOT_TOKEN;
  async function call(method, url, body) {
    const t = tok();
    if (!t) throw new ToolError('unreachable', UNREACHABLE('no API token found'));
    let res;
    try {
      res = await fetchImpl(base + url, {
        method,
        headers: { Authorization: `Bearer ${t}`, 'X-Mesimot-Via': 'mcp', ...(runId ? { 'X-Mesimot-Run': String(runId) } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new ToolError('unreachable', UNREACHABLE(e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code || e.message))); }
    const text = await res.text().catch(() => '');
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
    if (res.status >= 500) throw new ToolError('unreachable', UNREACHABLE(`HTTP ${res.status}`), res.status);
    if (!res.ok) throw new ToolError('refused', `The server refused (HTTP ${res.status}): ${(data && data.error) || (typeof data === 'string' && data) || 'no reason given'}`, res.status);
    return data;
  }
  return {
    get: (url, query) => call('GET', url + qs(query)),
    post: (url, body, query) => call('POST', url + qs(query), body === undefined ? {} : body),
    patch: (url, body) => call('PATCH', url, body === undefined ? {} : body),
    del: (url) => call('DELETE', url),
  };
}
module.exports = { createApi, ToolError, qs, UNREACHABLE };
