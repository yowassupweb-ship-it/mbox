#!/usr/bin/env node
// Установка своего MBOX одной командой (нужны Docker и Node 20+):
//   node scripts/selfhost-setup.mjs
//   node scripts/selfhost-setup.mjs --user Аня --domain mbox.example.com --yes
// Создаёт .env.selfhost (пароли и ключ шифрования генерируются), поднимает базу и приложение и печатает адрес и вход.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env.selfhost");
const COMPOSE = path.join(ROOT, "docker-compose.selfhost.yml");

const args = Object.fromEntries(process.argv.slice(2).map((item, index, all) => item.startsWith("--") ? [item.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : true] : []).filter((pair) => pair.length));
const fail = (message) => { console.error(`Ошибка: ${message}`); process.exit(1); };
const secret = (bytes) => randomBytes(bytes).toString("base64url");

function docker(extra) {
  return spawnSync("docker", ["compose", "--env-file", ENV_FILE, "-f", COMPOSE, ...extra], { cwd: ROOT, stdio: "inherit" });
}

if (Number(process.versions.node.split(".")[0]) < 20) fail("нужен Node 20 или новее: https://nodejs.org");
if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status !== 0) fail("не найден Docker с командой `docker compose`. Установите Docker Desktop: https://www.docker.com/products/docker-desktop");

const existing = fs.existsSync(ENV_FILE) ? Object.fromEntries(fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/).map((line) => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])) : {};
const rl = args.yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (question, fallback = "") => (rl ? (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback : fallback);

console.log("Свой MBOX: ответьте на пару вопросов (Enter — значение в скобках).\n");
const username = String(args.user || existing.MBOX_ADMIN_USERNAME || await ask("Ваш логин", "owner"));
let password = String(args.password || existing.MBOX_ADMIN_PASSWORD || "");
let passwordGenerated = false;
if (!password) { password = await ask("Пароль (пусто — сгенерировать)"); if (!password) { password = secret(12); passwordGenerated = true; } }
if (password.length < 8) fail("пароль должен быть не короче 8 знаков.");
const domain = String(args.domain ?? existing.MBOX_DOMAIN ?? await ask("Домен для HTTPS (пусто — только на этом компьютере)", ""));
const useDomain = domain && domain !== "true" && domain !== "localhost";

const values = {
  POSTGRES_PASSWORD: existing.POSTGRES_PASSWORD || secret(24),
  MBOX_SECRET_KEY: existing.MBOX_SECRET_KEY || secret(32),
  MBOX_ADMIN_USERNAME: username,
  MBOX_ADMIN_PASSWORD: password,
  MBOX_DOMAIN: useDomain ? domain : "localhost",
  // Без домена порт слушает только этот компьютер; в локальной сети коллеги зайдут, если поставить 0.0.0.0:3000.
  MBOX_PUBLISH: useDomain ? "127.0.0.1:3000" : String(args.lan ? "0.0.0.0:3000" : existing.MBOX_PUBLISH || "127.0.0.1:3000"),
  GEMINI_API_KEY: existing.GEMINI_API_KEY || "",
  GROQ_API_KEY: existing.GROQ_API_KEY || "",
};
fs.writeFileSync(ENV_FILE, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
console.log(`\nНастройки записаны в ${ENV_FILE} (не публикуйте этот файл и не теряйте: в нём ключ шифрования секретов).`);

console.log("\nЗапускаю (первый раз — несколько минут: собирается образ)…\n");
const up = docker(useDomain ? ["--profile", "tls", "up", "-d", "--build"] : ["up", "-d", "--build"]);
if (up.status !== 0) fail("Docker не смог запустить MBOX. Текст ошибки выше.");
await rl?.close();

const url = useDomain ? `https://${domain}` : "http://localhost:3000";
console.log(`\nГотово. MBOX работает: ${url}`);
console.log(`Логин: ${username}${passwordGenerated ? `\nПароль: ${password}   (сохраните; он же записан в .env.selfhost)` : ""}`);
console.log("\nДальше:");
console.log(`  1. Откройте ${url} и войдите.`);
console.log("  2. Коллегам: Настройки → Команда → Приглашения → создать ссылку.");
console.log(`  3. В MBOX Desktop на экране входа выберите «Другой сервер» и вставьте ${url}`);
console.log("  4. Джарвис нужен? Впишите GEMINI_API_KEY или GROQ_API_KEY в .env.selfhost и выполните: docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d");
console.log("  Остановить: docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml down   (данные сохранятся)");
