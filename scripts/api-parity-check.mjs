import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "scripts", "api-parity-known.json");
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

function importedFiles(entry) {
  const found = new Set();
  const visit = (file) => {
    const absolute = path.resolve(root, file);
    if (found.has(absolute) || !fs.existsSync(absolute)) return;
    found.add(absolute);
    const source = fs.readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/g)) {
      let target = path.resolve(path.dirname(absolute), match[1]);
      if (!path.extname(target)) target += ".mjs";
      if (target.startsWith(path.join(root, "server") + path.sep)) visit(path.relative(root, target));
    }
  };
  visit(entry);
  return [...found];
}

function blockAfter(source, offset) {
  const open = source.indexOf("{", offset);
  if (open < 0 || open - offset > 300) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  return "";
}

function normalizeRegex(raw) {
  let value = raw.replaceAll("\\/", "/");
  value = value.replace(/\\\.[+*?]/g, ".");
  value = value.replace(/\(\\d\+\)|\(\.\+\)|\(\[\^\\?\/\]\+\)/g, ":param");
  value = value.replace(/\(\[[^)]*\][^)]*\)/g, ":param");
  value = value.replace(/\(\?:\\?\/(?:[^()]|\([^)]*\))+\)\?/g, "/:param");
  value = value.replace(/^\^|\$$/g, "").replace(/\\([.?+*()[\]{}])/g, "$1");
  return value;
}

function enclosingMethods(source, offset) {
  const result = new Set();
  for (const match of source.matchAll(/if\s*\(\s*req\.method\s*(?:===|==)\s*["'](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)["']\s*\)\s*\{/g)) {
    const body = blockAfter(source, match.index);
    if (match.index < offset && match.index + match[0].length + body.length >= offset) result.add(match[1]);
  }
  return [...result];
}

function routeMethods(condition, body, inherited = [], allowFallback = true) {
  const explicit = new Set();
  const text = `${condition}\n${body}`;
  for (const method of methods) {
    if (new RegExp(`(?:req\\.method|method)\\s*(?:===|==)\\s*["']${method}["']|["']${method}["']\\s*(?:===|==)\\s*(?:req\\.method|method)`).test(text)) explicit.add(method);
  }
  for (const match of text.matchAll(/\[([^\]]+)\]\.includes\(req\.method\)/g)) {
    for (const method of methods) if (match[1].includes(`"${method}"`) || match[1].includes(`'${method}'`)) explicit.add(method);
  }
  if (inherited.length) return inherited;
  if (allowFallback && !/(?:req\.method|method)/.test(condition) && explicit.size) explicit.add("GET");
  return explicit.size ? [...explicit] : ["GET"];
}

function extractRoutes(files) {
  const routes = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const patterns = [
      /if\s*\(([^\n]*?pathname\s*===\s*["'](\/api\/[^"']+)["'][^\n]*?)\)\s*\{/g,
      /if\s*\(([^\n]*?pathname\.match\(\s*\/((?:\\\/|[^/])+)\/[gimyus]*\)[^\n]*?)\)\s*\{/g,
      /const\s+\w+\s*=\s*(?:url\.)?pathname\.match\(\s*\/((?:\\\/|[^/])+)\/[gimyus]*\s*\);/g,
    ];
    for (const [patternIndex, pattern] of patterns.entries()) {
      for (const match of source.matchAll(pattern)) {
        const rawPath = patternIndex === 0 ? match[2] : match[patternIndex === 1 ? 2 : 1];
        const routePath = patternIndex === 0 ? rawPath : normalizeRegex(rawPath);
        const condition = patternIndex === 2 ? source.slice(match.index, source.indexOf("\n", match.index)) : match[1];
        const body = blockAfter(source, match.index);
        for (const method of routeMethods(condition, body, enclosingMethods(source, match.index), patternIndex !== 2)) routes.add(`${method} ${routePath}`);
      }
    }
  }
  return [...routes].sort();
}

const dev = extractRoutes(importedFiles("vite.config.ts"));
const prod = extractRoutes(importedFiles("server/mbox-server.mjs"));
const devSet = new Set(dev);
const prodSet = new Set(prod);
const onlyDev = dev.filter((route) => !prodSet.has(route));
const onlyProd = prod.filter((route) => !devSet.has(route));
const common = dev.filter((route) => prodSet.has(route));
const current = { onlyDev, onlyProd };

if (process.argv.includes("--update")) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, baselinePath)}`);
}

const known = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : { onlyDev: [], onlyProd: [] };
const newOnlyDev = onlyDev.filter((route) => !known.onlyDev.includes(route));
const newOnlyProd = onlyProd.filter((route) => !known.onlyProd.includes(route));

console.log(`Dev: ${dev.length}; prod: ${prod.length}; common: ${common.length}`);
console.log(`Only dev (${onlyDev.length}):\n${onlyDev.map((route) => `  ${route}`).join("\n") || "  —"}`);
console.log(`Only prod (${onlyProd.length}):\n${onlyProd.map((route) => `  ${route}`).join("\n") || "  —"}`);
if (newOnlyDev.length || newOnlyProd.length) {
  console.error(`New API parity differences detected. Run with --update after review.`);
  process.exitCode = 1;
}
