'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const mailLayer = require('../lib/mail');
const email = require('../lib/email');

const msg = (id, from = 'Dana <dana@exconstruct.example>') => ({ message_id: id, from, to: ['x@y'], subject: 'FW: נושא ' + id, text: 'גוף ' + id, timestamp: new Date().toISOString(), labels: ['received'], authentication_results: { dmarc: 'pass' }, attachments: [] });
const fake = (name, ids, { failList = false } = {}) => {
  const calls = [];
  return { name, address: name + '@x', calls, async listNew() { if (failList) throw new Error(name + ' down'); return ids.map((i) => msg(i)); }, async fetch(id) { return msg(id); }, async attachment() { return Buffer.alloc(0); },
    async addLabel(id, l) { calls.push(['label', id, l]); }, async markDone(id) { calls.push(['done', id]); }, async list() { return []; }, async remove() { return { removed: 'x' }; }, async send() {} };
};
function install(primary, fb) {
  const orig = { get: mailLayer.get, all: mailLayer.all, byName: mailLayer.byName };
  mailLayer.get = () => primary; mailLayer.all = () => [primary, fb].filter(Boolean); mailLayer.byName = (n) => [primary, fb].find((p) => p && p.name === n) || primary;
  return () => Object.assign(mailLayer, orig);
}

test('intake reads the primary and the intake-only fallback; each email remembers its provider and is marked done there', async () => {
  const db = open(':memory:'); const store = createStore(db);
  const imap = fake('imap', ['<a@1>']), am = fake('agentmail', ['<b@2>']);
  const undo = install(imap, am);
  try {
    const taken = await email.pollOnce(db, store, () => {}, null);
    assert.equal(taken.length, 2);
    assert.deepEqual(db.prepare('SELECT message_id, mail_provider FROM emails ORDER BY id').all().map((r) => `${r.message_id}:${r.mail_provider}`), ['<a@1>:imap', '<b@2>:agentmail']);
    await email.markDone('<a@1>', db); await email.markDone('<b@2>', db);
    assert.deepEqual(imap.calls.filter((c) => c[0] === 'done'), [['done', '<a@1>']]);
    assert.deepEqual(am.calls.filter((c) => c[0] === 'done'), [['done', '<b@2>']]);
  } finally { undo(); }
});

test('a failing fallback does not stop the primary; a failing primary still lets the fallback run and then reports the error (watchdog)', async () => {
  const db = open(':memory:'); const store = createStore(db);
  let undo = install(fake('imap', ['<a@1>']), fake('agentmail', [], { failList: true }));
  try { assert.equal((await email.pollOnce(db, store, () => {}, null)).length, 1); } finally { undo(); }
  undo = install(fake('imap', [], { failList: true }), fake('agentmail', ['<b@2>']));
  try {
    await assert.rejects(() => email.pollOnce(db, store, () => {}, null), /imap down/);
    assert.ok(db.prepare("SELECT 1 FROM emails WHERE message_id='<b@2>'").get(), 'the fallback mail was still taken');
  } finally { undo(); }
});

test('the fallback is configured by MAIL_FALLBACK_PROVIDER and switches itself off after MAIL_FALLBACK_UNTIL', () => {
  const keep = { ...process.env };
  try {
    mailLayer.reset();
    Object.assign(process.env, { MAIL_PROVIDER: 'imap', MAIL_IMAP_HOST: '127.0.0.1', MAIL_FALLBACK_PROVIDER: 'agentmail', MAIL_FALLBACK_UNTIL: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(mailLayer.fallback().name, 'agentmail');
    assert.equal(mailLayer.all().length, 2);
    assert.equal(mailLayer.fallback(Date.now() + 2 * 86400000), null, 'expired');
    process.env.MAIL_FALLBACK_PROVIDER = 'imap';
    mailLayer.reset();
    assert.equal(mailLayer.fallback(), null, 'the same provider is not a fallback');
  } finally { for (const k of ['MAIL_PROVIDER', 'MAIL_IMAP_HOST', 'MAIL_FALLBACK_PROVIDER', 'MAIL_FALLBACK_UNTIL']) delete process.env[k]; Object.assign(process.env, keep); mailLayer.reset(); }
});
