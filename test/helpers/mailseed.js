'use strict';
// Fictional mail for the "דואר" tab: tests, the test instance and the speed measurement. Deterministic (seeded generator). Live mail is indexed by the database triggers,
// archive mail gets its rows in `search_archive` here (what lib/archive.js does).
const SUBJECTS = ['סיכום ישיבת אתר', 'בקשה לאישור תכניות', 'חשבון חלקי מספר', 'הצעת מחיר לעבודות איטום', 'עדכון לוח זמנים', 'מסמכי היתר', 'תיאום מעליות', 'בדיקת מעבדה לבטון', 'דרישה לתיקון ליקויים', 'אישור תשלום לקבלן', 'שינוי בתכנית חשמל', 'פרוטוקול מסירה'];
const SITES = ['רחוב הדקל 12', 'שכונת הגבעה', 'מגרש 7', 'שדרות הים 4', 'פארק התעשייה', 'רחוב הנחל'];
const FIRST = ['Dana', 'Omer', 'Noa', 'Yossi', 'Lior', 'Maya', 'Gil', 'Tamar', 'Ron', 'Shira'];
const LAST = ['Levi', 'Katz', 'Barak', 'Mizrahi', 'Dahan', 'Peretz', 'Shani', 'Amit'];
const BODY = ['שלום רב, מצורפת התכנית המעודכנת לבדיקתך. נא לאשר עד סוף השבוע.', 'בהמשך לשיחתנו, אבקש לקבל את המסמכים החתומים לפני הישיבה הקרובה.', 'הבדיקה הושלמה והתוצאות תקינות. מצורף דוח מלא.', 'נדרש תיקון בפרט הגמר בקומה השנייה, נא לעדכן את הקבלן.', 'לוח הזמנים המעודכן מצורף. שימו לב לשינוי במועד היציקה.', 'אשמח לתיאום פגישה בשבוע הבא לסגירת הנושאים הפתוחים.'];

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function seedMail(db, { live = 40, archive = 60, bodyKb = 0, owner = 'owner@example.test', seed = 7, end = Date.parse('2026-11-27T12:00:00Z'), projects = [] } = {}) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)];
  const ins = db.prepare(`INSERT INTO emails (message_id, from_addr, to_addr, subject, received_at, body_text, forwarded_from, attachments, project_id, processed_at, forwarded_date, original_subject, labels, participants, direction, import_state, thread_key, archived, text_only, mail_date, file_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,?,?,?,?,?)`);
  const sa = db.prepare('INSERT INTO search_archive (title, body, kind, ref_id, project_id, ts, person) VALUES (?,?,?,?,?,?,?)');
  const insFile = db.prepare("INSERT INTO files (original_name, path, mime, size, source, created_at, email_id, archived, discarded, text_status) VALUES (?,?,?,?, 'email', ?, ?, ?, ?, 'ok')");
  const pad = bodyKb ? ' ' + 'לורם איפסום טקסט למילוי נפח הגוף של ההודעה. '.repeat(Math.ceil(bodyKb * 1024 / 80)) : '';
  const total = live + archive, ids = [];
  const run = db.transaction(() => {
    for (let i = 0; i < total; i++) {
      const isArch = i >= live, sent = r() < 0.18, thr = Math.floor(i / 3 + (isArch ? 5000 : 0));       // about three mails per conversation
      const subj = `${SUBJECTS[thr % SUBJECTS.length]} - ${SITES[(thr >> 1) % SITES.length]} ${thr}`;
      const who = `${pick(FIRST)} ${pick(LAST)}`, em = `${who.split(' ')[0].toLowerCase()}${(i % 7)}@corp.example.test`, other = `${pick(FIRST)} ${pick(LAST)} <${pick(FIRST).toLowerCase()}${i % 5}@corp.example.test>`;
      const date = new Date(isArch ? end - 20 * 86400000 - (total - i) * 30 * 60 * 1000 : end - (live - i) * 37 * 60 * 1000).toISOString();   // live mail is the newest, the archive is older
      const from = sent ? `Owner Example <${owner}>` : `${who} <${em}>`, to = sent ? other : `Owner Example <${owner}>, ${other}`;
      const hasAtt = r() < 0.3, atts = hasAtt ? [{ filename: `מסמך ${i}.pdf`, content_type: 'application/pdf', size: 12000 + i, file_id: null }] : [];
      const subject = (i % 3 ? 'RE: ' : '') + subj, body = `${pick(BODY)} ${pick(BODY)} ${subj}${i % 11 === 0 ? ' פלדת זיון' : ''}${pad}`;
      const proj = projects.length && r() < 0.6 ? pick(projects) : null;
      const e = ins.run(`<seed-${seed}-${i}@example.test>`, from, to, subject, isArch ? new Date(end - 3600000).toISOString() : date, body, from, JSON.stringify(atts), proj, date, date, subject.replace(/^RE: /, ''),
        JSON.stringify([{ role: 'from', name: sent ? 'Owner Example' : who, email: sent ? owner : em }]), sent ? 'sent' : 'received', isArch ? 'archived' : 'done', subj.toLowerCase(), isArch ? 1 : 0, isArch && i % 2 ? 1 : 0, date, null);
      const id = Number(e.lastInsertRowid); ids.push(id);
      if (isArch) sa.run(subject, body, 'email', id, proj, date, from);
      if (hasAtt) insFile.run(`מסמך ${i}.pdf`, `/x/${i}`, 'application/pdf', 12000 + i, date, id, isArch ? 1 : 0, isArch && i % 2 ? 1 : 0);
    }
  });
  run();
  return ids;
}

module.exports = { seedMail };
