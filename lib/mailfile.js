'use strict';
// Read Outlook email files: .eml (new Outlook, OWA) and .msg (classic Outlook, OLE/CFB).
const iconv = require('iconv-lite');

const stripHtml = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// minimal RTF to text: handles \'hh bytes in the document code page, \uN, \par, skips non-text groups
function rtfToText(rtf) {
  const cp = +(/\\ansicpg(\d+)/.exec(rtf) || [])[1] || 1252;
  const enc = iconv.encodingExists('cp' + cp) ? 'cp' + cp : 'cp1252';
  const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'generator', 'listtable', 'listoverridetable', 'rsidtbl', 'mmathPr', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'fldinst']);
  let out = '', i = 0, depth = 0, skipDepth = -1, pending = [];
  const flush = () => { if (pending.length) { out += iconv.decode(Buffer.from(pending), enc); pending = []; } };
  let uc = 1;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') { flush(); depth++; i++; if (rtf[i] === '\\' && rtf[i + 1] === '*') { skipDepth = skipDepth < 0 ? depth : skipDepth; } continue; }
    if (ch === '}') { flush(); if (depth === skipDepth) skipDepth = -1; depth--; i++; continue; }
    if (ch === '\\') {
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (m) {
        const w = m[1], n = m[2] === undefined ? null : +m[2];
        i += m[0].length;
        if (SKIP.has(w) && skipDepth < 0) skipDepth = depth;
        if (skipDepth >= 0) continue;
        if (w === 'par' || w === 'line') { flush(); out += '\n'; }
        else if (w === 'tab') { flush(); out += '\t'; }
        else if (w === 'u' && n !== null) { flush(); out += String.fromCharCode(n < 0 ? n + 65536 : n); i += uc ? 1 : 0; }
        else if (w === 'uc' && n !== null) uc = n;
        continue;
      }
      const hex = /^\\'([0-9a-fA-F]{2})/.exec(rtf.slice(i, i + 4));
      if (hex) { i += 4; if (skipDepth < 0) pending.push(parseInt(hex[1], 16)); continue; }
      i += 2; if (skipDepth < 0 && /[\\{}]/.test(rtf[i - 1])) { flush(); out += rtf[i - 1]; } continue;
    }
    if (skipDepth < 0 && ch !== '\r' && ch !== '\n') { flush(); out += ch; }
    i++;
  }
  flush();
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const iso = (d) => (d ? (isNaN(new Date(d)) ? null : new Date(d).toISOString()) : null);
const addr = (a) => (a && (a.address || a.email || '')) || '';
const fmt = (name, email) => (email && name && name !== email ? `${name} <${email}>` : (email || name || ''));

// raw RFC822 header block -> { lowercase-name: value } (folded lines joined; the first occurrence wins)
function headerMap(raw) {
  const out = {}; let cur = null;
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && cur) { out[cur] += ' ' + line.trim(); continue; }
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) { cur = m[1].toLowerCase(); if (out[cur] === undefined) out[cur] = m[2]; else cur = '\0'; if (cur === '\0') cur = null; }
  }
  return out;
}
const idsOf = (v) => [...String(v || '').matchAll(/<([^>]+)>/g)].map((m) => m[1].trim().toLowerCase());
const KEEP = ['list-unsubscribe', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'x-auto-response-suppress', 'content-type', 'return-path', 'x-mailer', 'x-ms-exchange-inbox-rules-loop'];
const keep = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => KEEP.includes(k)));

async function parseEml(buf) {
  const { simpleParser } = require('mailparser');
  const p = await simpleParser(buf);
  const f = p.from?.value?.[0] || {};
  const list = (x) => (x?.value || []).map((v) => fmt(v.name, v.address));
  const body = p.text && p.text.trim() ? p.text : stripHtml(p.html || '');
  return {
    kind: 'eml', from_name: f.name || f.address || '', from_addr: (f.address || '').toLowerCase(), from: fmt(f.name, f.address),
    to: list(p.to), cc: list(p.cc), subject: p.subject || '', date: iso(p.date), message_id: p.messageId || null, body: body.trim(),
    msgid: idsOf(p.messageId)[0] || null, in_reply_to: idsOf(p.inReplyTo)[0] || null, references: idsOf(Array.isArray(p.references) ? p.references.join(' ') : p.references),
    headers: keep(headerMap((p.headerLines || []).map((l) => l.line).join('\n'))),
    has_calendar: (p.attachments || []).some((a) => /text\/calendar/i.test(a.contentType || '')) || /text\/calendar/i.test(String(p.headers.get('content-type')?.value || '')),
    attachments: (p.attachments || []).filter((a) => !a.related || a.filename).map((a) => { const rfc = /message\/rfc822/i.test(a.contentType || ''); const n = a.filename || (rfc ? 'message.eml' : 'attachment'); return { name: rfc && !/\.(eml|msg)$/i.test(n) ? n.slice(0, 80) + '.eml' : n, mime: a.contentType, content: a.content, embedded: rfc }; }),
  };
}

// the reader decodes ANSI strings as Western text: redo them with the message code page (windows-1255 for Hebrew)
function fixAnsi(s, cp) {
  if (!s || !cp || cp === 1252 || cp === 65001 || /[\u0590-\u05ff]/.test(s) || !/[\u00c0-\u00ff]/.test(s)) return s;
  const enc = 'cp' + cp;
  if (!iconv.encodingExists(enc)) return s;
  return iconv.decode(iconv.encode(s, 'cp1252'), enc);
}

function parseMsg(buf) {
  const MsgReader = require('@kenjiuno/msgreader').default;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const r = new MsgReader(ab);
  const d = r.getFileData();
  if (d.error) throw new Error('msg: ' + d.error);
  let body = d.body && d.body.trim() ? d.body : '';
  if (!body && d.bodyHtml) body = stripHtml(d.bodyHtml);
  if (!body && d.html) body = stripHtml(Buffer.from(d.html).toString('utf8'));
  if (!body && d.compressedRtf) {
    try {
      const { decompressRTF } = require('@kenjiuno/decompressrtf');
      body = rtfToText(Buffer.from(decompressRTF(Array.from(d.compressedRtf))).toString('latin1'));
    } catch { /* leave empty */ }
  }
  const cp = d.messageCodepage || d.internetCodepage || 0;
  const fx = (x) => fixAnsi(x, cp);
  if (d.senderName) d.senderName = fx(d.senderName);
  if (d.subject) d.subject = fx(d.subject);
  body = fx(body);
  for (const x of d.recipients || []) if (x.name) x.name = fx(x.name);
  const email = d.senderSmtpAddress || (d.senderEmail && d.senderEmail.includes('@') ? d.senderEmail : '') || '';
  const rec = (d.recipients || []);
  const by = (t) => rec.filter((x) => (x.recipType || 'to') === t).map((x) => fmt(x.name, x.smtpAddress || x.email));
  const atts = [];
  for (const a of d.attachments || []) {
    try {
      const got = r.getAttachment(a);
      if (!got || !got.content) continue;
      const isMsg = !!a.innerMsgContent; // ATTACH_EMBEDDED_MSG: the attachment is a whole Outlook message (classic "forward as attachment")
      const base = String(a.fileName || a.name || (got.fileName && !/^undefined/.test(got.fileName) ? got.fileName : '') || a.innerMsgContentFields?.subject || (isMsg ? 'message' : 'attachment')).replace(/[\\/\0]/g, '_').trim();
      // an embedded message always gets a .msg name (its own subject), short enough for the extension to survive the file-name limit
      const name = isMsg ? (/\.msg$/i.test(base) ? base.slice(0, 80) + (base.length > 80 ? '.msg' : '') : base.slice(0, 80) + '.msg') : base;
      atts.push({ name, mime: isMsg ? 'application/vnd.ms-outlook' : (a.attachMimeTag || null), content: Buffer.from(got.content), nested_msg: isMsg, embedded: isMsg });
    } catch { /* skip unreadable attachment */ }
  }
  return {
    kind: 'msg', from_name: d.senderName || '', from_addr: email.toLowerCase(), from: fmt(d.senderName, email),
    to: by('to'), cc: by('cc'), subject: d.subject || '',
    date: iso(d.clientSubmitTime || d.messageDeliveryTime || d.creationTime), message_id: null, body: body.trim(), attachments: atts,
    ...(() => { const h = headerMap(d.headers); return { headers: keep(h), msgid: idsOf(h['message-id'] || d.messageId)[0] || null, in_reply_to: idsOf(h['in-reply-to'])[0] || null, references: idsOf(h.references),
      has_calendar: /^IPM\.(Schedule|Appointment)/i.test(d.messageClass || '') || /text\/calendar/i.test(h['content-type'] || '') }; })(),
    message_class: d.messageClass || null,
  };
}

async function parseMailFile(buf, name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (ext === 'eml') return parseEml(buf);
  if (ext === 'msg') return parseMsg(buf);
  throw new Error('not an email file');
}

const isMailFile = (name) => /\.(eml|msg)$/i.test(String(name || ''));

module.exports = { headerMap, parseMailFile, isMailFile, rtfToText, stripHtml };
