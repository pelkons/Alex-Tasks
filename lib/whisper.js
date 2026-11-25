'use strict';
// Hebrew speech to text: a persistent faster-whisper worker (ivrit.ai model, language forced to Hebrew).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PY = process.env.MESIMOT_PYTHON || path.join(__dirname, '..', 'venv', 'bin', 'python');
const WORKER = path.join(__dirname, 'whisper_worker.py');

function toWav(input) {
  const out = path.join(os.tmpdir(), `mesimot-voice-${process.pid}-${Date.now()}.wav`);
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out], { timeout: 120000 }, (err) => (err ? reject(err) : resolve(out)));
  });
}

function createWhisper() {
  let child = null, buf = '', seq = 0;
  const waiting = new Map();
  const stats = { last_seconds: null, last_audio_seconds: null };

  function ensure() {
    if (child) return;
    child = spawn(PY, [WORKER], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.id && waiting.has(o.id)) { const w = waiting.get(o.id); waiting.delete(o.id); clearTimeout(w.t); o.error ? w.reject(new Error(o.error)) : w.resolve(o); }
      }
    });
    child.on('close', () => { child = null; for (const [, w] of waiting) { clearTimeout(w.t); w.reject(new Error('whisper worker stopped')); } waiting.clear(); });
  }

  // audio file in any format ffmpeg reads (Telegram voice notes are ogg/opus)
  async function transcribe(file) {
    const wav = await toWav(file);
    try {
      ensure();
      const id = ++seq;
      const res = await new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiting.delete(id); reject(new Error('whisper timeout')); }, 10 * 60 * 1000);
        waiting.set(id, { resolve, reject, t });
        child.stdin.write(JSON.stringify({ id, path: wav }) + '\n');
      });
      stats.last_seconds = res.seconds; stats.last_audio_seconds = res.duration; stats.last_language = res.language;
      return { text: res.text, language: res.language };
    } finally { fs.rm(wav, () => {}); }
  }
  const stop = () => { if (child) { child.kill(); child = null; } };
  return { transcribe, stop, stats };
}

module.exports = { createWhisper };
