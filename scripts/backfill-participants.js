'use strict';
// Fills emails.participants/thread for emails stored before those columns existed, and adds the contacts.
// Usage: MESIMOT_DB=<db> node scripts/backfill-participants.js     (back the database up first)
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { parseForwarded, threadFromHeaders } = require('../lib/forward');
const { ensureContacts } = require('../lib/email');
const db = open(process.env.MESIMOT_DB);
const store = createStore(db);
let n = 0;
const force = process.argv.includes('--force');
for (const e of db.prepare(force ? 'SELECT * FROM emails' : "SELECT * FROM emails WHERE participants IS NULL OR participants = ''").all()) {
  const p = parseForwarded(e.body_text, e.subject);
  const meta = p.forwarded ? p : threadFromHeaders({ from: e.from_addr, to: (e.to_addr || '').split(','), date: e.received_at, subject: e.subject });
  db.prepare('UPDATE emails SET participants=?, thread=? WHERE id=?').run(JSON.stringify(meta.participants), JSON.stringify(meta.thread), e.id);
  const made = ensureContacts(db, store, meta.participants);
  console.log(`email ${e.id}: ${meta.participants.length} participants, ${made.length} new contacts${made.map((m) => ' ' + m.name_he).join(',')}`);
  n++;
}
console.log(`backfilled ${n}`);
