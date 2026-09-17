#!/usr/bin/env node
// Переносит в репозиторий правки файлов навыков, которые агенты сделали на сервере MBOX (MCP edit_skill_file,
// server/skill-overrides.mjs). После переноса — коммит и деплой: версия из репозитория снова главная.
//
//   MBOX_URL=… MBOX_PASSWORD=… node scripts/skills-pull.mjs [--dry-run] [навык…]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = new Set(args.filter((arg) => !arg.startsWith("--")));

const baseUrl = (process.env.MBOX_URL || "").replace(/\/+$/, "");
if (!baseUrl || !process.env.MBOX_PASSWORD) {
  console.error("Нужны MBOX_URL и MBOX_PASSWORD (как у наблюдателей и MCP).");
  process.exit(1);
}

const login = await fetch(`${baseUrl}/api/mbox/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.MBOX_USERNAME || "Admin", password: process.env.MBOX_PASSWORD }),
});
if (!login.ok) throw new Error(`вход в MBOX: HTTP ${login.status}`);
const cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
const get = async (apiPath) => {
  const response = await fetch(`${baseUrl}${apiPath}`, { headers: { cookie, "x-mbox-agent": "skills-pull" } });
  if (!response.ok) throw new Error(`${apiPath}: HTTP ${response.status}`);
  return response.json();
};

let written = 0;
for (const entry of (await get("/api/mbox/agent/skills/packages")).packages || []) {
  if (only.size && !only.has(entry.id)) continue;
  const edited = (entry.files || []).filter((file) => file.edited);
  if (!edited.length) continue;
  const { package: skillPackage } = await get(`/api/mbox/agent/skills/packages/${encodeURIComponent(entry.id)}`);
  for (const file of skillPackage.files.filter((item) => item.edited)) {
    const target = path.join(REPO_SKILLS, entry.id, ...file.path.split("/"));
    const next = Buffer.from(file.content, "base64");
    if (fs.existsSync(target) && fs.readFileSync(target).equals(next)) continue;
    console.log(`${dryRun ? "[dry-run] " : ""}${entry.id}/${file.path} (${next.length} байт)`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, next);
    }
    written += 1;
  }
}
console.log(written ? `${dryRun ? "Будет перенесено" : "Перенесено"}: ${written}. Дальше — коммит и деплой.` : "Правок на сервере, которых нет в репозитории, нет.");
