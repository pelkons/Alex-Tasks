'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const { buildMsg } = require('./helpers/msg-builder');
const { parseMailFile, rtfToText } = require('../lib/mailfile');

const DATE = Date.UTC(2026, 10, 22, 14, 20);
const base = { from_name: 'יעל רוזן', from_addr: 'yael@exconstruct.example', to: [{ name: 'דנה', addr: 'dana@exconstruct.example' }], subject: 'חריגות בתקציב רבעון 4', date: DATE };

test('.msg with Unicode Hebrew strings', async () => {
  const r = await parseMailFile(buildMsg({ ...base, body: 'שלום דנה,\nנא לבדוק את החריגות ולהחזיר תשובה עד יום חמישי.' }), 'a.msg');
  assert.equal(r.from_name, 'יעל רוזן');
  assert.equal(r.from_addr, 'yael@exconstruct.example');
  assert.equal(r.subject, 'חריגות בתקציב רבעון 4');
  assert.equal(r.date, '2026-11-22T14:20:00.000Z');
  assert.match(r.body, /עד יום חמישי/);
  assert.match(r.to[0], /dana@exconstruct.example/);
});

test('.msg with ANSI strings in windows-1255', async () => {
  const r = await parseMailFile(buildMsg({ ...base, ansi1255: true, body: 'שלום, הקבלן אור הדוגמה איחר באספקה' }), 'a.msg');
  assert.equal(r.subject, 'חריגות בתקציב רבעון 4');
  assert.equal(r.from_name, 'יעל רוזן');
  assert.match(r.body, /אור הדוגמה איחר/);
});

test('.msg with an HTML-only body is converted to text', async () => {
  const r = await parseMailFile(buildMsg({ ...base, html: '<html><body dir="rtl"><p>שלום,</p><p>נא לאשר את <b>התוכנית</b></p></body></html>' }), 'a.msg');
  assert.match(r.body, /נא לאשר את התוכנית/);
  assert.ok(!/<p>/.test(r.body));
});

test('.msg with attachments, including a nested .msg', async () => {
  const inner = { from_name: 'מיכל גלעד', from_addr: 'michal@example.com', subject: 'הודעה פנימית', body: 'תוכן ההודעה הפנימית', date: Date.UTC(2026, 10, 20, 9, 0), attachments: [{ name: 'פנימי.txt', data: Buffer.from('קובץ בתוך הודעה בתוך הודעה') }] };
  const r = await parseMailFile(buildMsg({ ...base, body: 'ראו מצורף', attachments: [{ name: 'סיכום.txt', data: Buffer.from('סיכום הישיבה') }, { name: 'forwarded.msg', msg: inner }] }), 'a.msg');
  assert.equal(r.attachments.length, 2);
  assert.equal(r.attachments[0].name, 'סיכום.txt');
  assert.equal(r.attachments[0].content.toString(), 'סיכום הישיבה');
  const nested = r.attachments[1];
  assert.equal(nested.nested_msg, true);
  const n = await parseMailFile(nested.content, 'forwarded.msg');
  assert.equal(n.subject, 'הודעה פנימית');
  assert.equal(n.from_name, 'מיכל גלעד');
  assert.equal(n.attachments[0].content.toString(), 'קובץ בתוך הודעה בתוך הודעה');
});

test('.msg with only a compressed-RTF body (uncompressed MELA container), Hebrew in cp1255', async () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg1255\\deff0{\\fonttbl{\\f0 Arial;}}\\pard ' + [...iconv.encode('שלום עולם', 'cp1255')].map((b) => "\\'" + b.toString(16)).join('') + '\\par \\u1511?\\u1489?\\u1500?\\par }';
  assert.equal(rtfToText(rtf).replace(/\s+/g, ' ').trim(), 'שלום עולם קבל');
});

test('.eml: windows-1255 body, base64, with attachment', async () => {
  const body = iconv.encode('שלום דנה\nהקבלן אור הדוגמה מבקש לדחות את האספקה', 'cp1255').toString('base64');
  const eml = [
    'From: =?windows-1255?B?' + iconv.encode('יעל רוזן', 'cp1255').toString('base64') + '?= <yael@exconstruct.example>',
    'To: dana@exconstruct.example', 'Subject: =?utf-8?B?' + Buffer.from('דחיית אספקה').toString('base64') + '?=',
    'Date: Sun, 22 Nov 2026 16:20:00 +0200', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain; charset=windows-1255', 'Content-Transfer-Encoding: base64', '', body, '',
    '--b1', 'Content-Type: text/plain; charset=utf-8; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', 'Content-Transfer-Encoding: base64', '', Buffer.from('הערות').toString('base64'), '', '--b1--', ''].join('\r\n');
  const r = await parseMailFile(Buffer.from(eml), 'x.eml');
  assert.equal(r.from_name, 'יעל רוזן');
  assert.equal(r.subject, 'דחיית אספקה');
  assert.equal(r.date, '2026-11-22T14:20:00.000Z');
  assert.match(r.body, /אור הדוגמה מבקש/);
  assert.equal(r.attachments[0].name, 'notes.txt');
});

test('.eml: HTML-only UTF-8 (new Outlook style)', async () => {
  const html = '<div dir="rtl"><p>שלום,</p><p>נא לשלוח הצעת מחיר</p></div>';
  const eml = ['From: "מיכל גלעד" <michal@exconstruct.example>', 'To: dana@exconstruct.example', 'Subject: הצעת מחיר', 'Date: Mon, 23 Nov 2026 09:05:00 +0200',
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', Buffer.from(html).toString('latin1').replace(/[^\x20-\x7e]/g, (c) => '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))].join('\r\n');
  const r = await parseMailFile(Buffer.from(eml), 'x.eml');
  assert.equal(r.from_name, 'מיכל גלעד');
  assert.match(r.body, /נא לשלוח הצעת מחיר/);
});

test('.msg whose only body is compressed RTF', async () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg1255{\\fonttbl{\\f0 Arial;}}\\pard ' + [...iconv.encode('נא לאשר את התוכנית', 'cp1255')].map((b) => "\\'" + b.toString(16)).join('') + '\\par }';
  const r = await parseMailFile(buildMsg({ ...base, rtf }), 'a.msg');
  assert.match(r.body, /נא לאשר את התוכנית/);
});
