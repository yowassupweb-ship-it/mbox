#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [target, campaign, content] = process.argv.slice(2);
if (!target || !campaign || !content) {
  console.error('Usage: node scripts/repair.mjs <email.html> <utm_campaign> <utm_content>');
  process.exit(2);
}

const ignored = new Set(['vk.com', 'vk.me', 't.me', 'wa.me', 'viber.com', 'clck.ru', 'dzen.ru', 'max.ru']);
const isIgnored = (url) => [...ignored].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  || (url.hostname === 'yandex.ru' && url.pathname.startsWith('/maps/'));
const decodeHtmlAttribute = (value) => value
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
const path = resolve(target);
let html = readFileSync(path, 'utf8');
let repaired = 0;

html = html.replace(/font-size\s*:\s*15px\s*<br>/gi, () => { repaired += 1; return 'font-size:15px;'; });
html = html.replace(/<script\b[\s\S]*?<\/script>/gi, () => { repaired += 1; return ''; });
html = html.replace(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>/gis, (tag, before, quote, href, after) => {
  if (/^(?:mailto:|tel:|#)/i.test(href)) return tag;
  let url;
  try { url = new URL(decodeHtmlAttribute(href)); } catch { return tag; }
  if (!/^https?:$/.test(url.protocol) || isIgnored(url)) return tag;
  url.searchParams.delete('utm_term');
  url.searchParams.set('utm_source', 'email');
  url.searchParams.set('utm_medium', 'email');
  url.searchParams.set('utm_campaign', campaign);
  url.searchParams.set('utm_content', content);
  repaired += 1;
  return `<a${before}href=${quote}${url.toString().replaceAll('&', '&amp;')}${quote}${after}>`;
});

writeFileSync(path, html, 'utf8');
console.log(`Repaired ${repaired} deterministic issues in ${path}. Run preflight --strict next.`);
