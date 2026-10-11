// Включает личные пространства (server/spaces.mjs): владелец перестаёт видеть чужие проекты.
//   node scripts/migrate-spaces.mjs --dry   посчитать, ничего не менять
//   node scripts/migrate-spaces.mjs         выполнить (нужен DATABASE_URL: .env.local или окружение)
import fs from "node:fs";
import pg from "pg";
import { migrateToSpaces } from "../server/spaces.mjs";

for (const file of [".env.local", ".env"]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0 && !line.startsWith("#") && !process.env[line.slice(0, at)]) process.env[line.slice(0, at)] = line.slice(at + 1).trim();
  }
}
if (!process.env.DATABASE_URL) { console.error("Нет DATABASE_URL"); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const dryRun = process.argv.includes("--dry");
  const report = await migrateToSpaces((sql, params) => client.query(sql, params), { dryRun });
  console.log(dryRun ? "Пробный прогон (ничего не записано):" : "Готово:", JSON.stringify(report, null, 2));
} finally {
  await client.end();
}
