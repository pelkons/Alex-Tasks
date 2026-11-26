'use strict';
// One-off repair for container .msg/.eml files (one mail file holding many embedded messages) that were stored before embedded messages were
// understood: removes the unreadable extension-less child files and the wrong container rows, re-reads the containers and starts ONE import.
//   node scripts/reprocess-containers.js <file id>,<file id>,...  [--dry]      (uses the configured database; back it up first: it does so itself)
const fs = require('fs');
const path = require('path');
const { open, DEFAULT_DB } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createImporter } = require('../lib/importer');

(async () => {
  const ids = String(process.argv[2] || '').split(',').map(Number).filter(Boolean);
  const dry = process.argv.includes('--dry');
  if (!ids.length) { console.log('usage: node scripts/reprocess-containers.js 11,13,81 [--dry]'); process.exit(1); }
  const dbPath = process.env.MESIMOT_DB || DEFAULT_DB;
  const backup = path.join(path.dirname(dbPath), '..', 'backups', `pre-containers-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  const db = open(dbPath);
  if (!dry) { db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`); console.log('backup:', backup); }
  const store = createStore(db), knowledge = createKnowledge(db, store), chat = createChat(db, store, knowledge);
  const imp = createImporter({ db, store, knowledge, chat });
  const files = ids.map((id) => db.prepare('SELECT * FROM files WHERE id=?').get(id)).filter(Boolean);
  const emailIds = files.map((f) => f.email_id).filter(Boolean);
  // 1. the unreadable children: extension-less, no mime, attached to these containers
  const bogus = emailIds.length ? db.prepare(`SELECT id, path FROM files WHERE email_id IN (${emailIds.join(',')}) AND id NOT IN (${ids.join(',')}) AND original_name NOT LIKE '%.%' AND COALESCE(mime,'') = ''`).all() : [];
  console.log(`containers: ${files.length}; unreadable child files to remove: ${bogus.length}; wrong container rows: ${emailIds.length}`);
  if (dry) process.exit(0);
  const owner = store.ownerId(), assistant = store.assistantId();
  chat.sendChat(assistant, { text: `מצאתי את הבעיה: הקבצים מכילים הודעות מקוננות שלא נפתחו. אני מעבד עכשיו מחדש את כל ~570 ההודעות, זה ייקח זמן, אעדכן בסיכום.\nתיקון: הסיכום הקודם של הייבוא (״אין משימות חדשות״) נבנה רק מהקבצים החיצוניים ואינו נכון.\n${require('../lib/config').get().assistant.name_he}` });
  db.transaction(() => {
    for (const b of bogus) { db.prepare('DELETE FROM chunks WHERE file_id=?').run(b.id); db.prepare('DELETE FROM files WHERE id=?').run(b.id); }
    for (const id of emailIds) { for (const t of ['task_emails', 'mentions']) { try { db.prepare(`DELETE FROM ${t} WHERE ${t === 'mentions' ? "source_type='email' AND source_id" : 'email_id'}=?`).run(id); } catch { /* table shape differs */ } } db.prepare('DELETE FROM emails WHERE id=?').run(id); }
    for (const f of files) db.prepare('UPDATE files SET email_id=NULL, text_status=NULL WHERE id=?').run(f.id);
  })();
  for (const b of bogus) { try { fs.unlinkSync(b.path); } catch { /* already gone */ } }
  // 2. read each container again with the embedded-message support (its messages are staged)
  for (const f of files) {
    const t0 = Date.now();
    await knowledge.indexFile(owner, f.id, { stage: true });
    const row = db.prepare('SELECT email_id FROM files WHERE id=?').get(f.id);
    const n = db.prepare("SELECT COUNT(*) c FROM emails WHERE container_id=? AND import_state='staged'").get(row.email_id).c;
    console.log(`${f.original_name}: ${n} embedded messages (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  const fresh = ids.map((id) => ({ id, email_id: db.prepare('SELECT email_id FROM files WHERE id=?').get(id).email_id }));
  const { id } = imp.startFromFiles(owner, fresh, 'reprocess', { author: 'claude' });
  console.log('import', id, 'started:', JSON.stringify(imp.progress(id)));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
