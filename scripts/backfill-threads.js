'use strict';
// Sets thread_key / project_numbers on emails stored before threads existed. MESIMOT_DB=<db> node scripts/backfill-threads.js
const { open } = require('../lib/db');
const { setKeys } = require('../lib/threads');
const db = open(process.env.MESIMOT_DB);
let n = 0;
for (const e of db.prepare('SELECT id FROM emails WHERE thread_key IS NULL').all()) { setKeys(db, e.id); n++; }
console.log(`thread keys set on ${n} emails`);
