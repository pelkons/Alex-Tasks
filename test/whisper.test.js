'use strict';
// Runs the real worker (Hebrew and Russian models on CPU). Skipped when the models are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = path.join(__dirname, '..');
const PY = path.join(root, 'venv', 'bin', 'python');
const have = fs.existsSync(PY) && fs.existsSync(path.join(root, 'models', 'whisper')) && fs.existsSync(path.join(root, 'test', 'fixtures', 'voice-he.wav')) && fs.existsSync(path.join(root, 'test', 'fixtures', 'voice-ru.wav')); // the clips are not shipped: record two short ones (see docs)

test('voice: Hebrew and Russian clips are told apart and transcribed with the right model', { skip: !have, timeout: 600000 }, async () => {
  const child = spawn(PY, [path.join(root, 'lib', 'whisper_worker.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = []; let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { try { lines.push(JSON.parse(buf.slice(0, i))); } catch { /* ignore */ } buf = buf.slice(i + 1); } });
  const ask = (id, file) => new Promise((resolve) => { const t = setInterval(() => { const r = lines.find((l) => l.id === id); if (r) { clearInterval(t); resolve(r); } }, 200); child.stdin.write(JSON.stringify({ id, path: path.join(__dirname, 'fixtures', file) }) + '\n'); });
  try {
    const he = await ask('he', 'voice-he.wav');
    assert.equal(he.language, 'he'); assert.match(he.text, /[א-ת]{3}/);
    const ru = await ask('ru', 'voice-ru.wav');
    assert.equal(ru.language, 'ru'); assert.match(ru.text, /[А-Яа-я]{3}/);
    const ru2 = await ask('ru2', 'voice-ru.wav'); // warm: models stay loaded
    const he2 = await ask('he2', 'voice-he.wav');
    console.log(`transcription seconds (warm): Hebrew ${he2.seconds}s, Russian ${ru2.seconds}s for ${he2.duration}s and ${ru2.duration}s of speech`);
    assert.ok(he2.seconds < 60 && ru2.seconds < 60);
  } finally { child.kill(); }
});
