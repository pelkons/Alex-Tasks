'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { open } = require('../lib/db');
const auth = require('../lib/auth');
const { build } = require('../lib/server');

const TOKEN = 'cal-test';
function setup() {
  const db = open(':memory:');
  auth.setPassword(db, 'correct horse battery');
  const app = build({ db, token: TOKEN, loginDelayMs: 0 }); require('./helpers/owner')(app, db, 'correct horse battery');
  return { db, app, h: { authorization: `Bearer ${TOKEN}` } };
}

test('calendar feed: secret token, no login, RFC 5545 structure with a Jerusalem VTIMEZONE', async () => {
  const { app, h } = setup();
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל' } })).json();
  const t1 = (await app.inject({ method: 'POST', url: '/api/tasks', headers: h, payload: { title: 'לבדוק, חוזה; עם ספק', project: p.id, requester: 'יעל רוזן', due: '02/12/2026', due_source: 'estimated', description: 'שורה ראשונה\nשורה שנייה' } })).json();
  const t2 = (await app.inject({ method: 'POST', url: '/api/tasks', headers: h, payload: { title: 'משימה שנסגרה', due: '03/12/2026' } })).json();
  await app.inject({ method: 'PATCH', url: `/api/tasks/${t2.id}`, headers: h, payload: { status: 'הושלם' } });
  await app.inject({ method: 'POST', url: '/api/tasks', headers: h, payload: { title: 'ללא תאריך' } });
  const m = (await app.inject({ method: 'POST', url: '/api/calendar/items', headers: h, payload: { title: 'פגישה עם יעל על התקציב והלוחות זמנים של הפרויקט המשותף ועל חלוקת האחריות בין כל הקבלנים באתר', start: '30/11/2026 10:00', end: '30/11/2026 11:30', location: 'משרדי המזמין, רחוב הנחל 5, תל אביב', project: p.id } })).json();
  assert.equal(m.all_day, false);
  // same meeting twice is one item
  const again = (await app.inject({ method: 'POST', url: '/api/calendar/items', headers: h, payload: { title: m.title, start: '30/11/2026 10:00' } })).json();
  assert.equal(again.id, m.id);
  const summer = (await app.inject({ method: 'POST', url: '/api/calendar/items', headers: h, payload: { title: 'פגישת קיץ', start: '15/07/2027 09:30' } })).json();
  assert.equal(summer.start, '2027-07-15T06:30:00.000Z');

  const { token, url } = (await app.inject({ method: 'GET', url: '/api/calendar/info', headers: h })).json();
  assert.match(url, /\/cal\/[\w-]+\.ics$/);
  assert.equal((await app.inject({ method: 'GET', url: '/cal/wrong.ics' })).statusCode, 404);
  const r = await app.inject({ method: 'GET', url: `/cal/${token}.ics` }); // no cookie, no bearer
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/calendar/);
  const body = r.body;
  // RFC 5545 line rules
  assert.ok(body.endsWith('\r\n') && !/[^\r]\n/.test(body), 'CRLF line endings');
  for (const line of body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line over 75 octets: ${line}`);
  assert.ok(/\r\n [^\r]/.test(body), 'long lines are folded with a leading space');
  // parses with a strict iCalendar parser
  const cal = new ICAL.Component(ICAL.parse(body));
  assert.equal(cal.getFirstPropertyValue('version'), '2.0');
  assert.ok(cal.getFirstPropertyValue('prodid'));
  const tz = cal.getFirstSubcomponent('vtimezone');
  assert.equal(tz.getFirstPropertyValue('tzid'), 'Asia/Jerusalem');
  assert.equal(tz.getAllSubcomponents('daylight').length, 1); assert.equal(tz.getAllSubcomponents('standard').length, 1);
  const events = cal.getAllSubcomponents('vevent').map((e) => new ICAL.Event(e));
  const byUid = Object.fromEntries(events.map((e) => [e.uid, e]));
  assert.ok(byUid[`task-${t1.id}@mesimot`]); assert.ok(!byUid[`task-${t2.id}@mesimot`], 'closed tasks drop out');
  assert.equal(events.filter((e) => e.uid.startsWith('task-')).length, 1, 'tasks without a due date are not listed');
  const te = byUid[`task-${t1.id}@mesimot`];
  assert.match(te.summary, /\(משוער\)/); assert.match(te.summary, /לבדוק, חוזה; עם ספק/);
  assert.ok(te.startDate.isDate, 'a task is an all-day event');
  assert.equal(te.startDate.toString(), '2026-12-02'); assert.equal(te.endDate.toString(), '2026-12-03');
  assert.match(te.description, /שורה ראשונה\nשורה שנייה/);
  const me = byUid[`meeting-${m.id}@mesimot`];
  assert.equal(me.location, 'משרדי המזמין, רחוב הנחל 5, תל אביב');
  assert.equal(me.summary.length > 60, true);
  assert.equal(me.startDate.toString(), '2026-11-30T10:00:00'); assert.equal(me.startDate.zone.tzid, 'Asia/Jerusalem');
  const se = byUid[`meeting-${summer.id}@mesimot`];
  assert.equal(se.startDate.toString(), '2027-07-15T09:30:00');
  // ?only filters
  const tasksOnly = new ICAL.Component(ICAL.parse((await app.inject({ method: 'GET', url: `/cal/${token}.ics?only=tasks` })).body)).getAllSubcomponents('vevent');
  assert.ok(tasksOnly.every((e) => /^task-/.test(e.getFirstPropertyValue('uid'))));
  const meetOnly = new ICAL.Component(ICAL.parse((await app.inject({ method: 'GET', url: `/cal/${token}.ics?only=meetings` })).body)).getAllSubcomponents('vevent');
  assert.ok(meetOnly.every((e) => /^meeting-/.test(e.getFirstPropertyValue('uid'))));
  // the token can be rotated; the old link stops working
  const rot = (await app.inject({ method: 'POST', url: '/api/calendar/token', headers: h })).json();
  assert.notEqual(rot.token, token);
  assert.equal((await app.inject({ method: 'GET', url: `/cal/${token}.ics` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/cal/${rot.token}.ics` })).statusCode, 200);
});

test('calendar: range view, update, and a protocol\'s next meeting becomes a calendar item', async () => {
  const { app, h } = setup();
  const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: await app.ownerH(), payload: { name: 'מגדל הדוגמה' } })).json();
  await app.inject({ method: 'POST', url: '/api/tasks', headers: h, payload: { title: 'משימה', due: '05/12/2026' } });
  await app.inject({ method: 'POST', url: '/api/protocols', headers: h, payload: { project: p.id, date: '23/11/2026 14:00', title: 'ישיבת תיאום', next_meeting_at: '07/12/2026 14:00', location: 'האתר', items: [{ kind: 'info', text: 'x' }] } });
  const range = (await app.inject({ method: 'GET', url: '/api/calendar?from=2026-12-01&to=2026-12-31', headers: h })).json();
  assert.deepEqual(range.map((x) => [x.kind, x.date, x.time]), [['task', '2026-12-05', null], ['meeting', '2026-12-07', '14:00']]);
  assert.equal(range[1].title, 'ישיבת תיאום (המשך)');
  const id = range[1].id;
  const u = (await app.inject({ method: 'PATCH', url: `/api/calendar/items/${id}`, headers: h, payload: { start: '08/12/2026 15:30' } })).json();
  assert.equal(u.start, '2026-12-08T13:30:00.000Z');
  const ad = (await app.inject({ method: 'POST', url: '/api/calendar/items', headers: h, payload: { title: 'יום עיון', start: '20/12/2026' } })).json();
  assert.equal(ad.all_day, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/calendar/items', headers: h, payload: { title: '', start: '20/12/2026' } })).statusCode, 400);
});
