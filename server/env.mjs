import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Импортируется первым и в server/mbox-server.mjs, и в vite.config.ts: ESM-импорты выполняются раньше
// тела модуля, а server/jarvis.mjs читает ключи моделей из process.env прямо при загрузке — без этого
// файла ключи из .env.local при локальном запуске терялись бы. Уже заданные переменные не перетираются.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const name of [".env", ".env.local"]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    process.env[trimmed.slice(0, index)] ||= trimmed.slice(index + 1);
  }
}
