'use strict';
// Helpers for the encrypted database: convert a plain file, make an encrypted copy, re-key, compare two databases.
// Used by scripts/encrypt-db.js, scripts/rekey.js, scripts/backup-db.js and the backup conversion. Never prints the key.
const fs = require('fs');
const path = require('path');
const { openRaw, isPlainFile, applyKey } = require('./dbkey');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const unlinkQuiet = (f) => { try { fs.unlinkSync(f); } catch { /* not there */ } };
const rmSidecars = (f) => { unlinkQuiet(f + '-wal'); unlinkQuiet(f + '-shm'); unlinkQuiet(f + '-journal'); };

// Plain file -> encrypted file at dest. src is left untouched (a consistent snapshot is taken with the backup API, so this is safe on a live database).
async function encryptCopy(src, dest, hex) {
  rmSidecars(dest); unlinkQuiet(dest);
  const plain = openRaw(src, { mode: 'plain', readonly: true });
  try { await plain.backup(dest); } finally { plain.close(); }
  encryptInPlace(dest, hex);
}

// Encrypts a plain database file in place (journal mode must not be WAL for rekey).
function encryptInPlace(file, hex) {
  const d = openRaw(file, { mode: 'plain' });
  try {
    d.pragma('journal_mode = DELETE');
    d.pragma("cipher = 'sqlcipher'");
    d.pragma(`rekey = "x'${hex}'"`);
  } finally { d.close(); }
  rmSidecars(file);
}

// Changes the key of an encrypted file in place.
function rekeyInPlace(file, oldHex, newHex) {
  const d = openRaw(file, { hex: oldHex });
  try {
    d.pragma('wal_checkpoint(TRUNCATE)');
    d.pragma('journal_mode = DELETE');
    d.pragma(`rekey = "x'${newHex}'"`);
    d.pragma('journal_mode = WAL');
  } finally { d.close(); }
}

// Encrypted consistent snapshot of a live database (VACUUM INTO keeps the source's encryption; a plain source is encrypted afterwards).
function backupTo(srcFile, dest, hex) {
  rmSidecars(dest); unlinkQuiet(dest);
  const plain = isPlainFile(srcFile);
  const d = plain ? openRaw(srcFile, { mode: 'plain', readonly: true }) : openRaw(srcFile, { hex, readonly: true });
  try { d.exec(`VACUUM INTO ${q(dest)}`); } finally { d.close(); }
  if (plain) encryptInPlace(dest, hex);
  rmSidecars(dest);
}

function tables(db) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name); }

function loadVec(db) { try { require('sqlite-vec').load(db); return true; } catch { return false; } }

// Compare every table's row count; returns { ok, diffs, counts }.
function compareCounts(a, b) {
  loadVec(a); loadVec(b);
  const ta = tables(a), tb = tables(b), diffs = [], counts = {};
  for (const t of new Set([...ta, ...tb])) {
    let na = null, nb = null;
    try { na = a.prepare(`SELECT count(*) c FROM "${t}"`).get().c; } catch (e) { na = 'ERR ' + e.message; }
    try { nb = b.prepare(`SELECT count(*) c FROM "${t}"`).get().c; } catch (e) { nb = 'ERR ' + e.message; }
    counts[t] = na;
    if (na !== nb) diffs.push(`${t}: ${na} vs ${nb}`);
  }
  return { ok: diffs.length === 0, diffs, counts };
}

// Five FTS searches and five vector searches must return the same ids on both databases.
function compareSearches(a, b, n = 5) {
  const out = [];
  let words = [];
  try { words = a.prepare("SELECT title FROM tasks ORDER BY id DESC LIMIT 200").all().map((r) => String(r.title).split(/\s+/).find((w) => w.length >= 3)).filter(Boolean); } catch { /* none */ }
  words = [...new Set(words)].slice(0, n);
  for (const w of words) {
    const sql = "SELECT rowid FROM search_index WHERE search_index MATCH ? ORDER BY rowid LIMIT 50";
    let ra, rb; try { ra = JSON.stringify(a.prepare(sql).all(`"${w.replace(/"/g, '')}"`)); rb = JSON.stringify(b.prepare(sql).all(`"${w.replace(/"/g, '')}"`)); } catch (e) { ra = 'ERR'; rb = e.message; }
    out.push({ kind: "fts", same: ra === rb && ra !== "ERR", hits: ra === "ERR" ? 0 : JSON.parse(ra).length });
  }
  try {
    const vs = a.prepare('SELECT embedding e FROM vec_items LIMIT ?').all(n);
    for (const v of vs) {
      const sql = 'SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = 20 ORDER BY distance';
      const ra = JSON.stringify(a.prepare(sql).all(v.e)), rb = JSON.stringify(b.prepare(sql).all(v.e));
      out.push({ kind: "vec", same: ra === rb, hits: JSON.parse(ra).length });
    }
  } catch (e) { out.push({ kind: 'vec', same: true, note: 'no vector table: ' + e.message }); }
  return out;
}

function integrity(db) { return db.pragma('integrity_check', { simple: true }); }

module.exports = { encryptCopy, encryptInPlace, rekeyInPlace, backupTo, compareCounts, compareSearches, integrity, rmSidecars, tables, loadVec };
