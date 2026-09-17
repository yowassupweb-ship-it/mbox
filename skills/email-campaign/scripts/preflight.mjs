#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPreflight } from './preflight-core.mjs';

const target = process.argv.find((arg) => !arg.startsWith('-') && arg !== process.argv[0] && arg !== process.argv[1]);
const strict = process.argv.includes('--strict');

if (!target) {
  console.error('Usage: node scripts/preflight.mjs <email.html> [--strict]');
  process.exit(2);
}

const { errors, warnings, stats } = runPreflight(readFileSync(resolve(target), 'utf8'));
const print = (label, rows) => rows.forEach((row) => console.log(`${label} [${row.code}] ${row.detail}`));
print('ERROR', errors);
print('WARN', warnings);
console.log(`Preflight: ${errors.length} errors, ${warnings.length} warnings, ${stats.links} links, ${stats.images} images, ${stats.blocks} UniSender blocks, ${stats.atoms} atoms.`);

if (errors.length || (strict && warnings.length)) process.exit(1);
