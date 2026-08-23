#!/usr/bin/env node
// Todo #161: API Джарвиса живёт в трёх независимых копиях (mbox-server.mjs / vite.config.ts /
// mbox-archivist.mjs) — уже случалось, что фикс попадал в одну и не попадал в остальные (например
// текст "Итог запуска" был верным только в dev-версии). Полный вынос в shared-модуль — отдельная
// большая задача с архитектурными последствиями (одна копия ходит через прямой pg.Client, другая
// через vite dev middleware, третья — чистый REST-клиент без доступа к БД вовсе). Этот скрипт —
// дешёвая защита прямо сейчас: сверяет набор имён инструментов Джарвиса (JARVIS_TOOLS) и набор
// веток диспетчера (runJarvisTool/dispatch) между тремя файлами. Расхождение почти всегда значит,
// что кто-то забыл зеркалировать правку.
//
// Запуск: node scripts/check-triple-mirror.mjs (или npm run check:mirror). Не блокирует коммит
// сам по себе — коммитить сюда hook не стали, т.к. .git/hooks не версионируется и не переживёт
// новый клон репозитория; это ручная/CI-проверка.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const FILES = {
  "server/mbox-server.mjs": join(ROOT, "server/mbox-server.mjs"),
  "vite.config.ts": join(ROOT, "vite.config.ts"),
  "scripts/mbox-archivist.mjs": join(ROOT, "scripts/mbox-archivist.mjs"),
};

function extractToolNames(source) {
  const names = new Set();
  const re = /type:\s*"function",\s*function:\s*\{\s*name:\s*"([a-z0-9_]+)"/g;
  let match;
  while ((match = re.exec(source))) names.add(match[1]);
  return names;
}

function extractDispatchNames(source) {
  const names = new Set();
  // Обе диспетчерские функции пишут одинаково: if (name === "tool_name") — по обеим известным
  // сигнатурам (runJarvisTool в трёх файлах называется одинаково).
  const re = /if\s*\(\s*name\s*===\s*"([a-z0-9_]+)"/g;
  let match;
  while ((match = re.exec(source))) names.add(match[1]);
  return names;
}

function diffSets(setsByFile, label) {
  const allNames = new Set();
  for (const set of Object.values(setsByFile)) for (const n of set) allNames.add(n);
  const problems = [];
  for (const name of allNames) {
    const missingFrom = Object.entries(setsByFile).filter(([, set]) => !set.has(name)).map(([file]) => file);
    if (missingFrom.length > 0 && missingFrom.length < Object.keys(setsByFile).length) {
      problems.push(`  ${label} "${name}" отсутствует в: ${missingFrom.join(", ")}`);
    }
  }
  return problems;
}

const sources = {};
for (const [label, path] of Object.entries(FILES)) {
  try {
    sources[label] = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`Не смог прочитать ${label}: ${error.message}`);
    process.exit(1);
  }
}

const toolSets = Object.fromEntries(Object.entries(sources).map(([label, src]) => [label, extractToolNames(src)]));
const dispatchSets = Object.fromEntries(Object.entries(sources).map(([label, src]) => [label, extractDispatchNames(src)]));

const problems = [...diffSets(toolSets, "Инструмент JARVIS_TOOLS"), ...diffSets(dispatchSets, "Ветка диспетчера")];

if (problems.length === 0) {
  console.log("OK: набор инструментов Джарвиса и веток диспетчера одинаков во всех трёх файлах.");
  process.exit(0);
}

console.error("Расхождение между тремя копиями API Джарвиса (todo #161):");
console.error(problems.join("\n"));
console.error("\nЕсли расхождение осознанное (например инструмент нарочно недоступен в резервном cron) — игнорируй. Иначе зеркалируй правку в остальные файлы.");
process.exit(1);
