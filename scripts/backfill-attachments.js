'use strict';
// Downloads the attachments of stored AgentMail emails that have none yet. MESIMOT_DB=<db> node scripts/backfill-attachments.js [emailId,...]
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { downloadAttachments, fetchMessage } = require('../lib/email');
const db = open(process.env.MESIMOT_DB);
const store = createStore(db), knowledge = createKnowledge(db, store);
const only = (process.argv[2] || '').split(',').map(Number).filter(Boolean);
(async () => {
  for (const e of db.prepare("SELECT id, message_id FROM emails WHERE message_id NOT LIKE 'fixture:%' AND message_id NOT LIKE 'upload:%' ORDER BY id").all()) {
    if (only.length && !only.includes(e.id)) continue;
    if (db.prepare('SELECT 1 FROM files WHERE email_id=?').get(e.id)) { console.log(`email ${e.id}: already has files`); continue; }
    try {
      const msg = await fetchMessage(e.message_id);
      const saved = await downloadAttachments(db, store, knowledge, e.id, msg, console.log);
      console.log(`email ${e.id}: ${saved.length} files stored (${saved.map((f) => `${f.original_name}:${f.text_status}`).join(', ')})`);
    } catch (x) { console.log(`email ${e.id}: ${x.message}`); }
  }
})();
