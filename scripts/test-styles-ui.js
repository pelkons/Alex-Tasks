'use strict';
// UI check of Settings → סגנונות כתיבה on the TEST instance (412x915 phone and 1440 desktop, light and dark), fictional data only:
// the list (name, who, status) and a pending suggestion; the editor (dropdowns, "who" chips add/remove, group members, forbidden phrases,
// the preview from the rules, the real examples read-only, save / activate); accepting a suggestion; the "סגנון: <name>" tag on an outgoing-mail card.
// No horizontal overflow anywhere, no JS errors. Screenshots in $SHOTS (default /tmp/ui-shots).
//   scripts/testenv.sh start; eval "$(scripts/testenv.sh env)"; NODE_PATH=<a node_modules directory that has playwright> node scripts/test-styles-ui.js
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8111';
const OUT = process.env.SHOTS || '/tmp/ui-shots';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { open } = require('../lib/db'); const { createStore } = require('../lib/store'); const { createStyles } = require('../lib/writingstyle'); const { createOutbox } = require('../lib/outbox');
  const db = open(process.env.MESIMOT_DB); const store = createStore(db); const S = createStyles({ db, store }); S.ensureSeed();
  const owner = store.ownerId(), a = store.assistantId();
  const person = (name, email) => store.listPeople().find((p) => p.name_he === name) || store.createPerson(owner, { name, emails: email });
  const seed = () => {
    db.prepare("DELETE FROM writing_styles WHERE key NOT IN ('base','casual','formal')").run(); db.prepare('DELETE FROM style_suggestions').run();
    const dana = person('דנה לוי', 'dana.levi@example.com'); const noa = person('נועה ברק', 'noa@studio.example.com');
    S.setGroup(owner, noa.id, 'משרדי תכנון');
    const p = S.create(owner, { key: 'p-person-test', replace: true, name_he: 'דנה לוי', status: 'proposed', description_he: 'קצר מאוד וישיר, כמו בצ׳אט. שואל שאלה אחת.', rules: { formality: 'casual', greeting: '{first_name}, היי', greeting_alt: ['היי {first_name}', 'none'], closing: 'none', max_sentences: 3, max_words: 45, allow_bullets: false, forbidden_phrases: ['אשמח אם תוכלי', 'בהמשך לשיחתנו'] },
      examples: [{ email_id: 1, date: '2026-11-20', subject: 'תוכניות קומה 3', text: 'דנה, היי\nשלחת כבר את התוכניות של קומה 3?' }, { email_id: 2, date: '2026-11-18', subject: 'פגישה', text: 'היי דנה\nנדבר מחר בבוקר?' }, { email_id: 3, date: '2026-11-12', subject: 'חשבון', text: 'מצורף החשבון המעודכן, תעברי עליו.' }],
      assignments: [{ kind: 'person', ref: String(dana.id) }] }, { source: 'analysis' });
    S.create(owner, { key: 'p-group-test', replace: true, name_he: 'משרדי תכנון', status: 'active', rules: { formality: 'neutral', greeting: 'שלום {first_name}', closing: 'תודה', max_sentences: 6 }, assignments: [{ kind: 'group', ref: 'משרדי תכנון' }, { kind: 'domain', ref: 'studio.example.com' }] });
    S.addSuggestion(p.id, 'feedback', 'בדרך כלל אתה מקצר ל-2 משפטים לדנה לוי - לעדכן?', { max_sentences: 2 }, {}, 'ui-test');
    const ob = createOutbox({ db, store, styles: S });
    return ob.create(a, { to: 'נועה ברק (noa@studio.example.com)', subject: 'תוכניות מעודכנות', body: 'שלום נועה,\nאפשר לקבל את התוכניות המעודכנות עד חמישי?\nתודה' });
  };
  let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [w, h, tag, scheme] of [[412, 915, 'phone', 'light'], [412, 915, 'phone', 'dark'], [1440, 900, 'desktop', 'light'], [1440, 900, 'desktop', 'dark']]) {
    const T = `${tag}-${scheme}`;
    const draft = seed();
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: tag === 'desktop' ? 1 : 2 }); const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/login'); await page.fill('input[type=password]', 'test-password-1234'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
    const noOverflow = async (what) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && [...document.querySelectorAll('.sty *')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1 && el.getBoundingClientRect().left >= -1)), `${T}: ${what}: no horizontal overflow`);
    await page.goto(BASE + '/settings?c=styles'); await page.waitForSelector('[data-test=styles]'); await page.waitForTimeout(600);
    ok(await page.locator('.sty-row').count() >= 5, `${T}: the list shows the styles`);
    ok(await page.locator('.sty-row[data-key=p-person-test] .sty-st').innerText() === 'הצעה', `${T}: a proposed style is marked "הצעה"`);
    ok(/(?=.*משרדי תכנון)(?=.*studio\.example\.com)/s.test(await page.locator('.sty-row[data-key=p-group-test]').innerText()), `${T}: who it applies to`);
    ok(await page.locator('[data-test=sty-sugg]').count() === 1, `${T}: the pending suggestion`);
    await noOverflow('list'); await page.screenshot({ path: `${OUT}/styles-list-${T}.png`, fullPage: true });
    // the editor
    await page.click('.sty-row[data-key=p-person-test]'); await page.waitForSelector('[data-test=sty-editor]'); await page.waitForTimeout(400);
    ok(/דנה, היי/.test(await page.locator('[data-test=sty-preview]').innerText()), `${T}: the preview shows the greeting from the rules`);
    ok(await page.locator('.sty-ex').count() === 3, `${T}: 3 real examples, read-only`);
    await page.selectOption('[aria-label=פתיחה]', 'שלום {first_name}'); await page.waitForTimeout(150);
    ok(/^שלום דנה/.test(await page.locator('[data-test=sty-preview]').innerText()), `${T}: the preview follows the dropdown`);
    await page.fill('[aria-label="ביטוי אסור"]', 'בברכה חמה'); await page.locator('[aria-label="ביטוי אסור"]').press('Enter'); await page.waitForTimeout(150);
    ok(await page.locator('.sty-chip', { hasText: 'בברכה חמה' }).count() === 1, `${T}: a forbidden phrase added`);
    await page.selectOption('.sty-add select >> nth=0', 'domain'); await page.fill('.sty-add input[aria-label=למי]', 'example.com'); await page.locator('.sty-add input[aria-label=למי]').press('Enter'); await page.waitForTimeout(500);
    ok(await page.locator('.sty-chip[data-kind=domain]', { hasText: 'example.com' }).count() === 1, `${T}: a domain chip added`);
    await noOverflow('editor'); await page.screenshot({ path: `${OUT}/styles-editor-${T}.png`, fullPage: true });
    await page.locator('.sty-chip[data-kind=domain] button').click(); await page.waitForTimeout(400);
    ok(await page.locator('.sty-chip[data-kind=domain]').count() === 0, `${T}: the chip removed`);
    await page.click('[data-test=sty-activate]'); await page.waitForTimeout(600);
    const st = S.find('p-person-test'); ok(st.status === 'active' && st.rules.greeting === 'שלום {first_name}' && st.rules.forbidden_phrases.includes('בברכה חמה'), `${T}: saved and activated`);
    // a group's members
    await page.click('text=→ כל הסגנונות'); await page.waitForTimeout(500); await page.click('.sty-row[data-key=p-group-test]'); await page.waitForTimeout(500);
    ok(await page.locator('.sty-chip', { hasText: 'נועה ברק' }).count() === 1, `${T}: the group lists its members`);
    await page.click('text=→ כל הסגנונות'); await page.waitForTimeout(500);
    // the suggestion: accepted -> applied
    await page.click('[data-test=sty-sugg] .btn.primary'); await page.waitForTimeout(600);
    ok(S.find('p-person-test').rules.max_sentences === 2 && (await page.locator('[data-test=sty-sugg]').count()) === 0, `${T}: the accepted suggestion is applied`);
    // the tag on the outgoing-mail card
    await page.goto(BASE + '/chat'); await page.waitForTimeout(1500);
    const tag2 = page.locator(`[data-test=ob-style]`).last(); ok((await tag2.count()) && /סגנון: משרדי תכנון/.test(await tag2.innerText()), `${T}: the card shows "סגנון: ${draft.style_name}"`);
    await tag2.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${OUT}/styles-card-${T}.png` });
    ok(!errors.length, `${T}: no JS errors ${errors.join(' | ')}`);
    await ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
