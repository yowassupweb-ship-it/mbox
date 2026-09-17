#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'templates', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const failures = [];
const blockIds = new Set();
const blockKeys = new Set();
const templateIds = new Set();

for (const pageName of ['library.html', 'brief-builder.html']) {
  const page = readFileSync(resolve(root, pageName), 'utf8');
  const scripts = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (!scripts.length) failures.push(`${pageName}: не найден встроенный script.`);
  scripts.forEach((source, index) => {
    try { new Script(source, { filename: `${pageName}#script-${index + 1}` }); }
    catch (error) { failures.push(`${pageName}: ошибка JavaScript: ${error.message}`); }
  });
}

for (const block of manifest.blocks || []) {
  if (!/^B(?:0[1-9]|1[0-2])$/.test(block.id)) failures.push(`Некорректный ID блока: ${block.id}`);
  if (blockIds.has(block.id)) failures.push(`Повтор ID блока: ${block.id}`);
  if (blockKeys.has(block.key)) failures.push(`Повтор key блока: ${block.key}`);
  blockIds.add(block.id);
  blockKeys.add(block.key);
}

for (const template of manifest.templates || []) {
  if (templateIds.has(template.id)) failures.push(`Повтор ID шаблона: ${template.id}`);
  templateIds.add(template.id);
  const source = resolve(root, template.source);
  if (!existsSync(source)) failures.push(`Не найден референс ${template.id}: ${source}`);
  for (const key of template.blocks || []) {
    if (!blockKeys.has(key)) failures.push(`${template.id} ссылается на неизвестный блок: ${key}`);
  }
}

if (blockIds.size !== 12) failures.push(`Ожидалось 12 блоков B01–B12, найдено: ${blockIds.size}`);

// Компоненты: уникальные номера C###, файлы на месте, next больше любого номера, шаблоны ссылаются на известные.
const registryPath = resolve(root, 'components', 'registry.json');
let componentCount = 0;
if (existsSync(registryPath)) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const componentIds = new Set();
  for (const component of registry.components || []) {
    if (!/^C\d{3,}$/.test(component.id)) failures.push(`Некорректный номер компонента: ${component.id}`);
    if (componentIds.has(component.id)) failures.push(`Повтор номера компонента: ${component.id}`);
    componentIds.add(component.id);
    if (!existsSync(resolve(root, component.file))) failures.push(`${component.id}: нет файла ${component.file}`);
    if (Number(component.id.slice(1)) >= (registry.next || 0)) failures.push(`registry.next (${registry.next}) не больше номера ${component.id}`);
  }
  for (const template of manifest.templates || []) {
    for (const id of template.components || []) if (!componentIds.has(id)) failures.push(`${template.id} ссылается на неизвестный компонент ${id}`);
    if (template.shell && !existsSync(resolve(root, template.shell))) failures.push(`${template.id}: нет оболочки ${template.shell}`);
  }
  componentCount = componentIds.size;
}
if (!(manifest.templates || []).length) failures.push('В manifest нет шаблонов.');

if (failures.length) {
  failures.forEach((failure) => console.error(`ERROR ${failure}`));
  process.exit(1);
}

console.log(`catalog tests: ${manifest.templates.length} templates, ${blockIds.size} blocks, ${componentCount} components, all references valid`);
