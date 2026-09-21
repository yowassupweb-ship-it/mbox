import path from 'node:path';
import { chromium } from 'playwright';

const outputPath = path.resolve(process.argv[2] || 'artifacts-workbench-icons.png');
const requestedTheme = process.argv[3];
const cdpUrl = process.env.MBOX_CDP_URL || 'http://127.0.0.1:9223';
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes('127.0.0.1:5173'));

if (!page) {
  console.error(`MBOX page was not found through ${cdpUrl}`);
  process.exit(1);
}

await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(800);

const previousTheme = await page.locator('html').getAttribute('data-theme');
if (requestedTheme) await page.locator('html').evaluate((element, theme) => element.setAttribute('data-theme', theme), requestedTheme);

const icons = await page.locator('.wb-activity-icon img').evaluateAll((images) => images.map((image) => ({
  source: image.getAttribute('src'),
  width: image.clientWidth,
  height: image.clientHeight,
  naturalWidth: image.naturalWidth,
  naturalHeight: image.naturalHeight,
  complete: image.complete,
})));

await page.screenshot({ path: outputPath, fullPage: false });
if (requestedTheme) {
  await page.locator('html').evaluate((element, theme) => {
    if (theme) element.setAttribute('data-theme', theme);
    else element.removeAttribute('data-theme');
  }, previousTheme);
}
console.log(JSON.stringify({ outputPath, icons }, null, 2));
process.exit(icons.length === 9 && icons.every((icon) => icon.complete && icon.naturalWidth === 128 && icon.naturalHeight === 128) ? 0 : 1);
