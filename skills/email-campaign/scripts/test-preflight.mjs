#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const preflight = join(here, 'preflight.mjs');
const repair = join(here, 'repair.mjs');
const fixture = join(here, 'fixtures', 'valid-email.html');
const temp = mkdtempSync(join(tmpdir(), 'mail-skill-preflight-'));

const run = (script, args) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8',
  windowsHide: true,
});

const assert = (condition, message, result) => {
  if (condition) return;
  const details = result ? `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` : '';
  throw new Error(`${message}${details}`);
};

try {
  const valid = run(preflight, [fixture, '--strict']);
  assert(valid.status === 0, 'Valid fixture must pass strict preflight.', valid);

  const mixedCampaigns = join(temp, 'mixed-campaigns.html');
  const secondLink = '<a href="https://vs-travel.ru/other?utm_source=email&amp;utm_medium=email&amp;utm_campaign=other&amp;utm_content=150926">Другой тур</a>';
  writeFileSync(mixedCampaigns, readFileSync(fixture, 'utf8').replace('</body>', `${secondLink}</body>`), 'utf8');
  const mixed = run(preflight, [mixedCampaigns, '--strict']);
  assert(mixed.status === 1 && mixed.stdout.includes('[utm-campaign]'), 'Mixed utm_campaign values must fail.', mixed);

  const repairTarget = join(temp, 'repair.html');
  const repairInput = readFileSync(fixture, 'utf8')
    .replace('</body>', '<a href="https://yandex.ru/maps/213/moscow/">Карта</a></body>')
    .replaceAll('utm_campaign=test', 'utm_campaign=old')
    .replaceAll('utm_content=150926', 'utm_term=legacy');
  writeFileSync(repairTarget, repairInput, 'utf8');
  const repaired = run(repair, [repairTarget, 'campaign', '150926']);
  assert(repaired.status === 0, 'Repair script must complete.', repaired);
  const repairedHtml = readFileSync(repairTarget, 'utf8');
  assert(repairedHtml.includes('utm_campaign=campaign') && repairedHtml.includes('utm_content=150926'), 'Repair must normalize campaign UTM.', repaired);
  assert(repairedHtml.includes('&amp;utm_medium=email'), 'Repair must HTML-escape query separators.', repaired);
  assert(!repairedHtml.includes('utm_term='), 'Repair must remove legacy utm_term.', repaired);
  assert(repairedHtml.includes('href="https://yandex.ru/maps/213/moscow/"'), 'Repair must leave Yandex Maps links untouched.', repaired);
  const repairedPreflight = run(preflight, [repairTarget, '--strict']);
  assert(repairedPreflight.status === 0, 'Repaired fixture must pass strict preflight.', repairedPreflight);

  console.log('preflight tests: 4 passed');
} finally {
  rmSync(resolve(temp), { recursive: true, force: true });
}
