'use strict';
// Insert a realistic forwarded Hebrew Outlook email through the normal intake path (test fixture, nothing is sent).
const path = require('path');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { ingestMessage } = require('../lib/email');
if (!process.env.MESIMOT_DB) { console.error('set MESIMOT_DB to a test database'); process.exit(1); }
const db = open(process.env.MESIMOT_DB);
const store = createStore(db);
const id = 'fixture:' + Date.now();
const r = ingestMessage(db, store, {
  message_id: id,
  from: 'דנה <dana@exconstruct.example>',
  to: ['assistant@agentmail.example'],
  subject: 'FW: חריגות בתקציב רבעון 4 - מגדל הנוף',
  timestamp: new Date().toISOString(),
  labels: ['received', 'mesimot'],
  attachments: [{ filename: 'חריגות-רבעון-4.xlsx', content_type: 'application/vnd.ms-excel', size: 20480 }],
  text: `דנה, לטיפולך בבקשה.

‏________________________________
‏מאת: יעל רוזן <arnon.fridman@exconstruct.example>
‏נשלח: יום ראשון, 22 בנובמבר 2026 16:20
‏אל: דנה לוי <dana@exconstruct.example>
‏עותק: רון שחר <guy.cohen@exconstruct.example>
‏נושא: חריגות בתקציב רבעון 4 - מגדל הנוף

שלום דנה,

בבדיקה שעשיתי עולה חריגה של כ-7% בסעיף החשמל בפרויקט מגדל הנוף (קבלן החשמל - אור הדוגמה).
אני צריך שתבדוק את חריגות התקציב מול הקבלן ותחזיר לי תשובה מסודרת עד יום חמישי,
כי אני מציג את זה בישיבת ההנהלה. מצורף קובץ הנתונים.

בברכה,
יעל`,
});
console.log(JSON.stringify({ email_id: r.id, original_from: r.parsed?.from, original_date: r.parsed?.date }));
