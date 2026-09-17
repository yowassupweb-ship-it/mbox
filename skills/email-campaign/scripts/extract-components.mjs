#!/usr/bin/env node
// Раскладывает письма из templates/manifest.json на компоненты с уникальными сквозными номерами C001, C002, …
//
//   node scripts/extract-components.mjs
//
// Результат (всё в папке навыка, её читает страница library.html и агент):
//   components/registry.json   — реестр: номер, имя, категория, письмо-источник, файл, sha
//   components/C001.html …     — HTML компонента: строка <tr em="block"> как в письме
//   components/shells/<id>.html — оболочка письма: <head> и обёртка с меткой <!--MBOX:COMPONENTS--> вместо блоков
//   templates/manifest.json    — у каждого шаблона список components (номера по порядку)
//
// Номер закреплён за компонентом навсегда: при повторном запуске одинаковый HTML получает прежний номер,
// новый — следующий свободный; номера удалённых компонентов не переиспользуются (registry.next).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'templates', 'manifest.json');
const registryPath = resolve(root, 'components', 'registry.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const previous = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : { next: 1, components: [] };
const bySha = new Map(previous.components.map((item) => [item.sha256, item]));
const sha = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');

let next = previous.next || previous.components.length + 1;
const components = [...previous.components];
const seen = new Set(components.map((item) => item.id));

function blockSpans(html) {
  const spans = [];
  const start = /<tr\b[^>]*\bem\s*=\s*(["'])block\1[^>]*>/gi;
  let match;
  while ((match = start.exec(html))) {
    const tokens = /<tr\b[^>]*>|<\/tr\s*>/gi;
    tokens.lastIndex = match.index;
    let depth = 0;
    let end = -1;
    let token;
    while ((token = tokens.exec(html))) {
      depth += /^<tr\b/i.test(token[0]) ? 1 : -1;
      if (depth === 0) { end = tokens.lastIndex; break; }
    }
    if (end < 0) break;
    spans.push({ start: match.index, end });
    start.lastIndex = end;
  }
  return spans;
}

function plainText(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function guessCategory(name, html, index, total) {
  const text = `${name} ${plainText(html)}`.toLowerCase();
  if (['разделитель', 'отступ', 'изображение'].includes(name.toLowerCase())) return index === 0 ? 'Шапка' : 'Разделители и изображения';
  if (/^текст$/.test(name.toLowerCase())) return 'Текст';
  if (/футер|авиамоторная|ртo|рто 0/.test(text)) return 'Подвал';
  if (/логотип/.test(text) || (index === 0 && !plainText(html))) return 'Шапка';
  if (/меню|туры по россии|личный кабинет/.test(text)) return 'Навигация';
  if (/max|макс|maкс/.test(text)) return 'Мессенджер';
  if (/каталог туров/.test(text)) return 'Баннер';
  if (/промокод|скидк/.test(text) && /<img/i.test(html) === false) return 'Акция';
  if ((html.match(/<img/gi) || []).length && /–|—/.test(plainText(html))) return 'Карточка тура';
  if (/заголовок/.test(text)) return 'Заголовок';
  if (/текст/.test(text)) return 'Текст';
  if (!plainText(html)) return index === total - 1 ? 'Подвал' : 'Отступ и изображение';
  return 'Контент';
}

mkdirSync(resolve(root, 'components', 'shells'), { recursive: true });

for (const template of manifest.templates || []) {
  const sourcePath = resolve(root, template.source);
  const html = readFileSync(sourcePath, 'utf8');
  const spans = blockSpans(html);
  if (!spans.length) { template.components = []; continue; }

  // Оболочка: всё до первого блока и после последнего; блоки заменяет метка. У писем с вложенными группами
  // (промо МФП) обёртки групп между блоками пропадают — для сборки берите оболочку основного письма.
  const shell = `${html.slice(0, spans[0].start)}<!--MBOX:COMPONENTS-->${html.slice(spans.at(-1).end)}`;
  writeFileSync(resolve(root, 'components', 'shells', `${template.id}.html`), shell);

  template.components = spans.map((span, index) => {
    const blockHtml = html.slice(span.start, span.end);
    const digest = sha(blockHtml);
    const known = bySha.get(digest);
    if (known) return known.id;
    const before = html.slice(Math.max(0, span.start - 300), span.start);
    const comment = [...before.matchAll(/<!--\s*([\s\S]*?)\s*-->/g)].at(-1)?.[1]?.replace(/\s+/g, ' ').trim();
    const text = plainText(blockHtml);
    const kind = /border-top\s*:/i.test(blockHtml) && !text ? 'Разделитель' : /<img/i.test(blockHtml) && !text ? 'Изображение' : !text ? 'Отступ' : '';
    const name = comment && comment.length < 90 ? comment : kind || text.split(' ').slice(0, 6).join(' ');
    let id = `C${String(next).padStart(3, '0')}`;
    while (seen.has(id)) { next += 1; id = `C${String(next).padStart(3, '0')}`; }
    next += 1;
    seen.add(id);
    const entry = {
      id,
      name,
      category: guessCategory(name, blockHtml, index, spans.length),
      source: template.id,
      file: `components/${id}.html`,
      sha256: digest,
    };
    writeFileSync(resolve(root, entry.file), `${blockHtml}\n`);
    components.push(entry);
    bySha.set(digest, entry);
    return id;
  });
  template.shell = `components/shells/${template.id}.html`;
}

writeFileSync(registryPath, `${JSON.stringify({ version: 1, next, components }, null, 2)}\n`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`components: ${components.length} (next ${`C${String(next).padStart(3, '0')}`}); templates: ${(manifest.templates || []).map((t) => `${t.id} → ${t.components.length}`).join(', ')}`);
