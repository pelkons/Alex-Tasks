'use strict';
// PERMANENT deletion of a task: its notes, drafts, email links, decisions, attention items, task-scoped chat and search/vector index entries go; events that mention it are
// anonymised (the fact that something happened stays, the content does not). The row snapshot lives only in memory for 30 seconds so the owner can say "בטל"; after that the
// daily database backup is the only other copy.
const crypto = require('crypto');
const { now } = require('./db');
const { missing } = require('./store');

const TTL_MS = 30000;

function createTaskDelete({ db, store, ttl = TTL_MS }) {
  const q = (sql) => db.prepare(sql);
  const snaps = new Map(); // token -> { data, expires }
  const sweep = () => { const t = Date.now(); for (const [k, v] of snaps) if (v.expires <= t) snaps.delete(k); };
  const hasTable = (n) => !!q("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
  const rows = (sql, ...a) => q(sql).all(...a);

  function purge(actor, id) {
    sweep();
    const task = q('SELECT * FROM tasks WHERE id=?').get(id); if (!task) throw missing('המשימה לא נמצאה');
    const data = {
      task, notes: rows('SELECT * FROM notes WHERE task_id=?', id), drafts: rows('SELECT * FROM drafts WHERE task_id=?', id), task_emails: rows('SELECT * FROM task_emails WHERE task_id=?', id),
      decisions: rows('SELECT * FROM decisions WHERE task_id=?', id), attention: rows('SELECT * FROM attention WHERE task_id=?', id), chat: rows('SELECT * FROM chat_messages WHERE task_id=?', id),
      files: rows('SELECT id FROM files WHERE task_id=?', id).map((r) => r.id), calendar: rows('SELECT id FROM calendar_items WHERE task_id=?', id).map((r) => r.id),
      children: rows('SELECT id FROM tasks WHERE parent_task_id=?', id).map((r) => r.id), pitems: rows('SELECT id FROM protocol_items WHERE task_id=?', id).map((r) => r.id),
      events: rows("SELECT id, field, old_value, new_value, meta FROM events WHERE entity='task' AND entity_id=?", id),
    };
    db.transaction(() => {
      const noteIds = data.notes.map((n) => n.id);
      if (hasTable('embeddings')) {
        const emb = [...rows("SELECT id FROM embeddings WHERE kind='task' AND ref_id=?", id), ...noteIds.flatMap((n) => rows("SELECT id FROM embeddings WHERE kind='note' AND ref_id=?", n))];
        for (const e of emb) { try { q('DELETE FROM vec_items WHERE rowid=?').run(BigInt(e.id)); } catch { /* no vector table */ } q('DELETE FROM embeddings WHERE id=?').run(e.id); }
      }
      q('DELETE FROM notes WHERE task_id=?').run(id); q('DELETE FROM drafts WHERE task_id=?').run(id); q('DELETE FROM task_emails WHERE task_id=?').run(id);
      q('DELETE FROM decisions WHERE task_id=?').run(id); q('DELETE FROM attention WHERE task_id=?').run(id); q('DELETE FROM chat_messages WHERE task_id=?').run(id);
      q('UPDATE files SET task_id=NULL WHERE task_id=?').run(id); q('UPDATE calendar_items SET task_id=NULL WHERE task_id=?').run(id);
      q('UPDATE tasks SET parent_task_id=NULL WHERE parent_task_id=?').run(id); q('UPDATE protocol_items SET task_id=NULL WHERE task_id=?').run(id);
      q("UPDATE events SET field=NULL, old_value=NULL, new_value=NULL, meta=NULL WHERE entity='task' AND entity_id=?").run(id);
      q('DELETE FROM tasks WHERE id=?').run(id);
      store.logEvent(actor, 'task', id, 'purge', 'title', null, `נמחקה לצמיתות: ${task.title}`);
    })();
    const token = crypto.randomBytes(9).toString('hex'); snaps.set(token, { data, expires: Date.now() + ttl });
    setTimeout(sweep, ttl + 50).unref?.();
    return { id, title: task.title, token, undo_seconds: ttl / 1000 };
  }

  function restore(actor, token) {
    sweep();
    const s = snaps.get(token); if (!s) throw missing('חלון הביטול (30 שניות) נסגר');
    const d = s.data; snaps.delete(token);
    const ins = (table, row) => { const cols = Object.keys(row); q(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c])); };
    db.transaction(() => {
      ins('tasks', d.task);
      for (const n of d.notes) ins('notes', n); for (const x of d.drafts) ins('drafts', x); for (const x of d.task_emails) ins('task_emails', x); for (const x of d.decisions) ins('decisions', x);
      for (const x of d.attention) ins('attention', x); for (const x of d.chat) ins('chat_messages', x);
      for (const f of d.files) q('UPDATE files SET task_id=? WHERE id=?').run(d.task.id, f); for (const c of d.calendar) q('UPDATE calendar_items SET task_id=? WHERE id=?').run(d.task.id, c);
      for (const c of d.children) q('UPDATE tasks SET parent_task_id=? WHERE id=?').run(d.task.id, c); for (const p of d.pitems) q('UPDATE protocol_items SET task_id=? WHERE id=?').run(d.task.id, p);
      for (const e of d.events) q('UPDATE events SET field=?, old_value=?, new_value=?, meta=? WHERE id=?').run(e.field, e.old_value, e.new_value, e.meta, e.id);
      store.logEvent(actor, 'task', d.task.id, 'restore', 'title', null, 'המחיקה בוטלה');
    })();
    return { id: d.task.id, title: d.task.title };
  }
  return { purge, restore, TTL_MS };
}
module.exports = { createTaskDelete };
