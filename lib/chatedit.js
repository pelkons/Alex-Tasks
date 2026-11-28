'use strict';
// Edit and delete chat messages (ChatGPT style). Editing an owner message UNDOES what the assistant did for it (through the events/undo machinery),
// marks the old reply as superseded and asks for a new chat-priority run; deleting hides the message (soft delete, audit kept), optionally undoing too, and puts it in the
// recycle bin (lib/trash.js): restoring shows it again, deleting it there (or expiry) blanks its text for good.
const { now } = require('./db');
const { bad, missing } = require('./store');

function createChatEdit({ db, store, chat, undo, tgDelete = null, trash = null }) {
  const q = (sql) => db.prepare(sql);
  const bin = trash || require('./trash').createTrash({ db, store });
  const row = (id) => { const m = q('SELECT * FROM chat_messages WHERE id=?').get(id); if (!m || m.deleted_at) throw missing('ההודעה לא נמצאה'); return m; };
  const runsFor = (msgId) => q('SELECT DISTINCT rm.run_id id FROM run_messages rm JOIN claude_runs r ON r.id = rm.run_id WHERE rm.msg_id=? AND r.finished_at IS NOT NULL ORDER BY rm.run_id DESC').all(msgId).map((r) => r.id);
  // undo whole runs; what cannot be undone (the owner changed it since) is kept and reported
  function undoRuns(actor, runIds) {
    const out = { runs: runIds, undone: 0, skipped: [] };
    for (const r of runIds) { const x = undo.undoRun(actor, r); out.undone += x.undone; out.skipped.push(...x.skipped.filter((s) => !/ההחלטה נרשמה/.test(s.reason))); }
    return out;
  }
  const supersede = (runIds) => { for (const r of runIds) q("UPDATE chat_messages SET superseded=1 WHERE run_id=? AND author='claude'").run(r); };
  const tg = (m) => { if (tgDelete && m.telegram_message_id) { Promise.resolve().then(() => tgDelete(m.telegram_message_id)).catch(() => {}); } };

  // owner edits his own message: keep the original, undo the old answer's actions, supersede the old reply, wake a new run with the edited text
  function edit(actor, id, text) {
    const m = row(+id);
    if (m.author !== 'owner') throw bad('אפשר לערוך רק הודעות שלך');
    if (m.import_id) throw bad('אי אפשר לערוך כרטיס ייבוא');
    const tx = String(text ?? '').trim();
    if (!tx) throw bad('ההודעה ריקה');
    if (tx.length > 20000) throw bad('ההודעה ארוכה מדי');
    if (tx === m.text) return { message: chat.decorate(m), undone: 0, skipped: [], runs: [] };
    const runIds = runsFor(m.id);
    const res = undoRuns(actor, runIds);
    db.transaction(() => {
      q('INSERT INTO chat_edits (msg_id, old_text, new_text, at, actor_id) VALUES (?,?,?,?,?)').run(m.id, m.text, tx, now(), actor);
      q('UPDATE chat_messages SET text=?, edited_at=?, edited_from=COALESCE(edited_from, ?) WHERE id=?').run(tx, now(), m.text, m.id);
      supersede(runIds);
      // a new chat-priority run (task-scoped messages pin the same task again)
      store.logEvent(actor, 'chat', m.id, 'edit', 'text', m.text.slice(0, 300), tx.slice(0, 500), { undone_runs: runIds, skipped: res.skipped.length });
    })();
    return { message: chat.decorate(q('SELECT * FROM chat_messages WHERE id=?').get(m.id)), ...res };
  }

  // delete: owner message (hidden; optionally undo what it caused) or assistant message (hidden only)
  function remove(actor, id, { undoActions = false } = {}) {
    const m = row(+id);
    let res = { runs: [], undone: 0, skipped: [] }; let trashId = null;
    db.transaction(() => {
      q('UPDATE chat_messages SET deleted_at=? WHERE id=?').run(now(), m.id);
      trashId = bin.trashChat(actor, m);
      store.logEvent(actor, 'chat', m.id, 'delete', 'text', m.text.slice(0, 200), null, { undo: !!undoActions && m.author === 'owner', trash_id: trashId }); bin.seal(trashId);
    })();
    if (m.author === 'owner' && undoActions) {
      const runIds = runsFor(m.id);
      res = undoRuns(actor, runIds); supersede(runIds);
    }
    tg(m);
    return { id: m.id, trash_id: trashId, trashed: true, ...res };
  }

  return { edit, remove, runsFor };
}
module.exports = { createChatEdit };
