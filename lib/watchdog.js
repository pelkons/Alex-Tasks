'use strict';
// Watchdog (separate oneshot job, every 5 minutes): checks the services, the runner's heartbeats and the site.
// A failing service is restarted once; if it still fails at the next check the owner is told (at most once per 2 hours per service,
// with a recovery notice later). Everything that touches the outside world is injectable, so tests use fakes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { now } = require('./db');
const hb = require('./heartbeat');

const SERVICES = { mesimot: 'האתר', 'mesimot-runner': 'הרצה ודואר', 'mesimot-tunnel': 'גישה מבחוץ', 'mesimot-botapi': 'שרת טלגרם מקומי (קבצים גדולים)', 'proton-bridge': 'Proton Mail Bridge' };
const LIMITS = { loop_ms: 2 * 60000, mail_ms: 10 * 60000, telegram_ms: 5 * 60000, stuck_ms: 15 * 60000, alert_gap_ms: 2 * 3600000 };
const ENV_FILE = process.env.MESIMOT_ENV_FILE || path.join(os.homedir(), '.config', 'mesimot', 'env');

function envVar(name) {
  if (process.env[name]) return process.env[name];
  try { const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm').exec(fs.readFileSync(ENV_FILE, 'utf8')); return m ? m[1].replace(/^["']|["']$/g, '') : ''; } catch { return ''; }
}
function envToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try { const m = /^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.*?)\s*$/m.exec(fs.readFileSync(ENV_FILE, 'utf8')); return m ? m[1].replace(/^["']|["']$/g, '') : ''; } catch { return ''; }
}

function defaultSystemctl(args) {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 30000 });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim() };
}
// children of the runner (the running `claude`): killed when a run is stuck
function defaultKillChildren(systemctl) {
  const pid = +(systemctl(['show', '-p', 'MainPID', '--value', 'mesimot-runner']).stdout || 0);
  if (!pid) return 0;
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  let n = 0;
  for (const c of (r.stdout || '').split('\n').map(Number).filter(Boolean)) { try { process.kill(c, 'SIGKILL'); n++; } catch { /* gone */ } }
  return n;
}

function createWatchdog(db, store, o = {}) {
  const systemctl = o.systemctl || defaultSystemctl;
  const doFetch = o.fetch || fetch;
  const localUrl = o.localUrl ?? `http://127.0.0.1:${process.env.MESIMOT_PORT || 8110}`;
  const publicUrl = o.publicUrl ?? require('./config').get().public_url;
  const noSystemd = o.noSystemd ?? process.env.MESIMOT_NO_SYSTEMD === '1';
  const token = () => (o.token !== undefined ? o.token : envToken());
  const q = (sql) => db.prepare(sql);
  const log = o.log || (() => {});
  const record = (action, detail) => q('INSERT INTO housekeeping_log (at, action, detail) VALUES (?,?,?)').run(now(), action, String(detail).slice(0, 500));

  async function probe(url, okCodes) {
    try {
      const res = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      return okCodes.includes(res.status) ? { ok: true, detail: String(res.status) } : { ok: false, detail: `קוד ${res.status}` };
    } catch (e) { return { ok: false, detail: 'אין תשובה' }; }
  }
  const age = (key, at, startKey = 'runner_start') => {
    const a = hb.ageMs(db, key, at);
    if (a != null) return a;
    const s = hb.ageMs(db, startKey, at); // never beat since the runner started: count from its start
    return s;
  };
  const mins = (ms) => `${Math.max(0, Math.round(ms / 60000))} דק׳`;

  // read-only: every component with its state. `service` is what a restart would fix.
  async function check(at = Date.now()) {
    const out = [];
    const add = (id, label, service, ok, detail) => out.push({ id, label, service, ok: !!ok, detail });
    // the local Bot API server exists only once the bot was switched to it (TELEGRAM_API_BASE); until then the cloud API is used
    const botapiBase = o.botapiBase !== undefined ? o.botapiBase : envVar('TELEGRAM_API_BASE');
    const imap = o.imap !== undefined ? o.imap : (require('./mail').settings().MAIL_PROVIDER || '').toLowerCase() === 'imap';
    const watched = Object.entries(SERVICES).filter(([svc]) => (svc !== 'mesimot-botapi' || botapiBase) && (svc !== 'proton-bridge' || imap));
    if (!noSystemd) for (const [svc, label] of watched) {
      const r = systemctl(['is-active', svc]);
      add(`svc:${svc}`, `שירות: ${label}`, svc, r.stdout === 'active', r.stdout || 'לא פעיל');
    }
    const local = localUrl ? await probe(localUrl + '/healthz', [200]) : { ok: true, detail: 'דולג' };
    add('site', 'האתר (מקומי)', 'mesimot', local.ok, local.detail);
    if (publicUrl) { const pub = await probe(publicUrl, [200, 302]); add('public', 'כתובת האתר ברשת', local.ok ? 'mesimot-tunnel' : 'mesimot', pub.ok, pub.detail); }
    if (botapiBase) {
      const r = await probe(botapiBase.replace(/\/$/, '') + '/', [200, 301, 302, 400, 401, 404]);
      add('botapi', 'שרת טלגרם מקומי', 'mesimot-botapi', r.ok, r.ok ? 'עונה (קבצים עד 2 ג״ב)' : 'לא עונה, הבוט עובר זמנית ל-20 מ״ב');
    }
    // Proton Bridge: the service is up and the assistant's IMAP account accepts the login (a failure restarts the Bridge, not the runner)
    let bridgeBad = false;
    if (imap) {
      let ok = true, detail = 'התחברות תקינה';
      try { await (o.mailPing || (() => require('./mail').get().ping()))(); } catch (e) { ok = false; detail = 'ההתחברות ל-IMAP נכשלה'; }
      bridgeBad = !ok || out.some((c) => c.id === 'svc:proton-bridge' && !c.ok);
      add('bridge_login', 'Bridge: התחברות לתיבת אלכס', 'proton-bridge', ok, detail);
    }
    const loop = age('loop', at);
    add('loop', 'לולאת ההרצה', 'mesimot-runner', loop != null && loop < LIMITS.loop_ms, loop == null ? 'אין פעימה' : `פעימה לפני ${mins(loop)}`);
    const mail = age('mail_poll', at);
    add('mail', 'קליטת דואר', bridgeBad ? 'proton-bridge' : 'mesimot-runner', mail != null && mail < LIMITS.mail_ms, mail == null ? 'אין פעימה' : `הצלחה לפני ${mins(mail)}`);
    if (token()) {
      const tg = age('telegram_poll', at);
      add('telegram', 'טלגרם', 'mesimot-runner', tg != null && tg < LIMITS.telegram_ms, tg == null ? 'אין פעימה' : `הצלחה לפני ${mins(tg)}`);
    }
    const stuck = q("SELECT id, trigger, started_at FROM claude_runs WHERE finished_at IS NULL AND started_at < ? ORDER BY id").all(new Date(at - LIMITS.stuck_ms).toISOString());
    add('claude', 'הרצת Claude', 'mesimot-runner', stuck.length === 0, stuck.length ? `הרצה ${stuck[0].id} תקועה מעל 15 דק׳` : 'תקין');
    out.stuck = stuck;
    return out;
  }

  // ---- delivery of alerts: Telegram, or email when Telegram is the problem (or fails)
  async function sendTelegram(text) {
    const chatId = q("SELECT value FROM settings WHERE key='telegram_chat_id'").get()?.value;
    if (!token() || !chatId) throw new Error('telegram not configured');
    const res = await doFetch(`https://api.telegram.org/bot${token()}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram: ${j.description || res.status}`);
  }
  async function sendEmail(subject, text) {
    const to = store.listPeople().find((p) => p.role === 'owner')?.emails[0];
    if (!to) throw new Error('no owner address');
    await (o.sendEmail || require('./email').sendOwnerEmail)(db, { to, subject, text });
  }
  async function tell(text, { preferEmail = false } = {}) {
    const viaTelegram = o.sendTelegram || sendTelegram;
    const viaEmail = o.sendEmailText || ((t) => sendEmail('התראת מערכת: מסימות', t));
    if (!preferEmail) { try { await viaTelegram(text); return 'telegram'; } catch (e) { log('watchdog: telegram alert failed:', e.message); } }
    await viaEmail(text);
    return 'email';
  }

  // one full pass: act on what `check` found
  async function run(at = Date.now()) {
    const comps = await check(at);
    const actions = [];
    // a stuck claude run: kill it and mark it interrupted (no restart needed)
    for (const r of comps.stuck || []) {
      const killed = (o.killChildren || (() => defaultKillChildren(systemctl)))();
      q("UPDATE claude_runs SET finished_at=?, error='interrupted' WHERE id=? AND finished_at IS NULL").run(now(), r.id);
      record('watchdog', `claude run ${r.id} (${r.trigger}) stuck since ${r.started_at}: killed ${killed}, marked interrupted`);
      actions.push({ stuck_run: r.id, killed });
    }
    const bySvc = {};
    for (const c of comps) if (c.id !== 'claude') (bySvc[c.service] ||= []).push(c);
    const quiet = o.isQuiet ? o.isQuiet(new Date(at)) : false;
    for (const [svc, list] of Object.entries(bySvc)) {
      const failing = list.filter((c) => !c.ok);
      const st = q('SELECT * FROM watchdog_state WHERE service=?').get(svc);
      if (!failing.length) {
        if (st) {
          q('DELETE FROM watchdog_state WHERE service=?').run(svc);
          if (st.alerted && !quiet) { try { await tell(`✅ ${SERVICES[svc] || svc} חזר לפעול.`); actions.push({ svc, recovered: true }); } catch (e) { log('watchdog: recovery notice failed:', e.message); } }
        }
        continue;
      }
      const detail = failing.map((c) => `${c.label}: ${c.detail}`).join('; ');
      if (!st) {
        q('INSERT INTO watchdog_state (service, failing_since, restarts, detail) VALUES (?,?,1,?)').run(svc, now(), detail);
        const r = systemctl(['restart', svc]);
        record('watchdog', `${svc} failing (${detail}): restarted (exit ${r.code})`);
        actions.push({ svc, restarted: true });
        continue;
      }
      q('UPDATE watchdog_state SET detail=? WHERE service=?').run(detail, svc);
      // still failing after the one restart: tell the owner, at most once per 2 hours
      if (st.last_alert_at && at - Date.parse(st.last_alert_at) < LIMITS.alert_gap_ms) continue;
      if (quiet) continue;
      const telegramIsIt = failing.some((c) => c.id === 'telegram');
      const text = `⚠️ תקלה במערכת המשימות: ${SERVICES[svc] || svc} לא חזר לפעול גם אחרי הפעלה מחדש.\n${failing.map((c) => `• ${c.label}: ${c.detail}`).join('\n')}`;
      try {
        const via = await tell(text, { preferEmail: telegramIsIt });
        q('UPDATE watchdog_state SET last_alert_at=?, alerted=1 WHERE service=?').run(new Date(at).toISOString(), svc);
        record('watchdog', `${svc} still failing: owner alerted by ${via}`);
        actions.push({ svc, alerted: via });
      } catch (e) { record('watchdog', `${svc} still failing, alert could not be sent: ${e.message}`); }
    }
    try { const ing = await checkIngest(at); if (ing.alerted || ing.recovered) actions.push({ ingest: ing }); } catch (e) { log('watchdog: ingest check failed:', e.message); }
    return { components: comps.map(({ id, label, ok, detail }) => ({ id, label, ok, detail })), actions };
  }

  // the Outlook connector: during working hours (Sun-Thu 08-19, Asia/Jerusalem) it contacts the server every ~10 minutes; 2 hours of silence is told ONCE per outage
  const INGEST_SILENCE_MS = 2 * 3600000;
  const workHours = (at) => { const { dow, minutes } = require('./notify').jerusalemParts(new Date(at)); return dow >= 0 && dow <= 4 && minutes >= 8 * 60 && minutes < 19 * 60; };
  async function checkIngest(at = Date.now()) {
    const last = q("SELECT value FROM settings WHERE key='ingest_last_contact'").get()?.value;
    if (!last) return { skipped: 'never connected' };
    const alerted = q("SELECT value FROM settings WHERE key='ingest_alerted_for'").get()?.value;
    const silent = at - Date.parse(last);
    if (silent < INGEST_SILENCE_MS) { if (alerted) { q("DELETE FROM settings WHERE key='ingest_alerted_for'").run(); try { await tell('✅ המחשב MAINPC חזר לשלוח מיילים.'); } catch (e) { log('watchdog: ingest recovery notice failed:', e.message); } return { recovered: true }; } return { ok: true }; }
    if (!workHours(at) || alerted === last) return { skipped: alerted === last ? 'already alerted' : 'outside work hours' };
    const hhmm = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(last));
    try { await tell(`⚠️ המחשב MAINPC לא שלח מיילים מאז ${hhmm} (${Math.round(silent / 3600000)} שעות). בדקו שהמחשב דלוק ושהמחבר רץ.`); } catch (e) { record('watchdog', `ingest silent, alert could not be sent: ${e.message}`); return { error: e.message }; }
    q("INSERT INTO settings (key,value) VALUES ('ingest_alerted_for',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(last);
    record('watchdog', `Outlook connector silent since ${last}: owner alerted`);
    return { alerted: true };
  }

  return { check, run, checkIngest, tell };
}

module.exports = { createWatchdog, SERVICES, LIMITS };
