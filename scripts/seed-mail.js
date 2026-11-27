'use strict';
// Fictional mail for the TEST instance (scripts/testenv.sh, port 8111):  eval "$(scripts/testenv.sh env)"; node scripts/seed-mail.js [live=120] [archive=400]
const { open } = require('../lib/db');
const { seedMail } = require('../test/helpers/mailseed');
const dbPath = process.env.MESIMOT_DB;
if (!dbPath || !/mesimot-test/.test(dbPath)) { console.error('refusing: MESIMOT_DB must be the test database (scripts/testenv.sh env)'); process.exit(1); }
const db = open(dbPath);
const now = '2026-11-27T08:00:00.000Z';
let projects = db.prepare('SELECT id FROM projects WHERE is_default=0').all().map((r) => r.id);
if (projects.length < 3) for (const [n, c] of [['מגדלי הנחל', '#2563eb'], ['שכונת הגבעה', '#0d9488'], ['שדרות הדקל', '#d97706']]) projects.push(Number(db.prepare('INSERT INTO projects (name_he, color, created_at) VALUES (?,?,?)').run(n, c, now).lastInsertRowid));
const ids = seedMail(db, { live: +process.argv[2] || 120, archive: +process.argv[3] || 400, projects, owner: 'owner@example.test', end: Date.now() - 3600 * 1000 });
// a few tasks linked to mails
const st = db.prepare('SELECT id FROM statuses ORDER BY id LIMIT 1').get().id, pr = db.prepare('SELECT id FROM priorities ORDER BY id LIMIT 1').get().id;
const nl = +process.argv[2] || 120;
for (const id of [ids[nl - 1], ids[nl - 4], ids[nl - 9], ids[nl + 3], ids[nl + 10], ids[nl + 40]]) {
  const t = db.prepare('INSERT INTO tasks (title, project_id, status_id, priority_id, source_email_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('לבדוק את המסמכים ולהחזיר תשובה', projects[0], st, pr, id, now, now).lastInsertRowid;
  db.prepare("INSERT INTO task_emails (task_id, email_id, relation, created_at) VALUES (?,?,'created',?)").run(t, id, now);
}
db.prepare("INSERT OR IGNORE INTO people (name_he, role, emails, created_at) VALUES ('דנה לוי', 'contact', ?, ?)").run(JSON.stringify(['dana1@corp.example.test']), now);
console.log(`seeded ${ids.length} mails`);
