'use strict';
// A real UI smoke test with headless Chrome over the DevTools protocol (no extra dependency): log in with the real password, check that the main list renders rows
// matching /api/tasks, the chat renders, the project / calendar / archive pages open, and that there are ZERO console errors and page errors.
// This is the check that would have caught the blank task list: the process and the HTTP codes were fine, the page was not.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function launchChrome(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-smoke-'));
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--window-size=1300,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = ''; const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Chrome did not start')); }, 20000);
    proc.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); resolve({ ws: m[1], proc, dir }); } });
    proc.on('error', (e) => { clearTimeout(t); reject(e); });
    proc.on('exit', () => { clearTimeout(t); reject(new Error('Chrome exited early')); });
  });
}
const cleanup = (c) => { try { c.proc.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch { /* ignore */ } };

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = []; this.open = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('CDP connection failed')); }); this.ws.onmessage = (m) => this.onMessage(JSON.parse(m.data)); }
  onMessage(msg) { if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } else if (msg.method) for (const h of this.handlers) h(msg); }
  send(method, params = {}, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.delete(id)) rej(new Error('CDP timeout: ' + method)); }, 30000); }); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// returns { ok, errors: [...], problems: [...], facts: {...} }
async function smoke({ url, password, chrome = '/usr/bin/google-chrome', rowsTimeoutMs = 25000, log = () => {} }) {
  const errors = [], problems = [], facts = {};
  const c = await launchChrome(chrome); let cdp;
  try {
    cdp = new Cdp(c.ws); await cdp.open;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    cdp.handlers.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') errors.push('page error: ' + String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '').split('\n')[0].slice(0, 200));
      else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console error: ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
      else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && /\/api\//.test(msg.params.entry.url || '') && !/\/api\/login/.test(msg.params.entry.url)) errors.push('api error: ' + (msg.params.entry.text || '').slice(0, 120) + ' ' + msg.params.entry.url);
    });
    await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
    const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed'); return r.result.value; };
    const go = async (p) => { await S('Page.navigate', { url: url + p }); await new Promise((r) => setTimeout(r, 400)); };
    const waitFor = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* page loading */ } await new Promise((r) => setTimeout(r, 400)); } return false; };
    await go('/login'); await waitFor("document.readyState==='complete'", 15000);
    const st = await ev(`fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.status)`);
    if (st !== 200) { problems.push(`ההתחברות נכשלה (קוד ${st})`); return { ok: false, errors, problems, facts }; }
    // the main list
    await go('/');
    const rendered = await waitFor("document.querySelectorAll('.rows .row').length>0", rowsTimeoutMs);
    await new Promise((r) => setTimeout(r, 1200));
    const api = await ev("fetch('/api/tasks?open=1').then(r=>r.json()).then(a=>Array.isArray(a)?a.length:-1)");
    const rows = await ev("document.querySelectorAll('.rows .row').length");
    const emptyMsg = await ev("!!Array.from(document.querySelectorAll('.empty b')).find(e=>/אין משימות להצגה/.test(e.textContent))");
    facts.api_tasks = api; facts.rows = rows;
    if (api > 0 && (!rendered || rows === 0 || emptyMsg)) problems.push(`רשימת המשימות ריקה במסך (${rows} שורות) אף ש-/api/tasks מחזיר ${api}`);
    else if (api > 0 && rows < Math.min(api, 5)) problems.push(`רשימת המשימות מציגה ${rows} שורות מתוך ${api}`);
    const bubbles = await ev("document.querySelectorAll('.bubble').length");
    facts.chat_bubbles = bubbles;
    const chatApi = await ev("fetch('/api/chat?limit=5').then(r=>r.json()).then(a=>Array.isArray(a)?a.length:-1)");
    if (chatApi > 0 && bubbles === 0) problems.push('הצ׳אט לא מציג הודעות');
    // pages
    const projects = await ev("fetch('/api/projects').then(r=>r.json()).then(a=>(Array.isArray(a)?a:a.projects||[]).filter(p=>!p.is_default).map(p=>p.id))");
    for (const [label, route, sel] of [['דף פרויקט', projects[0] ? `/projects/${projects[0]}` : null, '.pj-head'], ['היומן', '/calendar', '.cal-cell'], ['הארכיון', '/archive', '.arc-filters']]) {
      if (!route) continue;
      await go(route);
      if (!(await waitFor(`!!document.querySelector('${sel}')`, 15000))) problems.push(`${label} לא נפתח`);
      await new Promise((r) => setTimeout(r, 800));
    }
    if (errors.length) problems.push(`${errors.length} שגיאות JavaScript: ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
    return { ok: problems.length === 0, errors, problems, facts };
  } catch (e) { problems.push('בדיקת הדפדפן נכשלה: ' + e.message); return { ok: false, errors, problems, facts }; }
  finally { if (cdp) cdp.close(); cleanup(c); log('smoke done', url); }
}
module.exports = { smoke };
