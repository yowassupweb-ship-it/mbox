import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInboxWake } from "./inbox-wake.mjs";
import { chatRules, clipError, codexContextUsage, createPhaseBoard, dropTurnImageDir, imageLine, turnImageDir, turnImages, uploadTurnImages, createRunTimings, createSessionStore, describeTimings, historyBlock, isLostSession, laneOf, messageBlock, parallelLimit, RESUME_REMINDER, ROTATE_CONTEXT_TOKENS, sameThread, threadOf } from "./chat-threads.mjs";
import { codexCachedModels, publishModelCatalog } from "./model-catalog.mjs";

const FETCH_TIMEOUT_MS = 30_000;
const LOCK_TOUCH_MS = 30_000;
const LOCK_STALE_MS = 3 * 60_000;
// Потолок на один ответ: зависший CLI раньше держал наблюдателя бесконечно. 45 минут хватает и на большую работу.
const RUN_TIMEOUT_MS = Number(process.env.MBOX_WATCH_RUN_TIMEOUT_MS || 45 * 60_000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig();
const baseUrl = requireValue(config.MBOX_URL, "MBOX_URL");
const username = config.MBOX_USERNAME || "Admin";
const accessToken = String(config.MBOX_TOKEN || "").trim();
const password = accessToken ? "" : requireValue(config.MBOX_PASSWORD, "MBOX_PASSWORD or MBOX_TOKEN");
const agentName = config.MBOX_AGENT_NAME || "ChatGPT";
const agentKind = config.MBOX_AGENT_KIND || "local_watcher";
const project = config.MBOX_PROJECT || "MBOX";
// Опрос — запасной путь: обычно наблюдателя будит вебсокет (inbox-wake.mjs). Но сообщения из dev-окна
// (локальный vite) прод не рассылает, и там ответ начинается только по опросу — поэтому он частый.
const pollMs = Number(config.MBOX_WATCH_POLL_MS || 2000);
// Heartbeat — не на каждый круг опроса: присутствие считается живым минутами, лишний POST раз в 2 с не нужен.
const HEARTBEAT_MS = 20_000;
let lastHeartbeat = 0;
const startGraceMs = Number(config.MBOX_WATCH_START_GRACE_MS || 15 * 60 * 1000);
const includeBacklog = ["1", "true", "yes"].includes(String(config.MBOX_WATCH_BACKLOG || "").toLowerCase());
const includeUnaddressed = ["1", "true", "yes"].includes(String(config.MBOX_WATCH_UNADDRESSED || "").toLowerCase());
const startedAt = new Date();
const cutoffAt = new Date(startedAt.getTime() - startGraceMs);
const codexCommand = resolveCodexCommand(config.CODEX_COMMAND || "codex");
const codexModel = config.CODEX_WATCH_MODEL || "";
const workdir = resolveWatchWorkdir(config.CODEX_WATCH_WORKDIR || root);
const contextLimit = Number(config.MBOX_WATCH_CONTEXT_LIMIT || 12);
const contextLineLimit = Number(config.MBOX_WATCH_CONTEXT_LINE_LIMIT || 1200);
const codexEffort = config.CODEX_WATCH_EFFORT || "low";
const sessions = createSessionStore(`codex-${agentName}`);
// Сколько чатов отвечаем одновременно (см. parallelLimit в chat-threads.mjs).
const MAX_PARALLEL = parallelLimit(config.MBOX_WATCH_PARALLEL);
const activeLanes = new Map();
const reportPhase = createPhaseBoard((phase) => { ping("heartbeat", phase).catch(() => {}); });
const timings = createRunTimings();
// Весь набор уровней из каталога Codex (models_cache.json): у новых моделей есть max и ultra.
const CODEX_EFFORT_CHOICES = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const pickModel = (value) => {
  const model = String(value || "").trim();
  if (!model || ["default", "auto", "codex default", "codex-cli-default"].includes(model.toLowerCase())) return "";
  // Модели Claude и Джарвиса (Gemini, Groq) Codex не знает — их выбор из чужого чата игнорируем.
  if (/^(claude|opus|sonnet|haiku|fable|gemini|openai\/|llama|meta-)/i.test(model)) return "";
  return /^[A-Za-z0-9._:/@-]{1,120}$/.test(model) ? model : "";
};
const pickEffort = (value) => (CODEX_EFFORT_CHOICES.has(String(value || "")) ? String(value) : "");
const aliases = (config.CODEX_CHAT_ALIASES || "codex,Codex,chatgpt,ChatGPT,кодекс,Кодекс")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const broadcastAliases = (config.MBOX_BROADCAST_ALIASES || "\u0412\u0441\u0435\u043c,\u0412\u0441\u0435,All,Everyone,Everybody")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!aliases.some((alias) => alias.toLowerCase() === agentName.toLowerCase())) aliases.unshift(agentName);
for (const alias of String(config.MBOX_AGENT_ALIASES || "").split(",").map((value) => value.trim()).filter(Boolean)) {
  if (!aliases.some((item) => item.toLowerCase() === alias.toLowerCase())) aliases.push(alias);
}
const accountKey = username.replace(/[^a-z0-9_-]+/gi, "_");
const seenPath = path.join(os.tmpdir(), `codex-chat-watcher-seen-${accountKey}-${agentName}-${project}.json`);
const lockPath = path.join(os.tmpdir(), `codex-chat-watcher-${accountKey}-${agentName}-${project}.lock`);
const logPrefix = `[${agentName} chat]`;
const MAX_STEP_INPUT = Number(config.MBOX_WATCH_STEP_INPUT_LIMIT || 700);
const MAX_STEP_OUTPUT = Number(config.MBOX_WATCH_STEP_OUTPUT_LIMIT || 1500);
const MAX_STEP_TEXT = Number(config.MBOX_WATCH_STEP_TEXT_LIMIT || 700);
const MAX_STEPS = Number(config.MBOX_WATCH_MAX_STEPS || 60);

let cookie = "";
let stopping = false;
let seen = loadSeen();
let lockFd = null;

acquireSingleInstanceLock();
setInterval(touchLock, LOCK_TOUCH_MS).unref();
ensureCodexMcp();

process.on("SIGINT", () => {
  stopping = true;
  releaseSingleInstanceLock();
});
process.on("SIGTERM", () => {
  stopping = true;
  releaseSingleInstanceLock();
});
process.on("exit", releaseSingleInstanceLock);

await ping("session_start");
// Список моделей для чата — кеш каталога самого Codex (~/.codex/models_cache.json, список OpenAI для аккаунта).
publishModelCatalog({
  agent: agentKind === "cloud_agent" ? agentName : "ChatGPT",
  collect: async () => codexCachedModels(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
  post: (body) => mboxFetch("/api/mbox/agent/models", { method: "POST", body: JSON.stringify(body) }),
  log: (message) => console.log(`${logPrefix} ${message}`),
});
const wake = createInboxWake({
  baseUrl,
  authHeaders: () => ({ ...(accessToken ? { authorization: `Bearer ${accessToken}` } : { cookie }), "x-mbox-agent": encodeURIComponent(agentName) }),
  log: (message) => console.log(`${logPrefix} ${message}`),
});
console.log(`${logPrefix} watching @codex mentions on ${baseUrl} project=${project} every ${pollMs}ms`);
console.log(`${logPrefix} using Codex CLI: ${codexCommand}`);
console.log(`${logPrefix} ${includeBacklog ? "including backlog" : `ignoring chat before ${cutoffAt.toISOString()}`}`);

while (!stopping) {
  try {
    if (Date.now() - lastHeartbeat > HEARTBEAT_MS) { lastHeartbeat = Date.now(); await ping("heartbeat"); }
    for (const item of await pendingMentions()) {
      // Чат уже отвечает или места нет — сообщение остаётся open и берётся, когда освободится.
      const lane = laneOf(item);
      if (activeLanes.has(lane) || activeLanes.size >= MAX_PARALLEL) continue;
      seen.add(String(item.id));
      saveSeen();
      activeLanes.set(lane, handleMention(item)
        .catch((error) => console.error(`${logPrefix} #${item.id}: ${error.stack || error.message}`))
        .finally(() => { activeLanes.delete(lane); wake.poke(); }));
    }
  } catch (error) {
    console.error(`${logPrefix} ${error.stack || error.message}`);
  }
  await wake.wait(pollMs);
}

console.log(`${logPrefix} stopped`);
releaseSingleInstanceLock();

function acquireSingleInstanceLock() {
  try {
    lockFd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
  } catch (error) {
    const pid = readLockPid();
    if (pid && isProcessAlive(pid) && lockIsFresh()) {
      console.error(`${logPrefix} another watcher is already running pid=${pid}; exiting`);
      process.exit(0);
    }
    try {
      fs.rmSync(lockPath, { force: true });
      lockFd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(lockFd, String(process.pid));
    } catch (retryError) {
      console.error(`${logPrefix} could not acquire lock ${lockPath}: ${retryError.message}`);
      process.exit(1);
    }
  }
}

/**
 * Живой наблюдатель трогает lock-файл каждые LOCK_TOUCH_MS (таймер идёт и во время долгого ответа).
 * Проверки одного pid мало: Windows переиспользует номера процессов, и после сбоя новый наблюдатель
 * видел «живой» чужой pid в старом lock и молча выходил — чат не отвечал до ручного перезапуска.
 */
function lockIsFresh() {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function touchLock() {
  if (lockFd === null) return;
  try {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  } catch {
    // lock удалили снаружи — следующий запуск просто создаст новый
  }
}

function readLockPid() {
  try {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    return Number.isFinite(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseSingleInstanceLock() {
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch {}
    lockFd = null;
  }
  if (readLockPid() === process.pid) {
    try { fs.rmSync(lockPath, { force: true }); } catch {}
  }
}

/**
 * MBOX-инструменты (note_*, open_tab, workspace_*, save_report…) Codex берёт из [mcp_servers.mbox-prod]
 * своего ~/.codex/config.toml. На компьютере владельца блок вписан руками, а у облачного агента на сервере
 * его не было — CodexCloud честно отвечал «инструментов mbox-prod нет». Дописываем блок, если его нет:
 * тот же сервер и вход, что у самого наблюдателя. Есть — не трогаем.
 */
function ensureCodexMcp() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const file = path.join(home, "config.toml");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* конфига ещё нет */ }
  if (/\[mcp_servers\.mbox-prod\]/.test(text)) return;
  const toml = (value) => JSON.stringify(String(value));
  const env = {
    MBOX_URL: baseUrl,
    MBOX_AGENT_NAME: agentName,
    MBOX_AGENT_CLIENT: "codex-chat-watcher",
    MBOX_MCP_PUSH: "off",
    ...(accessToken ? { MBOX_TOKEN: accessToken } : { MBOX_USERNAME: username, MBOX_PASSWORD: password }),
  };
  const block = [
    "",
    "# MBOX: дописано наблюдателем codex-chat-watcher — инструменты MBOX для Codex.",
    "[mcp_servers.mbox-prod]",
    `command = ${toml(process.execPath)}`,
    `args = [${toml(path.join(__dirname, "mbox-mcp-server.mjs"))}]`,
    "",
    "[mcp_servers.mbox-prod.env]",
    ...Object.entries(env).map(([key, value]) => `${key} = ${toml(value)}`),
    "",
  ].join("\n");
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(file, block, { mode: 0o600 });
    console.log(`${logPrefix} MCP mbox-prod добавлен в ${file}`);
  } catch (error) {
    console.error(`${logPrefix} не удалось дописать MCP в ${file}: ${error.message}`);
  }
}

function loadConfig() {
  const env = { ...process.env };
  const codexConfig = path.join(os.homedir(), ".codex", "config.toml");
  if (fs.existsSync(codexConfig)) Object.assign(env, readMboxEnvFromCodexToml(codexConfig));
  return { ...env, ...process.env };
}

function readMboxEnvFromCodexToml(file) {
  const text = fs.readFileSync(file, "utf8");
  const block = text.match(/\[mcp_servers\.mbox-prod\][\s\S]*?(?=\n\[|$)/);
  const result = {};
  if (block) {
    const envLine = block[0].match(/env\s*=\s*\{([^}]+)\}/);
    if (envLine) {
      for (const pair of envLine[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) {
        result[pair[1]] = unescapeTomlString(pair[2]);
      }
    }
  }
  const envBlock = text.match(/\[mcp_servers\.mbox-prod\.env\][\s\S]*?(?=\n\[|$)/);
  if (envBlock) {
    for (const pair of envBlock[0].matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/gm)) {
      result[pair[1]] = unescapeTomlString(pair[2]);
    }
  }
  return result;
}

function unescapeTomlString(value) {
  return value.replace(/\\(["\\btnfr])/g, (_, char) => {
    const escapes = { '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" };
    return escapes[char] || char;
  });
}

function requireValue(value, name) {
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function resolveCodexCommand(command) {
  const explicit = String(command || "").trim();
  if (!explicit || explicit.toLowerCase() === "codex") {
    return findCodexExecutable() || "codex";
  }
  if (path.isAbsolute(explicit) || explicit.includes("\\") || explicit.includes("/")) {
    return fs.existsSync(explicit) ? explicit : findCodexExecutable() || explicit;
  }
  return findOnPath(explicit) || findCodexExecutable() || explicit;
}

function findCodexExecutable() {
  return findOnPath("codex") || findLatestVsCodeCodex() || findOnPath("codex.exe");
}

function findOnPath(command) {
  const pathValue = process.env.PATH || process.env.Path || "";
  const pathExt = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const names = path.extname(command) ? [command] : pathExt.map((ext) => `${command}${ext.toLowerCase()}`);
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function findLatestVsCodeCodex() {
  const extensionRoot = path.join(os.homedir(), ".vscode", "extensions");
  try {
    const candidates = fs.readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
      .map((entry) => path.join(extensionRoot, entry.name, "bin", "windows-x86_64", "codex.exe"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((a, b) => b.localeCompare(a));
    return candidates[0] || "";
  } catch {
    return "";
  }
}

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(seenPath, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSeen() {
  fs.writeFileSync(seenPath, JSON.stringify([...seen].slice(-500)), "utf8");
}

async function login() {
  const response = await fetch(`${baseUrl}/api/mbox/auth/login`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`MBOX login failed: ${response.status} ${await response.text()}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function mboxFetch(apiPath, init = {}) {
  if (!accessToken && !cookie) await login();
  const response = await fetch(`${baseUrl}${apiPath}`, {
    // Без таймаута запрос при обрыве сети висел вечно, и вместе с ним — весь наблюдатель: чат молчал,
    // пока человек не перезапустит ответчик вручную.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : { cookie }),
      "x-mbox-agent": agentName,
      ...(init.headers || {}),
    },
  });
  if (response.status === 401) {
    if (accessToken) throw new Error("MBOX token rejected");
    cookie = "";
    await login();
    return mboxFetch(apiPath, init);
  }
  if (!response.ok) throw new Error(`MBOX ${response.status}: ${await response.text()}`);
  return response.json();
}

async function ping(event, phase, extra) {
  await mboxFetch("/api/mbox/agent/ping", {
    method: "POST",
    body: JSON.stringify({
      agent: agentName,
      event,
      kind: agentKind,
      client: "codex-chat-watcher",
      scope: "project_chat_mentions,codex_exec",
      ...(phase === undefined ? {} : { phase }),
      ...(extra || {}),
    }),
  });
}

function resolveWatchWorkdir(preferred) {
  const candidates = [
    preferred,
    root,
    process.env.MBOX_REPO_ROOT,
    path.resolve(process.cwd()),
    path.join(path.dirname(process.cwd()), "mbox"),
    path.join(process.cwd(), "mbox"),
    path.join(os.homedir(), "Desktop", "Mbox", "mbox"),
    path.join(os.homedir(), "Desktop", "MBOX", "mbox"),
    path.join(os.homedir(), "Projects", "Mbox", "mbox"),
    path.join(os.homedir(), "Projects", "MBOX", "mbox"),
    "E:\\Projects\\Mbox\\mbox",
    "E:\\Projects\\MBOX\\mbox",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(path.join(resolved, "package.json")) && fs.existsSync(path.join(resolved, "scripts"))) return resolved;
  }
  return path.resolve(preferred || root);
}

function clip(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function stringifyInput(input) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === "string") return input[keys[0]];
  try { return JSON.stringify(input, null, 1); } catch { return String(input); }
}

function addStep(state, step) {
  if (state.steps.length >= MAX_STEPS) return null;
  state.steps.push(step);
  return step;
}

function streamStep(inboxId, index, step) {
  if (!inboxId) return;
  ping("heartbeat", undefined, { inbox_id: String(inboxId), step: { i: index, ...step } }).catch(() => {});
}

/** Проект наблюдателя почти не меняется — раньше его перечитывали на каждом круге опроса. */
var projectCache = null;
async function targetProject() {
  if (projectCache && Date.now() - projectCache.at < 10 * 60_000) return projectCache.target;
  const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}&detail=short`);
  const target = projects.projects?.find((item) => item.name === project) || projects.projects?.[0] || null;
  projectCache = { at: Date.now(), target };
  return target;
}

async function pendingMentions() {
  const target = await targetProject();
  // status=open и light=1: без них каждый круг опроса тянул 200 записей со шагами и ошибками — 1,5 МБ.
  const data = await mboxFetch("/api/mbox/agent/inbox?status=open&light=1&limit=100");
  const inbox = data.inbox || [];
  return inbox
    .filter((item) => item.status === "open")
    .filter((item) => !seen.has(String(item.id)))
    .filter((item) => item.agent_name !== agentName)
    .filter((item) => !["agent_response", "agent_error"].includes(item.item_type))
    .filter((item) => includeBacklog || new Date(item.created_at) >= cutoffAt)
    .filter((item) => !target || item.project_id == null || String(item.project_id) === String(target.id || ""))
    .filter((item) => isMentionForCodex(item))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function isMentionForCodex(item) {
  // Наблюдатель работает под аккаунтом владельца и с его диском — отвечает только владельцу.
  // Участникам (mbox_owner: false) отвечает Джарвис, если он у них включён.
  if (item.props?.mbox_owner === false) return false;
  const to = String(item.props?.to || item.props?.target || item.props?.agent || "");
  if (aliases.some((alias) => to.toLowerCase() === alias.toLowerCase())) return true;
  if (broadcastAliases.some((alias) => to.toLowerCase() === alias.toLowerCase())) return true;
  const text = `${item.title || ""}\n${item.body || ""}`;
  if (aliases.some((alias) => new RegExp(`@${escapeRegExp(alias)}\\b`, "iu").test(text))) return true;
  if (broadcastAliases.some((alias) => new RegExp(`@${escapeRegExp(alias)}\\b`, "iu").test(text))) return true;
  if (to.trim()) return false;
  if (!includeUnaddressed) return false;
  return ["Human", "User"].includes(item.agent_name) || item.item_type === "question";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function handleMention(item) {
  console.log(`${logPrefix} handling chat #${item.id}: ${item.title}`);
  const claimed = await claimInbox(item.id, { ...(item.props || {}), handled_by: agentName, handling_started_at: new Date().toISOString(), source: "codex-chat-watcher" });
  if (!claimed) {
    console.log(`${logPrefix} chat #${item.id} already taken by another watcher; skipping`);
    return;
  }
  // Старый сервер age_ms не отдаёт — тогда по своим часам (могут расходиться с серверными на секунды).
  timings.start(item.id, claimed.age_ms !== undefined ? Number(claimed.age_ms) : Date.now() - Date.parse(item.created_at));

  // «Принял» — сразу после захвата: до «Запускается» ещё история чата и старт CLI.
  reportPhase(item.id, "Принял");
  // Папка картинок хода: путь уходит агенту в сообщении, после ответа всё оттуда загружается в чат.
  const imageDir = turnImageDir(agentName, item.id);
  item = { ...item, imageDir };
  const runPromise = createRun(item).catch((error) => { console.error(`${logPrefix} agent run: ${error.message}`); return null; });
  const startedAt = Date.now();
  let run = null;
  try {
    const outcome = await runCodex(item);
    run = await runPromise;
    const images = await attachTurnImages(item, imageDir, outcome.text, startedAt);
    const timing = timings.finish(item.id);
    outcome.stats = { ...(outcome.stats || {}), ...timing };
    console.log(`${logPrefix} #${item.id}: ${describeTimings(timing)}`);
    const answer = outcome.text;
    await createInboxItem({
      project_id: item.project_id || null,
      title: `ChatGPT: ответ на #${item.id}`,
      body: images.body || "Готово.",
      item_type: "agent_response",
      priority: "normal",
      props: {
        in_reply_to: item.id,
        to: item.agent_name || "Человек",
        source: "codex-chat-watcher",
        ...(images.attachments.length ? { attachments: images.attachments } : {}),
        ...(threadOf(item) ? { thread: threadOf(item) } : {}),
        tools_used: outcome.toolsUsed,
        trace: outcome.trace,
        steps: outcome.steps,
        work: outcome.stats,
        model: outcome.model,
        effort: outcome.effort,
      },
    });
    await patchInbox(item.id, {
      status: "done",
      props: { ...(item.props || {}), handled_by: agentName, answered_by: agentName, answered_at: new Date().toISOString(), agent_run_id: run?.id || null, source: "codex-chat-watcher" },
    });
    await finishRun(run?.id, "done", answer, Date.now() - startedAt);
  } catch (error) {
    const message = error.cliFailure ? error.message : error.stack || error.message;
    timings.finish(item.id);
    reportPhase(item.id, "");
    run = await runPromise;
    await createInboxItem({
      project_id: item.project_id || null,
      title: `ChatGPT не смог ответить на #${item.id}`,
      body: message,
      item_type: "agent_error",
      priority: "high",
      props: { in_reply_to: item.id, source: "codex-chat-watcher", ...(threadOf(item) ? { thread: threadOf(item) } : {}) },
    });
    await patchInbox(item.id, {
      status: "open",
      props: { ...(item.props || {}), handled_by: agentName, last_error: clipError(error.message), source: "codex-chat-watcher" },
    });
    await finishRun(run?.id, "failed", message, Date.now() - startedAt);
  } finally {
    dropTurnImageDir(imageDir);
  }
}

/** Загрузка картинки хода в хранилище MBOX (см. uploadTurnImages). Размер fetch ставит сам по Buffer. */
async function uploadStorage(key, buffer, type) {
  return mboxFetch(`/api/mbox/storage/upload?key=${encodeURIComponent(key)}`, { method: "POST", body: buffer, headers: { "content-type": type } });
}

/** Картинки хода — в хранилище и ссылками в конец текста: карточки в чате строятся по props.attachments,
 *  а агенты в следующих ходах читают текст (тот же формат «Вложения:», что у сообщений человека). */
async function attachTurnImages(item, dir, text, since) {
  const images = turnImages(dir, text, since);
  if (!images.length) return { attachments: [], body: text };
  const projectId = item.project_id || (await targetProject())?.id || "";
  const attachments = await uploadTurnImages({ images, projectId, inboxId: item.id, upload: uploadStorage, log: (message) => console.log(`${logPrefix} ${message}`) });
  if (!attachments.length) return { attachments, body: text };
  const list = attachments.map((file) => `- [${file.name}](${baseUrl}/api/mbox/storage/file?key=${encodeURIComponent(file.key)})`);
  return { attachments, body: [text, ["Вложения:", ...list].join("\n")].filter(Boolean).join("\n\n") };
}


/** Захват сообщения: null, если его уже взял другой наблюдатель (сервер вернул 409 на if_status). */
async function claimInbox(id, props) {
  try {
    const data = await mboxFetch(`/api/mbox/agent/inbox/${id}`, { method: "PATCH", body: JSON.stringify({ status: "doing", if_status: "open", props }) });
    return data.inbox_item || {};
  } catch (error) {
    if (/^MBOX 409\b/.test(error.message)) return null;
    throw error;
  }
}

async function patchInbox(id, body) {
  await mboxFetch(`/api/mbox/agent/inbox/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function createInboxItem(body) {
  return mboxFetch("/api/mbox/agent/inbox", {
    method: "POST",
    body: JSON.stringify({ agent_name: agentName, requires_human: false, ...body }),
  });
}

async function createRun(item) {
  const data = await mboxFetch("/api/mbox/agent/runs", {
    method: "POST",
    body: JSON.stringify({
      project_id: item.project_id || null,
      agent_name: agentName,
      status: "running",
      goal: `Answer project chat @codex #${item.id}: ${item.title}`,
      read_context: [`project_chat:${item.id}`],
      props: { source: "codex-chat-watcher", inbox_id: item.id },
    }),
  });
  return data.run;
}

async function finishRun(id, status, result, elapsedMs) {
  if (!id) return;
  await mboxFetch(`/api/mbox/agent/runs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status, result, props: { source: "codex-chat-watcher", elapsed_ms: elapsedMs } }),
  });
}

async function recentConversationContext(item) {
  if (!contextLimit) return "";
  // Чат с id — только его сообщения, а не 200 последних записей всей консоли.
  const thread = threadOf(item);
  const data = await mboxFetch(thread ? `/api/mbox/agent/inbox?thread=${thread}&light=1&limit=${contextLimit * 3}` : "/api/mbox/agent/inbox?light=1");
  const targetProjectId = String(item.project_id || "");
  const currentCreatedAt = new Date(item.created_at || Date.now()).getTime();
  const rows = (data.inbox || [])
    .filter((entry) => ["question", "chat", "answer", "agent_response"].includes(entry.item_type))
    .filter((entry) => String(entry.project_id || "") === targetProjectId)
    .filter((entry) => sameThread(entry, item))
    .filter((entry) => String(entry.id) !== String(item.id))
    .filter((entry) => new Date(entry.created_at || 0).getTime() <= currentCreatedAt)
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
    .slice(-contextLimit);

  return historyBlock(rows.map(formatContextLine));
}

function formatContextLine(entry) {
  const at = entry.created_at ? new Date(entry.created_at).toISOString().slice(11, 19) : "--:--:--";
  const actor = entry.agent_name || "unknown";
  const to = entry.props?.to ? ` -> ${entry.props.to}` : "";
  const re = entry.props?.re || entry.props?.in_reply_to ? `, reply to #${entry.props.re || entry.props.in_reply_to}` : "";
  const text = compactContextText(entry.body || entry.title || "");
  const clipped = clip(text, contextLineLimit);
  return `[${at}] ${actor}${to} (${entry.item_type} #${entry.id}${re}): ${clipped}`;
}

function compactContextText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[inline image]")
    .replace(/[A-Za-z0-9+/]{180,}={0,2}/g, "[long encoded data]")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ответ в чате. Первый запрос чата начинает сессию Codex, следующие продолжают её
 * (`codex exec resume`) — история уже внутри и идёт из кеша, в запрос уходит только новое сообщение.
 * См. scripts/chat-threads.mjs.
 */
async function runCodex(item) {
  const thread = threadOf(item);
  let sessionId = sessions.get(thread);
  // См. ROTATE_CONTEXT_TOKENS: сессии чатов Codex дорастали до 225k контекста и 9 млн входа на ответ.
  const rotated = Boolean(sessionId && sessions.contextOf(thread) > ROTATE_CONTEXT_TOKENS);
  if (rotated) {
    console.log(`${logPrefix} чат ${thread}: контекст ${sessions.contextOf(thread)} > ${ROTATE_CONTEXT_TOKENS} — начинаю новую сессию`);
    sessions.forget(thread);
    sessionId = "";
  }
  if (sessionId) {
    try {
      const outcome = await runCodexTurn(item, sessionId);
      sessions.remember(thread, outcome.sessionId || sessionId, outcome.stats?.context_tokens);
      return outcome;
    } catch (error) {
      if (!isLostSession(error)) throw error;
      console.log(`${logPrefix} сессия чата ${thread} потеряна — начинаю заново`);
      sessions.forget(thread);
    }
  }
  const outcome = await runCodexTurn(item, "");
  sessions.remember(thread, outcome.sessionId, outcome.stats?.context_tokens);
  if (rotated && outcome.stats) outcome.stats.session_rotated = true;
  return outcome;
}

/**
 * Первый ход сессии: правила (общие с Claude, см. chatRules), история чата и сообщение. Системного промпта
 * на каждый ход у codex exec нет, поэтому в продолженной сессии — короткое напоминание (RESUME_REMINDER).
 */
async function freshPrompt(item) {
  return [
    chatRules({ agentName }),
    "Spend tokens carefully: search with explicit paths and exclude build artifacts, binaries and generated assets.",
    await recentConversationContext(item),
    messageBlock(item),
    item.imageDir ? imageLine(item.imageDir) : "",
  ].filter(Boolean).join("\n\n");
}

async function runCodexTurn(item, resumeId) {
  const outputFile = path.join(os.tmpdir(), `codex-mbox-chat-${item.id}-${Date.now()}.txt`);
  const prompt = resumeId
    ? [RESUME_REMINDER, messageBlock(item), item.imageDir ? imageLine(item.imageDir) : ""].filter(Boolean).join("\n\n")
    : await freshPrompt(item);

  // resume не знает -C и --sandbox: папка берётся из сессии, режим песочницы — через -c.
  const args = resumeId
    ? ["exec", "resume", "-c", 'sandbox_mode="danger-full-access"', "--skip-git-repo-check", "--json", "--output-last-message", outputFile]
    : ["exec", "-C", workdir, "--sandbox", "danger-full-access", "--skip-git-repo-check", "--json", "--output-last-message", outputFile];
  const wantedModel = pickModel(item.props?.model) || pickModel(codexModel);
  const wantedEffort = pickEffort(item.props?.effort) || pickEffort(codexEffort);
  if (wantedModel) args.push("-m", wantedModel);
  if (wantedEffort) args.push("-c", `model_reasoning_effort="${wantedEffort}"`);
  if (resumeId) args.push(resumeId);
  args.push(prompt);

  timings.spawn(item.id);
  const outcome = await spawnCodex(codexCommand, args, { cwd: workdir, env: { ...process.env, MBOX_AGENT_NAME: agentName, MBOX_AGENT_CLIENT: "codex-chat-watcher", MBOX_MCP_PUSH: "off" } }, item.id);
  const answer = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
  fs.rmSync(outputFile, { force: true });
  if (outcome.stats) {
    outcome.stats.resumed = Boolean(resumeId);
    Object.assign(outcome.stats, codexContextUsage(outcome.sessionId || resumeId) || {});
  }
  return { ...outcome, text: answer || outcome.text, model: wantedModel || "codex default", effort: wantedEffort || "" };
}

function spawnCodex(command, args, options, inboxId = "") {
  return new Promise((resolve, reject) => {
    // windowsHide: без него Windows открывала CLI агента в отдельном видимом окне консоли.
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const runTimer = armRunTimeout(child);
    const startedAt = Date.now();
    const state = { text: "", toolsUsed: [], trace: [], steps: [], stats: null, failure: "", sessionId: "" };
    let stderr = "";
    let stdout = "";
    let buffer = "";
    const pendingTools = new Map();
    let lastPhaseAt = 0;
    let lastPhase = "Запускается";

    reportPhase(inboxId, "Запускается");

    // Новая фаза — сразу, повтор той же — не чаще раза в 3 с (см. claude-inbox-watcher.mjs).
    const pushPhase = (phase) => {
      const now = Date.now();
      if (phase === lastPhase && now - lastPhaseAt < 3000) return;
      lastPhase = phase;
      lastPhaseAt = now;
      reportPhase(inboxId, phase);
    };

    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-8000);
      process.stdout.write(chunk);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // Первая строка JSON — CLI поднялся (thread.started), первый item.* — модель начала работу.
        if (line.startsWith("{")) timings.mark(inboxId, "readyAt");
        if (line.includes('"type":"item.')) timings.mark(inboxId, "replyAt");
        handleCodexLine(line, state, startedAt, pushPhase, inboxId, pendingTools);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(runTimer);
      if (buffer.trim()) handleCodexLine(buffer, state, startedAt, pushPhase, inboxId, pendingTools);
      reportPhase(inboxId, "");
      if (code === 0) {
        if (!state.stats) state.stats = { duration_ms: Date.now() - startedAt };
        if (state.failure) {
          const error = new Error(state.failure);
          error.cliFailure = true;
          reject(error);
          return;
        }
        console.log(`${logPrefix} готово: ${formatTokens(totalWorkTokens(state.stats))} токенов, инструментов ${state.toolsUsed.length}`);
        resolve(state);
      }
      else reject(describeCliFailure(command, code, stdout, stderr));
    });
  });
}

function handleCodexLine(line, state, startedAt, pushPhase, inboxId = "", pendingTools = new Map()) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !trimmed.startsWith("{")) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (event.type === "thread.started" && event.thread_id) {
    state.sessionId = String(event.thread_id);
    return;
  }
  if (event.type === "turn.started") {
    pushPhase("Думает");
    return;
  }
  if (event.type === "turn.completed") {
    state.stats = codexStats(event.usage, event.duration_ms || Date.now() - startedAt);
    pushPhase("Готовит ответ");
    return;
  }
  if (event.type === "item.started" && event.item) {
    const item = event.item;
    const tool = codexToolName(item);
    if (tool) {
      const hint = toolHint(item);
      const key = codexItemKey(item);
      const pending = key ? pendingTools.get(key) : null;
      if (pending) {
        pendingTools.delete(key);
        pending.output = clip(codexToolOutput(item), MAX_STEP_OUTPUT);
        pending.is_error = codexToolError(item);
        pending.ms = pending.at ? Date.now() - pending.at : 0;
        delete pending.at;
        streamStep(inboxId, pending.i, { output: pending.output, is_error: pending.is_error, ms: pending.ms });
        pushPhase("\u0420\u0430\u0431\u043e\u0442\u0430\u0435\u0442");
        return;
      }
      if (!state.toolsUsed.includes(tool)) state.toolsUsed.push(tool);
      state.trace.push(`${state.trace.length + 1}. ${tool}${hint ? `\n   ${hint}` : ""}`);
      const index = state.steps.length;
      const step = { kind: "tool", name: tool, hint, input: clip(stringifyInput(codexToolInput(item)), MAX_STEP_INPUT), at: Date.now() };
      if (addStep(state, step)) {
        step.i = index;
        const key = codexItemKey(item);
        if (key) pendingTools.set(key, step);
        streamStep(inboxId, index, { kind: "tool", name: tool, hint, input: step.input });
      }
      pushPhase("\u0420\u0430\u0431\u043e\u0442\u0430\u0435\u0442");
    }
    return;
  }
  if (event.type === "item.completed" && event.item) {
    const item = event.item;
    if (item.type === "agent_message" && item.text) {
      state.text = String(item.text || "").trim();
      pushPhase("Пишет");
      return;
    }
    if (item.type === "reasoning") {
      const text = String(item.text || item.summary || "").replace(/\*\*/g, "").trim();
      pushPhase("Думает");
      if (text) {
        const index = state.steps.length;
        const step = { kind: "text", text: clip(text, MAX_STEP_TEXT) };
        if (addStep(state, step)) streamStep(inboxId, index, step);
      }
      return;
    }
    const tool = codexToolName(item);
    if (tool) {
      const hint = toolHint(item);
      const key = codexItemKey(item);
      const pending = key ? pendingTools.get(key) : null;
      if (pending) {
        pendingTools.delete(key);
        pending.output = clip(codexToolOutput(item), MAX_STEP_OUTPUT);
        pending.is_error = codexToolError(item);
        pending.ms = pending.at ? Date.now() - pending.at : 0;
        delete pending.at;
        streamStep(inboxId, pending.i, { output: pending.output, is_error: pending.is_error, ms: pending.ms });
        pushPhase("\u0420\u0430\u0431\u043e\u0442\u0430\u0435\u0442");
        return;
      }
      if (!state.toolsUsed.includes(tool)) state.toolsUsed.push(tool);
      state.trace.push(`${state.trace.length + 1}. ${tool}${hint ? `\n   ${hint}` : ""}`);
      const index = state.steps.length;
      const step = {
        kind: "tool",
        name: tool,
        hint,
        input: clip(stringifyInput(codexToolInput(item)), MAX_STEP_INPUT),
        output: clip(codexToolOutput(item), MAX_STEP_OUTPUT),
        is_error: codexToolError(item),
      };
      if (addStep(state, step)) streamStep(inboxId, index, step);
      pushPhase("Работает");
    }
    return;
  }
  if ((event.type === "exec_command" || event.type === "apply_patch") && event.cmd) {
    addCodexTool(state, event.type, event, pushPhase, inboxId);
    return;
  }
  if (event.type === "error" || event.type === "turn.failed") {
    state.failure = String(event.message || event.error || event.reason || "Codex CLI вернул ошибку");
  }
}

function codexStats(usage, durationMs) {
  const inputTokens = Number(usage?.input_tokens) || 0;
  const cachedInputTokens = Number(usage?.cached_input_tokens) || 0;
  const outputTokens = Number(usage?.output_tokens) || 0;
  const reasoningOutputTokens = Number(usage?.reasoning_output_tokens) || 0;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    thinking_tokens: reasoningOutputTokens,
    total_tokens: inputTokens + outputTokens,
    duration_ms: Number(durationMs) || 0,
    turns: 1,
  };
}

function codexItemKey(item) {
  return String(item?.id || item?.call_id || item?.tool_call_id || item?.item_id || "").trim();
}

function codexToolName(item) {
  const type = String(item.type || "");
  if (type === "agent_message") return "";
  // Вызов MCP у Codex: имя инструмента в item.tool, а type — общее «mcp_tool_call».
  if (item.tool) return item.server ? `mcp__${item.server}__${item.tool}` : String(item.tool);
  if (item.name || item.tool_name) return String(item.name || item.tool_name).trim();
  if (item.command || item.cmd) return "shell_command";
  if (/patch/i.test(type)) return "apply_patch";
  if (/exec|command|shell/i.test(type)) return "shell_command";
  if (/tool|call|mcp|function/i.test(type)) return type;
  return "";
}

function toolHint(item) {
  const raw = item.input || item.arguments || item.command || item.cmd || item.path || item.file_path || item.status || "";
  const value = typeof raw === "string" ? raw : raw && typeof raw === "object" ? raw.command || raw.path || raw.file_path || raw.query || "" : "";
  const text = String(value).split(/[\\/]/).pop() || String(value);
  return text.length > 48 ? `${text.slice(0, 48)}...` : text;
}

function codexToolInput(item) {
  return item.input || item.arguments || item.params || item.command || item.cmd || item.path || item.file_path || "";
}

function codexToolOutput(item) {
  // Вывод команды Codex кладёт в aggregated_output; без него в чате у упавшей команды было только «failed».
  if (typeof item.aggregated_output === "string") {
    const exit = item.exit_code ? `[exit ${item.exit_code}]` : "";
    return compactToolOutput([item.aggregated_output.trim(), exit].filter(Boolean).join("\n"));
  }
  const raw = item.output || item.result || item.content || item.text || item.status || "";
  if (typeof raw === "string") return compactToolOutput(raw);
  if (Array.isArray(raw)) return raw.map((part) => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join("\n");
  if (raw && typeof raw === "object") { try { return compactToolOutput(JSON.stringify(raw, null, 1)); } catch { return ""; } }
  return "";
}

function compactToolOutput(value) {
  return String(value || "")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[inline image]")
    .replace(/[A-Za-z0-9+/]{240,}={0,2}/g, "[long encoded data]")
    .split(/\r?\n/)
    .slice(0, 80)
    .map((line) => line.length > 220 ? `${line.slice(0, 220)}...` : line)
    .join("\n");
}

function codexToolError(item) {
  return Boolean(item.is_error || item.error || item.status === "failed" || item.exit_code);
}

function addCodexTool(state, name, item, pushPhase, inboxId = "") {
  const tool = name === "exec_command" ? "shell_command" : name;
  const hint = toolHint(item);
  if (!state.toolsUsed.includes(tool)) state.toolsUsed.push(tool);
  state.trace.push(`${state.trace.length + 1}. ${tool}${hint ? `\n   ${hint}` : ""}`);
  const index = state.steps.length;
  const step = { kind: "tool", name: tool, hint, input: clip(stringifyInput(codexToolInput(item)), MAX_STEP_INPUT) };
  if (addStep(state, step)) streamStep(inboxId, index, step);
  pushPhase("Работает");
}

function totalWorkTokens(stats) {
  return (Number(stats?.input_tokens) || 0) + (Number(stats?.output_tokens) || 0);
}

function formatTokens(count) {
  if (!count) return "0";
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(".", ",")}k` : String(count);
}

/** Почему CLI агента упал — человеческим текстом. Claude и Codex пишут причину («You've hit your
 * session limit», «usage limit») в stdout, а не в stderr, и в чат уходило пустое «exited with 1»
 * со стеком node. Берём хвост обоих потоков без шумовых предупреждений node. */
function describeCliFailure(command, code, stdout, stderr) {
  const noise = /DeprecationWarning|--trace-deprecation|^\s*at\s/;
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !noise.test(line));
  const tail = lines.slice(-6).join("\n");
  const name = String(command).split(/[\\/]/).pop();
  const limit = lines.find((line) => /(usage|session|rate) limit|hit your .*limit|limit reached|quota/i.test(line));
  const reason = limit ? `Исчерпан лимит подписки: ${limit}` : tail || "CLI не вывел причину";
  const error = new Error(`${name} завершился с кодом ${code}. ${reason}`);
  error.cliFailure = true;
  return error;
}

/** Зависший CLI (сеть, ожидание ввода) снимаем по таймауту — вместе с дочерними процессами. */
function armRunTimeout(child) {
  return setTimeout(() => {
    console.error(`${logPrefix} ответ дольше ${Math.round(RUN_TIMEOUT_MS / 60000)} мин — останавливаю CLI`);
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
  }, RUN_TIMEOUT_MS);
}
