'use strict';
// Telegram bot: the owner's second window into the shared chat. Long polling (no webhook, no open ports), only the owner's chat id.
// The bot token is read from ~/.config/mesimot/env (TELEGRAM_BOT_TOKEN) and never stored anywhere else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { now } = require('./db');
const { todayIL } = require('./store');
const heartbeat = require('./heartbeat');

const API = 'https://api.telegram.org';
const MB = 1024 * 1024;
const CLOUD_MAX = 20 * MB;      // what the public Bot API lets a bot download
const LOCAL_MAX = 2000 * MB;    // the local Bot API server (tdlib, --local) serves files up to 2 GB
const LOCAL_PREFIX = process.env.TELEGRAM_LOCAL_PREFIX || '/var/lib/telegram-bot-api';
const LOCAL_DIR = process.env.TELEGRAM_LOCAL_DIR || path.join(__dirname, '..', 'data', 'botapi');
const siteBase = (db) => require('./config').siteUrl(db);

const he = {
  start: 'שלום! אני אלכס, העוזר שלך. כתבו לי כאן כמו באתר: הוראות, שאלות, קבצים והקלטות קוליות בעברית.\nפקודות: /today להיום, /urgent לדחוף, /open למשימות פתוחות, /s לחיפוש באינטרנט (למשל: /s מה שעון הקיץ בישראל 2027).',
  notBound: 'הבוט עדיין לא חובר. יש להריץ באתר או בשרת את הפקודה לחיבור.',
  bound: 'החיבור הושלם. מעכשיו אני עונה רק לך.',
  bigFile: (limitMb, siteMb) => (limitMb >= 1000
    ? `הקובץ גדול מ־${(limitMb / 1000).toLocaleString('he-IL')} ג״ב, וטלגרם לא מאפשרת להעביר קבצים גדולים יותר. אפשר להעלות אותו דרך האתר (עד ${(siteMb / 1024).toLocaleString('he-IL')} ג״ב).`
    : `הקובץ גדול מ־${limitMb} מ״ב, ולכן טלגרם לא מאפשרת לבוט לקבל אותו. אפשר להעלות אותו דרך האתר (עד ${siteMb >= 1024 ? (siteMb / 1024).toLocaleString('he-IL') + ' ג״ב' : siteMb + ' מ״ב'}).`),
  fileFail: 'לא הצלחתי לשמור את הקובץ. נסו שוב.',
  voiceFail: 'לא הצלחתי לזהות את ההקלטה. נסו שוב או כתבו.',
  heard: 'שמעתי',
  none: 'אין משימות להצגה.',
  done: 'סומן כהושלם',
  snoozed: 'נדחה למחר',
  failed: 'הפעולה נכשלה',
};

const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

function createTelegram({ db, store, knowledge, chat, token, fetchImpl = fetch, whisper, log = () => {}, filesDir, notify = null, apiBase = process.env.TELEGRAM_API_BASE || '', chatEdit = null, confirmations = null, taskdel = null }) {
  const q = (sql) => db.prepare(sql);
  const getSet = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
  const setSet = (k, v) => q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const delSet = (k) => q('DELETE FROM settings WHERE key=?').run(k);
  const ownerChat = () => getSet('telegram_chat_id');

  // A local Bot API server (apiBase, e.g. http://127.0.0.1:8081) lifts the file limit from 20 MB to 2 GB. When it is down the bot
  // falls back to the public API (20 MB) for a minute at a time, and the watchdog restarts the local server.
  let localDownUntil = 0;
  const localConfigured = !!apiBase && apiBase.replace(/\/$/, '') !== API;
  const localActive = () => localConfigured && Date.now() > localDownUntil;
  const base = () => (localActive() ? apiBase.replace(/\/$/, '') : API);
  const maxFile = () => (localActive() ? Math.min(LOCAL_MAX, (+getSet('telegram_max_mb') || 2000) * MB) : CLOUD_MAX);
  const siteMb = () => Math.round(knowledge.maxFileBytes() / MB);
  async function call(method, body = {}, signal) {
    let res;
    try { res = await fetchImpl(`${base()}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }); }
    catch (e) {
      if (localActive() && !(e && e.name === 'AbortError')) { localDownUntil = Date.now() + 60000; log('telegram: the local Bot API server does not answer, using the public API (20 MB limit) for a minute'); return call(method, body, signal); }
      throw e;
    }
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description || res.status}`);
    return j.result;
  }
  // returns { buffer } (public API) or { path } (local server: the file already sits on this machine's disk)
  async function download(fileId, knownSize) {
    if (knownSize && knownSize > maxFile()) { const e = new Error('big'); e.big = true; throw e; }
    const f = await call('getFile', { file_id: fileId });
    if (f.file_size && f.file_size > maxFile()) { const e = new Error('big'); e.big = true; throw e; }
    if (localActive() && path.isAbsolute(f.file_path)) {
      const host = f.file_path.startsWith(LOCAL_PREFIX) ? path.join(LOCAL_DIR, f.file_path.slice(LOCAL_PREFIX.length)) : f.file_path;
      if (!fs.existsSync(host)) throw new Error('local file missing: ' + host);
      return { path: host, file_path: f.file_path };
    }
    const res = await fetchImpl(`${API}/file/bot${token}/${f.file_path}`);
    if (!res.ok) throw new Error('download failed');
    return { buffer: Buffer.from(await res.arrayBuffer()), file_path: f.file_path };
  }
  const say = (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra });

  // ---- binding: the owner proves it is him with a one-time code created on the server
  function createBindCode() {
    const code = 'B' + crypto.randomBytes(4).toString('hex');
    setSet('telegram_bind', JSON.stringify({ code, expires: Date.now() + 10 * 60 * 1000 }));
    return code;
  }
  function tryBind(text, chatId) {
    // accepts "/start CODE" (deep link) or a message that is just the code
    const m = /^(?:\/start\s+)?(\S+)\s*$/.exec((text || '').trim());
    if (!m) return false;
    const b = JSON.parse(getSet('telegram_bind') || 'null');
    if (!b || b.expires < Date.now() || b.code !== m[1]) return false;
    setSet('telegram_chat_id', chatId); delSet('telegram_bind');
    q('UPDATE chat_messages SET tg_sent=1').run(); // do not replay the old history into Telegram
    return true;
  }

  // ---- commands answered by code (no assistant run)
  const taskLine = (t) => `• ${t.title}${t.requester ? ' · מאת ' + t.requester : ''}${t.due_date ? ' · עד ' + fmtDate(t.due_date) + (t.due_source === 'estimated' ? ' (משוער)' : '') : ''}\n${siteBase(db)}/task/${t.id}`;
  function command(cmd) {
    const today = todayIL();
    if (cmd === '/today') {
      const rows = store.listTasks({ open: '1' }).filter((t) => t.due_date && t.due_date <= today);
      return rows.length ? 'להיום ובאיחור:\n\n' + rows.slice(0, 15).map((t) => (t.due_date < today ? '⚠️ ' : '') + taskLine(t)).join('\n\n') : 'אין משימות להיום או באיחור.';
    }
    if (cmd === '/urgent') {
      const rows = store.listTasks({ open: '1', priority: 'דחוף' });
      return rows.length ? 'דחוף:\n\n' + rows.slice(0, 15).map(taskLine).join('\n\n') : 'אין משימות דחופות.';
    }
    if (cmd === '/open') {
      const rows = store.listTasks({ open: '1' });
      return rows.length ? `משימות פתוחות: ${rows.length}\n\n` + rows.slice(0, 12).map(taskLine).join('\n\n') : he.none;
    }
    return null;
  }

  // ---- incoming
  function ownerMessage(text, files, extra = {}) {
    return chat.sendChat(store.ownerId(), { text, file_ids: files }, { channel: 'telegram', ...extra });
  }

  async function onMessage(m) {
    const chatId = String(m.chat.id);
    if (!ownerChat()) { if (tryBind(m.text, chatId)) await say(chatId, he.bound); return; }
    if (chatId !== ownerChat()) return; // strangers get no answer at all
    if (m.text) {
      const cmd = /^\/(\w+)/.exec(m.text);
      if (cmd) {
        const name = '/' + cmd[1].toLowerCase();
        if (name === '/start' || name === '/help') return void (await say(chatId, he.start));
        const out = command(name);
        if (out !== null) return void (await say(chatId, out));
      }
      // /s@botname question (the form Telegram uses in groups) is the same as /s question
      return void ownerMessage(m.text.replace(/^\/s@\w+/i, '/s'), [], { telegram_message_id: m.message_id });
    }
    if (m.voice || m.audio || m.video_note) return onVoice(m, chatId);
    if (m.photo || m.document) return onFile(m, chatId);
  }

  async function onVoice(m, chatId) {
    const v = m.voice || m.audio || m.video_note;
    let dl;
    try { dl = await download(v.file_id, v.file_size); } catch (e) { return void (await say(chatId, e.big ? he.bigFile(Math.round(maxFile() / MB), siteMb()) : he.voiceFail)); }
    const dir = path.join(filesDir || path.join(__dirname, '..', 'files'), 'voice');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${m.message_id}${path.extname(dl.file_path) || '.oga'}`);
    if (dl.path) fs.copyFileSync(dl.path, file); else fs.writeFileSync(file, dl.buffer);
    let heard = null;
    try { heard = await whisper.transcribe(file); } catch (e) { log('whisper failed:', e.message); }
    const text = heard && typeof heard === 'object' ? String(heard.text || '').trim() : String(heard || '').trim();
    if (!text) return void (await say(chatId, he.voiceFail));
    // no "what I heard" message: the assistant's reply is the answer. The language stays internal (it only picked the model).
    ownerMessage(text, [], { telegram_message_id: m.message_id, voice_file: file, transcript: text, lang: heard && heard.language ? heard.language : null });
  }

  async function onFile(m, chatId) {
    const d = m.document;
    const photo = m.photo ? m.photo[m.photo.length - 1] : null;
    const fileId = d ? d.file_id : photo.file_id;
    let dl;
    try { dl = await download(fileId, d?.file_size || photo?.file_size); } catch (e) { return void (await say(chatId, e.big ? he.bigFile(Math.round(maxFile() / MB), siteMb()) : he.fileFail)); }
    const name = d?.file_name || `photo-${new Date().toISOString().slice(0, 10)}-${m.message_id}${path.extname(dl.file_path) || '.jpg'}`;
    let saved;
    try {
      const o = { name, mime: d?.mime_type || (photo ? 'image/jpeg' : null), source: 'telegram' };
      saved = dl.path ? await knowledge.saveUploadFromPath(store.ownerId(), { ...o, file: dl.path }) : await knowledge.saveUpload(store.ownerId(), { ...o, buffer: dl.buffer });
    } catch (e) { return void (await say(chatId, /גדול מדי/.test(e.message) ? e.message : he.fileFail)); }
    ownerMessage(m.caption || '', [saved.id], { telegram_message_id: m.message_id });
    if (saved.text_status === 'unsupported') await say(chatId, `הקובץ "${saved.original_name}" נשמר, אך לא ניתן היה לקרוא את תוכנו.`);
  }

  async function onCallback(cb) {
    const chatId = String(cb.message?.chat?.id || '');
    if (!ownerChat() || chatId !== ownerChat()) return;
    const [act, idStr] = String(cb.data || '').split(':');
    const id = +idStr;
    try {
      // confirmations of destructive actions: "כן, למחוק" / "לא", and a 30-second "בטל" after a deletion
      if (act === 'cfy' || act === 'cfn') {
        if (!confirmations) return;
        const r = confirmations.answer(store.ownerId(), id, act === 'cfy');
        if (r.status === 'yes' && r.result && r.result.token) {
          await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'נמחקה לצמיתות' });
          await say(chatId, `נמחקה לצמיתות: ${r.result.title}`, { reply_markup: { inline_keyboard: [[{ text: 'בטל (30 שניות)', callback_data: `cfu:${r.result.token}` }]] } });
        } else await call('answerCallbackQuery', { callback_query_id: cb.id, text: r.status === 'no' ? 'בסדר, לא נמחק' : (r.error || 'בוצע') });
        return;
      }
      if (act === 'cfu') {
        try { const r = taskdel.restore(store.ownerId(), idStr); await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'המחיקה בוטלה' }); await say(chatId, `שוחזרה: ${r.title}`); }
        catch (e) { await call('answerCallbackQuery', { callback_query_id: cb.id, text: e.message }); }
        return;
      }
      if (act === 'done') {
        const st = q('SELECT id FROM statuses WHERE is_done=1 ORDER BY sort LIMIT 1').get();
        store.updateTask(store.ownerId(), id, { status: st.id });
        await call('answerCallbackQuery', { callback_query_id: cb.id, text: he.done });
      } else if (act === 'snooze') {
        const d = new Date(); d.setDate(d.getDate() + 1);
        store.updateTask(store.ownerId(), id, { due_date: todayIL(d) });
        await call('answerCallbackQuery', { callback_query_id: cb.id, text: he.snoozed });
      } else if (act === 'fbup' || act === 'fbdown') {
        const fb = require('./feedback').createFeedback({ db, store });
        fb.record(store.ownerId(), { item_type: 'task', item_id: id, verdict: act === 'fbup' ? 'up' : 'down', reason: act === 'fbdown' ? 'לא מועיל (טלגרם)' : null });
        await call('answerCallbackQuery', { callback_query_id: cb.id, text: act === 'fbup' ? 'תודה' : 'נשמר. אפשר לתקן באתר' });
      } else return;
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: '👁 פתח באתר', url: `${siteBase(db)}/task/${id}` }]] } }).catch(() => {});
    } catch (e) { await call('answerCallbackQuery', { callback_query_id: cb.id, text: he.failed }).catch(() => {}); }
  }

  // the owner edited a message in Telegram: the same as an edit on the web (undo what it caused, re-think, reply to the edited message)
  async function onEdited(m) {
    if (!chatEdit || !m.text || String(m.chat.id) !== ownerChat()) return;
    const row = q("SELECT id, text FROM chat_messages WHERE author='owner' AND telegram_message_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(m.message_id);
    if (!row || row.text === m.text) return;
    const out = chatEdit.edit(store.ownerId(), row.id, m.text);
    log(`telegram: message ${row.id} edited (${out.undone} actions undone)`);
  }
  async function handleUpdate(u) {
    try {
      if (u.edited_message) await onEdited(u.edited_message);
      else if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) { log('telegram update failed:', e.message); }
  }

  // ---- outgoing: assistant messages -> Telegram, with quick buttons for the tasks they mention
  async function deliverPending() {
    const chatId = ownerChat();
    if (!chatId) return 0;
    if (notify && !notify.settings().notify_telegram) return 0;
    const quiet = !!notify && notify.isQuiet();
    let rows = q("SELECT * FROM chat_messages WHERE author='claude' AND tg_sent=0 AND deleted_at IS NULL AND superseded=0 ORDER BY id LIMIT 10").all();
    // quiet hours and Shabbat hold back what the assistant wrote on its own; answers to a message the owner just sent still go out
    if (quiet) rows = rows.filter((r) => q("SELECT 1 FROM chat_messages WHERE author='owner' AND id < ? AND created_at > ?").get(r.id, new Date(Date.parse(r.created_at) - 10 * 60000).toISOString()));
    let n = 0;
    for (const r of rows) {
      const m = chat.decorate(r);
      const text = [(m.web ? '🌐 ' : '') + r.text, ...m.files.map((f) => '📎 ' + f.name)].filter(Boolean).join('\n');
      const rows2 = m.tasks.slice(0, 3).map((t) => [
        { text: '✔ הושלם', callback_data: `done:${t.id}` }, { text: '⏰ דחה למחר', callback_data: `snooze:${t.id}` }, { text: '👁 פתח באתר', url: `${siteBase(db)}/task/${t.id}` }, { text: '👍', callback_data: `fbup:${t.id}` }, { text: '👎', callback_data: `fbdown:${t.id}` }]);
      try {
        const replyTo = r.after_id ? q('SELECT telegram_message_id t FROM chat_messages WHERE id=?').get(r.after_id)?.t : null;
        const cf = m.confirm && m.confirm.status === 'open' ? [[{ text: 'כן, למחוק', callback_data: `cfy:${m.confirm.id}` }, { text: 'לא', callback_data: `cfn:${m.confirm.id}` }]] : null;
        const sent = await say(chatId, text, { ...(cf ? { reply_markup: { inline_keyboard: cf } } : {}), ...(rows2.length ? { reply_markup: { inline_keyboard: rows2 } } : {}), ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}) });
        q('UPDATE chat_messages SET tg_sent=1, telegram_message_id=? WHERE id=?').run(sent.message_id, r.id);
        n++;
      } catch (e) { log('telegram send failed:', e.message); q('UPDATE chat_messages SET tg_sent=2 WHERE id=?').run(r.id); }
    }
    return n;
  }

  async function typing() {
    const chatId = ownerChat();
    if (!chatId) return;
    const s = chat.status();
    const last = q("SELECT channel FROM chat_messages WHERE author='owner' ORDER BY id DESC LIMIT 1").get();
    if ((s.working || s.pending_chat > 0 || s.pending_web > 0) && last?.channel === 'telegram') await call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }

  // ---- loops
  let stopped = false;
  async function pollLoop() {
    let offset = +(getSet('telegram_offset') || 0);
    while (!stopped) {
      try {
        const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, AbortSignal.timeout(40000));
        heartbeat.beat(db, 'telegram_poll');
        for (const u of ups) { offset = u.update_id + 1; setSet('telegram_offset', offset); await handleUpdate(u); }
      } catch (e) { if (!stopped) { log('telegram poll:', e.message); await new Promise((r) => setTimeout(r, 5000)); } }
    }
  }
  // the bot's command menu in Telegram, with Hebrew descriptions
  const setCommands = () => call('setMyCommands', { commands: [{ command: 'today', description: 'משימות להיום ובאיחור' }, { command: 'urgent', description: 'משימות דחופות' }, { command: 'open', description: 'משימות פתוחות' }, { command: 's', description: 'חיפוש באינטרנט' }] });
  function start() {
    if (!token) return false;
    setCommands().catch((e) => log('setMyCommands failed:', e.message));
    pollLoop();
    setInterval(() => deliverPending().catch((e) => log('deliver:', e.message)), 2000);
    setInterval(() => typing(), 4500);
    log('telegram bot started');
    return true;
  }
  const stop = () => { stopped = true; };

  async function me() { return call('getMe'); }
  return { start, stop, setCommands, maxFile, localActive, handleUpdate, deliverPending, createBindCode, me, command, ownerChat };
}

// delete a message in the owner's Telegram chat (best effort; bots can delete messages younger than 48 h). Never from a test or a non-default database.
function deleter(db, { fetchImpl = fetch } = {}) {
  return async (messageId) => {
    const customDb = process.env.MESIMOT_DB && path.resolve(process.env.MESIMOT_DB) !== path.resolve(require('./db').DEFAULT_DB);
    if (process.env.MESIMOT_TELEGRAM === '0' || (customDb && process.env.MESIMOT_TELEGRAM !== '1') || process.env.NODE_TEST_CONTEXT) return false;
    let token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) { try { token = /^TELEGRAM_BOT_TOKEN=(.*)$/m.exec(fs.readFileSync(path.join(os.homedir(), '.config', 'mesimot', 'env'), 'utf8'))?.[1]?.trim().replace(/^["']|["']$/g, ''); } catch { /* no env file */ } }
    const chatId = db.prepare("SELECT value FROM settings WHERE key='telegram_chat_id'").get()?.value;
    if (!token || !chatId) return false;
    const base = process.env.TELEGRAM_API_BASE || API;
    const res = await fetchImpl(`${base}/bot${token}/deleteMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) });
    return res.ok;
  };
}

module.exports = { createTelegram, he, deleter };
