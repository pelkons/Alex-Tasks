'use strict';
// Speed of the "דואר" tab API on a synthetic mailbox:  node scripts/bench-mail.js [mails=25000] [bodyKb=6]
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'), path = require('path'), fs = require('fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-bench-mail-')); process.env.MESIMOT_DB_KEY_FILE = path.join(dir, 'db.key');
const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createSearch } = require('../lib/search'); const { createMailList } = require('../lib/maillist');
const { seedMail } = require('../test/helpers/mailseed');
const n = +process.argv[2] || 25000, kb = +process.argv[3] || 6;
const db = open(path.join(dir, 'bench.db')); const store = createStore(db);
const pr = [1, 2, 3].map((i) => Number(db.prepare("INSERT INTO projects (name_he, color, created_at) VALUES (?, '#2563eb', '2026-01-01')").run('פרויקט ' + i).lastInsertRowid));
let t = Date.now(); seedMail(db, { live: Math.round(n * 0.1), archive: Math.round(n * 0.9), bodyKb: kb, projects: pr }); console.log(`seeded ${n} mails (${kb} KB bodies) in ${Date.now() - t} ms, db ${(fs.statSync(path.join(dir, 'bench.db')).size / 1e6).toFixed(0)} MB`);
db.exec('ANALYZE');
const ml = createMailList({ db, store, searcher: createSearch(db), semantic: null });
async function time(label, fn, reps = 5) { const ts = []; let r; for (let i = 0; i < reps; i++) { const s = process.hrtime.bigint(); r = await fn(); ts.push(Number(process.hrtime.bigint() - s) / 1e6); } ts.sort((a, b) => a - b); console.log(label.padEnd(58), `median ${ts[Math.floor(reps / 2)].toFixed(1)} ms, worst ${ts[reps - 1].toFixed(1)} ms`, r && r.items ? `(${r.items.length} rows)` : ''); return r; }
(async () => {
  const first = await time('threads, first page (50) + total', () => ml.list({ limit: 50 }));
  let cur = first.next; for (let i = 0; i < 200 && cur; i++) cur = (await ml.list({ limit: 50, before: cur })).next;
  await time('threads, page 200 deep (keyset)', () => ml.list({ limit: 50, before: cur }));
  await time('all mails, first page', () => ml.list({ limit: 50, mode: 'all' }));
  await time('folder=out (sent), threads', () => ml.list({ limit: 50, folder: 'out' }));
  await time('project filter, threads', () => ml.list({ limit: 50, project: pr[1] }));
  await time('with attachments, threads', () => ml.list({ limit: 50, att: '1' }));
  await time('not linked to a task, threads', () => ml.list({ limit: 50, linked: '0' }));
  await time('date range (last 30 days), threads', () => ml.list({ limit: 50, from: '2026-10-01', to: '2026-11-27' }));
  await time('person (a rare address), threads', () => ml.list({ limit: 50, person: 'dana3@corp.example.test' }));
  await time('person that does not exist (worst case: full scan)', () => ml.list({ limit: 50, person: 'nobody@nowhere.test' }), 3);
  await time('search "פלדת זיון" (keyword layer)', () => ml.list({ q: 'פלדת זיון' }), 3);
  await time('search, one rare word', () => ml.list({ q: 'שנים 4' }), 3);
  await time('conversation of one mail', () => ml.thread(first.items[0].id));
  console.log(db.prepare("EXPLAIN QUERY PLAN SELECT e.id FROM emails e WHERE e.dup_of IS NULL AND COALESCE(e.import_state,'')<>'container' AND (e.thread_key IS NULL OR e.thread_key='' OR e.id=(SELECT x.id FROM emails x WHERE x.thread_key=e.thread_key AND x.dup_of IS NULL ORDER BY COALESCE(x.forwarded_date,x.received_at) DESC, x.id DESC LIMIT 1)) ORDER BY COALESCE(e.forwarded_date,e.received_at) DESC, e.id DESC LIMIT 51").all().map((r) => r.detail).join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
})();
