'use strict';
// Shared chat feed and the runner's run log.
const { now } = require('./db');
const { bad, missing } = require('./store');
const heartbeat = require('./heartbeat');

// `/s <question>`: the owner asks the assistant to search the internet (a separate, isolated run, see runner.webOnce)
const WEB_RE = /^\/s(?:@\w+)?(?:\s+([\s\S]*))?$/i;
const WEB_HINT = 'כדי לחפש באינטרנט כתבו /s ואחריו את השאלה, למשל: /s מה שעון הקיץ בישראל 2027';
const webQuestion = (text) => { const m = WEB_RE.exec(String(text || '').trim()); return m ? String(m[1] || '').trim() : null; };

function createChat(db, store, knowledge) {
  const q = (sql) => db.prepare(sql);
  const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

  // a reply produced after an EDIT is shown right after the edited message, not at the end of the chat
  const pos = (m) => (m.after_id ? m.after_id + 0.5 + m.id * 1e-9 : m.id);
  // the chip that links a scoped message in the "show scoped conversations too" view to its place
  function scopeLabel(ref) {
    try {
      const [t, id] = ref.split(':');
      const name = t === 'project' ? q('SELECT name_he n FROM projects WHERE id=?').get(+id)?.n : t === 'person' ? q('SELECT name_he n FROM people WHERE id=?').get(+id)?.n
        : t === 'protocol' ? q('SELECT title n FROM protocols WHERE id=?').get(+id)?.n : t === 'email' ? q('SELECT COALESCE(original_subject, subject) n FROM emails WHERE id=?').get(+id)?.n : id;
      const kind = { project: 'פרויקט', person: 'איש קשר', protocol: 'פרוטוקול', email: 'מייל', day: 'יום' }[t] || '';
      return `${kind}: ${String(name || id).slice(0, 40)}`;
    } catch { return ref; }
  }
  function decorate(m) {
    const ids = [...new Set([...(m.task_id ? [m.task_id] : []), ...parse(m.task_ids)])];
    const tasks = ids.map((id) => q(`SELECT t.id, t.title, p.name_he AS project, p.color AS project_color, p.is_default AS project_default
      FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`).get(id)).filter(Boolean);
    const files = parse(m.file_ids).map((id) => { try { const f = knowledge.getFile(id); return { id: f.id, name: f.original_name, size: f.size, mime: f.mime, project_id: f.project_id, text_status: f.text_status, email_id: f.email_id }; } catch { return null; } }).filter(Boolean);
    // names for the links written in the text, so the UI can show "מגדל הדוגמה 2-4" instead of "פרויקט 2"
    const refs = { task: {}, projects: {}, email: {} };
    for (const [, kind, id] of String(m.text || '').matchAll(/\/(task|projects|email)\/(\d+)/g)) {
      if (kind === 'task') refs.task[id] = q('SELECT title FROM tasks WHERE id=?').get(+id)?.title;
      else if (kind === 'projects') refs.projects[id] = q('SELECT name_he FROM projects WHERE id=?').get(+id)?.name_he;
      else refs.email[id] = q('SELECT COALESCE(original_subject, subject) s FROM emails WHERE id=?').get(+id)?.s;
    }
    return { id: m.id, author: m.author, channel: m.channel, text: m.text, created_at: m.created_at, tasks, files, refs, voice: !!m.voice_file, web: m.kind === 'web', edited: !!m.edited_at, superseded: !!m.superseded, after_id: m.after_id || null, pos: pos(m), scope: m.scope || null, in_main: !m.scope || !!m.in_main, scope_ref: m.scope_ref || null, scope_label: m.scope === 'entity' && m.scope_ref ? scopeLabel(m.scope_ref) : null, scope_path: m.scope === 'entity' && m.scope_ref ? refPath(m.scope_ref) : null, rich: m.rich ? (() => { try { return require('./digestfmt').web(JSON.parse(m.rich)); } catch { return null; } })() : null, reply_to_id: m.reply_to_id || null, reply_quote: m.reply_quote || null, reply: m.reply_to_id ? (() => { const r = q('SELECT id, author, text FROM chat_messages WHERE id=?').get(m.reply_to_id); return r ? { id: r.id, author: r.author, text: String(r.text || '').slice(0, 160) } : null; })() : null, task_id: m.task_id || null, task_title: m.scope === 'task' && m.task_id ? (q('SELECT title FROM tasks WHERE id=?').get(m.task_id)?.title || null) : null, import_id: m.import_id || null, proposal_batch: m.proposal_batch || null, outbox: m.outbox_id && store.hooks.outboxView ? (() => { try { return store.hooks.outboxView(m.outbox_id, m.outbox_hash); } catch { return null; } })() : null, confirm: m.confirm_id && store.hooks.confirmView ? (() => { try { return store.hooks.confirmView(m.confirm_id); } catch { return null; } })() : null, import: m.import_id && store.hooks.importProgress ? store.hooks.importProgress(m.import_id) : null };
  }

  const NO_CHAT_TRIGGERS = new Set(['import', 'reconcile', 'curator', 'names', 'triage', 'audit', 'facts-backfill', 'files-backfill', 'profile-backfill', 'style-analysis', 'daily', 'housekeeping', 'reingest']);
  function sendChat(actor, b, internal = null) {
    const text = String(b.text ?? '').trim();
    const fileIds = [...new Set((Array.isArray(b.file_ids) ? b.file_ids : String(b.file ?? b.files ?? '').split(',')).map(Number).filter(Boolean))]; // the assistant sends files to the owner with `chat send --file ID` (or chat_files in apply)
    if (!text && !fileIds.length) throw bad('יש לכתוב הודעה');
    if (text.length > 20000) throw bad('ההודעה ארוכה מדי');
    for (const f of fileIds) knowledge.getFile(f);
    const author = actor === store.ownerId() ? 'owner' : 'claude';
    // many mail files (or a zip of them, or "ייבוא יומי"): one import card instead of a message per file
    if (author === 'owner' && !internal && store.hooks.importIntake) { const card = store.hooks.importIntake(actor, { text, fileIds }); if (card) return card; }
    // TASK-SCOPED chat: a message in the task card is an ordinary chat message with task_id and scope 'task'. The assistant's replies inside a run that was pinned
    // to a task are scoped to it automatically (override with task_scope: 0 to write to the main chat).
    const openRun = author === 'claude' ? q('SELECT id, trigger, pinned_task_id, pinned_ref, edited_msg_id FROM claude_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1').get() : null;
    // MAIN-CHAT POST: the explicit way out of a scope (`chat send --main`, or internal.main for global system messages). A run pinned to a task / project / person / protocol / day / email
    // otherwise ALWAYS writes into that scope (task_scope: 0 and entity_scope: 0 no longer escape it). One short main-chat message per scoped run.
    const wantMain = !!(internal?.main || (b.main !== undefined && b.main !== null && b.main !== false && b.main !== '' && b.main !== '0' && b.main !== 'false'));
    const pinnedRun = !!(openRun && (openRun.pinned_task_id || openRun.pinned_ref));
    if (author === 'claude' && wantMain && pinnedRun && internal?.agent) {
      if (text.length > 600) throw bad('הודעה לצ׳אט הראשי מתוך שיחה ממוקדת חייבת להיות קצרה (עד 600 תווים)');
      if (q("SELECT 1 FROM chat_messages WHERE run_id=? AND author='claude' AND scope IS NULL AND deleted_at IS NULL").get(openRun.id)) throw bad('בשיחה ממוקדת מותרת הודעה אחת בלבד לצ׳אט הראשי. המשיכו בשיחה הממוקדת');
    }
    const explicitTask = !wantMain && b.task_scope !== undefined && b.task_scope !== null && b.task_scope !== '' && !(pinnedRun && String(b.task_scope) === '0');
    const scopeId = wantMain ? 0 : (explicitTask ? +b.task_scope : (openRun?.pinned_task_id || 0));
    if (scopeId) store.getTask(scopeId);
    // BACKGROUND RUNS NEVER POST TO THE CHAT: imports, re-extraction, backfills, curator, audits, reconcile, name fixes and triage have no voice here. What the agent would say becomes the run's summary
    // (the activity screen) and, at most, one line in the next digest. Only chat, task chat, owner mail, the pulse and the web search may post; system code (urgent live mail, digests, alerts) calls this without `agent`.
    if (internal && internal.agent && author === 'claude' && openRun && NO_CHAT_TRIGGERS.has(openRun.trigger)) {
      q("UPDATE claude_runs SET summary_he=substr(COALESCE(summary_he || ' | ', '') || ?, 1, 600) WHERE id=?").run(text, openRun.id);
      return { id: null, suppressed: true, author: 'claude', text, files: [], tasks: [], refs: { task: {}, projects: {}, email: {} }, note: 'רצה ברקע: ההודעה נשמרה בפעילות ולא נשלחה לצ׳אט' };
    }
    // ONE reply per owner message: a gate re-prompt or a retry inside the same run that sends another message does not add a near-duplicate; it EDITS the run's earlier reply (Telegram follows with an edit)
    if (internal && internal.agent && author === 'claude' && openRun && openRun.trigger === 'chat' && !wantMain) {
      const nIn = q('SELECT COUNT(*) c FROM run_messages WHERE run_id=?').get(openRun.id).c;
      const prev = nIn === 1 ? q(`SELECT * FROM chat_messages WHERE run_id=? AND author='claude' AND deleted_at IS NULL AND outbox_id IS NULL AND confirm_id IS NULL AND proposal_batch IS NULL${pinnedRun ? ' AND scope IS NOT NULL' : ''} ORDER BY id DESC LIMIT 1`).get(openRun.id) : null;
      if (prev) { q('UPDATE chat_messages SET text=?, edited_at=?, tg_edit=CASE WHEN tg_sent=1 AND telegram_message_id IS NOT NULL THEN 1 ELSE tg_edit END WHERE id=?').run(text, now(), prev.id); return decorate(q('SELECT * FROM chat_messages WHERE id=?').get(prev.id)); }
    }
    // ENTITY-SCOPED chat (project / person / protocol / calendar day): scope 'entity' with scope_ref 'project:5'. A task scope wins; replies inside a pinned run inherit the ref
    const entExplicit = b.entity_scope !== undefined && b.entity_scope !== null && b.entity_scope !== '' && !(pinnedRun && String(b.entity_scope) === '0');
    let ref = scopeId || wantMain ? '' : (entExplicit ? (String(b.entity_scope) === '0' ? '' : String(b.entity_scope)) : (openRun?.pinned_ref || ''));
    if (ref) ref = checkRef(ref);
    let taskIds = String(b.task ?? '').split(',').map((x) => +x.trim()).filter(Boolean);
    if (scopeId && !taskIds.includes(scopeId)) taskIds = [scopeId, ...taskIds];
    for (const t of taskIds) store.getTask(t);
    // Telegram is bound: every message from the assistant is also delivered there (the runner's Telegram module sends it)
    let tgBound = author === 'claude' && !!q("SELECT 1 FROM settings WHERE key='telegram_chat_id'").get();
    // A scoped conversation stays where it was started. Started on the WEB: nothing goes to Telegram. Started in TELEGRAM (the run answers a Telegram message, even if the
    // assistant pins its reply to a task / entity): the answer goes back to Telegram with the link, and also shows in the main chat.
    let outText = text, inMain = 0;
    if ((scopeId || ref) && author === 'claude') {
      const fromTg = !!(openRun && q("SELECT 1 FROM run_messages rm JOIN chat_messages c ON c.id=rm.msg_id WHERE rm.run_id=? AND c.author='owner' AND c.channel='telegram'").get(openRun.id));
      if (!fromTg) tgBound = false;
      else { inMain = 1; outText = `${text}\n📌 ${require('./config').siteUrl(db)}${scopeId ? '/task/' + scopeId : refPath(ref)}`; }
    }
    const channel = author === 'owner' && internal?.channel === 'telegram' ? 'telegram' : 'web';
    // a REPLY (Telegram swipe-reply or the web quote action): remember what the owner answered, so the assistant never mixes it up with the latest message
    const replyTo = author === 'owner' ? (+(internal?.reply_to_id ?? b.reply_to) || null) : null;
    const replyProp = author === 'owner' ? (+internal?.reply_proposal_id || null) : null;
    const replyQuote = author === 'owner' && (replyTo || replyProp || internal?.reply_quote) ? String(internal?.reply_quote || '').slice(0, 1000) || null : null;
    const msg = db.transaction(() => {
      const id = q(`INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, telegram_message_id, voice_file, transcript, lang, kind, task_id, scope, run_id, after_id, scope_ref, in_main) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(author, channel, outText, JSON.stringify(fileIds), JSON.stringify(taskIds), now(), tgBound ? 0 : 1, internal?.telegram_message_id ?? null, internal?.voice_file ?? null, internal?.transcript ?? null, internal?.lang ?? null, internal?.kind ?? null, scopeId || null, scopeId ? 'task' : (ref ? 'entity' : null), openRun?.id ?? null, openRun?.edited_msg_id ?? null, ref || null, inMain || null).lastInsertRowid;
      // an owner message that starts with /s is a web search request: its own event kind (never seen by the normal run), or a usage hint
      const wq = author === 'owner' ? webQuestion(text) : null;
      if (wq === null) store.logEvent(actor, 'chat', id, 'message', 'text', null, text.slice(0, 500));
      else if (wq) store.logEvent(actor, 'websearch', id, 'message', 'text', null, wq.slice(0, 500));
      else { // /s with no question: a one-line hint, no run
        db.prepare('INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, kind) VALUES (?,?,?,?,?,?,?,?)').run('claude', 'web', WEB_HINT, '[]', '[]', now(), (!!q("SELECT 1 FROM settings WHERE key='telegram_chat_id'").get()) ? 0 : 1, 'web');
      }
      if (store.hooks.mention) { try { store.hooks.mention('chat', id, { text }); } catch { /* ignore */ } }
      if (replyTo || replyProp || replyQuote) q('UPDATE chat_messages SET reply_to_id=?, reply_proposal_id=?, reply_quote=? WHERE id=?').run(replyTo, replyProp, replyQuote, id);
      return decorate(q('SELECT * FROM chat_messages WHERE id=?').get(id));
    })();
    // a reply to a CARD (a question, a proposal, an outbox draft) is interpreted here, in code; what is not a clear card answer goes to the assistant with the quoted message in front
    if ((replyTo || replyProp) && store.hooks.reply) {
      try { const r = store.hooks.reply.handle(msg.id); if (r && r.handled) q("UPDATE events SET processed_at=? WHERE entity='chat' AND entity_id=? AND processed_at IS NULL").run(now(), msg.id); } catch { /* never lose the message: the assistant gets it with its context */ }
    }
    return msg;
  }

  // a digest or a long system message: stored as an object (the web page and Telegram render it with lib/digestfmt.js) plus its plain-text fallback
  function sendRich(actor, rich) {
    const f = require('./digestfmt'); const id = q(`INSERT INTO chat_messages (author, channel, text, file_ids, task_ids, created_at, tg_sent, kind, rich) VALUES ('claude','web',?,'[]','[]',?,?,NULL,?)`)
      .run(f.plain(rich), now(), q("SELECT 1 FROM settings WHERE key='telegram_chat_id'").get() ? 0 : 1, JSON.stringify(rich)).lastInsertRowid;
    return decorate(q('SELECT * FROM chat_messages WHERE id=?').get(id));
  }
  const REF_TYPES = { project: 'projects', person: 'people', protocol: 'protocols', email: 'emails' };
  function checkRef(ref) {
    const m = /^(project|person|protocol|email|day):(.+)$/.exec(String(ref));
    if (!m) throw bad('הקשר שיחה לא תקין');
    if (m[1] === 'day') { if (!/^\d{4}-\d{2}-\d{2}$/.test(m[2])) throw bad('תאריך לא תקין'); return ref; }
    if (!q(`SELECT 1 FROM ${REF_TYPES[m[1]]} WHERE id=?`).get(+m[2])) throw bad('הפריט לא נמצא');
    return `${m[1]}:${+m[2]}`;
  }
  const refPath = (ref) => { const [t, id] = ref.split(':'); return t === 'project' ? `/projects/${id}` : t === 'protocol' ? `/protocols/${id}` : t === 'email' ? `/email/${id}` : t === 'person' ? '/people' : '/calendar'; };
  function scopeThread(ref, limit = 200) {
    return q("SELECT * FROM chat_messages WHERE scope='entity' AND scope_ref=? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?").all(checkRef(ref), limit).reverse().map(decorate).sort((a, b) => a.pos - b.pos);
  }
  // the conversation about one task (both sides), oldest first
  function taskThread(taskId, limit = 200) {
    return q("SELECT * FROM chat_messages WHERE task_id=? AND scope='task' AND deleted_at IS NULL ORDER BY id LIMIT ?").all(taskId, limit).map(decorate).sort((a, b) => a.pos - b.pos);
  }
  // main: only what belongs in the MAIN chat (unscoped messages, plus scoped answers to a conversation the owner started in Telegram)
  function listChat({ after, before, limit, main } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const M = main && main !== '0' && main !== 'false' ? ' AND (scope IS NULL OR in_main=1)' : '';
    let rows;
    if (after) rows = q(`SELECT * FROM chat_messages WHERE id > ? AND deleted_at IS NULL${M} ORDER BY id LIMIT ?`).all(+after, n);
    else if (before) rows = q(`SELECT * FROM chat_messages WHERE id < ? AND deleted_at IS NULL${M} ORDER BY id DESC LIMIT ?`).all(+before, n).reverse();
    else rows = q(`SELECT * FROM chat_messages WHERE deleted_at IS NULL${M} ORDER BY id DESC LIMIT ?`).all(n).reverse();
    return rows.map(decorate).sort((a, b) => a.pos - b.pos);
  }

  // ---- run log
  function startRun(trigger, eventsCount) {
    return q('INSERT INTO claude_runs (started_at, trigger, events_count) VALUES (?,?,?)').run(now(), trigger, eventsCount).lastInsertRowid;
  }
  function finishRun(id, f = {}) {
    q(`UPDATE claude_runs SET finished_at=?, summary_he=COALESCE(?, summary_he), error=?, duration_ms=?, num_turns=?, chat_reply_ms=? WHERE id=?`)
      .run(now(), f.summary ?? null, f.error ?? null, f.duration_ms ?? null, f.num_turns ?? null, f.chat_reply_ms ?? null, id);
    try { heartbeat.beat(db, 'last_run', { id, trigger: q('SELECT trigger FROM claude_runs WHERE id=?').get(id)?.trigger, status: f.error ? 'error' : 'ok' }); } catch { /* the heartbeat must never break a run */ }
  }
  function setRunSummary(text) {
    const t = String(text ?? '').trim();
    if (!t) throw bad('יש להזין טקסט');
    const r = q('SELECT id FROM claude_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1').get();
    if (!r) throw bad('אין הרצה פעילה');
    q('UPDATE claude_runs SET summary_he=? WHERE id=?').run(t, r.id);
    return { run: r.id };
  }
  function status() {
    const run = q('SELECT * FROM claude_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1').get();
    const fresh = run && Date.now() - Date.parse(run.started_at) < 20 * 60 * 1000;
    const last = q('SELECT id, started_at, finished_at, trigger, summary_he, error, duration_ms FROM claude_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    const pendingChat = q("SELECT COUNT(*) n FROM events WHERE entity='chat' AND processed_at IS NULL").get().n;
    const pendingWeb = q("SELECT COUNT(*) n FROM events WHERE entity='websearch' AND processed_at IS NULL").get().n;
    return { working: !!fresh, trigger: fresh ? run.trigger : null, since: fresh ? run.started_at : null, pending_chat: pendingChat, pending_web: pendingWeb, last_run: last || null, last_message_id: q('SELECT MAX(id) m FROM chat_messages').get().m || 0 };
  }
  function listRuns(limit = 30) {
    return q('SELECT * FROM claude_runs ORDER BY id DESC LIMIT ?').all(limit);
  }
  return { sendRich, sendChat, taskThread, scopeThread, checkRef, listChat, startRun, finishRun, setRunSummary, status, listRuns, decorate };
}

module.exports = { createChat, webQuestion, WEB_HINT };
