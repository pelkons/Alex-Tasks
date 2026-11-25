'use strict';
// Builds minimal but valid Outlook .msg (CFB) files for tests.
const CFB = require('cfb');
const iconv = require('iconv-lite');

const u16 = (s) => Buffer.from(s, 'utf16le');
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

function filetime(ms) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(ms + 11644473600000) * 10000n);
  return b;
}

// opts: from_name, from_addr, to:[{name,addr}], subject, body, html, date (ms), ansi1255 (use ANSI strings), attachments:[{name, data}|{name, msg}]
function buildMsg(opts, cfb, prefix = '', embedded = false) {
  const c = cfb || CFB.utils.cfb_new();
  const add = (p, data) => CFB.utils.cfb_add(c, prefix + p, data);
  const str = (id, s) => {
    if (s === undefined || s === null) return;
    if (opts.ansi1255) add(`/__substg1.0_${hex4(id)}001E`, iconv.encode(s, 'cp1255'));
    else add(`/__substg1.0_${hex4(id)}001F`, u16(s));
  };
  const entries = [];
  const prop = (id, type, value8) => { const b = Buffer.alloc(16); b.writeUInt32LE(((id << 16) | type) >>> 0, 0); b.writeUInt32LE(6, 4); value8.copy(b, 8); entries.push(b); };
  const int32 = (n) => { const b = Buffer.alloc(8); b.writeInt32LE(n, 0); return b; };
  str(0x001A, 'IPM.Note');
  str(0x0037, opts.subject);
  str(0x0C1A, opts.from_name);
  str(0x0C1F, opts.from_addr);
  str(0x5D01, opts.from_addr);
  if (opts.body !== undefined) str(0x1000, opts.body);
  if (opts.rtf) { // uncompressed ("MELA") compressed-RTF container
    const raw = Buffer.from(opts.rtf, 'latin1');
    const h = Buffer.alloc(16); h.writeUInt32LE(raw.length + 12, 0); h.writeUInt32LE(raw.length, 4); h.write('MELA', 8, 'latin1'); h.writeUInt32LE(0, 12);
    add('/__substg1.0_10090102', Buffer.concat([h, raw]));
  }
  if (opts.html) add('/__substg1.0_10130102', Buffer.from(opts.html, 'utf8'));
  if (opts.ansi1255) prop(0x3FFD, 3, int32(1255));
  if (opts.date) prop(0x0039, 0x40, filetime(opts.date));
  prop(0x0E07, 3, int32(1));
  const to = opts.to || [];
  to.forEach((r, i) => {
    const base = `/__recip_version1.0_#${i.toString(16).padStart(8, '0')}`;
    const rp = Buffer.alloc(8); const e = Buffer.alloc(16); e.writeUInt32LE(((0x0C15 << 16) | 3) >>> 0, 0); e.writeUInt32LE(6, 4); e.writeInt32LE(1, 8);
    add(base + '/__properties_version1.0', Buffer.concat([rp, e]));
    add(base + `/__substg1.0_3001001F`, u16(r.name || r.addr));
    add(base + `/__substg1.0_39FE001F`, u16(r.addr));
    add(base + `/__substg1.0_3003001F`, u16(r.addr));
  });
  const atts = opts.attachments || [];
  atts.forEach((a, i) => {
    const base = `/__attach_version1.0_#${i.toString(16).padStart(8, '0')}`;
    const e = Buffer.alloc(16); e.writeUInt32LE(((0x3705 << 16) | 3) >>> 0, 0); e.writeUInt32LE(6, 4); e.writeInt32LE(a.msg ? 5 : 1, 8);
    add(base + '/__properties_version1.0', Buffer.concat([Buffer.alloc(8), e]));
    add(base + '/__substg1.0_3707001F', u16(a.name));
    add(base + '/__substg1.0_3704001F', u16(a.name));
    if (a.msg) buildMsg(a.msg, c, prefix + base + '/__substg1.0_3701000D', true);
    else { add(base + '/__substg1.0_37010102', a.data); if (a.mime) add(base + '/__substg1.0_370E001F', u16(a.mime)); }
  });
  const header = Buffer.alloc(embedded ? 24 : 32);
  header.writeUInt32LE(to.length, 8); header.writeUInt32LE(atts.length, 12); header.writeUInt32LE(to.length, embedded ? 16 : 16); header.writeUInt32LE(atts.length, embedded ? 20 : 20);
  add('/__properties_version1.0', Buffer.concat([header, ...entries]));
  if (!embedded && !cfb) return Buffer.from(CFB.write(c, { type: 'buffer' }));
  return c;
}

module.exports = { buildMsg };
