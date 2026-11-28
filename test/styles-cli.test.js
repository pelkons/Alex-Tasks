'use strict';
// The writing-style gate through the real CLI (bin/mesimot) against a listening server: refused with the Hebrew fixes, accepted in the owner's style. Fictional data only.
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const fs = require('fs'); const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-stylescli-')); process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(TMP, 'outbox-sign.key'); process.env.MESIMOT_FILES = path.join(TMP, 'files');
const test = require('node:test');
const assert = require('node:assert/strict');
const { server, TOKEN } = require('./helpers/styles');

test('CLI: `mesimot outbox draft` is refused with the Hebrew fixes and exit code 1, succeeds in his style; `mesimot style for` prints the guide', async () => {
  const X = server(); await X.app.listen({ port: 0, host: '127.0.0.1' }); const port = X.app.server.address().port;
  const { execFile } = require('child_process'); // async: the server answers in this same process
  const run = (...args) => new Promise((res) => execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'mesimot'), ...args], { env: { ...process.env, MESIMOT_URL: `http://127.0.0.1:${port}`, MESIMOT_TOKEN: TOKEN, MESIMOT_AGENT_MODE: '1' }, encoding: 'utf8' }, (err, stdout, stderr) => res({ status: err ? err.code : 0, stdout, stderr })));
  try {
    const bad = await run('outbox', 'draft', '--to', 'ron@exconstruct.example', '--subject', 'תוכניות', '--body', 'לכבוד רון,\nהריני לבקש את התוכניות.');
    assert.equal(bad.status, 1); assert.match(JSON.parse(bad.stderr).error, /לא בסגנון "עמית"[\s\S]*לתקן:[\s\S]*"לכבוד"/);
    const good = await run('outbox', 'draft', '--to', 'ron@exconstruct.example', '--subject', 'תוכניות', '--body', 'רון, היי\nמה עם התוכניות?');
    assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).style_key, 'colleague');
    const f = await run('style', 'for', '--to', 'רון'); assert.equal(f.status, 0, f.stderr); assert.equal(JSON.parse(f.stdout).style.key, 'colleague');
    assert.equal((await run('style', 'analyse')).status, 1, 'the analysis is not for the assistant');
  } finally { await X.app.close(); }
});
