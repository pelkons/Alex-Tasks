'use strict';
// Remove all working data (tasks, emails, chat, files, knowledge, runs, non-default projects). Keeps seeds, settings and login.
const fs = require('fs'), path = require('path');
const { open } = require('../lib/db');
const target = process.env.MESIMOT_DB;
if (!target || path.resolve(target) === path.resolve(__dirname, '..', 'data', 'mesimot.db')) {
  console.error('refusing: set MESIMOT_DB to a test database (the real one is never cleared)'); process.exit(1);
}
const db = open(target);
db.pragma('foreign_keys = OFF');
db.transaction(() => {
  for (const t of ['events', 'notes', 'drafts', 'attention', 'chunks', 'files', 'knowledge', 'chat_messages', 'claude_runs', 'tasks', 'emails']) db.exec(`DELETE FROM ${t}`);
  db.exec('DELETE FROM projects WHERE is_default=0');
  db.exec("DELETE FROM people WHERE id > 6");
  db.exec('DELETE FROM search_index');
  db.exec("UPDATE projects SET summary_he='' ");
})();
for (const d of [process.env.MESIMOT_FILES, process.env.MESIMOT_RUN_LOG]) if (d && d.startsWith('/tmp/')) fs.rmSync(d, { recursive: true, force: true });
console.log('cleared');
