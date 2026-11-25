'use strict';
// QA over every screen on phone and desktop, light and dark, against the TEST instance. Reports truncation, overflow, Latin words and oversized empty controls.
const fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
if (!/8111|test/.test(BASE)) throw new Error('QA must run against the test instance');
const OUT = path.join(__dirname, '..', 'screenshots', 'qa');
const EXE = process.env.CHROMIUM_PATH || undefined; // optional Chromium binary (Playwright's own browser otherwise)
const ids = JSON.parse(process.env.QA_IDS || '{}');
const routes = [
  ['home', '/'], ['task', `/task/${ids.task || 1}`], ['projects', `/projects/${ids.project || 2}`], ['protocols', `/protocols/${ids.protocol || 1}`], ['calendar-month', '/calendar'], ['search', '/search?q=%D7%AA%D7%A7%D7%A6%D7%99%D7%91'],
  ['activity', '/activity'], ['people', '/people'], ['settings', '/settings'], ['email', `/email/${ids.email || 1}`],
];
const ALLOWED = /^(Claude|http|https|www|com|co|il|org|net|ics|only|tasks|meetings|AM|PM)$/i;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: EXE });
  const findings = [];
  for (const [dev, vp, mob] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) {
    for (const theme of ['light', 'dark']) {
      const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1.5, isMobile: mob, hasTouch: mob, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', colorScheme: theme });
      const page = await ctx.newPage();
      const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
      await page.goto(BASE + '/login'); await page.fill('#pw', 'test-password-1234');
      await Promise.all([page.waitForURL((u) => new URL(u).pathname === '/'), page.click('#go')]);
      await page.waitForTimeout(500);
      for (const [name, url] of routes) {
        await page.goto(BASE + url); await page.waitForTimeout(900);
        if (name === 'calendar-month') await page.waitForSelector('.cal-grid');
        const r = await page.evaluate((allowedSrc) => {
          const allowed = new RegExp(allowedSrc, 'i');
          const out = { overflowX: document.scrollingElement.scrollWidth > innerWidth + 1, truncated: [], latin: [], emptyBig: [] };
          const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
          for (const el of document.querySelectorAll('main *, .chat-panel *, .topbar *, .bottomnav *')) {
            if (!vis(el) || !el.childNodes.length) continue;
            const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
            const cs = getComputedStyle(el);
            if (hasText && (cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis') && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 3) && !el.closest('.chiprow, .feed, .picker, .menu, .cal-cell, .cal-grid, .mailtext, pre')) out.truncated.push(`${el.tagName}.${el.className.toString().slice(0, 30)}: ${el.textContent.trim().slice(0, 50)}`);
            if ((el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && !el.value && el.getBoundingClientRect().height > 100 && !el.closest('.cp-composer')) out.emptyBig.push(`${el.tagName}[${el.placeholder || el.getAttribute('aria-label') || ''}] h=${Math.round(el.getBoundingClientRect().height)}`);
          }
          // Latin words in visible text (emails, urls and the name Claude are fine)
          const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT);
          for (let n; (n = walker.nextNode());) {
            const el = n.parentElement;
            if (!el || !vis(el) || el.closest('bdi, .mh-mail, .s-snip, .mailtext, pre, .p-chip i, input, textarea, [dir=ltr]')) continue;
            for (const w of n.textContent.replace(/\S+@\S+/g, '').replace(/https?:\/\/\S+/g, '').match(/[A-Za-z]{3,}/g) || []) if (!allowed.test(w)) out.latin.push(`${w} in ${el.className.toString().slice(0, 25) || el.tagName}`);
          }
          return out;
        }, ALLOWED.source);
        const tag = `${dev}-${theme}-${name}`;
        if (r.overflowX) findings.push(`${tag}: horizontal overflow`);
        for (const t of [...new Set(r.truncated)].slice(0, 6)) findings.push(`${tag}: truncated -> ${t}`);
        for (const t of [...new Set(r.latin)].slice(0, 6)) findings.push(`${tag}: latin -> ${t}`);
        for (const t of [...new Set(r.emptyBig)].slice(0, 4)) findings.push(`${tag}: big empty control -> ${t}`);
        if (theme === 'light' || name === 'home' || name === 'task') await page.screenshot({ path: `${OUT}/${tag}.png` });
      }
      if (errs.length) findings.push(`${dev}-${theme}: console errors ${[...new Set(errs)].slice(0, 3).join(' | ')}`);
      await ctx.close();
    }
  }
  await b.close();
  console.log(findings.length ? findings.join('\n') : 'no findings');
})().catch((e) => { console.error(e); process.exit(1); });
