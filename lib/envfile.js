'use strict';
// The secrets file shared by the server, the CLI and the MCP server (~/.config/mesimot/env, KEY=value lines). Kept tiny so the MCP process starts fast.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_FILE = process.env.MESIMOT_ENV_FILE || path.join(os.homedir(), '.config', 'mesimot', 'env');

function readEnvFile(file = ENV_FILE) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* missing file */ }
  return out;
}
module.exports = { readEnvFile, ENV_FILE };
