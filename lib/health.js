'use strict';
// `mesimot health`: ONE checker for everything that has to work, run every 15 minutes round the clock. The watchdog only looked at processes and HTTP codes and did not notice a blank task list;
// this one also opens the real UI in headless Chrome. Results go to the `health` table (Settings card "מצב המערכת"), the owner is told once per issue (Telegram, email when Telegram is down)
// and once more when it recovers. It restarts a dead service once; it never touches data. Everything that touches the outside is injectable, so tests use fakes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { now } = require('./db');

const SERVICES = ['mesimot', 'mesimot-runner', 'mesimot-tunnel', 'proton-bridge']; // plus config.health.extra_services (an installation's own units)
const TIMERS = ['mesimot-backup', 'mesimot-curator', 'mesimot-daily', 'mesimot-housekeeping', 'mesimot-pulse', 'mesimot-reconcile', 'mesimot-usage', 'mesimot-watchdog', 'mesimot-health'];
const RENOTIFY_MS = 6 * 3600000; // an issue that stays red is repeated at most every 6 hours (never within 2)
const ENV_FILE = process.env.MESIMOT_ENV_FILE || path.join(os.homedir(), '.config', 'mesimot', 'env');
const envVar = (k) => { if (process.env[k]) return process.env[k]; try { const m = new RegExp(`^\\s*${k}\\s*=\\s*(.*?)\\s*$`, 'm').exec(fs.readFileSync(ENV_FILE, 'utf8')); return m ? m[1].replace(/^["']|["']$/g, '') : ''; } catch { return ''; } };
const OK = 'ok', WARN = 'warn', RED = 'red';

function createHealth(db, store, o = {}) {
  const q = (s) => db.prepare(s);
  const nowMs = o.nowMs || (() => Date.now());
  const systemctl = o.systemctl || ((args) => { const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 30000 }); return { code: r.status ?? 1, stdout: (r.stdout || '').trim() }; });
  const doFetch = o.fetch || fetch;
  const cfg = () => require('./config').get();
  const localUrl = o.localUrl ?? `http://127.0.0.1:${process.env.MESIMOT_PORT || 8110}`;
  const password = () => (o.password !== undefined ? o.password : (() => { try { return fs.readFileSync(process.env.MESIMOT_WEB_PASSWORD_FILE || path.join(os.homedir(), '.config', 'mesimot', 'web-password.txt'), 'utf8').trim(); } catch { return ''; } })());
  const apiToken = () => (o.apiToken !== undefined ? o.apiToken : (process.env.MESIMOT_TOKEN || envVar('MESIMOT_TOKEN')));
  const smoke = o.smoke || ((a) => require('./uismoke').smoke(a));
  const log = o.log || (() => {});
  const age = (iso) => (iso ? nowMs() - Date.parse(iso) : null);
  const mins = (ms) => `${Math.round(ms / 60000)} דק׳`;
  const getSet = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
  const setSet = (k, v) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const R = (id, label, status, message, extra = {}) => ({ id, label, status, message, critical: !!extra.critical, ms: extra.ms ?? null, alert: extra.alert !== false, once: !!extra.once, detail: extra.detail });
  const timed = async (fn) => { const t = nowMs(); const r = await fn(); return [r, nowMs() - t]; };

  // ---- 1. services and timers
  async function services() {
    const out = [];
    for (const u of [...SERVICES, ...(cfg().health?.extra_services || [])]) {
      const act = systemctl(['is-active', u]).stdout;
      const res = systemctl(['show', '-p', 'Result', '--value', u]).stdout;
      if (act === 'active') out.push(R(`svc:${u}`, `שירות ${u}`, res && res !== 'success' ? WARN : OK, res && res !== 'success' ? `פעיל, אבל התוצאה האחרונה: ${res}` : 'פעיל', { critical: ['mesimot', 'mesimot-runner'].includes(u) }));
      else out.push(R(`svc:${u}`, `שירות ${u}`, RED, `לא פעיל (${act || 'לא ידוע'})`, { critical: ['mesimot', 'mesimot-runner', 'mesimot-tunnel'].includes(u), detail: { unit: u } }));
    }
    for (const t of TIMERS) {
      const act = systemctl(['is-active', `${t}.timer`]).stdout;
      const svc = systemctl(['show', '-p', 'Result', '--value', `${t}.service`]).stdout;
      out.push(R(`timer:${t}`, `טיימר ${t}`, act !== 'active' ? RED : (svc && svc !== 'success' ? WARN : OK), act !== 'active' ? `הטיימר לא פעיל (${act || '?'})` : (svc && svc !== 'success' ? `ההרצה האחרונה נכשלה (${svc})` : 'פעיל')));
    }
    return out;
  }
  // a dead service is restarted ONCE per outage (the watchdog does the same; this covers the gap), then reported
  function selfHeal(results) {
    for (const r of results) {
      if (!r.id.startsWith('svc:') || r.status !== RED || !r.detail?.unit) continue;
      const key = `health_restart:${r.detail.unit}`; const last = getSet(key);
      if (last && age(last) < 30 * 60000) { r.message += ' (הופעל מחדש כבר, עדיין לא עובד)'; continue; }
      const res = systemctl(['restart', r.detail.unit]); setSet(key, new Date(nowMs()).toISOString());
      r.message += res.code === 0 ? ' (הופעל מחדש עכשיו)' : ' (הפעלה מחדש נכשלה)';
    }
  }

  // ---- 2. the real UI, on every address
  async function ui() {
    const c = cfg(); const pw = password();
    const targets = [['local', 'האתר (מקומי)', localUrl, true], ['public', 'האתר (tasks)', c.public_url, true], ['mirror', 'האתר (מראה workers.dev)', c.mirror_url, false]].filter((t) => t[2]);
    if (!pw) return targets.map(([id, label]) => R(`ui:${id}`, `ממשק: ${label}`, WARN, 'אין קובץ סיסמה לבדיקת הממשק', { alert: false }));
    return Promise.all(targets.map(async ([id, label, url, critical]) => {
      const [r, ms] = await timed(() => smoke({ url, password: pw, chrome: o.chrome || '/usr/bin/google-chrome', log }).catch((e) => ({ ok: false, problems: ['בדיקת הדפדפן נכשלה: ' + e.message], facts: {} })));
      return R(`ui:${id}`, `ממשק: ${label}`, r.ok ? OK : RED, r.ok ? `תקין (${r.facts.rows} משימות ברשימה, ${r.facts.chat_bubbles} הודעות בצ׳אט, בלי שגיאות)` : r.problems.join('; '), { critical, ms });
    }));
  }

  // ---- 3. the APIs, with latency
  async function apis() {
    const out = []; const base = localUrl; const tok = apiToken();
    const timeit = async (id, label, fn, slowMs = 2500) => {
      const t = nowMs();
      try { const detail = await fn(); const ms = nowMs() - t; out.push(R(`api:${id}`, `API: ${label}`, ms > 8000 ? RED : ms > slowMs ? WARN : OK, `${detail || 'תקין'} (${ms} ms)`, { critical: id === 'tasks' || id === 'login', ms })); }
      catch (e) { out.push(R(`api:${id}`, `API: ${label}`, RED, e.message, { critical: id === 'tasks' || id === 'login', ms: nowMs() - t })); }
    };
    const get = async (p) => { const r = await doFetch(base + p, { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`קוד ${r.status}`); return r.json(); };
    await timeit('login', 'התחברות', async () => { const pw = password(); if (!pw) return 'דולג (אין סיסמה)'; const r = await doFetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }), signal: AbortSignal.timeout(15000) }); if (r.status !== 200) throw new Error(`קוד ${r.status}`); });
    await timeit('tasks', 'משימות', async () => { const a = await get('/api/tasks?open=1'); if (!Array.isArray(a)) throw new Error('התשובה אינה רשימה'); if (a.some((t) => !t || typeof t !== 'object')) throw new Error('שורה פגומה ברשימה'); return `${a.length} משימות פתוחות`; });
    await timeit('chat', 'צ׳אט', async () => { const a = await get('/api/chat?limit=20'); if (!Array.isArray(a)) throw new Error('התשובה אינה רשימה'); return `${a.length} הודעות`; });
    await timeit('search', 'חיפוש', async () => { const r = await get('/api/search?q=' + encodeURIComponent('משימה')); if (!r || typeof r !== 'object') throw new Error('תשובה לא תקינה'); });
    await timeit('ask', 'שאלות (ask)', async () => { const r = await get('/api/ask?q=' + encodeURIComponent('מה המצב')); if (!r || typeof r !== 'object') throw new Error('תשובה לא תקינה'); }, 5000);
    return out;
  }

  // ---- 4. the assistant pipeline
  function pipeline() {
    const out = []; const hour = new Date(nowMs() - 3600000).toISOString();
    const runs = q("SELECT error, trigger FROM claude_runs WHERE finished_at IS NOT NULL AND started_at >= ?").all(hour);
    const bad = runs.filter((r) => r.error && r.error !== 'interrupted' && !/rate.?limit|429|overloaded/i.test(r.error)); const rate = runs.length ? bad.length / runs.length : 0;
    out.push(R('pipe:errors', 'הרצות העוזר: שיעור שגיאות', runs.length >= 5 && rate > 0.2 ? RED : OK, runs.length >= 5 && rate > 0.2 ? `${bad.length} מתוך ${runs.length} ההרצות בשעה האחרונה נכשלו (${Math.round(rate * 100)}%)` : `${bad.length}/${runs.length} שגיאות בשעה האחרונה`));
    const stuck = q('SELECT id, trigger, started_at FROM claude_runs WHERE finished_at IS NULL AND started_at < ?').all(new Date(nowMs() - 15 * 60000).toISOString());
    out.push(R('pipe:stuck', 'הרצה תקועה', stuck.length ? RED : OK, stuck.length ? `הרצה ${stuck[0].id} (${stuck[0].trigger}) רצה מעל ${mins(age(stuck[0].started_at))}` : 'אין הרצה תקועה', { critical: false }));
    const pending = q("SELECT COUNT(*) n FROM emails WHERE import_id IN (SELECT id FROM imports WHERE status NOT IN ('done')) AND import_state IN ('staged','parsed','relevant','fyi')").get().n;
    const lastMove = Math.max(0, ...[q('SELECT MAX(started_at) m FROM claude_runs WHERE import_id IS NOT NULL').get().m, q('SELECT MAX(processed_at) m FROM emails').get().m, q("SELECT MAX(created_at) m FROM imports").get().m].filter(Boolean).map(Date.parse));
    const backoff = getSet('rate_limit_until'); const limited = backoff && Date.parse(backoff) > nowMs();
    const stalled = pending > 0 && nowMs() - lastMove > 30 * 60000 && !limited;
    out.push(R('pipe:import', 'תור הייבוא', stalled ? RED : OK, stalled ? `${pending} מיילים ממתינים ואין התקדמות כבר ${mins(nowMs() - lastMove)}` : (pending ? `${pending} מיילים בעיבוד${limited ? ' (מושהה: מגבלת קצב)' : ''}` : 'התור ריק')));
    return out;
  }

  // ---- 4b. the Outlook mail archive (old mail, background worker): disk space, a stalled worker, failures. Only once an archive exists (a queue row).
  function archiveCheck() {
    const out = [];
    if (!q('SELECT 1 FROM archive_queue LIMIT 1').get()) return out;
    const st = require('./archive').createArchive({ db, store }).status();
    const gb = (b) => (b / 1024 ** 3).toFixed(1);
    if (st.free_bytes != null) out.push(R('archive:disk', 'ארכיון המיילים: מקום בדיסק', st.disk_ok ? OK : RED, st.disk_ok ? `${gb(st.free_bytes)} GB פנויים` : `פחות מ-${gb(st.min_free_bytes)} GB פנויים (${gb(st.free_bytes)} GB): קליטת הארכיון נעצרה עד שיתפנה מקום`, { critical: false }));
    const waiting = st.queued + st.working + st.embedding; const beat = q("SELECT at FROM heartbeat WHERE key='archive_worker'").get()?.at; const lag = beat ? age(beat) : null;
    const stalled = waiting > 0 && (lag == null || lag > 20 * 60000);
    out.push(R('archive:worker', 'ארכיון המיילים: עיבוד ברקע', stalled ? WARN : OK, stalled ? `${waiting} מיילים ממתינים והעיבוד לא פעיל ${lag == null ? '(אין פעימה)' : 'כבר ' + mins(lag)}` : `${st.emails} מיילים בארכיון${waiting ? `, ${waiting} בתור` : ''}${st.failed ? `, ${st.failed} נכשלו` : ''}`, { critical: false, alert: false }));
    return out;
  }

  // ---- 5. mail, ingest, outbox
  async function mail() {
    const out = [];
    const hb = (k) => q('SELECT at FROM heartbeat WHERE key=?').get(k)?.at;
    try { await Promise.race([(o.mailPing || (() => require('./mail').get().ping()))(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]); out.push(R('mail:login', 'דואר: התחברות Proton IMAP', OK, 'ההתחברות תקינה')); }
    catch (e) { out.push(R('mail:login', 'דואר: התחברות Proton IMAP', RED, 'ההתחברות נכשלה: ' + String(e.message).slice(0, 80))); }
    const m = age(hb('mail_poll')); out.push(R('mail:poll', 'דואר: קליטה אחרונה', m == null || m > 15 * 60000 ? RED : OK, m == null ? 'אין פעימת קליטה' : `הצלחה לפני ${mins(m)}`));
    const last = getSet('ingest_last_contact'); const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs())); const wd = parts.find((p) => p.type === 'weekday').value; const hr = +parts.find((p) => p.type === 'hour').value;
    const work = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(wd) && hr >= 8 && hr < 19;
    const acn = require('./connector').activeContact(db); const lastC = acn ? acn.last : last; // with paired devices: the ACTIVE one only
    if (!lastC) out.push(R('ingest', 'Outlook: קשר מהמחשב', OK, 'המחבר עדיין לא התחבר'));
    else { const a = age(lastC); out.push(R('ingest', 'Outlook: קשר מהמחשב', a > 2 * 3600000 && work ? RED : (a > 2 * 3600000 ? WARN : OK), `קשר אחרון לפני ${mins(a)}`, { alert: false })); } // the watchdog owns this alert
    try { // connector devices: heartbeat state (the watchdog owns the alert)
      const devs = q('SELECT * FROM connector_devices WHERE revoked_at IS NULL').all();
      for (const d of devs) {
        const a = d.hb_at ? age(d.hb_at) : null; const nm = d.name || `מחשב ${d.id}`;
        if (d.role === 'standby') { out.push(R(`connector:${d.id}`, `מחבר Outlook: ${nm}`, OK, `במצב המתנה${a == null ? '' : ` · פעימה לפני ${mins(a)}`}`, { alert: false })); continue; }
        const prob = a == null ? 'עדיין לא נשלחה פעימה' : a > 30 * 60000 ? `פעימה אחרונה לפני ${mins(a)}` : d.hb_outlook_ok === 0 ? 'Outlook סגור' : d.hb_paused_ingest ? 'קליטה מושהית' : d.hb_paused_send ? 'שליחה מושהית' : d.hb_last_error ? 'שגיאה: ' + String(d.hb_last_error).slice(0, 60) : null;
        out.push(R(`connector:${d.id}`, `מחבר Outlook: ${nm}`, prob ? (work || a == null ? WARN : OK) : OK, prob || `תקין${d.app_version ? ' · גרסה ' + d.app_version : ''}`, { alert: false }));
      }
    } catch { /* no devices table */ }
    // garbled text ("?" for Hebrew) in the mail ingested in the last 24 hours: what an ANSI-format .msg looks like
    try {
      const { garbledRatio, GARBLED } = require('./textclean');
      const rows = q('SELECT e.body_text FROM ingest_mail i JOIN emails e ON e.id=i.email_id WHERE i.created_at >= ? AND i.status IN (\'stored\',\'reingested\')').all(new Date(nowMs() - 24 * 3600000).toISOString());
      const bad = rows.filter((r) => garbledRatio(r.body_text) > GARBLED).length; const share = rows.length ? bad / rows.length : 0;
      out.push(R('ingest:garbled', 'Outlook: מיילים עם טקסט משובש (24 שעות)', share > 0.05 ? WARN : OK, rows.length ? `${bad} מתוך ${rows.length} (${Math.round(share * 100)}%)${share > 0.05 ? ': המחבר שומר ב-ANSI במקום Unicode?' : ''}` : 'אין מיילים', { alert: false }));
    } catch { /* no ingest tables */ }
    try { // names (files, people) that still carry "?" for Hebrew: they drop to zero once the connector re-pushes the mail
      const { nameGarbledRatio, GARBLED } = require('./textclean');
      const files = q('SELECT original_name FROM files').all().filter((f) => nameGarbledRatio(f.original_name) > GARBLED).length;
      const ppl = q('SELECT name_he FROM people').all().filter((p) => nameGarbledRatio(p.name_he) > 0.3).length;
      out.push(R('data:garblednames', 'שמות משובשים ("?") בקבצים ובאנשים', files + ppl ? WARN : OK, files + ppl ? `${files} קבצים, ${ppl} אנשים (יתוקנו כשהמחבר ישלח שוב את המיילים)` : 'אין', { alert: false }));
    } catch { /* ignore */ }
    // questions and proposal cards that should have reached Telegram: open for over an hour, outside quiet hours, no confirmed message id
    try {
      const quiet = o.isQuiet ? o.isQuiet(new Date(nowMs())) : false; const old = new Date(nowMs() - 3600000).toISOString();
      const waiting = q("SELECT COUNT(*) n FROM proposals WHERE status='open' AND kind IN ('bench_question','question','project_new','project_pick') AND tg_message_id IS NOT NULL").get().n; // while questions wait for an answer the rest are held back on purpose
      const qs = waiting ? 0 : q("SELECT COUNT(*) n FROM proposals WHERE status='open' AND kind IN ('bench_question','question','project_new','project_pick') AND created_at < ? AND tg_message_id IS NULL").get(old).n;
      const benchOpen = q("SELECT COUNT(*) n FROM proposals WHERE status='open' AND kind='bench_question'").get().n;
      const cards = benchOpen ? 0 : q("SELECT COUNT(*) n FROM proposal_batches b WHERE b.tg_sent=0 AND b.created_at < ? AND EXISTS (SELECT 1 FROM proposals p WHERE p.batch=b.id AND p.status='open')").get(old).n;
      const stuck = qs + cards;
      out.push(R('proposals:delivery', 'שאלות והצעות שלא הגיעו לטלגרם', stuck && !quiet ? WARN : OK, stuck ? `${stuck} פתוחות מעל שעה בלי אישור משלוח${quiet ? ' (שעות שקט)' : ''}` : 'הכול נמסר', { alert: false }));
    } catch { /* no proposals yet */ }
    // the original-view HTML of mails: Hebrew that came out as Latin letters (a wrong code page) is caught here
    try {
      const mv = require('./mailview'); const rows = q("SELECT email_id, html, state FROM email_html WHERE state IN (1,3) ORDER BY email_id DESC LIMIT 400").all();
      const bad = rows.filter((r) => r.state === 3 || mv.looksMojibake(r.html)).length;
      out.push(R('data:mailhtml', 'תצוגה מקורית של מיילים (קידוד עברית)', bad ? WARN : OK, bad ? `${bad} מיילים עם עברית משובשת בתצוגה המקורית (מוצג הטקסט במקומה)` : 'תקין', { alert: false }));
    } catch { /* no table yet */ }
    const appr = q("SELECT id, approved_at FROM outbox WHERE status='approved' AND approved_at < ?").all(new Date(nowMs() - 10 * 60000).toISOString());
    const send = q("SELECT id, claimed_at FROM outbox WHERE status='sending' AND claimed_at < ?").all(new Date(nowMs() - 10 * 60000).toISOString());
    out.push(R('outbox', 'מיילים יוצאים', send.length ? RED : appr.length ? WARN : OK, send.length ? `מייל ${send[0].id} בשליחה מעל 10 דקות בלי תוצאה: בדקו ב-Outlook לפני ניסיון נוסף` : appr.length ? `מייל ${appr[0].id} אושר לפני ${mins(age(appr[0].approved_at))} ועדיין לא נתבע (המחשב MAINPC כבוי?)` : 'אין פריטים תקועים'));
    return out;
  }

  // ---- 6. Telegram
  async function telegram() {
    const token = o.tgToken !== undefined ? o.tgToken : envVar('TELEGRAM_BOT_TOKEN'); if (!token) return [R('tg', 'טלגרם', OK, 'לא מוגדר', { alert: false })];
    const base = (o.tgBase !== undefined ? o.tgBase : envVar('TELEGRAM_API_BASE')) || 'https://api.telegram.org';
    let me = 'לא הצליח';
    try { const r = await doFetch(`${base.replace(/\/$/, '')}/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) }); const j = await r.json(); me = j.ok ? 'getMe תקין' : `getMe נכשל (${j.description || r.status})`; if (!j.ok) throw new Error(me); } catch (e) { return [R('tg', 'טלגרם', RED, `getMe נכשל: ${String(e.message).slice(0, 80)}`)]; }
    const p = age(q("SELECT at FROM heartbeat WHERE key='telegram_poll'").get()?.at);
    return [R('tg', 'טלגרם', p == null || p > 5 * 60000 ? RED : OK, `${me}; סקירה אחרונה לפני ${p == null ? '?' : mins(p)}`)];
  }

  // ---- 7. data
  function data() {
    const out = []; const dbFile = o.dbFile || process.env.MESIMOT_DB || path.join(__dirname, '..', 'data', 'mesimot.db');
    const lastCheck = getSet('health_quickcheck_at');
    if (!lastCheck || age(lastCheck) > 24 * 3600000) {
      let res = '?'; try { res = q('PRAGMA quick_check').all().map((r) => r.quick_check).join(',').slice(0, 80); } catch (e) { res = e.message; }
      setSet('health_quickcheck_at', new Date(nowMs()).toISOString()); setSet('health_quickcheck_res', res);
    }
    const res = getSet('health_quickcheck_res'); out.push(R('data:integrity', 'בסיס הנתונים: בדיקת שלמות (פעם ביום)', res === 'ok' ? OK : RED, res === 'ok' ? `תקין (נבדק ${new Date(getSet('health_quickcheck_at')).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })})` : `quick_check: ${res}`, { critical: true }));
    try { // the database file must be encrypted on disk (a plaintext header means the encryption was lost)
      if (fs.existsSync(dbFile)) { const plain = require('./dbkey').isPlainFile(dbFile); out.push(R('data:encrypted', 'הצפנת בסיס הנתונים בדיסק', plain ? RED : OK, plain ? 'הקובץ אינו מוצפן' : 'מוצפן (AES-256)', { critical: true })); }
    } catch { /* unreadable: the integrity check reports it */ }
    const bdir = o.backupDir || path.join(__dirname, '..', 'backups'); let newest = 0;
    try { for (const f of fs.readdirSync(bdir)) if (/^mesimot-.*\.db(\.gz)?$/.test(f)) newest = Math.max(newest, fs.statSync(path.join(bdir, f)).mtimeMs); } catch { /* none */ }
    const ba = newest ? nowMs() - newest : null; out.push(R('data:backup', 'גיבוי אחרון', ba == null || ba > 26 * 3600000 ? RED : OK, ba == null ? 'לא נמצא גיבוי' : `לפני ${Math.round(ba / 3600000)} שעות`));
    try { // the nightly encrypted copy on Proton Drive: red when the last run failed or there was no success for 36 hours; the owner is told once per outage
      const ost = require('./offsite').readStatus(db); const v = require('./offsite').verdict(ost, nowMs());
      if (v === null) out.push(R('data:offsite', 'גיבוי מוצפן ל-Proton Drive', OK, 'עדיין לא הופעל', { alert: false }));
      else out.push(R('data:offsite', 'גיבוי מוצפן ל-Proton Drive', v === 'ok' ? OK : RED, v === 'ok' ? `הצלחה אחרונה לפני ${Math.round((nowMs() - Date.parse(ost.last_success_at)) / 3600000)} שעות` : v, { once: true }));
    } catch { /* no settings table */ }
    try { const st = fs.statfsSync(path.dirname(dbFile)); const free = st.bavail / st.blocks; out.push(R('data:disk', 'מקום פנוי בדיסק', free < 0.05 ? RED : free < 0.1 ? WARN : OK, `${Math.round(free * 100)}% פנוי (${Math.round(st.bavail * st.bsize / 1e9)} GB)`)); } catch (e) { out.push(R('data:disk', 'מקום פנוי בדיסק', WARN, 'לא ניתן לבדוק', { alert: false })); }
    try {
      const size = fs.statSync(dbFile).size; const hist = JSON.parse(getSet('health_dbsize') || '[]').filter((x) => age(x.at) < 8 * 86400000); if (!hist.length || age(hist[hist.length - 1].at) > 20 * 3600000) { hist.push({ at: new Date(nowMs()).toISOString(), size }); setSet('health_dbsize', JSON.stringify(hist)); }
      const base = hist[0]; const grew = base && base.size ? size / base.size : 1;
      out.push(R('data:size', 'גודל בסיס הנתונים', grew > 2 && size > 200e6 ? WARN : OK, `${Math.round(size / 1e6)} MB${base ? ` (לפני ${Math.round(age(base.at) / 86400000)} ימים: ${Math.round(base.size / 1e6)} MB)` : ''}`, { alert: false }));
    } catch { /* in-memory database */ }
    return out;
  }

  // ---- MCP: one line, never an alert (docs/MCP.md): refusals the server gave to the assistant's tools in the last 24 hours
  function mcpLine() {
    const mode = require('./mcp/mode').getSwitch(db).value;
    const n = q("SELECT COUNT(*) n FROM mcp_errors WHERE at >= ?").get(new Date(nowMs() - 86400000).toISOString()).n;
    if (mode === 'off' && !n) return [];
    return [R('mcp:errors', 'MCP: שגיאות כלים ב-24 שעות', OK, `מצב: ${mode} · ${n} סירובים של השרת`, { alert: false })];
  }

  // ---- 8. anomalies
  function anomalies() {
    const out = []; const t = nowMs();
    const openN = q("SELECT COUNT(*) n FROM attention WHERE status='open'").get().n;
    const hist = JSON.parse(getSet('health_attention') || '[]').filter((x) => t - Date.parse(x.at) < 3 * 3600000); hist.push({ at: new Date(t).toISOString(), n: openN }); setSet('health_attention', JSON.stringify(hist.slice(-40)));
    const ref = hist.filter((x) => t - Date.parse(x.at) >= 50 * 60000).pop() || null; const jump = ref ? openN - ref.n : 0;
    out.push(R('anom:attention', 'פריטי תשומת לב פתוחים', jump >= 30 ? WARN : OK, jump >= 30 ? `קפצו ב-${jump} בשעה האחרונה (עכשיו ${openN})` : `${openN} פתוחים`));
    const day = (d) => q("SELECT COALESCE(SUM(cost_usd),0) c FROM run_usage WHERE substr(at,1,10)=?").get(d).c; const iso = (n) => new Date(t - n * 86400000).toISOString().slice(0, 10);
    const today = day(iso(0)); const prev = [...Array(14)].map((_, i) => day(iso(i + 1))).filter((x) => x > 0); const avg = prev.length >= 3 ? prev.reduce((a, x) => a + x, 0) / prev.length : 0;
    out.push(R('anom:cost', 'עלות יומית', avg && today > 8 && today > 2 * avg ? WARN : OK, `היום $${today.toFixed(1)}${avg ? ` (ממוצע 14 ימים $${avg.toFixed(1)})` : ''}`, { alert: false })); // the runner already tells the owner
    const locks = (() => { try { return q('SELECT COUNT(*) n FROM db_lock_events WHERE at >= ?').get(new Date(t - 3600000).toISOString()).n; } catch { return 0; } })();
    out.push(R('anom:dblock', 'נעילות בסיס הנתונים (שעה אחרונה)', locks > 5 ? RED : locks > 0 ? WARN : OK, locks ? `${locks} נעילות (SQLITE_BUSY) בשעה האחרונה` : 'אין'));
    const failed = q("SELECT COUNT(*) n FROM chat_messages WHERE tg_sent=2 AND created_at >= ?").get(new Date(t - 3600000).toISOString()).n;
    out.push(R('anom:chatsend', 'הודעות שלא נשלחו לטלגרם', failed ? WARN : OK, failed ? `${failed} הודעות נכשלו בשליחה בשעה האחרונה` : 'אין'));
    return out;
  }

  // ---- persistence and alerts
  function persist(r) {
    const prev = q('SELECT * FROM health WHERE check_id=?').get(r.id); const at = new Date(nowMs()).toISOString();
    const since = prev && prev.status === r.status ? prev.since : at;
    q(`INSERT INTO health (check_id, label, status, message, at, since, critical, ms, alerted_at, alert_status) VALUES (?,?,?,?,?,?,?,?,NULL,NULL)
       ON CONFLICT(check_id) DO UPDATE SET label=excluded.label, status=excluded.status, message=excluded.message, at=excluded.at, since=excluded.since, critical=excluded.critical, ms=excluded.ms`).run(r.id, r.label, r.status, r.message, at, since, r.critical ? 1 : 0, r.ms);
    return prev;
  }
  async function alertAll(results, prevMap) {
    const quiet = o.isQuiet ? o.isQuiet(new Date(nowMs())) : false; const sent = [];
    // a deploy restarts the services for ~1 minute: scripts/deploy.sh writes data/.deploying, and no alert goes out while it is fresh (the results are still recorded)
    try { const f = require('path').join(__dirname, '..', 'data', '.deploying'); if (nowMs() - require('fs').statSync(f).mtimeMs < 10 * 60000) return sent; } catch { /* no deploy running */ }
    for (const r of results) {
      const row = q('SELECT * FROM health WHERE check_id=?').get(r.id); const prev = prevMap.get(r.id);
      if (r.status === RED && r.alert) {
        const due = !row.alerted_at || (row.alert_status === 'recovered') || (!r.once && nowMs() - Date.parse(row.alerted_at) >= RENOTIFY_MS); // r.once: told once per outage (the off-site backup)
        if (!due || (quiet && !r.critical)) continue; // quiet hours hold back non-critical issues; a site down or a broken list alerts anytime
        const text = `⚠️ ${row.alerted_at && row.alert_status === 'red' ? 'עדיין תקלה' : 'תקלה'} במערכת Alex Tasks: ${r.label}\n${r.message}`;
        try { const via = await (o.tell || (async () => 'none'))(text, { preferEmail: r.id === 'tg' }); q("UPDATE health SET alerted_at=?, alert_status='red' WHERE check_id=?").run(new Date(nowMs()).toISOString(), r.id); sent.push({ id: r.id, via }); } catch (e) { log('health: alert failed:', e.message); }
      } else if (r.status !== RED && prev && prev.alert_status === 'red' && prev.alerted_at) {
        if (quiet && !r.critical) { q("UPDATE health SET alerted_at=?, alert_status='red' WHERE check_id=?").run(prev.alerted_at, r.id); continue; }
        try { await (o.tell || (async () => 'none'))(`✅ חזר לפעול: ${r.label}`); q("UPDATE health SET alert_status='recovered' WHERE check_id=?").run(r.id); sent.push({ id: r.id, recovered: true }); } catch (e) { log('health: recovery notice failed:', e.message); }
      }
    }
    return sent;
  }

  // quick: the UI smoke test plus the APIs (the post-deploy gate). Full: everything.
  async function run({ quick = false, alert = true } = {}) {
    const results = [];
    const add = async (fn) => { try { results.push(...(await fn())); } catch (e) { results.push(R('health:internal', 'בודק המערכת', WARN, 'שגיאה פנימית בבדיקה: ' + String(e.message).slice(0, 120), { alert: false })); } };
    if (quick) { await add(ui); await add(apis); }
    else { await add(services); selfHeal(results); await add(ui); await add(apis); await add(pipeline); await add(archiveCheck); await add(mail); await add(telegram); await add(data); await add(anomalies); await add(mcpLine); }
    const prevMap = new Map(q('SELECT * FROM health').all().map((r) => [r.check_id, r]));
    for (const r of results) persist(r);
    const alerts = alert && !quick ? await alertAll(results, prevMap) : [];
    const bad = results.filter((r) => r.status !== OK);
    // the post-deploy gate (quick) fails on a CRITICAL red (the site, the list, login, tasks); the mirror or a slow API alone does not roll a deploy back
    return { ok: !results.some((r) => r.status === RED && (!quick || r.critical)), results, problems: bad, alerts };
  }
  // the morning one-liner
  function summary() {
    const rows = q('SELECT * FROM health').all(); if (!rows.length) return null;
    const stale = rows.filter((r) => age(r.at) > 3 * 3600000);
    const bad = rows.filter((r) => r.status !== OK && age(r.at) <= 3 * 3600000);
    if (stale.length === rows.length) return 'בדיקת המערכת לא רצה בשלוש השעות האחרונות';
    return bad.length ? `בעיות במערכת: ${bad.slice(0, 5).map((r) => `${r.label} (${r.message.slice(0, 60)})`).join(' · ')}` : 'כל המערכות תקינות';
  }
  const status = () => q('SELECT check_id id, label, status, message, at, since, critical, ms FROM health ORDER BY CASE status WHEN \'red\' THEN 0 WHEN \'warn\' THEN 1 ELSE 2 END, check_id').all();
  return { run, summary, status, services, ui, apis, pipeline, archiveCheck, mail, telegram, data, anomalies, SERVICES, TIMERS };
}
module.exports = { createHealth, SERVICES, TIMERS };
