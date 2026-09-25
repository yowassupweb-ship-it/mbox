import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInboxWake } from "./inbox-wake.mjs";
import { codexContextUsage, createSessionStore, focusLines, isLostSession, sameThread, threadOf } from "./chat-threads.mjs";
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
const startedAt = new Date();
const cutoffAt = new Date(startedAt.getTime() - startGraceMs);
const codexCommand = resolveCodexCommand(config.CODEX_COMMAND || "codex");
const codexModel = config.CODEX_WATCH_MODEL || "";
const workdir = resolveWatchWorkdir(config.CODEX_WATCH_WORKDIR || root);
const contextLimit = Number(config.MBOX_WATCH_CONTEXT_LIMIT || 10);
const contextLineLimit = Number(config.MBOX_WATCH_CONTEXT_LINE_LIMIT || 420);
const codexEffort = config.CODEX_WATCH_EFFORT || "low";
const sessions = createSessionStore(`codex-${agentName}`);
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
const accountKey = username.replace(/[^a-z0-9_-]+/gi, "_");
const seenPath = path.join(os.tmpdir(), `codex-chat-watcher-seen-${accountKey}-${agentName}-${project}.json`);
const lockPath = path.join(os.tmpdir(), `codex-chat-watcher-${accountKey}-${agentName}-${project}.lock`);
const logPrefix = `[${agentName} chat]`;
const MAX_STEP_INPUT = Number(config.MBOX_WATCH_STEP_INPUT_LIMIT || 360);
const MAX_STEP_OUTPUT = Number(config.MBOX_WATCH_STEP_OUTPUT_LIMIT || 600);
const MAX_STEPS = Number(config.MBOX_WATCH_MAX_STEPS || 24);

let cookie = "";
let stopping = false;
let seen = loadSeen();
let lockFd = null;

acquireSingleInstanceLock();
setInterval(touchLock, LOCK_TOUCH_MS).unref();

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
    const item = await nextMention();
    if (item) { await handleMention(item); continue; }
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

async function targetProject() {
  const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}&detail=short`);
  return projects.projects?.find((item) => item.name === project) || projects.projects?.[0] || null;
}

async function nextMention() {
  const target = await targetProject();
  const data = await mboxFetch("/api/mbox/agent/inbox");
  const inbox = data.inbox || [];
  return inbox
    .filter((item) => item.status === "open")
    .filter((item) => !seen.has(String(item.id)))
    .filter((item) => item.agent_name !== agentName)
    .filter((item) => !["agent_response", "agent_error"].includes(item.item_type))
    .filter((item) => includeBacklog || new Date(item.created_at) >= cutoffAt)
    .filter((item) => !target || String(item.project_id || "") === String(target.id || ""))
    .filter((item) => isMentionForCodex(item))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
}

function isMentionForCodex(item) {
  // Наблюдатель работает под аккаунтом владельца и с его диском — отвечает только владельцу.
  // Участникам (mbox_owner: false) отвечает Джарвис, если он у них включён.
  if (item.props?.mbox_owner === false) return false;
  const to = String(item.props?.to || item.props?.target || item.props?.agent || "");
  if (aliases.some((alias) => to.toLowerCase() === alias.toLowerCase())) return true;
  const text = `${item.title || ""}\n${item.body || ""}`;
  return aliases.some((alias) => new RegExp(`@${escapeRegExp(alias)}\\b`, "iu").test(text));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function handleMention(item) {
  seen.add(String(item.id));
  saveSeen();
  console.log(`${logPrefix} handling chat #${item.id}: ${item.title}`);
  if (!(await claimInbox(item.id, { ...(item.props || {}), handled_by: agentName, handling_started_at: new Date().toISOString(), source: "codex-chat-watcher" }))) {
    console.log(`${logPrefix} chat #${item.id} already taken by another watcher; skipping`);
    return;
  }

  const run = await createRun(item);
  const startedAt = Date.now();
  try {
    const outcome = await runCodex(item);
    const answer = outcome.text;
    await createInboxItem({
      project_id: item.project_id || null,
      title: `ChatGPT: ответ на #${item.id}`,
      body: answer || "Готово.",
      item_type: "agent_response",
      priority: "normal",
      props: {
        in_reply_to: item.id,
        to: item.agent_name || "Человек",
        source: "codex-chat-watcher",
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
      props: { ...(item.props || {}), handled_by: agentName, last_error: error.message, source: "codex-chat-watcher" },
    });
    await finishRun(run?.id, "failed", message, Date.now() - startedAt);
  }
}

/** Захват сообщения: false, если его уже взял другой наблюдатель (сервер вернул 409 на if_status). */
async function claimInbox(id, props) {
  try {
    await mboxFetch(`/api/mbox/agent/inbox/${id}`, { method: "PATCH", body: JSON.stringify({ status: "doing", if_status: "open", props }) });
    return true;
  } catch (error) {
    if (/^MBOX 409/.test(error.message)) return false;
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
  const data = await mboxFetch("/api/mbox/agent/inbox");
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

  if (!rows.length) return "";
  return [
    "Recent MBOX console context, oldest to newest:",
    ...rows.map(formatContextLine),
  ].join("\n");
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
  const sessionId = sessions.get(thread);
  if (sessionId) {
    try {
      const outcome = await runCodexTurn(item, sessionId);
      sessions.remember(thread, outcome.sessionId || sessionId);
      return outcome;
    } catch (error) {
      if (!isLostSession(error)) throw error;
      console.log(`${logPrefix} сессия чата ${thread} потеряна — начинаю заново`);
      sessions.forget(thread);
    }
  }
  const outcome = await runCodexTurn(item, "");
  sessions.remember(thread, outcome.sessionId);
  return outcome;
}

function messageLines(item) {
  return [
    `Chat item id: ${item.id}`,
    // Ответ на конкретное сообщение (кнопка «Ответить» в чате MBOX): props.re — его id.
    ...(item.props?.re || item.props?.in_reply_to ? [`In reply to message #${item.props.re || item.props.in_reply_to}.`] : []),
    `From: ${item.agent_name || "unknown"}`,
    `Title: ${item.title || ""}`,
    `Body:\n${item.body || ""}`,
    ...focusLines(item),
  ];
}

async function freshPrompt(item) {
  const conversationContext = await recentConversationContext(item);
  return [
    "You were woken by an @codex mention in the MBOX project chat.",
    `Your canonical agent name is ${agentName}.`,
    "Answer the chat message below. If the user asks for code work, do it in the repo and summarize the result.",
    "Do not create an MBOX inbox response yourself; the watcher will post your final answer.",
    "Keep the final answer concise and directly useful.",
    "Spend tokens carefully: avoid broad repo scans and huge command outputs; prefer targeted rg with explicit paths and exclusions for build artifacts, binaries and generated assets.",
    "Use the recent MBOX console context to resolve short messages, pronouns, follow-ups, and @mentions.",
    // См. claude-inbox-watcher.mjs — тот же пробел без языкового сигнала уводил ответы на английский.
    "MBOX is a Russian-language project — the owner and all other agents communicate in Russian. Write your final answer in Russian, unless the user explicitly wrote in another language.",
    // 24.09: Codex правил .docx встроенным PowerShell (Expand-Archive в %TEMP%, регулярки по XML, Compress-Archive
    // и перезапись файла в «Загрузках») — Defender принял это за шифровальщик (Trojan:Win32/Commando.A!ml) и блокировал.
    "Editing Word/Excel/PowerPoint files: never unzip/rezip them with inline PowerShell (Expand-Archive, Compress-Archive, [IO.Compression]) or rewrite their XML with regex in %TEMP% — Windows Defender flags that pattern as ransomware and blocks it. Use the mbox-prod MCP tools (workspace_read_document, workspace_write_docx, workspace_read_table, workspace_write_cells, workspace_format_cells) for files in MBOX local folders — colors, fonts, borders and number formats go through workspace_format_cells, checked with workspace_read_table styles=true, not through Python; otherwise write a small Python script with python-docx/openpyxl. Always keep the original: save the result next to it (e.g. name.edited.docx) unless the owner explicitly asked to overwrite.",
    // 24.09: «сделай шрифт не жирным» стоило 20+ шагов и 580k токенов — агент искал render_docx.py, LibreOffice
    // и Word COM, чтобы визуально проверить результат. Каждый шаг пересылает весь контекст заново.
    "Routine requests (edit a file, fix formatting, rename, small change): do it in the fewest possible steps — ideally one tool call to change and one to verify by reading the result back. Do not search for renderers, converters or viewers (LibreOffice/soffice, Word COM, render scripts) and do not verify visually unless the owner asked for it. Do not explore the filesystem beyond what the task needs. If a skill's instructions demand heavier verification, skip it for routine edits.",
    "If a command or tool fails with access denied / permission denied / EACCES / EPERM, do not work around it (no copying elsewhere, no elevation, no retries under another path): stop and end your answer with a short question to the owner naming exactly what access is needed and why.",
    // Длинный отчёт в чате терялся — теперь он всегда отдельным файлом со ссылкой (MCP save_report).
    "If the answer is a report, audit, research or anything longer than ~20 lines, first save the full text as Markdown with the mbox-prod MCP tool save_report, then reply in chat with a short summary (5-10 lines) and the returned markdown_link — the owner must get a clickable link.",
    // Навык ведёт сценарий через интерфейс MBOX: форма, результат, папка открываются вкладкой, файлы навыка правятся на лету.
    "MBOX UI: to show the owner a skill form, a finished file or folder, use the MBOX MCP tool open_tab (skill-file:<skill>/<file>, skill-blocks:<skill>, path:<absolute path>). To change a skill's files (SKILL.md, forms, templates) use edit_skill_file / write_skill_file — live immediately, no deploy.",
    "Documents and tables: MBOX notes (note_search, note_read, note_write, note_edit) and files in the owner's local folders (workspace_edit_file for small text edits instead of rewriting a whole file, workspace_read_table / workspace_write_cells / workspace_format_cells for .xlsx/.csv, workspace_read_document / workspace_write_docx for Word). Pass show=true when the owner should watch the change happen — the document opens as a tab in MBOX.",
    "",
    conversationContext,
    "",
    ...messageLines(item),
  ].join("\n");
}

async function runCodexTurn(item, resumeId) {
  const outputFile = path.join(os.tmpdir(), `codex-mbox-chat-${item.id}-${Date.now()}.txt`);
  const prompt = resumeId
    ? ["New message in this same MBOX chat. Answer it the same way as before (Russian, concise; the watcher posts your final answer).", "", ...messageLines(item)].join("\n")
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
    let lastPhaseAt = 0;

    ping("heartbeat", "Запускается").catch(() => {});

    const pushPhase = (phase) => {
      const now = Date.now();
      if (now - lastPhaseAt < 3000) return;
      lastPhaseAt = now;
      ping("heartbeat", phase).catch(() => {});
    };

    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-8000);
      process.stdout.write(chunk);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) handleCodexLine(line, state, startedAt, pushPhase, inboxId);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(runTimer);
      if (buffer.trim()) handleCodexLine(buffer, state, startedAt, pushPhase, inboxId);
      ping("heartbeat", "").catch(() => {});
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

function handleCodexLine(line, state, startedAt, pushPhase, inboxId = "") {
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
  if (event.type === "item.completed" && event.item) {
    const item = event.item;
    if (item.type === "agent_message" && item.text) {
      state.text = String(item.text || "").trim();
      return;
    }
    const tool = codexToolName(item);
    if (tool) {
      const hint = toolHint(item);
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
