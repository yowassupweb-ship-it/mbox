#!/usr/bin/env node
// Навыки агентов MBOX хранятся на сервере (skills/ в репозитории, отдаёт /api/mbox/agent/skills/packages).
// Этот скрипт ставит их в ~/.claude/skills и ~/.codex/skills, чтобы Claude и Codex — в консоли MBOX, в терминале,
// на любой машине — работали с одной серверной версией. Наблюдатель Claude вызывает его сам.
//
//   node scripts/sync-skills.mjs [--source auto|server|repo] [--dry-run] [--targets <папка>[,<папка>]]
//
// server — MBOX_URL и MBOX_PASSWORD (MBOX_USERNAME, по умолчанию Admin), как у наблюдателей и MCP;
// repo — папка skills/ рядом со scripts/ (разработка до деплоя); auto — сервер, при недоступности — репозиторий.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_SKILLS = path.resolve(SCRIPTS_DIR, "..", "skills");
const MARKER = ".mbox-skill.json";

export const DEFAULT_TARGETS = [path.join(os.homedir(), ".claude", "skills"), path.join(os.homedir(), ".codex", "skills")];

export async function syncSkills({ source = "auto", dryRun = false, targets = DEFAULT_TARGETS, log = () => {} } = {}) {
  const { from, packages } = await loadPackages(source, log);
  const results = [];
  for (const skillPackage of packages) {
    for (const root of targets) results.push(installPackage(skillPackage, root, from, dryRun));
  }
  return { from, packages: packages.map(({ id, name, description, hash }) => ({ id, name, description, hash })), results };
}

async function loadPackages(source, log) {
  const canUseServer = Boolean(process.env.MBOX_URL && process.env.MBOX_PASSWORD);
  if (source === "server" && !canUseServer) throw new Error("для --source server нужны MBOX_URL и MBOX_PASSWORD");
  if (source !== "repo" && canUseServer) {
    try {
      return { from: "server", packages: await fetchServerPackages() };
    } catch (error) {
      if (source === "server") throw error;
      log(`сервер MBOX не отдал навыки (${error.message}) — беру skills/ из репозитория`);
    }
  }
  if (!fs.existsSync(REPO_SKILLS)) throw new Error(`нет доступа к серверу MBOX (MBOX_URL, MBOX_PASSWORD) и нет папки ${REPO_SKILLS}`);
  const { listSkillPackages, readSkillPackage } = await import(pathToFileURL(path.resolve(SCRIPTS_DIR, "..", "server", "skill-packages.mjs")).href);
  return { from: "repo", packages: listSkillPackages(REPO_SKILLS).map((entry) => readSkillPackage(REPO_SKILLS, entry.id)) };
}

async function fetchServerPackages() {
  const baseUrl = process.env.MBOX_URL.replace(/\/+$/, "");
  const login = await fetch(`${baseUrl}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: process.env.MBOX_USERNAME || "Admin", password: process.env.MBOX_PASSWORD }),
  });
  if (!login.ok) throw new Error(`вход в MBOX: HTTP ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
  const get = async (apiPath) => {
    const response = await fetch(`${baseUrl}${apiPath}`, {
      headers: { cookie, "x-mbox-agent": encodeURIComponent(process.env.MBOX_AGENT_NAME || "skills-sync") },
    });
    if (!response.ok || !(response.headers.get("content-type") || "").includes("json")) throw new Error(`${apiPath}: HTTP ${response.status}`);
    return response.json();
  };
  const list = await get("/api/mbox/agent/skills/packages");
  const packages = [];
  for (const entry of list.packages || []) packages.push((await get(`/api/mbox/agent/skills/packages/${encodeURIComponent(entry.id)}`)).package);
  return packages;
}

// Старые указатели «прочитай C:\Users\…\Desktop\Mbox\…\SKILL.md» заменяем полным навыком; чужие папки не трогаем.
function isLegacyPointer(dir) {
  try {
    if (fs.readdirSync(dir).length > 2) return false;
    const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    return text.length < 4000 && /Desktop[\\/]+Mbox/i.test(text);
  } catch {
    return false;
  }
}

function installPackage(skillPackage, root, from, dryRun) {
  const { id, hash, files } = skillPackage;
  const dir = path.join(root, id);
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")); } catch { /* ставился не из MBOX или ещё не ставился */ }
  if (marker?.hash === hash) return { id, dir, action: "актуален" };
  const exists = fs.existsSync(dir);
  if (exists && !marker && !isLegacyPointer(dir)) return { id, dir, action: "пропущен: папка поставлена не из MBOX" };
  const action = exists ? "обновлён" : "установлен";
  if (dryRun) return { id, dir, action: `${action} (dry-run)` };

  // Собираем во временной папке и подменяем целиком, чтобы агент не увидел полусобранный навык.
  const temp = `${dir}.mbox-sync-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  try {
    for (const file of files) {
      const buffer = Buffer.from(file.content, "base64");
      if (createHash("sha256").update(buffer).digest("hex") !== file.sha256) throw new Error(`${id}/${file.path}: контрольная сумма не сошлась`);
      const target = path.join(temp, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
    }
    fs.writeFileSync(path.join(temp, MARKER), `${JSON.stringify({ id, hash, source: from, synced_at: new Date().toISOString() }, null, 2)}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(temp, dir);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return { id, dir, action };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  try {
    const result = await syncSkills({
      source: option("--source") || "auto",
      dryRun: args.includes("--dry-run"),
      targets: option("--targets") ? option("--targets").split(",").map((dir) => path.resolve(dir)) : DEFAULT_TARGETS,
      log: (message) => console.log(message),
    });
    console.log(`Навыки из ${result.from === "server" ? "сервера MBOX" : "репозитория (skills/)"}:`);
    for (const entry of result.results) console.log(`  ${entry.id} → ${entry.dir}: ${entry.action}`);
  } catch (error) {
    console.error(`ОШИБКА: ${error.message}`);
    process.exit(1);
  }
}
