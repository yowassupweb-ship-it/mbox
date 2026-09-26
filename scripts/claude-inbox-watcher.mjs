import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncSkills } from "./sync-skills.mjs";
import { createInboxWake } from "./inbox-wake.mjs";
import { claudeCliModels, publishModelCatalog } from "./model-catalog.mjs";
import { agentLessons, createSessionStore, focusLines, isLostSession, ROTATE_CONTEXT_TOKENS, sameThread, threadOf } from "./chat-threads.mjs";

const FETCH_TIMEOUT_MS = 30_000;
const LOCK_TOUCH_MS = 30_000;
const LOCK_STALE_MS = 3 * 60_000;
// Потолок на один ответ: зависший CLI раньше держал наблюдателя бесконечно. 45 минут хватает и на большую работу.
const RUN_TIMEOUT_MS = Number(process.env.MBOX_WATCH_RUN_TIMEOUT_MS || 45 * 60_000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const baseUrl = requireValue(process.env.MBOX_URL, "MBOX_URL");
const username = process.env.MBOX_USERNAME || "Admin";
const accessToken = String(process.env.MBOX_TOKEN || "").trim();
const password = accessToken ? "" : requireValue(process.env.MBOX_PASSWORD, "MBOX_PASSWORD or MBOX_TOKEN");
const agentName = process.env.MBOX_AGENT_NAME || "Claude";
// cloud_agent — тот же наблюдатель на сервере MBOX (ClaudeCloud); в списке агентов он отличается от локального.
const agentKind = process.env.MBOX_AGENT_KIND || "local_watcher";
const project = process.env.MBOX_PROJECT || "MBOX";
// 15 с ожидания до того, как наблюдатель вообще увидит сообщение, плюс холодный старт CLI — человек
// это чувствует как «не дошло». Пять секунд заметно живее и всё ещё дёшево: два лёгких запроса за тик.
// Опрос — запасной путь: обычно наблюдателя будит вебсокет (inbox-wake.mjs). Но сообщения из dev-окна
// (локальный vite) прод не рассылает, и там ответ начинается только по опросу — поэтому он частый.
const pollMs = Number(process.env.MBOX_WATCH_POLL_MS || 2000);
// Heartbeat — не на каждый круг опроса: присутствие считается живым минутами, лишний POST раз в 2 с не нужен.
const HEARTBEAT_MS = 20_000;
let lastHeartbeat = 0;
const includeUnaddressed = !["0", "false", "no"].includes(String(process.env.MBOX_WATCH_UNADDRESSED || "true").toLowerCase());
const startGraceMs = Number(process.env.MBOX_WATCH_START_GRACE_MS || 15 * 60 * 1000);
const includeBacklog = ["1", "true", "yes"].includes(String(process.env.MBOX_WATCH_BACKLOG || "").toLowerCase());
const startedAt = new Date();
// Сообщение, отправленное, пока наблюдатель лежал (перезапуск, сбой сети), раньше терялось: брались
// только пришедшие после старта. Теперь подхватываем открытые за последние startGraceMs — повторно
// ответить нельзя: отвеченное уже done, взятое — doing, а claim с if_status не даст взять дважды.
const cutoffAt = new Date(startedAt.getTime() - startGraceMs);
const agentAliases = [agentName, ...(process.env.MBOX_AGENT_ALIASES || "Клод").split(",")]
  .map((alias) => alias.trim())
  .filter(Boolean);
const broadcastAliases = (process.env.MBOX_BROADCAST_ALIASES || "Всем,Все,All,Everyone,Everybody")
  .split(",")
  .map((alias) => alias.trim())
  .filter(Boolean);
const logPrefix = `[${agentName} inbox]`;
const accountKey = username.replace(/[^a-z0-9_-]+/gi, "_");
const seenPath = path.join(os.tmpdir(), `claude-inbox-watcher-seen-${accountKey}-${agentName}.json`);
const lockPath = path.join(os.tmpdir(), `claude-inbox-watcher-${accountKey}-${agentName}-${project}.lock`);
const seen = new Set(loadSeen());
const claudeCommand = process.env.CLAUDE_COMMAND || "claude";
const claudeModel = process.env.CLAUDE_WATCH_MODEL || "";
const workdir = process.env.CLAUDE_WATCH_WORKDIR || path.resolve(__dirname, "..");
const autoRespond = !["0", "false", "no"].includes(String(process.env.MBOX_WATCH_AUTORESPOND || "true").toLowerCase());
// Старый общий чат (сообщения без thread) по-прежнему тянет историю в промпт — но теперь только
// свою и короче: 30 реплик по 6000 символов съедали лимит подписки быстрее самой работы.
const contextLimit = Number(process.env.MBOX_WATCH_CONTEXT_LIMIT || 12);
const sessions = createSessionStore(agentName);

// ВНИМАНИЕ: главный цикл этого файла (`while (!stopping)`) работает на верхнем уровне модуля и
// никогда не завершается, поэтому до объявлений НИЖЕ него исполнение просто не доходит. Функции
// поднимаются и работают, а `const` остаётся в temporal dead zone: обращение к нему из обработчика
// падает с «Cannot access ... before initialization». Всё, что нужно обработчикам константой,
// объявляем здесь, до цикла.
// Из сообщения приходит чужой ввод — в аргументы командной строки он попадает только из этих
// списков, никогда как есть.
// Модель по умолчанию — та же, что сервер показывает в поле ввода (см. jarvisModels).
const CLAUDE_DEFAULT_MODEL = "sonnet";
const CLAUDE_EFFORT_CHOICES = new Set(["low", "medium", "high", "xhigh", "max"]);
const pickModel = (value) => {
  const model = String(value || "").trim();
  if (!model || ["default", "auto", "claude default"].includes(model.toLowerCase())) return "";
  // Только модели Claude: выбор из чата другого агента (gpt-6-luna) ронял CLI с unrecognized_model.
  if (!/^(claude|opus|sonnet|haiku|fable)/i.test(model)) return "";
  // Скобки — часть id из каталога CLI: «claude-fable-5-1[1m]» (вариант с окном в миллион токенов).
  return /^[A-Za-z0-9._:/@[\]-]{1,120}$/.test(model) ? model : "";
};
const pickEffort = (value) => (CLAUDE_EFFORT_CHOICES.has(String(value || "")) ? String(value) : "");
// Сколько истории показывать агенту. Потолок на запись — против одного гигантского сообщения,
// общий бюджет — против тридцати средних. Вместе держат промпт в рамках, не обрывая при этом
// обычный развёрнутый ответ на полуслове.
const CONTEXT_CHARS_PER_ENTRY = 2500;
const CONTEXT_CHARS_TOTAL = 12000;
// MCP агента должен смотреть на ТОТ ЖЕ сервер, что и наблюдатель. Глобальный конфиг в ~/.claude.json
// нацелен на прод, и когда наблюдатель работает против другого адреса (локальный запуск, свой
// сервер), инструменты вроде open_tab уходили в пустоту: окно человека подключено к одному серверу,
// а агент стучится в другой, получает delivered: 0 и честно отвечает «окно не найдено».
// Одноимённый сервер в --mcp-config перебивает глобальный; --strict-mcp-config НЕ используем,
// иначе агент потеряет все остальные свои MCP. Пароль здесь тот же, что уже лежит в ~/.claude.json,
// новой утечки файл не создаёт, но и класть его куда-то ещё не нужно — только во временный каталог.
const mcpConfigPath = path.join(os.tmpdir(), `claude-inbox-watcher-mcp-${accountKey}-${agentName}.json`);
function writeMcpConfig() {
  const env = {
    MBOX_URL: baseUrl,
    MBOX_AGENT_NAME: agentName,
    MBOX_AGENT_CLIENT: "claude-inbox-watcher",
    ...(accessToken ? { MBOX_TOKEN: accessToken } : { MBOX_USERNAME: username, MBOX_PASSWORD: password }),
  };
  const config = { mcpServers: { "mbox-prod": { command: "node", args: [path.resolve(__dirname, "mbox-mcp-server.mjs")], env } } };
  try {
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config));
    return true;
  } catch (error) {
    console.error(`${logPrefix} не удалось записать MCP-конфиг: ${error.message}`);
    return false;
  }
}
const mcpConfigReady = writeMcpConfig();

// Цепочка шагов уезжает в props инбокса (JSONB), поэтому у неё должен быть потолок: вывод
// одного Read большого файла — это десятки килобайт, а таких шагов за ответ бывает под сотню.
// Режем каждый кусок и общее число шагов; в чате у обрезанного видно «…».
const MAX_STEP_INPUT = 700;
const MAX_STEP_OUTPUT = 1500;
const MAX_STEP_TEXT = 700;
const MAX_STEPS = 60;

function clip(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Аргументы инструмента человекочитаемо: одиночная строка как есть, остальное — JSON. */
function stringifyInput(input) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === "string") return input[keys[0]];
  try { return JSON.stringify(input, null, 1); } catch { return String(input); }
}

/** content у tool_result бывает строкой, а бывает массивом блоков — нужен текст. */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") { try { return JSON.stringify(content); } catch { return ""; } }
  return "";
}

/** Добавить шаг в цепочку. Сверх потолка не растим: важнее начало работы, чем её хвост. */
function addStep(state, step) {
  if (state.steps.length >= MAX_STEPS) return null;
  state.steps.push(step);
  return step;
}

let cookie = "";
let stopping = false;
let lockFd = null;

acquireSingleInstanceLock();
setInterval(touchLock, LOCK_TOUCH_MS).unref();

process.on("SIGINT", () => { stopping = true; releaseSingleInstanceLock(); });
process.on("SIGTERM", () => { stopping = true; releaseSingleInstanceLock(); });
process.on("exit", releaseSingleInstanceLock);

await ping("session_start");
// Список моделей и уровней effort для чата — из самого Claude Code, а не из списка в коде MBOX.
publishModelCatalog({
  // Облачный агент — под своим именем: его CLI на сервере бывает другой версии, и он затирал каталог локального Claude.
  agent: agentKind === "cloud_agent" ? agentName : "Claude",
  collect: () => claudeCliModels(claudeCommand),
  post: (body) => mboxFetch("/api/mbox/agent/models", { method: "POST", body: JSON.stringify(body) }),
  log: (message) => console.log(`${logPrefix} ${message}`),
});
const wake = createInboxWake({
  baseUrl,
  authHeaders: () => ({ ...(accessToken ? { authorization: `Bearer ${accessToken}` } : { cookie }), "x-mbox-agent": encodeURIComponent(agentName) }),
  log: (message) => console.log(`${logPrefix} ${message}`),
});

// Навыки хранятся на сервере MBOX; ставим их в ~/.claude/skills при старте и раз в час, чтобы `claude -p`
// на этой машине видел актуальные SKILL.md, правила и скрипты. Ошибка синхронизации не останавливает наблюдатель.
const skillSyncMs = Number(process.env.MBOX_SKILL_SYNC_MS || 60 * 60 * 1000);
let installedSkills = [];
let lastSkillSync = 0;
async function refreshSkills() {
  lastSkillSync = Date.now();
  try {
    const result = await syncSkills({ log: (message) => console.log(`${logPrefix} skills: ${message}`) });
    installedSkills = result.packages;
    const changed = result.results.filter((entry) => entry.action !== "актуален");
    console.log(`${logPrefix} skills from ${result.from}: ${result.packages.map((skill) => skill.id).join(", ") || "none"}${changed.length ? ` (${changed.map((entry) => `${entry.id} ${entry.action}`).join("; ")})` : ""}`);
  } catch (error) {
    console.error(`${logPrefix} skills sync failed: ${error.message}`);
  }
}
await refreshSkills();
console.log(`${logPrefix} watching ${baseUrl} project=${project} every ${pollMs}ms`);
console.log(`${logPrefix} ${includeBacklog ? "including backlog" : `ignoring inbox before ${cutoffAt.toISOString()}`}`);

while (!stopping) {
  try {
    if (Date.now() - lastHeartbeat > HEARTBEAT_MS) { lastHeartbeat = Date.now(); await ping("heartbeat"); }
    if (Date.now() - lastSkillSync > skillSyncMs) await refreshSkills();
    const items = await newInboxItems();
    for (const item of items) {
      seen.add(item.id);
      report(item);
      if (autoRespond) await handleInboxItem(item);
    }
    if (items.length) saveSeen();
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

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(seenPath, "utf8"));
  } catch {
    return [];
  }
}

function saveSeen() {
  fs.writeFileSync(seenPath, JSON.stringify([...seen].slice(-500)));
}

function requireValue(value, name) {
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
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

/** phase — живая строка «чем занят» для чата: сервер кладёт её в agent_presence и шлёт вебсокетом. */
async function ping(event, phase, extra) {
  await mboxFetch("/api/mbox/agent/ping", {
    method: "POST",
    body: JSON.stringify({ agent: agentName, event, kind: agentKind, client: "claude-inbox-watcher", scope: "agent_inbox", ...(phase === undefined ? {} : { phase }), ...(extra || {}) }),
  });
}

/**
 * Шаг работы — сразу в эфир, чтобы цепочка в чате росла по ходу дела, а не появлялась целиком
 * в конце. В базу не пишем: итоговая цепочка всё равно уедет в props ответа, здесь важна скорость.
 * `i` — номер шага: результат инструмента приходит отдельным событием и догоняет свой вызов по нему.
 */
function streamStep(inboxId, index, step) {
  ping("heartbeat", undefined, { inbox_id: String(inboxId), step: { i: index, ...step } }).catch(() => {});
}

async function newInboxItems() {
  const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}&detail=short`);
  const target = projects.projects?.find((item) => item.name === project) || projects.projects?.[0];
  const data = await mboxFetch("/api/mbox/agent/inbox");
  const inbox = data.inbox || [];
  return inbox
    .filter((item) => item.status === "open")
    .filter((item) => item.agent_name !== agentName)
    .filter((item) => !["agent_response", "agent_error"].includes(item.item_type))
    .filter((item) => new Date(item.created_at) >= cutoffAt)
    .filter((item) => !target || item.project_id == null || String(item.project_id) === String(target.id || ""))
    .filter((item) => !seen.has(item.id))
    .filter((item) => isAddressedToMe(item))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function isAddressedToMe(item) {
  // Наблюдатель работает под аккаунтом владельца и с его диском — отвечает только владельцу.
  // Участникам (mbox_owner: false) отвечает Джарвис, если он у них включён.
  if (item.props?.mbox_owner === false) return false;
  const text = `${item.title || ""}\n${item.body || ""}`;
  const to = item.props?.to || item.props?.target || item.props?.agent;
  if (agentAliases.some((alias) => String(to || "").toLowerCase() === alias.toLowerCase())) return true;
  if (broadcastAliases.some((alias) => String(to || "").toLowerCase() === alias.toLowerCase())) return true;
  if (agentAliases.some((alias) => new RegExp(`@${escapeRegExp(alias)}\\b`, "iu").test(text))) return true;
  if (broadcastAliases.some((alias) => new RegExp(`@${escapeRegExp(alias)}\\b`, "iu").test(text))) return true;
  // Раньше здесь была голая substring-проверка "Claude" где угодно в тексте (без @) — Джарвис
  // постоянно упоминает "Claude" в прозе ("Claude не смог ответить", "коллега Claude"), каждое
  // такое упоминание ловилось как новая задача мне -> ответ тоже упоминал "Claude" -> самовос-
  // производящаяся цепочка ("Ответ: Claude ответил на #788: Ответ: Claude не смог ответить на
  // #783..."). Только явное @-упоминание или прямой адресат (to/target/agent) считается вызовом.
  // Адресовано другому (props.to или чат с конкретным агентом) — не отвечаем: 17.09 на «@Codex тут?» ответил Claude.
  if (String(to || "").trim()) return false;
  if (!includeUnaddressed) return false;
  return ["Человек", "Human", "User"].includes(item.agent_name) || item.item_type === "question";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function report(item) {
  console.log(`${logPrefix} #${item.id} from ${item.agent_name || "unknown"}: ${item.title || ""}`);
  if (item.body) console.log(item.body);
}

async function handleInboxItem(item) {
  console.log(`${logPrefix} handling #${item.id}`);
  if (!(await claimInbox(item.id, { ...(item.props || {}), handled_by: agentName, handling_started_at: new Date().toISOString() }))) {
    console.log(`${logPrefix} #${item.id} already taken by another watcher; skipping`);
    return;
  }

  const run = await createRun(item);
  const startedAt = Date.now();
  try {
    const outcome = await runClaude(item);
    const answer = outcome.text;
    await createInboxItem({
      title: `Claude ответил на #${item.id}: ${item.title || ""}`,
      body: answer || "Готово.",
      item_type: "agent_response",
      priority: "normal",
      props: {
        in_reply_to: item.id,
        to: item.agent_name || "Человек",
        source: "claude-inbox-watcher",
        ...(threadOf(item) ? { thread: threadOf(item) } : {}),
        // След работы для чата: чипы инструментов, раскрывающийся список шагов и строка
        // «сколько думал / сколько заняло». Текста размышления у CLI нет — см. spawnStreaming.
        tools_used: outcome.toolsUsed,
        trace: outcome.trace,
        // Цепочка шагов, как в Claude Code: что вызвано, с чем и что вернулось, по порядку.
        // Последняя реплика агента совпадает с самим ответом — в цепочке она была бы дублем.
        steps: outcome.steps.filter((step) => !(step.kind === "text" && step.text && outcome.text.startsWith(step.text.replace(/…$/, "")))),
        work: outcome.stats,
        ...(worthShowingLimit(outcome.rateLimit) ? { rate_limit: claudeRateLimit(outcome.rateLimit) } : {}),
      },
    });
    await patchInbox(item.id, {
      status: "done",
      props: {
        ...(item.props || {}),
        handled_by: agentName,
        answered_by: agentName,
        answered_at: new Date().toISOString(),
        agent_run_id: run?.id || null,
      },
    });
    await finishRun(run?.id, "done", answer, Date.now() - startedAt);
  } catch (error) {
    const message = error.cliFailure ? error.message : error.stack || error.message;
    await createInboxItem({
      title: `Claude не смог ответить на #${item.id}`,
      body: message,
      item_type: "agent_error",
      priority: "high",
      props: { in_reply_to: item.id, source: "claude-inbox-watcher", ...(threadOf(item) ? { thread: threadOf(item) } : {}) },
    });
    await patchInbox(item.id, {
      status: "open",
      props: { ...(item.props || {}), handled_by: agentName, last_error: error.message },
    });
    await finishRun(run?.id, "failed", message, Date.now() - startedAt);
  }
}

/**
 * Лимиты подписки Claude из события потока — в ту же форму, что чат уже рисует для Джарвиса.
 * utilization приходит долей (0.5 = половина окна израсходована), resetsAt — unix-секунды.
 */
/** Плашку о лимите показываем не всегда: на половине окна она была бы шумом в каждом ответе. */
function worthShowingLimit(info) {
  if (!info) return false;
  if (/reject|block|exceed/i.test(String(info.status || ""))) return true;
  return (Number(info.utilization) || 0) >= 0.8;
}

function claudeRateLimit(info) {
  const resetsAt = Number(info.resetsAt) || 0;
  const window = info.rateLimitType === "seven_day" ? "недельное окно" : "пятичасовое окно";
  return {
    provider: "claude",
    model: "подписка Claude Code",
    used_percent: Math.round((Number(info.utilization) || 0) * 100),
    wait_seconds: resetsAt ? Math.max(0, resetsAt - Math.floor(Date.now() / 1000)) : 0,
    detail: `${window}${info.isUsingOverage ? ", идёт перерасход" : ""}`,
  };
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
  await mboxFetch(`/api/mbox/agent/inbox/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

async function createInboxItem(body) {
  const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}&detail=short`);
  const target = projects.projects?.find((item) => item.name === project) || projects.projects?.[0];
  return mboxFetch("/api/mbox/agent/inbox", {
    method: "POST",
    body: JSON.stringify({ project_id: target?.id || null, agent_name: agentName, requires_human: false, ...body }),
  });
}

async function createRun(item) {
  const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}&detail=short`);
  const target = projects.projects?.find((entry) => entry.name === project) || projects.projects?.[0];
  const data = await mboxFetch("/api/mbox/agent/runs", {
    method: "POST",
    body: JSON.stringify({
      project_id: target?.id || null,
      agent_name: agentName,
      status: "running",
      goal: `Answer MBOX inbox #${item.id}: ${item.title || ""}`,
      read_context: [`agent_inbox:${item.id}`],
      props: { source: "claude-inbox-watcher", inbox_id: item.id },
    }),
  });
  return data.run;
}

async function finishRun(id, status, result, elapsedMs) {
  if (!id) return;
  await mboxFetch(`/api/mbox/agent/runs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status, result, props: { source: "claude-inbox-watcher", elapsed_ms: elapsedMs } }),
  });
}

async function recentConversationContext(item) {
  if (!contextLimit) return "";
  const data = await mboxFetch("/api/mbox/agent/inbox");
  const targetProjectId = String(item.project_id || "");
  const currentCreatedAt = new Date(item.created_at || Date.now()).getTime();
  const rows = (data.inbox || [])
    .filter((entry) => ["question", "chat", "answer", "agent_response"].includes(entry.item_type))
    .filter((entry) => !targetProjectId || !entry.project_id || String(entry.project_id) === targetProjectId)
    .filter((entry) => sameThread(entry, item))
    .filter((entry) => String(entry.id) !== String(item.id))
    .filter((entry) => new Date(entry.created_at || 0).getTime() <= currentCreatedAt)
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
    .slice(-contextLimit);

  if (!rows.length) return "";
  // Свежее важнее старого: набираем историю с конца, пока укладываемся в общий бюджет символов,
  // и только потом переворачиваем обратно. Раньше бюджета не было вовсе, зато КАЖДАЯ запись резалась
  // до 900 символов — и агент читал свои же прошлые ответы оборванными на полуслове, после чего
  // решал, что это чат их обрезал, и переписывал ответ заново.
  const lines = [];
  let budget = CONTEXT_CHARS_TOTAL;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const line = formatContextLine(rows[i]);
    if (lines.length && line.length > budget) break;
    lines.unshift(line);
    budget -= line.length;
  }
  return [
    "Recent MBOX console context, oldest to newest:",
    ...lines,
  ].join("\n");
}

function formatContextLine(entry) {
  const at = entry.created_at ? new Date(entry.created_at).toISOString().slice(11, 19) : "--:--:--";
  const actor = entry.agent_name || "unknown";
  const to = entry.props?.to ? ` -> ${entry.props.to}` : "";
  const re = entry.props?.re || entry.props?.in_reply_to ? `, reply to #${entry.props.re || entry.props.in_reply_to}` : "";
  const text = String([entry.title, entry.body].filter(Boolean).join(" — ")).replace(/\s+/g, " ").trim();
  const clipped = text.length > CONTEXT_CHARS_PER_ENTRY ? `${text.slice(0, CONTEXT_CHARS_PER_ENTRY)}...` : text;
  return `[${at}] ${actor}${to} (${entry.item_type} #${entry.id}${re}): ${clipped}`;
}

/**
 * Ответ в чате. Первый запрос чата — полный промпт с инструкциями, следующие продолжают ту же сессию
 * CLI (`--resume`): инструкции и история уже в ней, уходит только новое сообщение. Потерянная сессия
 * (CLI её не нашёл) — не ошибка для человека: чат просто начинается заново.
 */
async function runClaude(item) {
  const thread = threadOf(item);
  let sessionId = sessions.get(thread);
  // Раздутая сессия дороже новой: каждый шаг пересылает весь контекст (см. ROTATE_CONTEXT_TOKENS).
  const rotated = Boolean(sessionId && sessions.contextOf(thread) > ROTATE_CONTEXT_TOKENS);
  if (rotated) {
    console.log(`${logPrefix} чат ${thread}: контекст ${sessions.contextOf(thread)} > ${ROTATE_CONTEXT_TOKENS} — начинаю новую сессию`);
    sessions.forget(thread);
    sessionId = "";
  }
  if (sessionId) {
    try {
      const outcome = await runClaudeTurn(item, sessionId);
      sessions.remember(thread, outcome.sessionId || sessionId, outcome.stats?.context_tokens);
      return outcome;
    } catch (error) {
      if (!isLostSession(error)) throw error;
      console.log(`${logPrefix} сессия чата ${thread} потеряна — начинаю заново`);
      sessions.forget(thread);
    }
  }
  const outcome = await runClaudeTurn(item, "");
  sessions.remember(thread, outcome.sessionId, outcome.stats?.context_tokens);
  if (rotated && outcome.stats) outcome.stats.session_rotated = true;
  return outcome;
}

function messageLines(item) {
  return [
    `Inbox id: ${item.id}`,
    // Ответ на конкретное сообщение (кнопка «Ответить» в чате MBOX): props.re — его id.
    ...(item.props?.re || item.props?.in_reply_to ? [`In reply to message #${item.props.re || item.props.in_reply_to}.`] : []),
    `From: ${item.agent_name || "unknown"}`,
    `Title: ${item.title || ""}`,
    `Body:\n${item.body || ""}`,
    ...focusLines(item),
  ];
}

async function runClaudeTurn(item, resumeId) {
  const prompt = resumeId
    ? ["New message in this same MBOX chat. Answer it the same way as before (Russian, concise; the watcher posts your final answer).", "", ...messageLines(item)].join("\n")
    : await freshPrompt(item);

  // stream-json вместо text: в человеке важен не только финальный ответ, но и то, что агент сейчас
  // делает. Текста размышления CLI не отдаёт ни при каких флагах (блоки thinking приходят пустыми,
  // сырую цепочку рассуждений API не возвращает), но отдаёт счётчик потраченных на размышление
  // токенов, перечень вызванных инструментов и состояние лимитов подписки — этого хватает на живую
  // строку «Думает · 1,3k токенов» в чате, как в VS Code.
  // --include-partial-messages не нужен: события system/thinking_tokens приходят и без него,
  // а с ним поток раздувается в двадцать раз на тех же данных (проверено).
  const args = ["-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "--input-format", "text"];
  if (resumeId) args.push("--resume", resumeId);
  // Модель и «усилие» человек выбирает рядом с полем ввода в MBOX (см. jarvisModels на сервере);
  // не выбрал — остаётся то, что настроено переменными окружения, а дальше умолчание самого CLI.
  const wantedModel = pickModel(item.props?.model) || pickModel(claudeModel) || CLAUDE_DEFAULT_MODEL;
  // CLAUDE_WATCH_EFFORT — экономный уровень по умолчанию для облачного агента (low), если в чате не выбран другой.
  const wantedEffort = pickEffort(item.props?.effort) || pickEffort(process.env.CLAUDE_WATCH_EFFORT);
  if (wantedModel) args.push("--model", wantedModel);
  if (wantedEffort) args.push("--effort", wantedEffort);
  if (mcpConfigReady) args.push("--mcp-config", mcpConfigPath);

  const outcome = await spawnStreaming(claudeCommand, args, { cwd: workdir, env: process.env }, prompt, item.id);
  if (outcome.stats) outcome.stats.resumed = Boolean(resumeId);
  return outcome;
}

async function freshPrompt(item) {
  const conversationContext = await recentConversationContext(item);
  return [
    "You were woken by MBOX agent_inbox.",
    `Your canonical agent name is ${agentName}.`,
    "Answer the inbox item below. If asked to do code work, do it in the repo and summarize the result.",
    "Do not create an MBOX inbox response yourself; the watcher will post your final answer.",
    "Keep the final answer concise and directly useful.",
    "Use the recent MBOX console context to resolve short messages, pronouns, follow-ups, and @mentions.",
    // MBOX — русскоязычный проект: владелец, Джарвис и вся консоль общаются по-русски. Без этой
    // строки ответ уходил на английском (нет другого языкового сигнала во всём промпте).
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
    // Навыки ставятся с сервера MBOX (refreshSkills); без явного списка Claude в -p режиме их не замечал.
    installedSkills.length
      ? `MBOX skills are installed in ~/.claude/skills (the Skill tool lists them with descriptions): ${installedSkills.map((skill) => skill.id).join(", ")}. If the request matches one, invoke it with the Skill tool and follow its SKILL.md exactly.`
      : "",
    agentLessons(),
    // Инструменты «на глазах»: агент работает в документах и таблицах, а человек видит правку во вкладке.
    "Documents and tables: MBOX notes (note_search, note_read, note_write, note_edit) and files in the owner's local folders (workspace_edit_file for small text edits instead of rewriting a whole file, workspace_read_table / workspace_write_cells / workspace_format_cells for .xlsx/.csv, workspace_read_document / workspace_write_docx for Word). Pass show=true when the owner should watch the change happen — the document opens as a tab in MBOX.",
    "Save tokens: read only the parts you need, prefer targeted search over broad scans, do not repeat large file contents in the answer.",
    "",
    conversationContext,
    "",
    ...messageLines(item),
  ].join("\n");
}

/** 1300 -> «1,3k»: в живой строке важен порядок величины, а не точное число. */
function formatTokens(count) {
  if (!count) return "0";
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(".", ",")}k` : String(count);
}

/** Чем занят инструмент — одной короткой подписью из его аргументов. */
function toolHint(input) {
  if (!input || typeof input !== "object") return "";
  const raw = input.file_path || input.path || input.command || input.pattern || input.query || input.url || input.prompt || "";
  const value = String(raw).split(/[\\/]/).pop() || String(raw);
  return value.length > 48 ? `${value.slice(0, 48)}…` : value;
}

/**
 * Запуск CLI агента с разбором потока событий.
 *
 * Возвращает не только текст ответа, но и след работы: какие инструменты вызывались, сколько
 * токенов ушло на размышление, во что обошёлся ответ и где сейчас лимиты подписки. Пока агент
 * работает, то же самое уходит в MBOX фазой (POST /agent/ping), и чат показывает её живой строкой.
 */
function spawnStreaming(command, args, options, input = "", inboxId = "") {
  return new Promise((resolve, reject) => {
    // windowsHide: наблюдатель сам работает без консоли, и без флага Windows открывала CLI агента
    // в отдельном видимом окне. claude на Windows — это claude.cmd, его запускает только cmd.exe.
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].join(" ")}"`], { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true })
      : spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const runTimer = armRunTimeout(child);

    // steps — цепочка шагов для чата: что вызвано, с чем и что вернулось, в порядке событий.
    // pendingTools связывает вызов с его результатом: они приходят разными событиями потока.
    const state = { text: "", toolsUsed: [], trace: [], steps: [], thinkingTokens: 0, rateLimit: null, stats: null, failure: "", sessionId: "", contextTokens: 0 };
    const pendingTools = new Map();
    // Claude Code стартует несколько секунд (грузит MCP и навыки) и до первого события молчит —
    // без этой строки человек всё это время видел бы пустоту там, где агент уже занят.
    ping("heartbeat", "Запускается").catch(() => {});
    let buffer = "";
    let plain = "";
    let stderr = "";
    let lastPhaseAt = 0;
    let lastPhase = "Запускается";

    // Новая фаза уходит сразу, повтор той же — не чаще раза в три секунды (каждая фаза — broadcast по
    // вебсокету, на него интерфейс перечитывает агентов). Раньше троттлилась любая фаза, а текст
    // рассуждения фазу не менял вовсе — чат писал «Запускается», пока агент уже писал рассуждения.
    const pushPhase = (phase) => {
      const now = Date.now();
      if (phase === lastPhase && now - lastPhaseAt < 3000) return;
      lastPhase = phase;
      lastPhaseAt = now;
      ping("heartbeat", phase).catch(() => {});
    };

    const handle = (event) => {
      if (event.session_id) state.sessionId = String(event.session_id);
      if (event.type === "assistant" && lastPhase === "Запускается") pushPhase("Думает");
      if (event.type === "system" && event.subtype === "thinking_tokens") {
        state.thinkingTokens = Math.max(state.thinkingTokens, Number(event.estimated_tokens) || 0);
        pushPhase("Думает");
        return;
      }
      if (event.type === "rate_limit_event" && event.rate_limit_info) {
        state.rateLimit = event.rate_limit_info;
        return;
      }
      if (event.type === "assistant" && event.message?.usage) {
        // Размер контекста — вход ПОСЛЕДНЕГО вызова модели вместе с кешем: столько сессия чата
        // сейчас тащит в каждый запрос. Его и показывает индикатор нагрузки чата.
        const usage = event.message.usage;
        state.contextTokens = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
      }
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            // Реплика между шагами («сейчас проверю тесты») — часть цепочки, а не сам ответ.
            const text = String(block.text || "").trim();
            if (text) pushPhase("Пишет");
            if (text) {
              const index = state.steps.length;
              if (addStep(state, { kind: "text", text: clip(text, MAX_STEP_TEXT) })) {
                streamStep(inboxId, index, { kind: "text", text: clip(text, MAX_STEP_TEXT) });
              }
            }
            continue;
          }
          if (block.type !== "tool_use") continue;
          const name = String(block.name || "?");
          const hint = toolHint(block.input);
          if (!state.toolsUsed.includes(name)) state.toolsUsed.push(name);
          state.trace.push(`${state.trace.length + 1}. ${name}${hint ? `\n   ${hint}` : ""}`);
          const index = state.steps.length;
          const step = addStep(state, { kind: "tool", name, hint, input: clip(stringifyInput(block.input), MAX_STEP_INPUT), at: Date.now() });
          if (step) {
            step.i = index;
            if (block.id) pendingTools.set(block.id, step);
            // Вызов уходит в чат сразу, не дожидаясь результата: в потоке шаг должен появиться
            // в тот момент, когда он начался, иначе «живой» цепочки не получится.
            streamStep(inboxId, index, { kind: "tool", name, hint, input: step.input });
          }
          console.log(`${logPrefix}   ${name}${hint ? " · " + hint : ""}`);
          // В чате — просто «Работает»: там нужен признак жизни, а не имя инструмента. Что и с чем
          // вызывалось, видно в цепочке шагов под готовым ответом.
          pushPhase("Работает");
        }
        return;
      }
      // Результат инструмента приходит отдельным событием роли user. Без него в цепочке была бы
      // только половина шага: что запустили, но не что вернулось.
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type !== "tool_result") continue;
          const step = pendingTools.get(block.tool_use_id);
          if (!step) continue;
          pendingTools.delete(block.tool_use_id);
          step.output = clip(toolResultText(block.content), MAX_STEP_OUTPUT);
          step.is_error = Boolean(block.is_error);
          step.ms = step.at ? Date.now() - step.at : 0;
          delete step.at;
          streamStep(inboxId, step.i, { output: step.output, is_error: step.is_error, ms: step.ms });
        }
        return;
      }
      if (event.type === "result") {
        state.text = String(event.result || "").trim();
        // total_cost_usd CLI считает по тарифам API, но отвечает-то он по подписке — показывать
        // эти доллары человеку значит врать о том, чего он не платит. Не берём.
        state.stats = {
          thinking_tokens: event.usage?.output_tokens_details?.thinking_tokens ?? state.thinkingTokens,
          // Те же поля, что у Codex: чат показывает, сколько ушло на вход и сколько из этого — из кеша.
          input_tokens: (Number(event.usage?.input_tokens) || 0) + (Number(event.usage?.cache_read_input_tokens) || 0) + (Number(event.usage?.cache_creation_input_tokens) || 0),
          cached_input_tokens: Number(event.usage?.cache_read_input_tokens) || 0,
          output_tokens: Number(event.usage?.output_tokens) || 0,
          context_tokens: state.contextTokens || 0,
          context_window: Math.max(0, ...Object.values(event.modelUsage || {}).map((item) => Number(item?.contextWindow) || 0)) || 0,
          duration_ms: Number(event.duration_ms) || 0,
          turns: Number(event.num_turns) || 0,
        };
        // Провал приходит успешным кодом выхода — причина только здесь, в самом событии.
        if (event.is_error) state.failure = state.text || String(event.subtype || "CLI вернул ошибку");
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith("{")) { plain += `${trimmed}\n`; console.log(`${logPrefix} ${trimmed}`); continue; }
        // Разбор и обработку разводим намеренно: общий catch глотал и ошибки обработчика, из-за
        // чего поломка в нём выглядела как «шаги просто не собрались», без следа в логе.
        let event = null;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Строка потока не разобралась — она не должна ронять ответ; держим её как обычный вывод.
          plain += `${trimmed}\n`;
        }
        if (event) {
          try {
            handle(event);
          } catch (error) {
            console.error(`${logPrefix} сбой разбора события ${event.type}: ${error.message}`);
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    if (input) child.stdin?.end(input);

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(runTimer);
      ping("heartbeat", "").catch(() => {});
      if (code !== 0) { reject(describeCliFailure(command, code, `${plain}\n${state.text}`, stderr)); return; }
      if (state.failure) { const error = new Error(state.failure); error.cliFailure = true; reject(error); return; }
      console.log(`${logPrefix} готово: ${formatTokens(state.stats?.thinking_tokens || 0)} токенов размышления, инструментов ${state.toolsUsed.length}`);
      resolve(state);
    });
  });
}

function spawnCaptured(command, args, options, input = "") {
  return new Promise((resolve, reject) => {
    // windowsHide: наблюдатель сам работает без консоли, и без флага Windows открывала CLI агента
    // в отдельном видимом окне. Вывод и так идёт в stdout — его показывает консоль MBOX Desktop.
    // claude на Windows — это claude.cmd, его запускает только cmd.exe. Раньше здесь был shell: true с массивом
    // аргументов, и node печатал DeprecationWarning DEP0190 в консоль агента на каждый ответ. Аргументы —
    // наши флаги без пробелов (текст запроса идёт через stdin), поэтому склеивать их в строку безопасно.
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].join(" ")}"`], { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true })
      : spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    if (input) {
      child.stdin?.end(input);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(describeCliFailure(command, code, stdout, stderr));
    });
  });
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
