'use strict';
// Deleting a PROJECT (with a disposition for what it holds), a PERSON or a PROTOCOL moves it to the RECYCLE BIN (lib/trash.js), from where it can be restored.
// Reached only through a confirmation the owner answers (lib/confirm.js). Permanent deletion happens only inside the bin.
const { createTrash } = require('./trash');

function createPurge({ db, store, taskdel = null, trash = null }) {
  const bin = trash || (taskdel && taskdel.trash) || createTrash({ db, store });
  return {
    project: (actor, id, payload = {}) => bin.trashProject(actor, id, payload),
    person: (actor, id) => bin.trashPerson(actor, id),
    protocol: (actor, id) => bin.trashProtocol(actor, id),
  };
}
module.exports = { createPurge };
