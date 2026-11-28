'use strict';
// The list of commands of bin/mesimot, read from its source: ["task list", "task show", ..., "health", "sql"]. Used by the parity test (every
// command the assistant may use has an MCP tool) so a new CLI command cannot silently miss one.
const fs = require('fs');
const path = require('path');

function cliCommands(file = path.join(__dirname, '..', '..', 'bin', 'mesimot')) {
  const src = fs.readFileSync(file, 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  const parts = main.split(/\n    case '/).slice(1);
  const out = new Set();
  const list = (s) => [...s.matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  for (const part of parts) {
    const cmd = /^([\w-]+)'/.exec(part)[1];
    if (cmd === 'default') continue;
    const subs = new Set();
    for (const m of part.matchAll(/\bsub (?:===|!==) '(\w[\w-]*)'/g)) subs.add(m[1]);
    for (const m of part.matchAll(/\[([^\]\n]*)\]\.includes\(sub\)/g)) for (const s of list(m[1])) subs.add(s);
    const actions = new Set();
    for (const m of part.matchAll(/\baction === '([\w-]+)'/g)) actions.add(m[1]);
    for (const m of part.matchAll(/\[([^\]\n]*)\]\.includes\(action\)/g)) for (const s of list(m[1])) actions.add(s);
    if (subs.has('item') && actions.size) { subs.delete('item'); for (const a of actions) out.add(`${cmd} item ${a}`); }
    if (!subs.size) out.add(cmd); else for (const s of subs) out.add(`${cmd} ${s}`);
  }
  return [...out].sort();
}
module.exports = { cliCommands };
