import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const [inputArg, outputArg] = process.argv.slice(2);

if (!inputArg || !outputArg) {
  console.error('Usage: node scripts/qa-icon-pack.mjs <input-directory> <output.png>');
  process.exit(1);
}

const inputDirectory = path.resolve(inputArg);
const outputPath = path.resolve(outputArg);
const files = (await readdir(inputDirectory))
  .filter((file) => file.toLowerCase().endsWith('.png'))
  .sort((left, right) => left.localeCompare(right, 'ru', { numeric: true }));

if (!files.length) {
  console.error(`No PNG files found in ${inputDirectory}`);
  process.exit(1);
}

const escapeHtml = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const rows = (await Promise.all(files.map(async (file) => {
  const image = await readFile(path.join(inputDirectory, file));
  const source = `data:image/png;base64,${image.toString('base64')}`;
  const samples = ['light', 'graphite', 'black'].map((theme) => `
    <div class="sample ${theme}">
      <img class="size-24" src="${source}" alt="">
      <img class="size-32" src="${source}" alt="">
    </div>`).join('');

  return `<div class="row"><div class="label">${escapeHtml(file)}</div>${samples}</div>`;
}))).join('');

const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 24px; background: #e8e8ec; color: #18181b; font: 14px Inter, Arial, sans-serif; }
      .head, .row { display: grid; grid-template-columns: 260px repeat(3, 1fr); gap: 10px; }
      .head { margin-bottom: 8px; font-weight: 700; }
      .head div:not(:first-child) { text-align: center; }
      .row { align-items: center; margin-bottom: 8px; }
      .label { overflow: hidden; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .sample { display: flex; height: 68px; align-items: center; justify-content: center; gap: 28px; border: 1px solid rgb(0 0 0 / 12%); border-radius: 12px; }
      .light { background: #f5f5f7; }
      .graphite { background: #202124; }
      .black { background: #050506; }
      .size-24 { width: 24px; height: 24px; object-fit: contain; }
      .size-32 { width: 32px; height: 32px; object-fit: contain; }
    </style>
  </head>
  <body>
    <div class="head"><div>Файл</div><div>Светлая</div><div>Графитовая</div><div>Тёмная</div></div>
    ${rows}
  </body>
</html>`;

const installedBrowsers = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
].filter(Boolean);
const executablePath = installedBrowsers.find((candidate) => existsSync(candidate));
const browser = await chromium.launch({ headless: true, executablePath });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(outputPath);
} finally {
  await browser.close();
}
