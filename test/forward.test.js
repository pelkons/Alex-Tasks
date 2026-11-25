'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseForwarded, parseDate, isForwardSubject } = require('../lib/forward');

const HE_OUTLOOK = `‏

תוכל לטפל בזה בהקדם? תודה

‏________________________________
‏מאת: יעל רוזן <arnon.fridman@exconstruct.example>
‏נשלח: יום ראשון, 22 בנובמבר 2026 16:20
‏אל: דנה לוי <dana@exconstruct.example>
‏עותק: רון שחר <guy.cohen@exconstruct.example>
‏נושא: RE: חריגות בתקציב רבעון 4 - מגדל הנוף

שלום דנה,
נדרש לבדוק את חריגות התקציב ולהחזיר לי תשובה עד יום חמישי.
בברכה,
יעל

‏מאת: אבי כהן <amir.brown@exconstruct.example>
‏נשלח: יום חמישי, 19 בנובמבר 2026 9:05
‏אל: יעל רוזן
‏נושא: תקציב רבעון 4

הרצאה ישנה יותר`;

test('Hebrew Outlook: takes the newest message in the chain', () => {
  const r = parseForwarded(HE_OUTLOOK, 'FW: חריגות בתקציב רבעון 4 - מגדל הנוף');
  assert.equal(r.forwarded, true);
  assert.equal(r.from_name, 'יעל רוזן');
  assert.equal(r.from_addr, 'arnon.fridman@exconstruct.example');
  assert.equal(r.date, '2026-11-22T14:20:00.000Z'); // 16:20 Jerusalem, UTC+2
  assert.equal(r.subject, 'חריגות בתקציב רבעון 4 - מגדל הנוף');
  assert.match(r.body, /עד יום חמישי/);
  assert.ok(!/הרצאה ישנה/.test(r.body));
  assert.equal(r.chain.length, 2);
  assert.equal(r.chain[1].from_name, 'אבי כהן');
});

test('English Outlook with PM time', () => {
  const body = `FYI

From: Avi Cohen <amir.brown@exconstruct.example>
Sent: Monday, November 23, 2026 2:05 PM
To: Dana P <dana@exconstruct.example>
Subject: Site measurements

Please schedule the survey.`;
  const r = parseForwarded(body, 'Fwd: Site measurements');
  assert.equal(r.from_name, 'Avi Cohen');
  assert.equal(r.date, '2026-11-23T12:05:00.000Z');
  assert.equal(r.subject, 'Site measurements');
});

test('Outlook Hebrew with 24h time and numeric date, mailto form', () => {
  const body = `מאת: מיכל גלעד [mailto:michal@example.com]
נשלח: 24/11/2026 07:50
אל: דנה
נושא: לוחות חשמל

אפשר לאשר?`;
  const r = parseForwarded(body, 'הועבר: לוחות חשמל');
  assert.equal(r.from_name, 'מיכל גלעד');
  assert.equal(r.from_addr, 'michal@example.com');
  assert.equal(r.date, '2026-11-24T05:50:00.000Z');
});

test('Gmail Hebrew forward block with abbreviated month', () => {
  const body = `---------- הודעה שהועברה ----------
מאת: יעל רוזן <yael@example.com>
תאריך: יום ג׳, 24 בנוב׳ 2026 בשעה 7:50
נושא: סיכום ישיבה
אל: דנה <dana@example.com>

סיכום מצורף`;
  const r = parseForwarded(body, 'Fwd: סיכום ישיבה');
  assert.equal(r.from_name, 'יעל רוזן');
  assert.equal(r.date, '2026-11-24T05:50:00.000Z');
});

test('Gmail English forward block', () => {
  const body = `---------- Forwarded message ---------
From: Yael Rosen <yael@example.com>
Date: Mon, Nov 23, 2026 at 2:05 PM
Subject: Budget
To: <dana@example.com>

Hello`;
  const r = parseForwarded(body, 'Fwd: Budget');
  assert.equal(r.from_addr, 'yael@example.com');
  assert.equal(r.date, '2026-11-23T12:05:00.000Z');
});

test('summer time uses UTC+3', () => {
  assert.equal(parseDate('יום שני, 13 ביולי 2026 10:00'), '2026-07-13T07:00:00.000Z');
});

test('no forward block: not forwarded', () => {
  const r = parseForwarded('תזכיר לי לבדוק משהו', 'משהו');
  assert.equal(r.forwarded, false);
  assert.equal(r.date, null);
});

test('forward subjects', () => {
  for (const s of ['FW: x', 'Fwd: x', 'הועבר: x', 'הודעה שהועברה: x']) assert.ok(isForwardSubject(s), s);
  assert.ok(!isForwardSubject('שלום'));
});

const REAL_SAMPLE = `

דנה

לוי
​​​​​
מנהל אזור
הנדסה
0546119849<tel:0546119849>
dana@exconstruct.example<mailto:dana@exconstruct.example>

[cid:image013.png@01DD7B71.94478960]<https://eu.content.exclaimer.net/?url=https%3A%2F%2Fwww.youtube.com>

מאת: Noa Sharon <noa@lawfirm.example>
נשלח: Monday, 23 November 2026 17:40
אל: rachel@utility.example
עותק: Dana Levi‏ <dana@exconstruct.example>; Yossi Katz‏ <yossi@lawfirm.example>; Michal Gilad‏ <michalg@exconstruct.example>
נושא: הוצאה לחתימות - מגדל הדוגמה 2-4 תל אביב יפו 100.2000

[CAUTION: This email originated from outside the organization.]

הי רחל,
ראי החוזה המצורף.

נועה`;

test('real Outlook sample: header block with To and Cc lists, RTL marks after names', () => {
  const r = parseForwarded(REAL_SAMPLE, 'FW: הוצאה לחתימות - מגדל הדוגמה 2-4 תל אביב יפו 100.2000');
  assert.equal(r.forwarded, true);
  assert.equal(r.from_name, 'Noa Sharon');
  assert.equal(r.from_addr, 'noa@lawfirm.example');
  assert.equal(r.date, '2026-11-23T15:40:00.000Z');
  assert.equal(r.thread.length, 1);
  assert.deepEqual(r.thread[0].to, [{ name: '', email: 'rachel@utility.example' }]);
  assert.deepEqual(r.thread[0].cc.map((x) => [x.name, x.email]), [['Dana Levi', 'dana@exconstruct.example'], ['Yossi Katz', 'yossi@lawfirm.example'], ['Michal Gilad', 'michalg@exconstruct.example']]);
  assert.ok(!r.participants.some((x) => /[‎‏]/.test(x.name)), 'no hidden RTL marks');
  assert.deepEqual(r.participants.map((x) => x.role + ':' + x.email), ['from:noa@lawfirm.example', 'to:rachel@utility.example', 'cc:dana@exconstruct.example', 'cc:yossi@lawfirm.example', 'cc:michalg@exconstruct.example']);
});

test('thread of several messages: newest first, each with its own to/cc', () => {
  const body = `מאת: יעל רוזן <yael@a.co>
נשלח: יום ראשון, 22 בנובמבר 2026 16:20
אל: דנה <dana@a.co>
עותק: רון שחר <ron@a.co>; מיכל גלעד <michal@a.co>
נושא: RE: תקציב

תשובה

מאת: דנה <dana@a.co>
נשלח: יום חמישי, 19 בנובמבר 2026 9:05
אל: יעל רוזן <yael@a.co>
נושא: תקציב

שאלה`;
  const r = parseForwarded(body, 'FW: תקציב');
  assert.equal(r.thread.length, 2);
  assert.equal(r.thread[0].from_email, 'yael@a.co');
  assert.equal(r.thread[0].cc.length, 2);
  assert.equal(r.thread[1].from_email, 'dana@a.co');
  assert.equal(r.thread[1].date, '2026-11-19T07:05:00.000Z');
  assert.ok(r.participants.some((x) => x.msg_index === 1 && x.role === 'to' && x.email === 'yael@a.co'));
});

test('Gmail style comma separated recipients and quoted names', () => {
  const { splitAddresses } = require('../lib/forward');
  const r = splitAddresses('"Cohen, Ron" <ron@a.co>, Michal M <michal@a.co>, plain@a.co');
  assert.deepEqual(r.map((x) => x.email), ['ron@a.co', 'michal@a.co', 'plain@a.co']);
});

test('plain-text conversion of Outlook html: <addr<mailto:addr>> forms are cleaned', () => {
  const body = `מאת: Noa Sharon <noa@lawfirm.example>
נשלח: Monday, 23 November 2026 17:40
אל: rachel@utility.example
נושא: x

טקסט

From: rachel@utility.example<mailto:rachel@utility.example> <rachel@utility.example<mailto:rachel@utility.example>>
Sent: Monday, November 23, 2026 3:10 PM
To: Noa Sharon‏ <noa@lawfirm.example<mailto:noa@lawfirm.example>>
Cc: dana@exconstruct.example<mailto:dana@exconstruct.example>; Yossi Katz‏ <yossi@lawfirm.example<mailto:yossi@lawfirm.example>>
Subject: RE: x

ישן`;
  const r = parseForwarded(body, 'FW: x');
  assert.equal(r.thread.length, 2);
  assert.equal(r.thread[1].date, '2026-11-23T13:10:00.000Z');
  assert.equal(r.thread[1].from_name, '');
  assert.equal(r.thread[1].from_email, 'rachel@utility.example');
  assert.deepEqual(r.thread[1].to, [{ name: 'Noa Sharon', email: 'noa@lawfirm.example' }]);
  assert.deepEqual(r.thread[1].cc.map((x) => x.email), ['dana@exconstruct.example', 'yossi@lawfirm.example']);
});
