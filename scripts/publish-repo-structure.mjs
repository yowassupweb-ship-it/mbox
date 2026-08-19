#!/usr/bin/env node
/**
 * Публикует список путей файлов текущего репозитория (структура, НЕ содержимое) в
 * project.props.repo_structure — так Джарвис отвечает на «где лежит файл X» через
 * find_file, не имея и не получая доступа к файловой системе.
 *
 * Список путей берётся из `git ls-files` (только версионируемые файлы, .gitignore уже
 * учтён репозиторием). Запускать из корня репозитория, который нужно опубликовать.
 *
 * env: MBOX_URL, MBOX_USERNAME (по умолчанию Admin), MBOX_PASSWORD, MBOX_AGENT_NAME
 * Запуск: node scripts/publish-repo-structure.mjs [имя проекта в MBOX]
 *         (по умолчанию — имя из package.json текущего репозитория)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const baseUrl = process.env.MBOX_URL;
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;
const agentName = process.env.MBOX_AGENT_NAME || "local-agent";

if (!baseUrl || !password) {
  console.error("MBOX_URL and MBOX_PASSWORD are required");
  process.exit(1);
}

function defaultProjectName() {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    if (pkg.name) return pkg.name;
  } catch { /* нет package.json в корне — не страшно, возьмём имя папки */ }
  return process.cwd().split(/[\\/]/).filter(Boolean).pop() || "unknown";
}

const projectName = process.argv[2] || defaultProjectName();

// Бинарные сборочные артефакты (хешированные бандлы) не несут смысла для «где лежит файл» —
// они каждый билд меняют имя и не то, что кто-то ищет по названию.
const SKIP = /^(dist|build|public\/assets|node_modules)\//;

const paths = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !SKIP.test(line));

if (!paths.length) {
  console.error("git ls-files вернул пусто — точно корень репозитория?");
  process.exit(1);
}

let cookie = "";
async function login() {
  const response = await fetch(`${baseUrl}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`MBOX login failed: ${response.status}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function mboxFetch(path, init = {}) {
  if (!cookie) await login();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, "x-mbox-agent": encodeURIComponent(agentName), ...(init.headers || {}) },
  });
  if (response.status === 401) {
    cookie = "";
    await login();
    return mboxFetch(path, init);
  }
  if (!response.ok) throw new Error(`MBOX ${response.status}: ${await response.text()}`);
  return response.json();
}

const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(projectName)}`);
const target = projects.projects.find((item) => item.name === projectName) || projects.projects[0];
if (!target) throw new Error(`Project not found in MBOX: ${projectName}`);

const props = {
  ...(target.props && typeof target.props === "object" ? target.props : {}),
  repo_structure: { paths, file_count: paths.length, updated_at: new Date().toISOString(), updated_by: agentName },
};

await mboxFetch(`/api/mbox/projects/${target.id}`, { method: "PATCH", body: JSON.stringify({ props }) });
console.log(`Published ${paths.length} paths for project "${target.name}"`);
