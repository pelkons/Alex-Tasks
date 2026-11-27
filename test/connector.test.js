'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.MESIMOT_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-conn-'));
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
const { createConnector, publish } = require('../lib/connector');

const LEGACY = 'legacy-token-0123456789'; const TS = '100.101.102.103'; const KEY = 'k'.repeat(64);
function lib() {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge);
  const calendar = createCalendar(db, store); const importer = createImporter({ db, store, knowledge, chat });
  const ingest = createIngest({ db, store, knowledge, importer, calendar, version: 'test' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-conn-dir-'));
  const outbox = createOutbox({ db, store, keyFile: path.join(dir, 'sign.key') });
  const connector = createConnector({ db, outboxKey: () => KEY, host: () => '100.64.0.9', dir: () => dir });
  const app = createIngestApp({ ingest, outbox, connector, token: LEGACY });
  return { db, connector, app, dir };
}
const call = (L, method, url, o = {}) => L.app.inject({ method, url, payload: o.body, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, remoteAddress: o.ip || TS });
const pairWith = (L, code, ip) => call(L, 'POST', '/ingest/pair', { body: { code, computer_name: 'PC-TEST', app_version: '1.0.0' }, ip });

test('pairing: good code gives a device token and the key; the code works once; a stored token is only a hash', async () => {
  const L = lib(); const c = L.connector.newCode();
  assert.match(c.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/); assert.equal(c.connect_string, `alex://100.64.0.9:8130/${c.code}`);
  const r = await pairWith(L, c.code); assert.equal(r.statusCode, 200);
  const j = r.json(); assert.ok(j.device_id > 0); assert.match(j.token, /^[0-9a-f]{64}$/); assert.equal(j.outbox_sign_key, KEY); assert.equal(j.server_name, 'Alex Tasks');
  assert.equal((await pairWith(L, c.code)).statusCode, 404, 'reused code');
  const row = L.db.prepare('SELECT * FROM connector_devices WHERE id=?').get(j.device_id);
  assert.equal(row.token_sha, L.connector.sha(j.token)); assert.ok(!JSON.stringify(row).includes(j.token), 'the token itself is not stored');
  assert.equal(L.db.prepare('SELECT COUNT(*) n FROM connector_codes WHERE code_sha=?').get(c.code).n, 0, 'codes are stored hashed');
});

test('pairing: expired, unknown, lower-case input, wrong source, at most 5 live codes, rate limit', async () => {
  const L = lib(); const c = L.connector.newCode();
  L.db.prepare('UPDATE connector_codes SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await pairWith(L, c.code)).statusCode, 404, 'expired');
  assert.equal((await pairWith(L, 'AAAA-AAAA')).statusCode, 404, 'unknown');
  const d = L.connector.newCode();
  assert.equal((await pairWith(L, d.code, '203.0.113.5')).statusCode, 403, 'a public source is refused');
  assert.equal((await pairWith(L, d.code, '127.0.0.1')).statusCode, 403, 'loopback is refused');
  assert.equal((await pairWith(L, d.code.toLowerCase())).statusCode, 200, 'case-insensitive');
  const M = lib(); for (let i = 0; i < 5; i++) M.connector.newCode();
  assert.throws(() => M.connector.newCode(), /5/);
  const R = lib(); let last; for (let i = 0; i < 12; i++) last = await pairWith(R, 'ZZZZ-ZZZZ'); assert.equal(last.statusCode, 429, 'rate limited');
});

test('device token works on /ingest and /outbox routes, revoked gets 401, legacy token keeps working', async () => {
  const L = lib(); const c = L.connector.newCode(); const j = (await pairWith(L, c.code)).json();
  assert.equal((await call(L, 'GET', '/ingest/status', { token: j.token })).statusCode, 200);
  assert.equal((await call(L, 'GET', '/outbox/approved', { token: j.token })).statusCode, 200);
  assert.ok(L.db.prepare('SELECT last_contact_at FROM connector_devices WHERE id=?').get(j.device_id).last_contact_at);
  assert.equal((await call(L, 'GET', '/ingest/status', { token: 'nope' })).statusCode, 401);
  assert.equal((await call(L, 'GET', '/ingest/status')).statusCode, 401);
  assert.equal((await call(L, 'GET', '/ingest/status', { token: j.token, ip: '203.0.113.5' })).statusCode, 403);
  L.connector.revoke(j.device_id);
  assert.equal((await call(L, 'GET', '/ingest/status', { token: j.token })).statusCode, 401, 'revoked');
  assert.equal((await call(L, 'GET', '/outbox/approved', { token: j.token })).statusCode, 401, 'revoked on outbox too');
  assert.equal((await call(L, 'GET', '/ingest/status', { token: LEGACY })).statusCode, 200, 'legacy token still valid');
  assert.equal((await call(L, 'GET', '/outbox/approved', { token: LEGACY })).statusCode, 200);
  assert.equal((await call(L, 'POST', '/ingest/heartbeat', { token: LEGACY, body: { app_version: '1' } })).statusCode, 200, 'legacy heartbeat is accepted and ignored');
});

test('heartbeat is stored per device and listed', async () => {
  const L = lib(); const j = (await pairWith(L, L.connector.newCode().code)).json();
  const hb = { app_version: '1.0.1', computer_name: 'OFFICE', outlook_ok: false, paused_ingest: true, paused_send: false, last_sync_at: '2026-11-27T08:00:00Z', last_error: 'boom' };
  assert.equal((await call(L, 'POST', '/ingest/heartbeat', { token: j.token, body: hb })).statusCode, 200);
  const d = L.connector.list().find((x) => x.id === j.device_id);
  assert.equal(d.name, 'OFFICE'); assert.equal(d.app_version, '1.0.1'); assert.equal(d.outlook_ok, false); assert.equal(d.paused_ingest, true); assert.equal(d.paused_send, false); assert.equal(d.hb_last_error, 'boom'); assert.ok(d.hb_at);
  assert.ok(!JSON.stringify(L.connector.list()).includes(j.token) && !JSON.stringify(L.connector.list()).includes('token_sha'));
});

test('latest / download: none, then published installer with sha256 and size', async () => {
  const L = lib(); const j = (await pairWith(L, L.connector.newCode().code)).json();
  assert.deepEqual((await call(L, 'GET', '/ingest/connector/latest', { token: j.token })).json(), { version: null });
  assert.equal((await call(L, 'GET', '/ingest/connector/download', { token: j.token })).statusCode, 404);
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'src-')), 'AlexLink-Setup-1.2.3.exe'); fs.writeFileSync(src, Buffer.from('MZ fake installer'));
  const info = publish(src, L.dir);
  assert.equal(info.version, '1.2.3'); assert.throws(() => publish(path.join(os.tmpdir(), 'x.exe'), L.dir), /file name/);
  const l = (await call(L, 'GET', '/ingest/connector/latest', { token: j.token })).json();
  assert.deepEqual(l, { version: '1.2.3', sha256: info.sha256, size: 17, download: '/ingest/connector/download' });
  const dl = await call(L, 'GET', '/ingest/connector/download', { token: j.token });
  assert.equal(dl.statusCode, 200); assert.equal(dl.rawPayload.toString(), 'MZ fake installer');
  assert.equal((await call(L, 'GET', '/ingest/connector/download')).statusCode, 401, 'Bearer required');
});

test('watchdog: Outlook closed or paused in work hours is told once, recovery once; silent outside work hours', async () => {
  const { createWatchdog } = require('../lib/watchdog');
  const L = lib(); const store = createStore(L.db); const tg = [];
  const wd = createWatchdog(L.db, store, { systemctl: () => ({ code: 0, stdout: 'active' }), fetch: async () => ({ status: 200 }), localUrl: '', publicUrl: '', token: '', sendTelegram: async (t) => tg.push(t), sendEmailText: async (t) => tg.push(t), isQuiet: () => false });
  const j = (await pairWith(L, L.connector.newCode().code)).json();
  const wed10 = Date.parse('2026-12-02T08:00:00Z'); const fri10 = Date.parse('2026-12-04T08:00:00Z');
  const beat = (at, b) => { L.connector.heartbeat(j.device_id, { computer_name: 'OFFICE', ...b }); L.db.prepare('UPDATE connector_devices SET hb_at=? WHERE id=?').run(new Date(at).toISOString(), j.device_id); };
  beat(fri10, { outlook_ok: false }); assert.deepEqual(await wd.checkDevices(fri10), {}); assert.equal(tg.length, 0, 'Friday: nothing');
  beat(wed10, { outlook_ok: false }); assert.equal((await wd.checkDevices(wed10)).alerted, true); assert.match(tg[0], /OFFICE.*Outlook סגור/);
  await wd.checkDevices(wed10 + 60000); assert.equal(tg.length, 1, 'once');
  beat(wed10 + 600000, { outlook_ok: true }); assert.equal((await wd.checkDevices(wed10 + 600000)).recovered, true); assert.equal(tg.length, 2);
  beat(wed10 + 900000, { outlook_ok: true, paused_send: true }); await wd.checkDevices(wed10 + 900000); assert.match(tg[2], /שליחת המיילים מושהית/);
});
