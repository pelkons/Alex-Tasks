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
// ---- keyboards: a phone shows about 30 characters per row. At most 2 buttons per row and a width budget; anything wider is re-flowed onto more rows (the primary action stays first).
const labelWidth = (t) => [...String(t || '')].reduce((n, ch) => n + (/\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0);
const ROW_BUDGET = 34, ROW_MAX = 2; // the owner's rule: at most TWO buttons per row, no exceptions
const rowWidth = (row) => row.reduce((n, b) => n + labelWidth(b.text) + 2, 0);
function fitKeyboard(rows) {
  const out = [];
  for (const row of rows || []) { let cur = []; for (const b of row) { if (cur.length && (cur.length >= ROW_MAX || rowWidth([...cur, b]) > ROW_BUDGET)) { out.push(cur); cur = []; } cur.push(b); } if (cur.length) out.push(cur); }
  return out;
}
// the buttons under a message that mentions tasks: one task = a 2-button row and a 3-button row; several (at most 3) = one short row each; the rest is behind "עוד באתר"
function taskKeyboard(tasks, site) {
  const short = (t) => { const s = String(t.title || '').trim(); return s.length > 8 ? s.slice(0, 7) + '…' : s; };
  if (tasks.length === 1) { const t = tasks[0]; return [[{ text: '✔ הושלם', callback_data: `done:${t.id}` }, { text: '⏰ למחר', callback_data: `snooze:${t.id}` }], [{ text: '🔗 באתר', url: `${site}/task/${t.id}` }, { text: '👍', callback_data: `fbup:${t.id}` }], [{ text: '👎', callback_data: `fbdown:${t.id}` }]]; }
  const rows = tasks.slice(0, 3).map((t) => [{ text: `✔ ${short(t)}`, callback_data: `done:${t.id}` }, { text: '🔗 באתר', url: `${site}/task/${t.id}` }]);
  if (tasks.length > 3) rows.push([{ text: `➕ עוד ${tasks.length - 3} באתר`, url: `${site}/chat` }]);
  return rows;
}
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

function createTelegram({ db, store, knowledge, chat, token, fetchImpl = fetch, whisper, log = () => {}, filesDir, notify = null, apiBase = process.env.TELEGRAM_API_BASE || '', chatEdit = null, confirmations = null, taskdel = null, outbox = null, proposals = null }) {
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
  // a file to the owner as a Telegram document (cloud Bot API: 50 MB; the local Bot API server allows more). Larger files, or a failed upload, become a link to the site.
  async function sendDocument(chatId, f) {
    const limit = localActive() ? maxFile() : 50 * MB; const link = `${siteBase(db)}/api/files/${f.id}/download`;
    let size = f.size || 0; try { size = require('./vault').plainSize(f.path); } catch { return say(chatId, `📎 ${f.name}: ${link}`); }
    if (size > limit) return say(chatId, `📎 ${f.name} (${Math.round(size / MB)} MB, גדול מדי לטלגרם): ${link}`);
    try {
      const fd = new FormData(); fd.append('chat_id', String(chatId)); fd.append('caption', String(f.name).slice(0, 200)); fd.append('document', new Blob([require('./vault').readFile(f.path)]), f.name);
      const res = await fetchImpl(`${base()}/bot${token}/sendDocument`, { method: 'POST', body: fd }); const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.description || res.status);
      return j.result;
    } catch (e) { log('telegram sendDocument failed:', e.message); return say(chatId, `📎 ${f.name}: ${link}`); }
  }
  // HTML messages (digests and every message with links): if Telegram cannot parse one, it goes out as plain text instead (a message is never lost to markup)
  async function sayHtml(chatId, html, extra = {}) {
    try { return await say(chatId, html, { parse_mode: 'HTML', ...extra }); }
    catch (e) { if (!/parse entities|can't parse/i.test(String(e.message))) throw e; return say(chatId, String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), extra); }
  }
  const say = (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...(extra.reply_markup && extra.reply_markup.inline_keyboard ? { ...extra, reply_markup: { ...extra.reply_markup, inline_keyboard: fitKeyboard(extra.reply_markup.inline_keyboard) } } : extra) });

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
  // a swipe-reply: which of OUR messages (or question cards) he answered
  function replyInfo(m) {
    const r = m.reply_to_message; if (!r || !r.message_id) return {};
    const row = q('SELECT id FROM chat_messages WHERE telegram_message_id=? ORDER BY id DESC').get(r.message_id); const prop = q('SELECT id FROM proposals WHERE tg_message_id=?').get(r.message_id);
    return { reply_to_id: row?.id || null, reply_proposal_id: prop?.id || null, reply_quote: String(r.text || r.caption || '').slice(0, 1000) || null };
  }
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
      return void ownerMessage(m.text.replace(/^\/s@\w+/i, '/s'), [], { telegram_message_id: m.message_id, ...replyInfo(m) });
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
    require('./vault').writeFile(file, dl.path ? fs.readFileSync(dl.path) : dl.buffer); // voice notes are encrypted at rest
    let heard = null;
    try { heard = await whisper.transcribe(file); } catch (e) { log('whisper failed:', e.message); }
    const text = heard && typeof heard === 'object' ? String(heard.text || '').trim() : String(heard || '').trim();
    if (!text) return void (await say(chatId, he.voiceFail));
    // no "what I heard" message: the assistant's reply is the answer. The language stays internal (it only picked the model).
    ownerMessage(text, [], { telegram_message_id: m.message_id, ...replyInfo(m), voice_file: file, transcript: text, lang: heard && heard.language ? heard.language : null });
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
    ownerMessage(m.caption || '', [saved.id], { telegram_message_id: m.message_id, ...replyInfo(m) });
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
      // OUTBOUND EMAIL: only a button of the card, from the owner's bound chat (checked above), approves. The callback carries the hash that the card showed.
      if (act === 'obre') { // re-send a failed mail: a NEW draft with a new card (approval is still the owner's button on that card)
        if (!outbox) return;
        try { const d = outbox.resend(store.ownerId(), id); await call('answerCallbackQuery', { callback_query_id: cb.id, text: `נוצרה טיוטה חדשה #${d.id}, כרטיס לאישור בדרך` }); } catch (e) { await call('answerCallbackQuery', { callback_query_id: cb.id, text: e.message, show_alert: true }); }
        return;
      }
      if (act === 'obok' || act === 'obed' || act === 'obno') {
        if (!outbox) return;
        const [, , hashShown] = String(cb.data).split(':');
        if (act === 'obok') {
          try { outbox.approve(store.ownerId(), id, hashShown, 'telegram'); await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'אושר. המייל יישלח מה-Outlook תוך דקות' }); await say(chatId, `✅ אושר לשליחה: ${outbox.get(id).subject}`); }
          catch (e) { await call('answerCallbackQuery', { callback_query_id: cb.id, text: e.message, show_alert: true }); }
        } else if (act === 'obno') {
          try { outbox.cancel(store.ownerId(), id); await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'הטיוטה בוטלה' }); } catch (e) { await call('answerCallbackQuery', { callback_query_id: cb.id, text: e.message }); }
        } else {
          await call('answerCallbackQuery', { callback_query_id: cb.id, text: 'כתבו כאן מה לשנות' });
          await say(chatId, `✏️ כתבו כאן מה לשנות בטיוטה #${id} (למשל "תקצר" או "תוסיף את דנה בעותק"), והעוזר ישלח כרטיס חדש לאישור. אפשר גם לערוך את הנוסח ישירות באתר: ${siteBase(db)}/chat`);
        }
        return;
      }
      if (act === 'pqy' || act === 'pqn') { // an answer to a question card: the button's own wording is what the owner chose
        if (!proposals) return;
        try { const it = proposals.withContext(q('SELECT * FROM proposals WHERE id=?').get(id)); proposals.decide(id, act === 'pqy' ? 'approve' : 'reject'); await call('answerCallbackQuery', { callback_query_id: cb.id, text: `נרשם: ${(act === 'pqy' ? it.approve_label : it.reject_label) || 'תשובה'}` }); await call('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {}); }
        catch (e) { await call('answerCallbackQuery', { callback_query_id: cb.id, text: e.message }); }
        return;
      }
      if (act === 'pball') { // "אשר הכל" on a compact proposals card
        if (!proposals) return;
        try { const done = proposals.approveBatch(id); await call('answerCallbackQuery', { callback_query_id: cb.id, text: `אושרו ${done.filter((x) => x.status === 'applied').length} מתוך ${done.length}` }); await call('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {}); }
        catch (e) { await call('answerCallbackQuery', { callback_query_id: cb.id, text: e.message }); }
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
        const title = String(store.getTask(id).title || '').slice(0, 60);
        await call('answerCallbackQuery', { callback_query_id: cb.id, text: `✔ סגרתי: ${title}` });
        await say(chatId, `✔ סגרתי: ${title}`).catch(() => {});
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
  // questions about an email (benchmark cards, active-learning questions): EACH one is its own message with who/when/project/subject, the cleaned excerpt, what is asked, the options and buttons that say what the answer MEANS;
  // "עוד" opens the full email on the site. A few per round, never one blob.
  async function deliverQuestions() {
    const chatId = ownerChat(); if (!chatId || !proposals) return 0;
    if (notify && (!notify.settings().notify_telegram || notify.isQuiet())) return 0; // held back during quiet hours; the next round after them releases the queue
    const D = require('./digestfmt'); const e = D.esc; const RLM = '\u200F';
    // pacing: at most 3 questions wait for an answer at the same time; the next one goes out when he answers one
    const outstanding = q("SELECT COUNT(*) c FROM proposals WHERE status='open' AND tg_sent=1 AND tg_message_id IS NOT NULL AND kind IN ('bench_question','question')").get().c;
    const slots = Math.max(0, 3 - outstanding); let n = 0;
    if (slots) for (const r of q("SELECT id, batch FROM proposals WHERE status='open' AND tg_sent=0 AND kind IN ('bench_question','question') ORDER BY id LIMIT ?").all(slots)) {
      const it = proposals.withContext(q('SELECT * FROM proposals WHERE id=?').get(r.id)); const em = it.email;
      const seq = q('SELECT COUNT(*) c FROM proposals WHERE batch=? AND id<=?').get(r.batch, r.id).c; const total = q('SELECT COUNT(*) c FROM proposals WHERE batch=?').get(r.batch).c;
      const lines = [RLM + `📧 <b>${total > 1 ? `שאלה ${seq}/${total}` : 'שאלה'}</b>`];
      if (em) {
        lines.push(`${RLM}${e(em.sender)} · ${e(em.when)}${em.project ? ' · ' + e(em.project) : ''}`, `${RLM}<b>${e(em.subject)}</b>`);
        if (it.summary) lines.push(`${RLM}בקצרה: ${e(it.summary)}`);
        lines.push(`<blockquote>${RLM}${e(em.excerpt)}</blockquote>`);
        if (em.attachments.length) lines.push(`${RLM}📎 ${e(em.attachments.slice(0, 6).join(', '))}`);
        lines.push('', `${RLM}<b>${e(it.ask || it.text)}</b>`);
      } else lines.push(`${RLM}<b>${e(it.text)}</b>`);
      if (it.left) lines.push(`${RLM}א) ${e(it.left)}`, `${RLM}ב) ${e(it.right)}`);
      if (it.suggested_title) lines.push(`${RLM}כותרת משימה מוצעת: ${e(it.suggested_title)}`);
      const kb = [[{ text: it.approve_label || 'כן', callback_data: `pqy:${it.id}` }, { text: it.reject_label || 'לא', callback_data: `pqn:${it.id}` }], ...(em ? [[{ text: '📄 המייל המלא באתר', url: em.link }]] : [])];
      try {
        const sent = await sayHtml(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: kb } });
        if (!sent || !sent.message_id) throw new Error('telegram returned no message id'); // a delivery counts only when Telegram confirms it with a message id
        q('UPDATE proposals SET tg_sent=1, tg_message_id=? WHERE id=?').run(sent.message_id, it.id); n++;
      } catch (err) { log('telegram question failed:', err.message); if (!/database is locked|SQLITE_BUSY/i.test(String(err.message))) q('UPDATE proposals SET tg_sent=2 WHERE id=?').run(it.id); }
    }
    // the compact cards of the other batches (task and people proposals) come AFTER every benchmark question is answered
    const pendingBench = q("SELECT COUNT(*) c FROM proposals WHERE status='open' AND kind='bench_question'").get().c;
    if (!pendingBench) for (const b of q("SELECT * FROM proposal_batches WHERE tg_sent=0 AND kind<>'bench' ORDER BY id LIMIT 1").all()) {
      const bt = proposals.batch(b.id); const open = bt.items.filter((x) => x.status === 'open');
      if (!open.length) { q('UPDATE proposal_batches SET tg_sent=1 WHERE id=?').run(b.id); continue; }
      const lines = [`${RLM}📋 <b>${e(bt.title)}</b>`, `${RLM}${open.length} הצעות ממתינות`, ...open.slice(0, 8).map((x) => `${RLM}• ${e(D.cut(x.text, 70))}`)]; if (open.length > 8) lines.push(`${RLM}ועוד ${open.length - 8}`);
      try {
        const sent = await sayHtml(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: '✅ אשר הכל', callback_data: `pball:${b.id}` }, { text: '🔗 פירוט באתר', url: `${siteBase(db)}/chat` }]] } });
        if (!sent || !sent.message_id) throw new Error('telegram returned no message id');
        q('UPDATE proposal_batches SET tg_sent=1, tg_message_id=? WHERE id=?').run(sent.message_id, b.id); n++;
      } catch (err) { log('telegram batch card failed:', err.message); }
    }
    return n;
  }
  async function deliverPending() {
    await deliverQuestions().catch((e) => log('questions:', e.message));
    // a reply the assistant corrected inside its own run is EDITED in Telegram, not sent again
    { const chatId0 = ownerChat(); if (chatId0) for (const r of q("SELECT id, text, telegram_message_id FROM chat_messages WHERE tg_edit=1 AND tg_sent=1 AND telegram_message_id IS NOT NULL LIMIT 5").all()) { try { await call('editMessageText', { chat_id: chatId0, message_id: r.telegram_message_id, text: String(r.text).slice(0, 4000), disable_web_page_preview: true }); } catch (e) { if (!/not modified/i.test(String(e.message))) log('telegram edit failed:', e.message); } q('UPDATE chat_messages SET tg_edit=0 WHERE id=?').run(r.id); } }
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
      const rows2 = m.outbox ? [] : taskKeyboard(m.tasks, siteBase(db));
      try {
        const replyTo = r.after_id ? q('SELECT telegram_message_id t FROM chat_messages WHERE id=?').get(r.after_id)?.t : null;
        // an approval card: ✅/✏️/❌ buttons bound to the hash it shows. A card too long for Telegram has no approve button (the exact content could not be shown): approval is on the site.
        const failedOb = m.outbox && m.outbox.status === 'failed' && !m.outbox.resent_as ? [[{ text: '🔁 שלח שוב', callback_data: `obre:${m.outbox.id}` }]] : null;
        const ob = failedOb || (m.outbox && m.outbox.status === 'pending' && !m.outbox.stale ? (m.outbox.telegram_approvable
          ? [[{ text: '✅ שלח', callback_data: `obok:${m.outbox.id}:${m.outbox.shown_hash.slice(0, 12)}` }, { text: '✏️ ערוך', callback_data: `obed:${m.outbox.id}` }, { text: '❌ בטל', callback_data: `obno:${m.outbox.id}` }]]
          : [[{ text: '🌐 לאישור באתר (המייל ארוך)', url: `${siteBase(db)}/chat` }, { text: '❌ בטל', callback_data: `obno:${m.outbox.id}` }]]) : null);
        const cf = ob || (m.confirm && m.confirm.status === 'open' ? [[{ text: 'כן, למחוק', callback_data: `cfy:${m.confirm.id}` }, { text: 'לא', callback_data: `cfn:${m.confirm.id}` }]] : null);
        const D = require('./digestfmt'); let sent;
        if (r.rich) { for (const part of D.telegram(JSON.parse(r.rich))) sent = await sayHtml(chatId, part, { disable_notification: false }); } // a digest: a few short HTML messages
        else sent = await sayHtml(chatId, D.htmlize(text), { ...(cf ? { reply_markup: { inline_keyboard: cf } } : {}), ...(rows2.length ? { reply_markup: { inline_keyboard: rows2 } } : {}), ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}) });
        q('UPDATE chat_messages SET tg_sent=1, telegram_message_id=? WHERE id=?').run(sent.message_id, r.id);
        for (const f of m.files) { const full = q('SELECT id, original_name name, path, size FROM files WHERE id=?').get(f.id); if (full) await sendDocument(chatId, full); }
        n++;
      } catch (e) { log('telegram send failed:', e.message); if (!/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(e.message))) q('UPDATE chat_messages SET tg_sent=2 WHERE id=?').run(r.id); } // a lock is retried on the next round, never given up on
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

module.exports = { createTelegram, he, deleter, fitKeyboard, taskKeyboard, rowWidth, ROW_BUDGET, ROW_MAX };
