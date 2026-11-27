'use strict';
// Repairs mail files whose Hebrew was lost to "?" (an ANSI-format .msg): 1) a nested message's body and subject are re-read with the better parser (HTML or RTF body when the text body is "?"),
// 2) a file name with "?" is renamed from the message's own subject when that is intact, 3) when the same email also has a clean-named copy of it (a re-push adds one when the bytes differ),
// the damaged one is merged into the clean one: references move over, then the damaged row goes. Idempotent; it only touches files whose name or text is damaged.
const fs = require('fs');
const { parseMailFile } = require('./mailfile');
const { garbledRatio, nameGarbledRatio, GARBLED } = require('./textclean');

function createFixNames({ db, store, knowledge }) {
  const q = (s) => db.prepare(s);
  const wildcard = (garbled) => new RegExp('^' + String(garbled).replace(/[.*+^${}()|[\]\\]/g, '\\$&').replace(/\\\?|\?/g, '.') + '$', 'i');
  function mergeInto(bad, good) {
    return db.transaction(() => {
      q("UPDATE project_facts SET source_id=? WHERE source_type='file' AND source_id=?").run(good.id, bad.id);
      for (const m of q('SELECT id, file_ids FROM chat_messages WHERE file_ids LIKE ?').all(`%${bad.id}%`)) { const ids = JSON.parse(m.file_ids || '[]'); if (ids.includes(bad.id)) q('UPDATE chat_messages SET file_ids=? WHERE id=?').run(JSON.stringify([...new Set(ids.map((x) => (x === bad.id ? good.id : x)))]), m.id); }
      q('UPDATE emails SET file_id=? WHERE file_id=?').run(good.id, bad.id);
      q('DELETE FROM chunks WHERE file_id=?').run(bad.id);
      try { q("DELETE FROM vec_items WHERE rowid IN (SELECT id FROM embeddings WHERE kind='chunk' AND ref_id NOT IN (SELECT id FROM chunks))").run(); q("DELETE FROM embeddings WHERE kind='chunk' AND ref_id NOT IN (SELECT id FROM chunks)").run(); } catch { /* no vectors */ }
      q('DELETE FROM files WHERE id=?').run(bad.id);
    })();
  }
  async function run({ emailId = null } = {}) {
    const out = { scanned: 0, renamed: 0, merged: 0, bodies: 0, left: 0 };
    const rows = q(`SELECT * FROM files WHERE lower(original_name) LIKE '%.msg' OR lower(original_name) LIKE '%.eml' ${emailId ? 'AND email_id=' + +emailId : ''}`).all();
    for (const f of rows) {
      if (!q('SELECT 1 FROM files WHERE id=?').get(f.id)) continue; // merged away earlier in this pass
      const badName = nameGarbledRatio(f.original_name) > GARBLED; const em = q('SELECT id, subject, body_text FROM emails WHERE file_id=?').get(f.id);
      const badText = em && (garbledRatio(em.body_text) > GARBLED || nameGarbledRatio(em.subject) > GARBLED);
      if (!badName && !badText) continue;
      out.scanned++;
      let m = null; try { m = await parseMailFile(require('./vault').readFile(f.path), f.original_name); } catch { /* unreadable */ }
      if (m && em && badText) {
        const nb = garbledRatio(m.body) < garbledRatio(em.body_text) ? m.body : em.body_text; const ns = nameGarbledRatio(m.subject) < nameGarbledRatio(em.subject) ? m.subject : em.subject;
        if (nb !== em.body_text || ns !== em.subject) { q('UPDATE emails SET body_text=?, subject=? WHERE id=?').run(nb, ns, em.id); out.bodies++; }
      }
      if (badName) {
        const ext = /\.eml$/i.test(f.original_name) ? '.eml' : '.msg'; const re = wildcard(f.original_name);
        const sib = f.email_id ? q('SELECT * FROM files WHERE email_id=? AND id<>? AND lower(original_name) LIKE ?').all(f.email_id, f.id, '%' + ext).find((c) => nameGarbledRatio(c.original_name) <= GARBLED && re.test(c.original_name)) : null;
        if (sib) { try { mergeInto(f, sib); out.merged++; continue; } catch { /* fall back to a rename */ } }
        if (m && m.subject && nameGarbledRatio(m.subject) <= GARBLED) { if (knowledge.renameFile(f.id, m.subject.replace(/[\\/\0:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + ext)) { out.renamed++; continue; } }
        out.left++;
      }
    }
    return out;
  }
  return { run, mergeInto };
}
module.exports = { createFixNames };
