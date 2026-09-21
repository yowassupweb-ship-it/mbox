import { chromium } from 'playwright';

const cdpUrl = process.env.MBOX_CDP_URL || 'http://127.0.0.1:9223';
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes('127.0.0.1:5173'));

if (!page) {
  console.error(`MBOX page was not found through ${cdpUrl}`);
  process.exit(1);
}

const button = page.locator('.wb-doc-actions .doc-theme-button').first();
const surface = page.locator('.wb-note-surface').first();
await button.waitFor({ state: 'visible' });
await surface.waitFor({ state: 'visible' });

const states = [];
for (let index = 0; index < 4; index += 1) {
  const current = await surface.getAttribute('class');
  states.push(current);
  if (index < 3) {
    await button.click();
    await page.waitForFunction(
      ({ selector, previous }) => document.querySelector(selector)?.getAttribute('class') !== previous,
      { selector: '.wb-note-surface', previous: current },
      { timeout: 5000 },
    );
  }
}

const themes = states.map((value) => value?.match(/doc-theme-(light|graphite|black)/)?.[1]);
const passed = new Set(themes.slice(0, 3)).size === 3 && themes[0] === themes[3];
console.log(JSON.stringify({ themes, passed }, null, 2));
process.exit(passed ? 0 : 1);
