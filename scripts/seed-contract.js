'use strict';
// TEST DB only: an email with an attached contract (file + chunks), the document uses different words than the questions of the regression scenario.
process.env.MESIMOT_DB = '/tmp/mesimot-test/test.db';
const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { now } = require('../lib/db');
const db = open('/tmp/mesimot-test/test.db'); const store = createStore(db);
const exists = db.prepare("SELECT id FROM files WHERE original_name LIKE 'חוזה מכר חדר שנאים%'").get(); if (exists) { console.log(JSON.stringify({ file: exists.id, email: db.prepare('SELECT email_id e FROM files WHERE id=?').get(exists.id).e })); process.exit(0); }
const emailId = db.prepare("INSERT INTO emails (message_id, from_addr, to_addr, subject, received_at, body_text, forwarded_from, attachments, labels, participants, thread, thread_key, project_numbers, mail_provider, forwarded_date, original_subject) VALUES ('<seed-contract@test>','owner@test','alex@test','FW: הוצאה לחתימות - מגדל הנוף',?, 'צירפתי את החוזה החתום לחדר השנאים של חברת החשמל במגדל הנוף. נא לטפל בהמשך.','avi@example.com','[]','[]','[]','[]','seed-contract','[]','test',?,'הוצאה לחתימות - מגדל הנוף')").run('2026-11-20T08:00:00Z', '2026-11-19T10:00:00Z').lastInsertRowid;
const fid = db.prepare("INSERT INTO files (original_name, path, mime, size, source, created_at, email_id, text_status) VALUES (?,?,?,?,?,?,?,?)").run('חוזה מכר חדר שנאים מגדל הנוף.docx', '/tmp/none.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1000, 'email', now(), emailId, 'ok').lastInsertRowid;
const parts = [
  'חוזה מכר ופיתוח\nבין: חברת החשמל לישראל בע"מ (להלן: "החברה") לבין: מגדל הנוף יזמות בע"מ (להלן: "המוכר").\nהואיל והמוכר הינו הבעלים של מגרש 112 בגוש 7001 ברחוב הים 4 תל אביב, והחברה מעוניינת ברכישת זכויות להקמת חדר שנאים ביעוד תשתית.',
  'סעיף 3 - הצהרות המוכר. המוכר מצהיר כי המקרקעין נקיים מכל שעבוד. הקמת החדר תבוצע בהתאם להיתר בנייה מספר 2026-0451 ולתוכנית מספר תא/4040.',
  'סעיף 9.1 - התמורה. התמורה עבור החדר, קרקע ובנייה לשנאי אחד, תעמוד על סך של 182,643.30 ש"ח (מאה שמונים ושניים אלף שש מאות ארבעים ושלושה שקלים חדשים ושלושים אגורות) בתוספת מע"מ כדין. התמורה תשולם בתנאי שוטף + 45 ממועד מילוי התנאים המתלים.',
  'סעיף 12 - מסירה. המוכר ימסור את החדר לחברה עד ליום 30.6.2027. עיכוב במסירה יזכה את החברה בפיצוי מוסכם בסך 500 ש"ח ליום.',
];
parts.forEach((t, i) => db.prepare('INSERT INTO chunks (file_id, idx, text, page) VALUES (?,?,?,?)').run(fid, i, t, i < 2 ? 1 : 2));
if (!store.listProjects().some((p) => p.name_he === 'מגדל הנוף')) store.createProject(store.ownerId(), { name: 'מגדל הנוף' });
console.log(JSON.stringify({ file: fid, email: emailId }));
