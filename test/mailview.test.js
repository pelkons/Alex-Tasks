'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { render, extract, remoteCount } = require('../lib/mailview');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('mail view security: scripts, handlers, javascript: links, remote images and CSS urls never reach the page', () => {
  const html = '<div onclick="x()">hi<script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">j</a><a href="https://ok.example/p">ok</a>'
    + '<img src="https://track.example/p.gif"><p style="background:url(https://evil.example/a.png);color:red">s</p><iframe src="https://e.example"></iframe><style>@import url(https://e.example/x.css)</style><form action="https://e.example"><input></form></div>';
  const { page, csp, blocked } = render(html, []);
  for (const bad of ['<script', 'alert(1)', 'onerror', 'onclick', 'javascript:', 'track.example', 'evil.example', '<iframe', '@import', '<form', '<input']) assert.ok(!page.includes(bad), bad);
  assert.ok(page.includes('href="https://ok.example/p"') && page.includes('rel="noopener noreferrer nofollow"') && page.includes('target="_blank"'));
  assert.ok(page.includes('color:red')); assert.equal(blocked, 1); assert.match(csp, /default-src 'none'/); assert.ok(!/img-src[^;]*https/.test(csp), 'no remote images in the CSP by default');
  const r = render(html, [], { remote: true }); assert.ok(r.page.includes('https://track.example/p.gif') && /img-src data: https:/.test(r.csp));
});

test('cid pictures become data URIs from the stored inline image; unknown cid and non-image data are dropped', () => {
  const { page } = render('<img src="cid:Image001.PNG@01D">  <img src="cid:nope"> <img src="data:text/html;base64,PHNjcmlwdD4=">', [{ cid: 'image001.png@01d', name: 'image001.png', mime: 'image/png', content: png }]);
  assert.match(page, /src="data:image\/png;base64,iVBOR/); assert.ok(!page.includes('cid:') && !page.includes('text/html'));
});

test('an .eml with HTML and a cid picture: html extracted, the picture kept as inline', async () => {
  const eml = ['From: a <a@x.com>', 'To: b@x.com', 'Subject: s', 'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary=B', '', '--B', 'Content-Type: text/html; charset=utf-8', '', '<p dir="rtl">שלום</p><img src="cid:logo1">', '--B', 'Content-Type: image/png; name=image001.png', 'Content-ID: <logo1>', 'Content-Transfer-Encoding: base64', 'Content-Disposition: inline; filename=image001.png', '', png.toString('base64'), '--B--', ''].join('\r\n');
  const x = await extract(Buffer.from(eml), 'a.eml'); assert.ok(x.html.includes('שלום')); assert.equal(x.inline.length, 1); assert.equal(x.inline[0].cid, 'logo1'); assert.equal(x.inline[0].name, 'image001.png');
  assert.equal(remoteCount('<img src="https://a.b/c.gif"><img src="cid:x">'), 1);
});

test('classic Outlook: HTML encapsulated in RTF (\\fromhtml1) is recovered, the RTF rendition is dropped', () => {
  const { htmlFromRtf } = require('../lib/mailview');
  const rtf = "{\\rtf1\\ansi\\ansicpg1255\\fromhtml1 {\\fonttbl{\\f0 Arial;}}{\\*\\htmltag19 <p>}\\htmlrtf {\\htmlrtf0 \\'f9\\'ec\\'e5\\'ed{\\*\\htmltag27 </p>}\\htmlrtf \\par }\\htmlrtf0 {\\*\\mhtmltag1 junk}}";
  assert.equal(htmlFromRtf(rtf), '<p>שלום</p>'); assert.equal(htmlFromRtf('{\\rtf1\\ansi plain}'), '');
});
