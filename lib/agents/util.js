'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// run a binary without a shell; returns { stdout, stderr, code, timedOut }
function capture(bin, args, { cwd, env, timeoutMs = 600000, input = null } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false;
    let child;
    try { child = spawn(bin, args, { cwd, env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); } } catch (e) { return resolve({ stdout: '', stderr: String(e.message), code: 127, timedOut: false }); }
    child.on('error', (e) => resolve({ stdout: out, stderr: err + String(e.message), code: 127, timedOut }));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code, timedOut }); });
  });
}
const agentEnv = (extra = {}) => ({ ...process.env, MESIMOT_AGENT_MODE: '1', PATH: `${os.homedir()}/.npm-global/bin:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`, ...extra });
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-agent-')), name);
const onPath = (bin) => { for (const d of (process.env.PATH || '').split(':').concat(`${os.homedir()}/.npm-global/bin`)) { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { /* next */ } } return false; };

// every adapter returns the same shape: { text, toolCalls, usage, exitCode, raw, stderr, error }
module.exports = { capture, agentEnv, clip, tmpFile, onPath };
