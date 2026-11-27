'use strict';
// TEST DB only (scripts/testenv.sh): one realistic, fully fictional project for the project-page UI check: passport, statuses per process (one by the owner),
// ~40 facts over every topic (some superseded), protocols, open tasks with people, files and mails. Prints the project id.
const DB = process.env.MESIMOT_DB || '/tmp/mesimot-test/test.db';
if (!/mesimot-test/.test(DB)) { console.error('refusing: seed only the test database'); process.exit(1); }
process.env.MESIMOT_DB = DB;
const { open, now } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createKnowledge } = require('../lib/knowledge'); const { createProtocols } = require('../lib/protocols');
const db = open(DB); const store = createStore(db); const knowledge = createKnowledge(db, store);
const protocols = createProtocols(db, store, knowledge, { addItem() {}, addFromProtocol() {} });
const owner = store.ownerId(), a = store.assistantId();
const NAME = 'מגדל הדוגמה';
let p = store.listProjects().find((x) => x.name_he === NAME);
if (p) { console.log(JSON.stringify({ project: p.id, existed: true })); process.exit(0); }
p = store.createProject(owner, { name: NAME, aliases: ['פרויקט 100.2000', 'הדוגמה 3'] });
store.updateProject(owner, p.id, { summary: 'פרויקט התחדשות עירונית (תמ"א 38/2) ברחוב הדוגמה 3: הריסה ובנייה מחדש של שני בניינים, 8 ו-12 קומות, 58 דירות חדשות במקום 24 קיימות. השלד בקומה 7, היתר שינויים בבדיקה בעירייה, השיווק פתוח.' });

const mail = (subject, body, date, from = 'רון לוי <ron@contractor.example>') => db.prepare("INSERT INTO emails (message_id, from_addr, to_addr, subject, original_subject, received_at, forwarded_date, body_text, project_id, forwarded_from, labels, participants, thread) VALUES (?,?,?,?,?,?,?,?,?,?,'[]','[]','[]')")
  .run(`<seed-pp-${Math.random()}@test>`, from, 'owner@test', subject, subject, date + 'T08:00:00Z', date + 'T08:00:00Z', body, p.id, from).lastInsertRowid;
const e1 = mail('פרוגרמה מעודכנת - מגדל הדוגמה', 'מצורפת פרוגרמה מעודכנת: 2 בניינים, 8 ו-12 קומות, 58 יח"ד חדשות, 24 יח"ד קיימות.', '2026-10-12', 'שרה אדריכלים <sara@arch.example>');
const e2 = mail('סטטוס שלד שבועי', 'השלד בקומה 7. ממתינים לתוכניות קורות קומות 7-8 מהקונסטרוקטור.', '2026-11-24');
const e3 = mail('היתר שינויים - בדיקה מרחבית', 'הבקשה להיתר שינויים נקלטה במכון הבקרה, צפי לדיון בוועדה המקומית בדצמבר.', '2026-11-18', 'דנה כהן <dana@permits.example>');
const e4 = mail('דוח מכירות נובמבר', 'נמכרו 41 מתוך 58 דירות. נותרו 17 דירות, בעיקר 5 חדרים.', '2026-11-25', 'מיכל שיווק <michal@sales.example>');
const e5 = mail('חשבון 10/26', 'מצורף חשבון 10/26 לאישור: 2,804,542.50 ש"ח.', '2026-11-20');

const people = [
  ['רון לוי', 'מנהל עבודה', 'בוני הדוגמה בע"מ', 'ron@contractor.example'], ['שרה אדריכלים', 'אדריכלית הפרויקט', 'שרה אדריכלים', 'sara@arch.example'],
  ['דנה כהן', 'מלווה רישוי', 'רישוי בע"מ', 'dana@permits.example'], ['מיכל ברק', 'מנהלת שיווק', 'שיווק פלוס', 'michal@sales.example'], ['יוסי קונסט', 'קונסטרוקטור', 'הנדסה וקונסטרוקציה', 'yossi@eng.example'],
].map(([name, role_text, company, email]) => store.listPeople().find((x) => x.name_he === name) || store.createPerson(owner, { name, role_text, company, emails: email }));

knowledge.profile.setProfile(a, { project: p.id, buildings: 2, floors: '8, 12', units_new: 58, units_existing: 24, track: 'תמ"א 38/2 (הריסה ובנייה)', as_of: '2026-10-12', source: `email:${e1}` });
knowledge.profile.setProfile(a, { project: p.id, contractor: 'בוני הדוגמה בע"מ', as_of: '2026-11-24', source: `email:${e2}` });
knowledge.profile.setProfile(owner, { project: p.id, architect: 'שרה אדריכלים' });
knowledge.profile.setStatus(a, { project: p.id, process: 'construction', text: 'שלד בקומה 7 בבניין ב׳; ממתינים לתוכניות קורות קומות 7-8 מהקונסטרוקטור', as_of: '2026-11-24', source: `email:${e2}` });
knowledge.profile.setStatus(a, { project: p.id, process: 'permit', text: 'בקשה להיתר שינויים נקלטה במכון הבקרה; צפי לדיון בוועדה המקומית בדצמבר', as_of: '2026-11-18', source: `email:${e3}` });
knowledge.profile.setStatus(a, { project: p.id, process: 'marketing', text: 'נמכרו 41 מתוך 58 דירות; נותרו 17, בעיקר 5 חדרים', as_of: '2026-11-25', source: `email:${e4}` });
knowledge.profile.setStatus(owner, { project: p.id, process: 'design', text: 'תכנון מפורט הושלם; נותרו תוכניות קורות 7-8 ופרטי חזיתות HPL', as_of: '2026-11-26' });

const F = (key, value, as_of, source, topic) => knowledge.setFact(a, { project: p.id, key, value, as_of, source, topic });
const facts = [
  ['גוש/חלקה', 'גוש 7001, חלקה 112', '2026-10-12', `email:${e1}`, 'permit'], ['תוכנית מפורטת', 'תא/4040, תמ"א 38/2', '2026-10-12', `email:${e1}`, 'permit'],
  ['מס׳ היתר', '2026-0451', '2026-09-01', `email:${e3}`, 'permit'], ['היתר שינויים', 'נקלט במכון הבקרה, בדיקה מרחבית', '2026-11-18', `email:${e3}`, 'permit'],
  ['מועד טופס 4 חוזי', '03/2028', '2026-10-12', `email:${e1}`, 'permit'], ['ערבות עוגנים', 'שוחררה על ידי העירייה', '2026-11-15', `email:${e3}`, 'permit'],
  ['סטטוס שלד', 'קומה 7 בבניין ב׳, ממתין לתוכניות קורות 7-8', '2026-11-24', `email:${e2}`, 'construction'], ['תוכניות ברזל', 'התקבלו 22/11, אספקה בסוף השבוע', '2026-11-23', `email:${e2}`, 'construction'],
  ['בקרת בטיחות', 'רבעונית; האחרונה 08/11 ללא ליקויים מהותיים', '2026-11-10', `email:${e2}`, 'construction'], ['עבודות חשמל דירתיות', 'החלו בבניין א׳', '2026-11-12', `email:${e2}`, 'construction'],
  ['מועד סיום חוזי לקבלן', '06/03/2028 (31 חודשי ביצוע)', '2026-10-12', `email:${e1}`, 'construction'], ['רצפת מחסן חניה 10', 'נוצקה בגובה שגוי; פרט תיקון מהקונסטרוקטור', '2026-11-12', `email:${e2}`, 'construction'],
  ['סט תוכניות מכר', 'עדכון 19/11 (לוח חשמל דירה 2B)', '2026-11-19', `email:${e1}`, 'design'], ['חזיתות HPL', 'חזית דרומית אושרה עקרונית; ממשיכים לשאר החזיתות', '2026-11-18', `email:${e1}`, 'design'],
  ['מעקות גג', 'גובה 105 ס״מ לפי השרטוט', '2026-11-26', `email:${e1}`, 'design'], ['תיאום מערכות', 'קומה טיפוסית מתואמת; קומת גג בתיאום', '2026-11-20', `email:${e1}`, 'design'],
  ['חשבון 10/26', '2,804,542.50 ₪ מצטבר, ממתין לאישור', '2026-11-20', `email:${e5}`, 'finance'], ['ערבות ביצוע', '5% מהיקף החוזה, בתוקף עד 06/2028', '2026-10-12', `email:${e1}`, 'finance'],
  ['תמורה חדר שנאים', '182,643.30 ₪ + מע"מ', '2026-11-24', `email:${e1}`, 'finance'], ['עלות שינויי מטבחים', 'כ-19,000 ₪', '2026-11-11', `email:${e4}`, 'finance'],
  ['מכירות', '41 מתוך 58 דירות', '2026-11-25', `email:${e4}`, 'marketing'], ['דירות פנויות', '17, בעיקר 5 חדרים', '2026-11-25', `email:${e4}`, 'marketing'],
  ['איחוד פנטהאוזים 28B+29A', 'ממתין לתשובת הקונסטרוקטור לגבי הקיר', '2026-11-26', `email:${e4}`, 'marketing'],
  ['קבלן ראשי', 'בוני הדוגמה בע"מ, מנהל עבודה רון לוי', '2026-11-24', `email:${e2}`, 'people'], ['אדריכלית', 'שרה אדריכלים, sara@arch.example', '2026-10-12', `email:${e1}`, 'people'],
  ['קונסטרוקטור', 'יוסי קונסט, הנדסה וקונסטרוקציה', '2026-11-24', `email:${e2}`, 'people'], ['מלווה רישוי', 'דנה כהן, רישוי בע"מ', '2026-11-18', `email:${e3}`, 'people'],
  ['יועץ חשמל', 'נדב חשמל', '2026-11-12', `email:${e2}`, 'people'], ['בנק מלווה', 'בנק הדוגמה בע"מ', '2026-10-12', `email:${e1}`, 'other'],
  ['מס׳ פרויקט', '100.2000', '2026-10-12', `email:${e1}`, 'other'],
];
for (const f of facts) F(...f);
// history: older values that were replaced
knowledge.setFact(a, { project: p.id, key: 'מכירות', value: '35 מתוך 58 דירות', as_of: '2026-10-30', source: `email:${e4}` });
knowledge.setFact(a, { project: p.id, key: 'סטטוס שלד', value: 'קומה 5 בבניין ב׳', as_of: '2026-11-03', source: `email:${e2}` });

const T = (title, assignee, requester, due, priority = 'רגיל', email = null) => store.createTask(owner, { title, project: p.id, assignee, requester, due, due_source: 'explicit', priority, source_date: '2026-11-20', email });
const [ron, sara, dana, michal, yossi] = people.map((x) => x.id);
T('להשיג מהקונסטרוקטור תוכניות קורות קומות 7-8', yossi, ron, '2026-11-27', 'דחוף', e2);
T('לאשר חשבון 10/26 של הקבלן', owner, ron, '2026-11-30', 'דחוף', e5);
T('לבדוק מול דנה את מועד הדיון בוועדה המקומית', dana, owner, '2026-12-03');
T('לסגור עם האדריכלית את חלוקת HPL בחזית הצפונית', sara, owner, '2026-12-05');
T('תשובה לרוכשי 28B+29A לגבי איחוד הפנטהאוזים', michal, michal, '2026-12-01');
T('לתאם פיקוח עליון של יועץ החשמל', owner, owner, null, 'נמוך');
T('לעדכן את סט המכר לאחר שינוי לוח החשמל', sara, michal, '2026-12-10');

if (!db.prepare('SELECT 1 FROM protocols WHERE project_id=?').get(p.id)) {
  protocols.addProtocol(owner, { project: p.id, date: '24/11/2026 10:00', title: 'ישיבת תיאום שבועית באתר', participants: 'רון לוי (בוני הדוגמה, מנהל עבודה); שרה אדריכלים; יוסי קונסט', summary: 'התקדמות השלד, תוכניות חסרות לקורות 7-8, חזיתות HPL.', source: `email:${e2}`,
    items: [{ kind: 'action', text: 'להעביר תוכניות קורות 7-8', owner: 'יוסי קונסט', due: '27/11/2026' }, { kind: 'decision', text: 'מעקות גג בגובה 105 ס״מ' }, { kind: 'info', text: 'אספקת ברזל בסוף השבוע' }] });
  protocols.addProtocol(owner, { project: p.id, date: '10/11/2026 09:00', title: 'פגישת שיווק חודשית', participants: 'מיכל ברק (שיווק פלוס)', summary: 'סטטוס מכירות, בקשות שינויים של רוכשים.', source: `email:${e4}`, items: [{ kind: 'action', text: 'לבדוק את בקשת איחוד הפנטהאוזים', owner: 'מיכל ברק' }] });
}
const fileRow = (name, email) => db.prepare("INSERT INTO files (original_name, path, mime, size, project_id, source, created_at, email_id, text_status, summary) VALUES (?,?,?,?,?,?,?,?,?,?)").run(name, '/tmp/none.pdf', 'application/pdf', 120000, p.id, 'email', now(), email, 'ok', 'מסמך לדוגמה').lastInsertRowid;
fileRow('פרוגרמה מעודכנת 10-2026.pdf', e1); fileRow('חשבון 10-26.pdf', e5);
knowledge.addKnowledge(owner, { project: p.id, kind: 'note', title: 'הדיירים ביקשו עדכון חודשי על התקדמות', body: 'לשלוח לנציגות הדיירים עדכון קצר בתחילת כל חודש', source: 'manual' });
console.log(JSON.stringify({ project: p.id }));
