'use strict';
// Agent adapter layer. One interface for every brain:
// Each adapter only invokes the official CLI binary with the user's OWN existing login. Nothing here reads, proxies or stores credentials.
//   agent.run({ prompt, workdir, allowedCommands, readPaths, writePaths, model, timeoutMs }) -> { text, toolCalls, usage, exitCode, raw, stderr, error }
// The provider is chosen by env MESIMOT_AGENT (claude-code | codex | gemini) and MESIMOT_AGENT_MODEL, or in Settings (stored in the database).
const ADAPTERS = {
  'claude-code': () => require('./claude-code'),
  codex: () => require('./codex'),
  gemini: () => require('./gemini'),
};
const NAMES = Object.keys(ADAPTERS);
const LABELS = { 'claude-code': 'Claude Code', codex: 'OpenAI Codex CLI', gemini: 'Gemini CLI' };

function createAgent(name = 'claude-code', opts = {}) {
  if (!ADAPTERS[name]) throw new Error(`unknown agent "${name}". Choose one of: ${NAMES.join(', ')}`);
  return ADAPTERS[name]().create(opts);
}
// what is configured: the database setting wins over the environment
function configured(db, env = process.env) {
  const get = (k) => { try { return db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value || ''; } catch { return ''; } };
  const rawEnv = env.MESIMOT_AGENT;
  const name = get('agent_provider') || (NAMES.includes(rawEnv) ? rawEnv : 'claude-code');
  return { name, model: get('agent_model') || env.MESIMOT_AGENT_MODEL || '' };
}
function describe(db, env = process.env) {
  const c = configured(db, env);
  const models = require('./models');
  return { ...c, models: models.table({ adapter: c.name, db, config: require('../config').get() }), jobs: models.JOBS, options: NAMES.map((n) => { const a = createAgent(n); return { name: n, label: LABELS[n], ready: !!a.available(), setup: a.setup }; }) };
}
module.exports = { createAgent, configured, describe, NAMES, LABELS };
