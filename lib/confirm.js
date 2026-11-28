'use strict';
// Destructive actions need ONE quick confirmation from the owner: the assistant posts a chat message with two buttons ("כן, למחוק" / "לא", in the web chat and in Telegram);
// only the owner's answer executes the action. The code refuses to run it any other way. Deleting a task, project, person or protocol moves it to the recycle bin
// (lib/trash.js); deleting an item of the bin or emptying the bin is PERMANENT and goes through the same confirmation.
const { now } = require('./db');
const { bad, missing } = require('./store');

const INTERNAL = Symbol('server-only'); // a JSON body can never carry it
function createConfirm({ db, store, chat, taskdel, purge = null, trash = null }) {
  const q = (sql) => db.prepare(sql);
  const bin = trash || (taskdel && taskdel.trash) || null;
  const keep = () => { const d = bin ? bin.days() : 60; return d > 0 ? ` אפשר לשחזר מהסל במשך ${d} ימים.` : ' אפשר לשחזר מהסל.'; };
  const get = (id) => { const r = q('SELECT * FROM confirmations WHERE id=?').get(id); if (!r) throw missing('הבקשה לא נמצאה'); return r; };
  function ask(actor, kind, targetId, opts = {}) {
    let text, label = null;
    if (kind === 'task_delete') { const t = store.getTask(+targetId); label = t.title; text = `להעביר לסל את המשימה "${t.title}" (מספר ${t.id})?${keep()}`; }
    else if (kind === 'project_delete') { const p = store.findProject(+targetId); label = p.name_he; const pl = opts.payload || {}; const n = db.prepare('SELECT (SELECT COUNT(*) FROM tasks WHERE project_id=?) t, (SELECT COUNT(*) FROM project_facts WHERE project_id=?) f, (SELECT COUNT(*) FROM protocols WHERE project_id=?) p').get(p.id, p.id, p.id); const where = String(pl.tasks || 'unassign'); let dest = ''; if (where.startsWith('move:')) { try { dest = store.findProject(where.slice(5)).name_he; } catch { dest = where.slice(5); } } text = `להעביר לסל את הפרויקט "${p.name_he}"? יש בו ${n.t} משימות, ${n.f} נתונים ו-${n.p} פרוטוקולים. המשימות: ${where.startsWith('move:') ? 'יועברו לפרויקט "' + dest + '"' : where === 'delete' ? 'יועברו לסל יחד עם הפרויקט' : 'יועברו ל"לא משויך"'}.${keep()}`; }
    else if (kind === 'person_delete') { const p = store.findPerson(+targetId); label = p.name_he; text = `להעביר לסל את איש הקשר "${p.name_he}"? המשימות שלו יישארו בלי שולח/אחראי.${keep()}`; }
    else if (kind === 'protocol_delete') { const p = db.prepare('SELECT title FROM protocols WHERE id=?').get(+targetId); if (!p) throw missing('הפרוטוקול לא נמצא'); label = p.title; text = `להעביר לסל את הפרוטוקול "${p.title}" עם כל הסעיפים שלו?${keep()}`; }
    else if (kind === 'trash_delete') { if (!bin) throw bad('הסל אינו זמין'); const it = bin.get(+targetId); label = it.title; text = `למחוק סופית מהסל את ${it.kind_he === 'יומן' ? 'פריט היומן' : it.kind_he} "${it.title}"? אי אפשר לשחזר אחרי זה.`; }
    else if (kind === 'trash_empty') { if (!bin) throw bad('הסל אינו זמין'); const n = bin.count(); if (!n) throw bad('הסל ריק'); label = 'הסל'; text = `לרוקן את הסל? ${n} פריטים יימחקו סופית, ואי אפשר לשחזר אותם.`; }
    else if (kind === 'mail_presence') { // a held deletions check from Outlook (lib/presence.js): only the server asks this, never the assistant's API
      if (opts.internal !== INTERNAL) throw bad('סוג בקשה לא מוכר');
      const pl = opts.payload || {}; label = `${pl.n} מיילים`;
      text = `Alex Link דיווח ש-${pl.n} מיילים מתוך ${pl.checked} מהשבועיים האחרונים כבר לא נמצאים ב-Outlook. זה הרבה מדי בבת אחת, אז לא העברתי אותם לסל: אולי זו תקלה בסנכרון. אם מחקת אותם ב-Outlook בכוונה, לחץ "כן, העבר לסל". אם לא, אין צורך לעשות דבר: האתר לא ישתנה.${keep()}`;
    }
    else throw bad('סוג בקשה לא מוכר');
    const id = q('INSERT INTO confirmations (kind, target_id, payload, text, status, created_at) VALUES (?,?,?,?,?,?)').run(kind, +targetId, JSON.stringify(opts.payload || {}), text, 'open', now()).lastInsertRowid;
    // the message is the assistant's (scoped to the task when it is in a task run)
    const m = chat.sendChat(actor, { text });
    q('UPDATE chat_messages SET confirm_id=?, tg_sent=0 WHERE id=?').run(id, m.id); q('UPDATE confirmations SET chat_message_id=? WHERE id=?').run(m.id, id);
    return { id, message_id: m.id, text, label };
  }
  // the owner's answer. yes -> execute now
  function answer(ownerActor, id, yes) {
    const c = get(id); if (c.status !== 'open') return { ...c, payload: undefined };
    if (!yes) { q("UPDATE confirmations SET status='no', decided_at=? WHERE id=?").run(now(), id); return { id, status: 'no' }; }
    let result;
    try {
      if (c.kind === 'task_delete') result = taskdel.purge(ownerActor, c.target_id);
      else if (c.kind === 'project_delete') { if (!purge) throw bad('מחיקה אינה זמינה'); result = purge.project(ownerActor, c.target_id, JSON.parse(c.payload || '{}')); }
      else if (c.kind === 'person_delete') { if (!purge) throw bad('מחיקה אינה זמינה'); result = purge.person(ownerActor, c.target_id); }
      else if (c.kind === 'protocol_delete') { if (!purge) throw bad('מחיקה אינה זמינה'); result = purge.protocol(ownerActor, c.target_id); }
      else if (c.kind === 'trash_delete') { if (!bin) throw bad('הסל אינו זמין'); result = bin.destroy(ownerActor, c.target_id); }
      else if (c.kind === 'trash_empty') { if (!bin) throw bad('הסל אינו זמין'); result = bin.empty(ownerActor); }
      else if (c.kind === 'mail_presence') { if (!bin) throw bad('הסל אינו זמין'); result = require('./presence').createPresence({ db, store, trash: bin }).applyHeld(c); }
    } catch (e) { q("UPDATE confirmations SET status='failed', decided_at=?, result=? WHERE id=?").run(now(), JSON.stringify({ error: e.message }), id); return { id, status: 'failed', error: e.message }; }
    q("UPDATE confirmations SET status='yes', decided_at=?, result=? WHERE id=?").run(now(), JSON.stringify(result), id);
    return { id, status: 'yes', result };
  }
  const YES = { mail_presence: 'כן, העבר לסל' };
  const view = (id) => { const c = get(id); return { id: c.id, kind: c.kind, text: c.text, status: c.status, decided_at: c.decided_at, result: c.result ? JSON.parse(c.result) : null, yes_label: YES[c.kind] || 'כן, למחוק', no_label: 'לא' }; };
  return { ask, answer, get: view };
}
module.exports = { createConfirm, INTERNAL };
