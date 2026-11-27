'use strict';
// Show an email the way Outlook does: the original HTML body with its inline pictures (signatures, logos), safely.
// The stored raw message (.msg / .eml) is the source. The HTML and the inline images are kept next to the email (never indexed, summarized or OCR'd,
// never listed as attachments) and rendered by the server into a sanitized page that the site shows inside a sandboxed iframe without scripts.
const fs = require('fs');
const iconv = require('iconv-lite');
const sanitizeHtml = require('sanitize-html');

const MAX_INLINE = 3 * 1024 * 1024;
const IMG_RE = /^image\/(png|jpe?g|gif|bmp|webp)$/i;
const cidOf = (s) => String(s || '').replace(/^<|>$/g, '').trim().toLowerCase();


// classic Outlook keeps the HTML body inside the compressed RTF ("encapsulated HTML", \fromhtml1): the text outside \htmlrtf is the original HTML.
// The \'xx bytes use the code page of the CURRENT FONT (\fcharset177 = windows-1255 Hebrew inside a document whose \ansicpg is 1252), \uN is Unicode.
const CHARSET_CP = { 0: 0, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
function htmlFromRtf(rtf) {
  if (!/\\fromhtml/.test(rtf.slice(0, 2000))) return '';
  const ansi = +(/\\ansicpg(\d+)/.exec(rtf) || [])[1] || 1252; const encOf = (cp) => (cp === 65001 ? 'utf8' : (iconv.encodingExists('cp' + cp) ? 'cp' + cp : 'cp1252'));
  const fontCp = {}; const ft = /\{\\f(\d+)[^{}]*?\\fcharset(\d+)/g; let fm; while ((fm = ft.exec(rtf.slice(0, 20000)))) fontCp[fm[1]] = CHARSET_CP[fm[2]] || ansi;
  let out = ''; let i = 0; const stack = []; let sup = false, skip = false, skipDepth = -1, depth = 0, font = null; let bytes = [], bytesEnc = null;
  const flush = () => { if (bytes.length) { out += iconv.decode(Buffer.from(bytes), bytesEnc); bytes = []; } };
  const SKIPG = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'mhtmltag', 'pntxta', 'pntxtb', 'generator', 'listtable', 'listoverridetable', 'rsidtbl', 'fldinst']);
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') { flush(); stack.push([sup, skip, font]); depth++; i++; const m = /^\\\*?\\?([a-z]+)/.exec(rtf.slice(i, i + 24)); if (m && SKIPG.has(m[1]) && !skip) { skip = true; skipDepth = depth; } continue; }
    if (ch === '}') { flush(); if (depth === skipDepth) { skip = false; skipDepth = -1; } const t = stack.pop(); if (t) { sup = t[0]; font = t[2]; if (skipDepth < 0) skip = false; } depth--; i++; continue; }
    if (ch === '\\') {
      const hex = /^\\'([0-9a-fA-F]{2})/.exec(rtf.slice(i, i + 4));
      if (hex) { i += 4; if (!sup && !skip) { const e = encOf(font != null && fontCp[font] ? fontCp[font] : ansi); if (bytesEnc && bytesEnc !== e) flush(); bytesEnc = e; bytes.push(parseInt(hex[1], 16)); } continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (m) { i += m[0].length; const w = m[1], n = m[2] === undefined ? null : +m[2];
        if (w === 'f' && n !== null) { flush(); font = n; continue; }
        if (w === 'htmlrtf') { sup = n !== 0; continue; }
        if (sup || skip) continue;
        if (w === 'u' && n !== null) { flush(); out += String.fromCharCode(n < 0 ? n + 65536 : n); i += /^\?/.test(rtf.slice(i)) ? 1 : 0; }
        else if (w === 'par' || w === 'line') { flush(); out += '\n'; } else if (w === 'tab') { flush(); out += '\t'; }
        continue; }
      const nx = rtf[i + 1]; i += 2; if (!sup && !skip && /[\\{}]/.test(nx)) { flush(); out += nx; } continue;
    }
    if (ch !== '\r' && ch !== '\n' && !sup && !skip) { flush(); out += ch; }
    i++;
  }
  flush(); return out.trim();
}

// Hebrew read as Western text (windows-1255 bytes decoded as windows-1252): many letters in À–ÿ and no Hebrew at all
const latinRatio = (t) => { const s = String(t || '').replace(/<[^>]*>/g, ' '); const letters = s.match(/[A-Za-z\u00c0-\u00ff\u0590-\u05ff]/g) || []; if (letters.length < 20) return 0; return letters.filter((c) => c >= '\u00c0' && c <= '\u00ff').length / letters.length; };
const hasHebrew = (t) => /[\u0590-\u05ff]/.test(t);
const looksMojibake = (t) => latinRatio(t) > 0.25 && !hasHebrew(String(t).replace(/<[^>]*>/g, ' '));
// repair: the characters were bytes of windows-1255 (or ISO-8859-8) -> decode them again
const redecode = (t, cp = 'cp1255') => iconv.decode(Buffer.from(String(t), 'latin1'), cp);
// an HTML body that declares another charset in its meta tag, when we hold it as bytes
function decodeHtmlBytes(b) {
  const head = b.slice(0, 3000).toString('latin1'); const m = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  const cs = m ? m[1].toLowerCase() : 'utf-8'; const name = /^(iso-?8859-8|windows-?1255|cp1255)/.test(cs) ? 'cp1255' : (iconv.encodingExists(cs) ? cs : 'utf-8');
  const t = iconv.decode(b, name); return name === 'utf-8' || name === 'utf8' ? t : t;
}

// -> { html, inline: [{ cid, name, mime, content }] } from raw bytes
async function extract(buf, name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (ext === 'eml') {
    const { simpleParser } = require('mailparser'); const p = await simpleParser(buf);
    const inline = (p.attachments || []).filter((a) => (a.cid || a.contentId) && IMG_RE.test(a.contentType || '') && a.content && a.content.length <= MAX_INLINE).map((a) => ({ cid: cidOf(a.cid || a.contentId), name: a.filename || 'image', mime: a.contentType, content: a.content }));
    let html = typeof p.html === 'string' ? p.html : ''; if (html && looksMojibake(html)) html = redecode(html);
    return { html, inline };
  }
  const MsgReader = require('@kenjiuno/msgreader').default; const r = new MsgReader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); const d = r.getFileData();
  if (d.error) throw new Error('msg: ' + d.error);
  let html = typeof d.bodyHtml === 'string' && d.bodyHtml.trim() ? d.bodyHtml : '';
  if (!html && d.html) { const b = Buffer.from(d.html); const cp = d.internetCodepage || d.messageCodepage || 65001; html = /charset\s*=\s*["']?\s*(iso-?8859-8|windows-?1255|cp1255)/i.test(b.slice(0, 3000).toString('latin1')) ? iconv.decode(b, 'cp1255') : (iconv.encodingExists(cp === 65001 ? 'utf8' : 'cp' + cp) ? iconv.decode(b, cp === 65001 ? 'utf8' : 'cp' + cp) : b.toString('utf8')); }
  if (!html && d.compressedRtf) { try { const { decompressRTF } = require('@kenjiuno/decompressrtf'); html = htmlFromRtf(Buffer.from(decompressRTF(Array.from(d.compressedRtf))).toString('latin1')); } catch { /* no html in the rtf */ } }
  if (html && looksMojibake(html)) html = redecode(html);
  const inline = [];
  for (const a of d.attachments || []) {
    try {
      const mime = a.attachMimeTag || ''; const got = r.getAttachment(a); if (!got || !got.content || got.content.length > MAX_INLINE) continue;
      const cid = cidOf(a.pidContentId); if (!cid && !a.attachmentHidden) continue;
      const m = IMG_RE.test(mime) ? mime : (/\.(png|jpe?g|gif|bmp|webp)$/i.test(a.fileName || '') ? 'image/' + String(a.fileName).split('.').pop().toLowerCase().replace('jpg', 'jpeg') : '');
      if (m) inline.push({ cid, name: a.fileName || a.name || 'image', mime: m, content: Buffer.from(got.content) });
    } catch { /* skip */ }
  }
  return { html, inline };
}

// a safe, self-contained page for one email's HTML. remote=false blocks every http(s) picture.
function render(html, inline, { remote = false, dir = 'auto' } = {}) {
  const byCid = new Map(inline.flatMap((i) => [[i.cid, i], [String(i.cid).split('@')[0], i]])); let blocked = 0;
  const safeStyle = [/^[-#%.,\sa-z0-9"']+$/i, /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/i];
  const prop = (...ps) => Object.fromEntries(ps.map((p) => [p, safeStyle]));
  const clean = sanitizeHtml(String(html || ''), {
    allowedTags: ['a', 'abbr', 'b', 'blockquote', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'col', 'colgroup', 'caption', 's', 'body', 'html'],
    disallowedTagsMode: 'discard',
    allowedAttributes: { a: ['href', 'name', 'title', 'dir', 'target', 'rel'], img: ['src', 'alt', 'width', 'height', 'title', 'data-blocked'], font: ['color', 'face', 'size'], td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'dir'], th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'dir'], table: ['width', 'border', 'cellpadding', 'cellspacing', 'align', 'bgcolor', 'dir'], tr: ['align', 'valign', 'bgcolor'], '*': ['dir', 'style', 'align', 'lang'] },
    allowedStyles: { '*': { ...prop('color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-align', 'text-decoration', 'direction', 'unicode-bidi', 'line-height', 'vertical-align', 'width', 'height', 'max-width', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right', 'border-collapse', 'text-indent', 'white-space') } },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'], allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] }, allowProtocolRelative: false,
    transformTags: {
      a: (tag, at) => ({ tagName: 'a', attribs: { ...at, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
      img: (tag, at) => {
        const src = String(at.src || '').trim(); const out = { alt: at.alt || '', width: at.width, height: at.height };
        if (/^cid:/i.test(src)) { const key = cidOf(src.slice(4)); const hit = byCid.get(key) || byCid.get(key.split('@')[0]) || inline.find((i) => String(i.name || '').toLowerCase() === key.split('@')[0]); if (hit) return { tagName: 'img', attribs: { ...out, src: `data:${hit.mime};base64,${Buffer.from(hit.content).toString('base64')}` } }; return { tagName: 'img', attribs: { ...out, 'data-blocked': '1' } }; }
        if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) return { tagName: 'img', attribs: { ...out, src } };
        if (/^https?:\/\//i.test(src)) { if (remote) return { tagName: 'img', attribs: { ...out, src } }; blocked++; return { tagName: 'img', attribs: { ...out, 'data-blocked': '1' } }; }
        return { tagName: 'img', attribs: { ...out, 'data-blocked': '1' } };
      },
    },
    exclusiveFilter: (f) => f.tag === 'img' && !f.attribs.src && !f.attribs['data-blocked'],
  });
  const csp = `default-src 'none'; img-src data:${remote ? ' https: http:' : ''}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox allow-popups allow-popups-to-escape-sandbox`;
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>html,body{margin:0}body{padding:10px 12px;background:#fff;color:#1a1a1a;font:14px/1.5 system-ui,Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}img[data-blocked]{display:none}pre{white-space:pre-wrap}</style></head><body dir="${dir}"><!--email_off-->${clean}<!--/email_off--></body></html>`;
  return { page, csp, blocked };
}

const remoteCount = (html) => (String(html || '').match(/<img\b[^>]*\ssrc\s*=\s*["']?\s*https?:/gi) || []).length;

function createMailView(db) {
  const q = (s) => db.prepare(s);
  const fileOf = (emailId) => q('SELECT f.path, f.original_name FROM emails e JOIN files f ON f.id=e.file_id WHERE e.id=?').get(emailId);
  // read the stored raw file once; remember the result (html_state 1 = has html, 2 = nothing to show / unreadable)
  async function ensure(emailId) {
    if (!q('SELECT 1 FROM emails WHERE id=?').get(emailId)) return null;
    const e = q('SELECT email_id id, html body_html, state html_state FROM email_html WHERE email_id=?').get(emailId); if (e) return e;
    const f = fileOf(emailId); let state = 2, html = null, n = 0;
    if (f && fs.existsSync(f.path)) {
      try {
        const x = await extract(fs.readFileSync(f.path), f.original_name);
        if (x.html && x.html.trim()) { state = looksMojibake(x.html) ? 3 : 1; html = x.html; } // 3: the decoder is not confident, the text view stays the default
        db.transaction(() => { q('DELETE FROM email_inline WHERE email_id=?').run(emailId); for (const i of x.inline) { q('INSERT INTO email_inline (email_id, cid, name, mime, size, data) VALUES (?,?,?,?,?,?)').run(emailId, i.cid, i.name, i.mime, i.content.length, i.content); n++; } })();
      } catch { /* unreadable: plain text stays */ }
    }
    q('INSERT OR REPLACE INTO email_html (email_id, html, state) VALUES (?,?,?)').run(emailId, html, state); // a separate table: touching emails would re-index the search and the embeddings
    return { id: emailId, body_html: html, html_state: state, inline: n };
  }
  const info = (emailId) => { const e = q('SELECT html body_html, state html_state FROM email_html WHERE email_id=?').get(emailId) || {}; return { has_html: e.html_state === 1, remote_images: e.html_state === 1 ? remoteCount(e.body_html) : 0 }; };
  // names of the pictures that live in the body: they are not attachments
  const inlineNames = (emailId) => new Set(q('SELECT name FROM email_inline WHERE email_id=?').all(emailId).map((r) => r.name));
  async function view(emailId, { remote = false } = {}) {
    const e = await ensure(emailId); const row = q('SELECT h.html body_html, h.state html_state, e.body_text FROM email_html h JOIN emails e ON e.id=h.email_id WHERE h.email_id=?').get(emailId); if (!row || row.html_state !== 1) return null;
    const inline = q('SELECT cid, name, mime, data FROM email_inline WHERE email_id=?').all(emailId).map((r) => ({ cid: r.cid, name: r.name, mime: r.mime, content: r.data }));
    const rtl = /[֐-׿]/.test(String(row.body_text || '').slice(0, 400)); void e;
    return render(row.body_html, inline, { remote, dir: /<[^>]+\bdir\s*=\s*["']?rtl/i.test(row.body_html) ? 'rtl' : (rtl ? 'rtl' : 'auto') });
  }
  async function backfill({ limit = 100000, log = () => {} } = {}) {
    const rows = q('SELECT id FROM emails WHERE file_id IS NOT NULL AND id NOT IN (SELECT email_id FROM email_html) ORDER BY id DESC LIMIT ?').all(limit); const c = { emails: rows.length, with_html: 0, without_html: 0, inline_images: 0 };
    for (const r of rows) { const x = await ensure(r.id); if (x && x.html_state === 1) c.with_html++; else c.without_html++; c.inline_images += q('SELECT COUNT(*) n FROM email_inline WHERE email_id=?').get(r.id).n; }
    log(JSON.stringify(c)); return c;
  }
  return { ensure, view, info, inlineNames, backfill };
}
module.exports = { createMailView, extract, render, remoteCount, htmlFromRtf, looksMojibake, redecode, latinRatio };
