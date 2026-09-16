// Собирает интерфейс MBOX внутрь приложения: mbox-desktop/ui (см. mbox-desktop/localUi.js).
// Бандл — тот же, что у сайта; рядом кладём статику из public/, которую Vite не копирует (publicDir: false):
// иконки, шрифты, манифест. Сервис-воркер и установщики приложения внутрь не нужны.
import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "mbox-desktop", "ui");
const publicDir = path.join(root, "public");

await build({ root, configFile: path.join(root, "vite.config.ts"), logLevel: "warn", build: { outDir, emptyOutDir: true } });

const copy = [
  "icons",
  "fonts",
  path.join("assets", "icons"),
  "manifest.webmanifest",
  "mbox-desktop-icon.png",
  "email-library.html",
];
for (const item of copy) {
  const from = path.join(publicDir, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(outDir, item), { recursive: true });
}

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
  const full = path.join(dir, entry.name);
  return sum + (entry.isDirectory() ? size(full) : fs.statSync(full).size);
}, 0);
console.log(`[desktop-ui] ${path.relative(root, outDir)} ${(size(outDir) / 1024 / 1024).toFixed(1)} MB`);
