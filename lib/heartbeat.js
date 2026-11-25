'use strict';
// Heartbeats written by the runner and read by the watchdog and the status card (one row per key).
const { now } = require('./db');

function beat(db, key, detail = null) {
  db.prepare('INSERT INTO heartbeat (key, at, detail) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at, detail=excluded.detail')
    .run(key, now(), detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
}
function ageMs(db, key, at = Date.now()) {
  const r = db.prepare('SELECT at FROM heartbeat WHERE key=?').get(key);
  return r ? at - Date.parse(r.at) : null;
}
const get = (db, key) => db.prepare('SELECT * FROM heartbeat WHERE key=?').get(key) || null;

module.exports = { beat, ageMs, get };
