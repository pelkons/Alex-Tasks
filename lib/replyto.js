'use strict';
// REPLIES. The owner answers in Telegram by swiping on a specific bot message (or with "השב" in the web chat). The reply is tied to THAT message:
//  * resolve(): which message / card / task / draft / outbox item he answered, and its quoted text;
//  * handle(): a reply to a question CARD (benchmark, active-learning, proposal) is a card answer: free text ("כן צריך משימה", "לא, רק מידע", "הפרויקט הוא X") is matched to the card's options in code;
//    ambiguous -> ask ONCE; a typed reply to an OUTBOX card is never an approval (only the button approves): approval-like words get "press ✅", anything else is an EDIT instruction for the draft;
//  * contextFor(): the block that goes first in the assistant's prompt: "הבעלים משיב להודעה הזאת: ...".
const { now } = require('./db');

const norm = (s) => String(s || '').normalize('NFC').replace(/[֑-ׇ]/g, '').toLowerCase().replace(/["'״׳`.,!?;:()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
const YES = /^(כן|בטח|נכון|אכן|בהחלט|אוקיי|אוקי|סבבה|בסדר|yes|ok)(\s|$)/; const NO = /^(לא|אין|בלי|no)(\s|$)/;
const APPROVAL_LIKE = /^(כן|שלח|שלחי|תשלח|אשר|אישור|מאושר|בסדר|אוקיי|אוקי|סבבה|יאללה|ok|yes|send|go)(\s+(כן|שלח|תשלח|בבקשה|לי|את זה|הכל|הכול))*$/;

// what each answer button MEANS, as phrases a person would type
function optionsOf(item) {
  const make = (id, label) => {
    const l = norm(label); const phrases = new Set(); let pol = null;
    if (/^כן/.test(l)) pol = 'yes'; else if (/^לא/.test(l)) pol = 'no';
    const add = (...p) => p.forEach((x) => phrases.add(norm(x)));
    if (/צריך משימה|נדרשת משימה/.test(l)) add('כן צריך משימה', 'צריך משימה', 'נדרשת משימה', 'כן משימה', 'כן צריך', 'משימה');
    if (/רק מידע|אין משימה/.test(l)) add('לא רק מידע', 'רק מידע', 'אין משימה', 'לא צריך משימה', 'לא צריך', 'אין צורך', 'לא נדרשת', 'לידיעה');
    if (/לידיעה|בלי פעולה/.test(l)) add('לידיעה', 'לידיעה בלבד', 'רק מידע', 'בלי פעולה', 'לא דורש פעולה', 'מידע');
    if (/דורש פעולה/.test(l)) add('דורש פעולה', 'צריך לטפל', 'פעולה', 'משימה');
    if (/אוטומטי|ידיעון|לא רלוונטי/.test(l)) add('אוטומטי', 'ידיעון', 'לא רלוונטי', 'רעש', 'ספאם', 'פרסומת');
    if (/^כן נכון|^כן, נכון/.test(label || '') || /^כן נכון/.test(l)) add('כן', 'נכון', 'אכן', 'בהחלט', 'כן נכון');
    if (/^לא לא נכון/.test(l)) add('לא נכון', 'לא', 'שגוי', 'טעות', 'לא נכון');
    if (/^אשר|^דחה/.test(l)) { if (/^אשר/.test(l)) add('אשר', 'כן', 'בסדר', 'אוקיי', 'אישור'); else add('דחה', 'לא', 'בטל', 'לדחות'); }
    const proj = /^הפרויקט\s*(.+)$/.exec(l); if (proj) { add(proj[1]); for (const w of proj[1].split(' ')) if (w.length >= 3) add(w); }
    for (const w of l.split(' ')) if (w.length >= 3 && !/^(כן|לא|הפרויקט|המודל|המערכת)$/.test(w)) phrases.add(w);
    return { id, label, pol, phrases: [...phrases].filter(Boolean) };
  };
  return [make('approve', item.approve_label || 'אשר'), make('reject', item.reject_label || 'דחה')];
}
// the option the text answers, or null when it is ambiguous
function matchOption(text, options) {
  const t = norm(text); if (!t) return null;
  const scored = options.map((o) => {
    let score = 0; for (const p of o.phrases) if (p && (` ${t} `).includes(` ${p} `)) score += p.split(' ').length >= 2 ? 3 : (o.pol === null ? 2 : 1);
    if (o.pol === 'yes' && YES.test(t)) score += 2; if (o.pol === 'no' && NO.test(t)) score += 2;
    if (o.pol === 'yes' && NO.test(t)) score -= 3; if (o.pol === 'no' && YES.test(t)) score -= 3;
    return { o, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].score >= 2 && scored[0].score - scored[1].score >= 2 ? scored[0].o : null;
}

function createReply({ db, store, chat, proposals = null, outbox = null }) {
  const q = (s) => db.prepare(s);
  const assistant = () => store.assistantId();
  const say = (text) => chat.sendChat(assistant(), { text });

  function resolve(row) {
    const out = { quote: null, kind: 'message', entity: null, proposal: null, msg: null };
    if (row.reply_proposal_id && proposals) { const p = q('SELECT * FROM proposals WHERE id=?').get(row.reply_proposal_id); if (p) { const it = proposals.withContext(p); out.kind = 'proposal'; out.proposal = it; out.entity = `question card #${it.id} (${it.kind})${it.email ? `, about email ${it.email.id} "${it.email.subject}"` : ''}; status ${it.status}`; out.quote = [it.email ? `${it.email.sender} · ${it.email.when} · ${it.email.subject}` : null, it.email ? it.email.excerpt : null, it.ask || it.text, it.left ? `${it.left} / ${it.right}` : null].filter(Boolean).join('\n'); return out; } }
    const m = row.reply_to_id ? q('SELECT * FROM chat_messages WHERE id=?').get(row.reply_to_id) : null; out.msg = m;
    if (m) {
      out.quote = String(m.text || '').slice(0, 1200);
      if (m.outbox_id) { const o = q('SELECT id, status, subject FROM outbox WHERE id=?').get(m.outbox_id); out.kind = 'outbox'; out.entity = `outgoing email draft #${m.outbox_id}${o ? ` ("${o.subject}", status ${o.status})` : ''}: a typed reply is an EDIT instruction for this draft (use \`mesimot outbox update ${m.outbox_id} ...\`), NEVER an approval`; out.outbox = o; }
      else if (m.confirm_id) { out.kind = 'confirm'; out.entity = `a confirmation question (#${m.confirm_id}); only its buttons answer it`; }
      else if (m.proposal_batch) { out.kind = 'proposal_batch'; out.entity = `a card of ${q('SELECT COUNT(*) c FROM proposals WHERE batch=?').get(m.proposal_batch).c} proposals (batch ${m.proposal_batch})`; }
      else { const ids = JSON.parse(m.task_ids || '[]'); if (m.task_id) ids.unshift(m.task_id); if (ids.length) { out.kind = 'task'; out.entity = `tasks mentioned in it: ${[...new Set(ids)].slice(0, 4).map((id) => { const t = q('SELECT title FROM tasks WHERE id=?').get(id); return `#${id}${t ? ` "${t.title}"` : ''}`; }).join(', ')}`; } }
    } else if (row.reply_quote) out.quote = row.reply_quote;
    return out;
  }

  // 1. in code: an answer to a card
  function handle(msgId) {
    const row = q('SELECT * FROM chat_messages WHERE id=?').get(msgId); if (!row || row.author !== 'owner') return { handled: false };
    const r = resolve(row); const text = String(row.text || '').trim();
    if (r.kind === 'outbox') {
      if (APPROVAL_LIKE.test(norm(text))) { say('הודעה מוקלדת אינה אישור שליחה. כדי לשלוח את המייל יש ללחוץ על ✅ שלח בכרטיס (בצ׳אט או בטלגרם). אם רוצים לשנות משהו, כתבו מה לשנות.'); return { handled: true, reason: 'outbox_typed_approval' }; }
      return { handled: false, kind: 'outbox' }; // an edit instruction: the assistant updates the draft (a new card follows)
    }
    if (r.kind === 'proposal' && r.proposal && r.proposal.status === 'open' && !/^\s*$/.test(text)) {
      const opt = matchOption(text, optionsOf(r.proposal));
      if (opt) {
        try { proposals.decide(r.proposal.id, opt.id); say(`נרשם: ${opt.label}`); return { handled: true, answered: opt.id }; } catch (e) { say(`לא הצלחתי לרשום את התשובה: ${e.message}`); return { handled: true }; }
      }
      const key = `reply_ask:${r.proposal.id}`; const asked = q('SELECT value FROM settings WHERE key=?').get(key)?.value;
      if (!asked) { q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, now()); const [a, b] = optionsOf(r.proposal); say(`לא הבנתי איזו תשובה התכוונת לשאלה "${(r.proposal.ask || r.proposal.text).slice(0, 80)}". אפשר ללחוץ על אחד הכפתורים, או לכתוב: "${a.label}" / "${b.label}".`); return { handled: true, asked: true }; }
      return { handled: false, kind: 'proposal' }; // asked once already: the assistant takes over with the context
    }
    return { handled: false, kind: r.kind };
  }

  // 2. for the assistant: what the owner replied to
  function contextFor(msgId) {
    const row = q('SELECT * FROM chat_messages WHERE id=?').get(msgId); if (!row || !(row.reply_to_id || row.reply_proposal_id || row.reply_quote)) return null;
    const r = resolve(row); if (!r.quote) return null;
    return `הבעלים משיב להודעה הזאת:\n${r.quote.split('\n').map((l) => '> ' + l).join('\n')}\n${r.entity ? `(${r.entity})\n` : ''}His message (the OWNER message with id ${msgId}) is a REPLY to the quoted message above: treat it as being about THAT message first, and NEVER about the latest message in the chat. If it is not clear what he means, ask him one short question quoting that message.`;
  }
  return { resolve, handle, contextFor, optionsOf, matchOption };
}
module.exports = { createReply, matchOption, optionsOf, norm, APPROVAL_LIKE };
