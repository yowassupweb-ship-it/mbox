// Где взять MCP-сервер mbox-prod для агента наблюдателя.
//
// На компьютере с репозиторием MBOX он лежит рядом (scripts/mbox-mcp-server.mjs) вместе с node_modules. А у человека,
// который поставил только MBOX Desktop, наблюдатели запускаются из ресурсов приложения: там нет ни самого сервера,
// ни его зависимостей (@modelcontextprotocol/sdk, zod) — агент получал «mbox-prod: Connection closed» и оставался
// без заметок, задач и отчётов MBOX. Поэтому: рядом есть рабочий — берём его; иначе набор агента в ~/.mbox/agent
// (его же ставит mbox-agent.mjs); нет и его — один раз скачиваем набор с сервера (/api/mbox/agent-kit) и ставим зависимости.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KIT_DIR = process.env.MBOX_AGENT_DIR || path.join(os.homedir(), ".mbox", "agent");

/** Есть ли пакет MCP SDK там, откуда node будет его искать для скрипта в dir (сам каталог и выше). */
function sdkReachable(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, "node_modules", "@modelcontextprotocol", "sdk", "package.json"))) return true;
    if (path.dirname(current) === current) return false;
  }
}

function usable(script) {
  return fs.existsSync(script) && sdkReachable(path.dirname(script));
}

async function downloadKit(baseUrl, headers, log) {
  const get = async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`, { headers });
    if (!response.ok) throw new Error(`${pathname}: ${response.status}`);
    return response;
  };
  const manifest = await (await get("/api/mbox/agent-kit")).json();
  const scripts = path.join(KIT_DIR, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of manifest.files || []) {
    const target = file.name === "package.json" ? path.join(KIT_DIR, file.name) : path.join(scripts, file.name);
    const current = fs.existsSync(target) ? createHash("sha256").update(fs.readFileSync(target)).digest("hex") : "";
    if (current === file.sha256) continue;
    fs.writeFileSync(target, await (await get(`/api/mbox/agent-kit/${encodeURIComponent(file.name)}`)).text());
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  log?.(`ставлю зависимости MCP в ${KIT_DIR} (один раз)…`);
  const result = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], { cwd: KIT_DIR, stdio: "ignore", shell: process.platform === "win32", windowsHide: true, timeout: 300_000 });
  if (result.status !== 0) throw new Error(`npm install завершился с кодом ${result.status ?? "?"}`);
}

/**
 * Путь к рабочему mbox-mcp-server.mjs или null (тогда агент работает без инструментов MBOX, а наблюдатель пишет почему).
 * headers — те же, с которыми наблюдатель ходит в MBOX (личный токен или cookie).
 */
export async function locateMcpServer({ baseUrl, headers = {}, log } = {}) {
  const local = path.join(HERE, "mbox-mcp-server.mjs");
  if (usable(local)) return local;
  const kit = path.join(KIT_DIR, "scripts", "mbox-mcp-server.mjs");
  if (usable(kit)) return kit;
  if (!baseUrl) return null;
  try {
    await downloadKit(baseUrl, headers, log);
  } catch (error) {
    log?.(`не удалось поставить MCP mbox-prod: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return usable(kit) ? kit : null;
}
