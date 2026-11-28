'use strict';
// Deleting a task moves it to the RECYCLE BIN (lib/trash.js): its notes, drafts, email links, decisions, attention items and task-scoped chat leave the live tables and the
// search/vector index, and a snapshot of them is kept in the encrypted database until the bin is emptied or the item expires (setting trash_days, default 60).
// `restore` takes the trash id (the old 30-second token is now the trash id, so the "בטל" button and Telegram's undo keep working).
const { createTrash } = require('./trash');

function createTaskDelete({ db, store, trash = null }) {
  const bin = trash || createTrash({ db, store });
  const purge = (actor, id) => bin.trashTask(actor, id);
  const restore = (actor, token) => bin.restore(actor, +token);
  return { purge, restore, trash: bin };
}
module.exports = { createTaskDelete };
