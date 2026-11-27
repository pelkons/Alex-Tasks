'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-roles-'));
process.env.MESIMOT_OUTBOX_KEY_FILE = path.join(process.env.MESIMOT_FILES, 'sign.key');
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createCalendar } = require('../lib/calendar');
const { createImporter } = require('../lib/importer');
const { createIngest, createIngestApp } = require('../lib/ingest');
const { createOutbox } = require('../lib/outbox');
const { createConnector, migrate } = require('../lib/connector');
const { createWatchdog } = require('../lib/watchdog');

const LEGACY = 'legacy-token-0123456789'; const TS = '100.101.102.103'; const KEY = 'k'.repeat(64);
const iso = (ms) => new Date(ms).toISOString();
function lib() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const calendar = createCalendar(db, store); const importer = createImporter({ db, store, knowledge, chat });
  const ingest = createIngest({ db, store, knowledge, importer, calendar, version: 'test' });
  const outbox = createOutbox({ db, store, keyFile: path.join(process.env.MESIMOT_FILES, 'k' + Math.random()) });
  const connector = createConnector({ db, outboxKey: () => KEY, host: () => '100.64.0.9', dir: () => process.env.MESIMOT_FILES });
  const app = createIngestApp({ ingest, outbox, connector, token: LEGACY });
  return { db, store, connector, app, outbox };
}
const call = (L, method, url, o = {}) => L.app.inject({ method, url, payload: o.body, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers || {}) }, remoteAddress: TS });
const pair = async (L, name) => (await call(L, 'POST', '/ingest/pair', { body: { code: L.connector.newCode().code, computer_name: name, app_version: '1.1.0' } })).json();
const role = (L, id) => L.db.prepare('SELECT role FROM connector_devices WHERE id=?').get(id).role;
const mp = (meta) => { const b = '----t' + Math.random().toString(16).slice(2); return { payload: Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="m.msg"\r\nContent-Type: application/octet-stream\r\n\r\nabc\r\n--${b}--\r\n`), headers: { 'content-type': `multipart/form-data; boundary=${b}` } }; };

test('migration: the most recently contacted live device becomes active, the others standby; idempotent', () => {
  const db = open(':memory:'); migrate(db);
  const ins = (name, last, rev) => db.prepare('INSERT INTO connector_devices (name, token_sha, created_at, last_contact_at, revoked_at, role) VALUES (?,?,?,?,?,?)').run(name, name, iso(1000), last, rev, 'standby').lastInsertRowid;
  const a = ins('A', iso(5000), null), b = ins('B', iso(9000), null), c = ins('C', iso(99000), iso(100000));
  migrate(db);
  assert.deepEqual([a, b, c].map((i) => db.prepare('SELECT role FROM connector_devices WHERE id=?').get(i).role), ['standby', 'active', 'standby']);
  migrate(db); assert.equal(db.prepare("SELECT COUNT(*) n FROM connector_devices WHERE role='active'").get().n, 1);
  db.prepare("UPDATE connector_devices SET role='standby'").run(); db.prepare("UPDATE connector_devices SET revoked_at=NULL WHERE id=?").run(c); migrate(db);
  assert.equal(db.prepare("SELECT name FROM connector_devices WHERE role='active'").get().name, 'C', 'recomputed when none is active');
});

test('pair: the first device is active, a second is standby, a silent (>24 h) active is replaced; response carries role and active_device', async () => {
  const L = lib(); const a = await pair(L, 'A');
  assert.equal(a.role, 'active'); assert.equal(a.active_device.id, a.device_id); assert.equal(a.active_device.name, 'A');
  const b = await pair(L, 'B');
  assert.equal(b.role, 'standby'); assert.equal(b.active_device.id, a.device_id); assert.equal(role(L, a.device_id), 'active');
  L.db.prepare('UPDATE connector_devices SET last_contact_at=? WHERE id=?').run(iso(Date.now() - 23 * 3600000), a.device_id);
  assert.equal((await pair(L, 'C')).role, 'standby', '23 h of silence: no takeover');
  L.db.prepare('UPDATE connector_devices SET last_contact_at=? WHERE id=?').run(iso(Date.now() - 25 * 3600000), a.device_id);
  const d = await pair(L, 'D'); assert.equal(d.role, 'active'); assert.equal(role(L, a.device_id), 'standby');
  assert.equal(L.db.prepare("SELECT COUNT(*) n FROM connector_devices WHERE role='active'").get().n, 1);
  assert.ok(L.db.prepare("SELECT 1 FROM events WHERE action='connector_switch' AND new_value=?").get('Alex Link עבר ל-D'), 'activity log entry');
});

test('heartbeat returns role and active_device in both roles; activate flips; legacy token gets 400', async () => {
  const L = lib(); const a = await pair(L, 'A'); const b = await pair(L, 'B');
  let r = (await call(L, 'POST', '/ingest/heartbeat', { token: b.token, body: { computer_name: 'B' } })).json();
  assert.equal(r.role, 'standby'); assert.equal(r.active_device.id, a.device_id);
  r = (await call(L, 'POST', '/ingest/heartbeat', { token: a.token, body: {} })).json(); assert.equal(r.role, 'active'); assert.equal(r.active_device.id, a.device_id);
  const act = await call(L, 'POST', '/ingest/activate', { token: b.token, body: {} }); assert.equal(act.statusCode, 200); assert.deepEqual(act.json(), { role: 'active' });
  assert.equal(role(L, a.device_id), 'standby'); assert.equal(role(L, b.device_id), 'active');
  assert.equal((await call(L, 'POST', '/ingest/activate', { token: b.token, body: {} })).statusCode, 200, 'idempotent');
  assert.equal(L.db.prepare("SELECT COUNT(*) n FROM events WHERE action='connector_switch'").get().n, 2, 'one entry per real switch (first pair, then B)');
  assert.equal((await call(L, 'POST', '/ingest/activate', { token: LEGACY, body: {} })).statusCode, 400);
});

test('standby: mail and calendar 409, archive allowed, outbox empty and claim 409; status works; active and legacy unaffected', async () => {
  const L = lib(); const a = await pair(L, 'A'); const b = await pair(L, 'B');
  const m = mp({ entry_id: 'E1', folder: 'inbox' });
  let r = await L.app.inject({ method: 'POST', url: '/ingest/mail', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${b.token}` }, remoteAddress: TS });
  assert.equal(r.statusCode, 409); assert.deepEqual(r.json(), { error: 'standby' });
  const ar = mp({ entry_id: 'E2', folder: 'inbox', archive: true });
  r = await L.app.inject({ method: 'POST', url: '/ingest/mail', payload: ar.payload, headers: { ...ar.headers, authorization: `Bearer ${b.token}` }, remoteAddress: TS });
  assert.notEqual(r.statusCode, 409, 'archive backfill is allowed from a standby device');
  r = await call(L, 'POST', '/ingest/calendar', { token: b.token, body: [] }); assert.equal(r.statusCode, 409); assert.deepEqual(r.json(), { error: 'standby' });
  assert.equal((await call(L, 'POST', '/ingest/calendar', { token: a.token, body: [] })).statusCode, 200);
  assert.equal((await call(L, 'POST', '/ingest/calendar', { token: LEGACY, body: [] })).statusCode, 200, 'legacy token is not a device');
  assert.deepEqual((await call(L, 'GET', '/outbox/approved', { token: b.token })).json(), { enabled: false, standby: true, items: [] });
  assert.equal((await call(L, 'GET', '/outbox/approved', { token: a.token })).json().standby, undefined);
  assert.equal((await call(L, 'POST', '/outbox/1/claim', { token: b.token, body: {} })).statusCode, 409);
  assert.notEqual((await call(L, 'POST', '/outbox/1/claim', { token: a.token, body: {} })).json().error, 'standby');
  assert.equal((await call(L, 'GET', '/ingest/status', { token: b.token })).statusCode, 200);
  assert.equal((await call(L, 'GET', '/ingest/connector/latest', { token: b.token })).statusCode, 200);
  const lm = mp({ entry_id: 'E3', folder: 'inbox' });
  r = await L.app.inject({ method: 'POST', url: '/ingest/mail', payload: lm.payload, headers: { ...lm.headers, authorization: `Bearer ${LEGACY}` }, remoteAddress: TS });
  assert.notEqual(r.statusCode, 409, 'legacy token pushes as before');
});

test('watchdog: only the active device is alerted; failover is offered once with a 2-per-row button, only in work hours with a live standby', async () => {
  const L = lib(); const store = createStore(L.db); const tg = [];
  const wd = createWatchdog(L.db, store, { systemctl: () => ({ code: 0, stdout: 'active' }), fetch: async () => ({ status: 200 }), localUrl: '', publicUrl: '', token: '', sendTelegram: async (t, markup) => tg.push({ t, markup }), sendEmailText: async (t) => tg.push({ t }) });
  const a = await pair(L, 'OFFICE'); const b = await pair(L, 'HOME'); const c = await pair(L, 'LAPTOP');
  const wed10 = Date.parse('2026-12-02T08:00:00Z'); const at = iso(wed10);
  const set = (id, f) => L.db.prepare(`UPDATE connector_devices SET ${Object.keys(f).map((k) => k + '=?').join(',')} WHERE id=?`).run(...Object.values(f), id);
  // Outlook closed on a standby device: silent; on the active device: alert
  set(b.device_id, { hb_at: at, hb_outlook_ok: 0 }); set(a.device_id, { hb_at: at, hb_outlook_ok: 1, last_contact_at: at });
  assert.deepEqual(await wd.checkDevices(wed10), {}); assert.equal(tg.length, 0, 'standby is silent');
  set(a.device_id, { hb_outlook_ok: 0 }); assert.equal((await wd.checkDevices(wed10)).alerted, true); assert.match(tg[0].t, /OFFICE/); tg.length = 0;
  // failover: the active one has been silent 3 h, HOME is alive (5 min), LAPTOP is not (20 min)
  set(a.device_id, { last_contact_at: iso(wed10 - 3 * 3600000), hb_at: iso(wed10 - 3 * 3600000) });
  set(b.device_id, { hb_at: iso(wed10 - 5 * 60000) }); set(c.device_id, { hb_at: iso(wed10 - 20 * 60000) });
  const fri = Date.parse('2026-12-04T08:00:00Z'); set(b.device_id, { hb_at: iso(fri - 60000) });
  assert.equal((await wd.checkFailover(fri)).skipped, 'outside work hours'); set(b.device_id, { hb_at: iso(wed10 - 5 * 60000) });
  assert.equal((await wd.checkFailover(wed10)).offered, true);
  assert.equal(tg.length, 1); assert.match(tg[0].t, /OFFICE/); const rows = tg[0].markup.inline_keyboard;
  assert.deepEqual(rows, [[{ text: 'העבר ל-HOME', callback_data: `cnact:${b.device_id}` }]]); assert.ok(rows.every((r) => r.length <= 2));
  assert.equal((await wd.checkFailover(wed10 + 60000)).skipped, 'already offered'); assert.equal(tg.length, 1, 'once');
  // the button's action
  require('../lib/connector').activateDevice(L.db, b.device_id); assert.equal(role(L, b.device_id), 'active'); assert.equal(role(L, a.device_id), 'standby');
});

test('watchdog: the "not seen" alert follows the active device, not the legacy token or a standby computer', async () => {
  const L = lib(); const store = createStore(L.db); const tg = [];
  const wd = createWatchdog(L.db, store, { systemctl: () => ({ code: 0, stdout: 'active' }), fetch: async () => ({ status: 200 }), localUrl: '', publicUrl: '', token: '', sendTelegram: async (t) => tg.push(t), sendEmailText: async (t) => tg.push(t) });
  const a = await pair(L, 'OFFICE'); await pair(L, 'HOME');
  const wed10 = Date.parse('2026-12-02T08:00:00Z');
  L.db.prepare('UPDATE connector_devices SET last_contact_at=? WHERE id=?').run(iso(wed10 - 3 * 3600000), a.device_id);
  L.db.prepare("INSERT INTO settings (key,value) VALUES ('ingest_last_contact',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(iso(wed10 - 60000)); // other traffic is fresh
  assert.equal((await wd.checkIngest(wed10)).alerted, true); assert.match(tg[0], /OFFICE/);
});
