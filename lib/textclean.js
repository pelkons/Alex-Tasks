'use strict';
// Text reduction in code, before any model sees a mail: quoted earlier replies (they are separate mails of the thread), signatures, legal disclaimers,
// external-sender banners and HTML leftovers. Conservative: when the cleaned text would be (almost) empty, the original is kept.
const REPLY_MARKERS = [
  /^-{2,}\s*(original message|forwarded message|הודעה מקורית|הודעה שהועברה)\s*-{2,}/i,
  /^_{5,}\s*$/,
  /^on .{5,200}wrote:\s*$/i,
  /^ב-?\s?.{5,120}כתב(?:ה)?:\s*$/,
  /^(from|מאת)\s*:\s*.{3,200}$/i, // an Outlook header block of the quoted mail starts here
  /^>+\s?/,
];
const BANNER = /(caution:?\s*this (e-?mail|message) (originated|came) from|external (e-?mail|sender)|\[external\]|זהירות:?\s*(הודעה|מייל) (זו|זה) (התקבל|הגיע)|this email originated from outside)/i;
const DISCLAIMER = /(this (e-?mail|message)[^.\n]{0,80}(confidential|intended (solely|only) for)|confidentiality notice|disclaimer|הודעה זו (מיועדת|כוללת מידע חסוי)|מידע (חסוי|סודי)|אם קיבלת (הודעה|מייל) זו בטעות|please consider the environment|נא לא להדפיס)/i;
const SIGN_OFF = /^(best regards|kind regards|regards|thanks,?|thank you,?|sincerely|בברכה|בכבוד רב|תודה,?|שבוע טוב|בהצלחה)[,.!\s]*$/i;

function clean(text, { max = 3500 } = {}) {
  const orig = String(text || '').replace(/\r/g, '');
  let lines = orig.split('\n');
  // 1. cut at the first quoted-reply marker, but only when real text came before it
  let cut = -1, seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l) seen += l.length;
    if (seen >= 40 && REPLY_MARKERS.some((re) => re.test(l))) { cut = i; break; }
  }
  if (cut > 0) lines = lines.slice(0, cut);
  // 2. banners, disclaimers (the disclaimer paragraph and everything after it), HTML leftovers, link-only noise
  const out = []; let stop = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (BANNER.test(l)) continue;
    if (DISCLAIMER.test(l)) stop = true;
    if (stop) continue;
    if (/^\[?(cid|image\d*):/i.test(l) || /^<https?:\/\/\S+>$/.test(l) || /^https?:\/\/\S{80,}$/.test(l)) continue;
    out.push(raw.replace(/\s+$/, ''));
  }
  // 3. signature: from a sign-off line to the end, when the sign-off is in the last half and little text follows
  let end = out.length;
  for (let i = out.length - 1; i >= Math.floor(out.length * 0.5) && i >= 0; i--) {
    if (SIGN_OFF.test(out[i].trim())) { const after = out.slice(i + 1).join(' ').length; if (after < 400) { end = i; break; } }
  }
  let res = out.slice(0, end).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (res.length < 25 && orig.trim().length > res.length) res = orig.trim(); // never reduce to nothing
  return res.length > max ? res.slice(0, max) + '…' : res;
}
// "?" in place of letters: what a mail saved in an ANSI format (instead of Unicode) looks like. Share of question marks among the non-space characters (0 for very short texts).
function garbledRatio(text) {
  const t = String(text || '').replace(/\s+/g, ''); if (t.length < 20) return 0;
  let q = 0; for (const ch of t) if (ch === '?') q++;
  return q / t.length;
}
const GARBLED = 0.2;
// the same for a file or person NAME: share of "?" among the letters of the name (extension and digits ignored)
function nameGarbledRatio(name) {
  const t = String(name || '').replace(/\.[^.]*$/, '').replace(/[\s\d\-_,.()]/g, ''); if (t.length < 3) return 0;
  return (t.match(/\?/g) || []).length / t.length;
}
module.exports = { clean, garbledRatio, nameGarbledRatio, GARBLED };
