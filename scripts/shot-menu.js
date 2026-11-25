// before/after screenshot of the project settings menu on the TEST instance: node scripts/shot-menu.js before|after
const { chromium } = require('playwright'); const path = require('path');
const tag = process.argv[2];
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:8111/login'); await p.fill('input[type=password]', 'test-password-1234'); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
  const pid = await p.evaluate(async () => (await (await fetch('/api/projects')).json()).find((x) => !x.is_default).id);
  await p.goto('http://127.0.0.1:8111/projects/' + pid); await p.waitForSelector('.proj-page'); await p.waitForTimeout(600);
  await p.click('button[aria-label="תפריט פרויקט"]'); await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'resize', `${tag}-1440-project-menu.png`) });
  await b.close();
})();
