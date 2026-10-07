// Проверка, что закоммиченная сборка public/ сделана из текущего src/.
// Прод отдаёт public/ как есть, поэтому правка src/ без `npm run build` и коммита public/ тихо остаётся только в коде.
//
//   node scripts/check-public-sync.mjs           проверить (код выхода 1, если src новее сборки)
//   node scripts/check-public-sync.mjs --write   записать отпечаток текущего src/ в public/build-info.json
//
// `npm run ship` = build + запись отпечатка; `npm run check:public` = проверка.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUTS = ["src", "index.html"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

function listFiles(target, base) {
  const full = path.join(base, target);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return [];
  }
  if (stat.isFile()) return [target];
  const found = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    found.push(...listFiles(path.posix.join(target.replaceAll("\\", "/"), entry.name), base));
  }
  return found;
}

/** Отпечаток входов сборки. Переводы строк приводятся к LF, чтобы CRLF/LF в рабочей копии не меняли хэш. */
export function sourceFingerprint(base = root, inputs = INPUTS) {
  const hash = createHash("sha256");
  const files = inputs.flatMap((input) => listFiles(input, base)).sort();
  for (const file of files) {
    const text = fs.readFileSync(path.join(base, file)).toString("latin1").replace(/\r\n/g, "\n");
    hash.update(`${file}\0${text}\0`, "latin1");
  }
  return { hash: hash.digest("hex"), files: files.length };
}

export function readBuildInfo(base = root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(base, "public", "build-info.json"), "utf8"));
  } catch {
    return null;
  }
}

export function checkPublicSync(base = root) {
  const current = sourceFingerprint(base);
  const built = readBuildInfo(base);
  if (!built?.srcHash) return { ok: false, reason: "no-build-info", current };
  if (built.srcHash !== current.hash) return { ok: false, reason: "stale", current, built };
  return { ok: true, current, built };
}

function main() {
  if (process.argv.includes("--write")) {
    const current = sourceFingerprint();
    const info = { srcHash: current.hash, files: current.files, builtAt: new Date().toISOString() };
    fs.writeFileSync(path.join(root, "public", "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
    console.log(`public/build-info.json: ${current.files} файлов src/, отпечаток ${current.hash.slice(0, 12)}`);
    return;
  }
  const result = checkPublicSync();
  if (result.ok) {
    console.log(`public/ собран из текущего src/ (${result.built.builtAt}).`);
    return;
  }
  const hint = "Выполните `npm run ship` (сборка + отпечаток) и закоммитьте public/.";
  console.error(result.reason === "no-build-info"
    ? `Нет public/build-info.json — неизвестно, из чего собран public/. ${hint}`
    : `src/ изменён после последней сборки public/ (сборка от ${result.built.builtAt}). ${hint}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
