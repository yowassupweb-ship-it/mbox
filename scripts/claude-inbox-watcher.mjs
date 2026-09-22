import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncSkills } from "./sync-skills.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const baseUrl = requireValue(process.env.MBOX_URL, "MBOX_URL");
const username = process.env.MBOX_USERNAME || "Admin";
const accessToken = String(process.env.MBOX_TOKEN || "").trim();
const password = accessToken ? "" : requireValue(process.env.MBOX_PASSWORD, "MBOX_PASSWORD or MBOX_TOKEN");
const agentName = process.env.MBOX_AGENT_NAME || "Claude";
const project = process.env.MBOX_PROJECT || "MBOX";
// 15 с ожидания до того, как наблюдатель вообще увидит сообщение, плюс холодный старт CLI — человек
// это чувствует как «не дошло». Пять секунд заметно живее и всё ещё дёшево: два лёгких запроса за тик.
const pollMs = Number(process.env.MBOX_WATCH_POLL_MS || 5000);
const includeUnaddressed = !["0", "false", "no"].includes(String(process.env.MBOX_WATCH_UNADDRESSED || "true").toLowerCase());
const startGraceMs = Number(process.env.MBOX_WATCH_START_GRACE_MS || 15 * 60 * 1000);
const includeBacklog = ["1", "true", "yes"].includes(String(process.env.MBOX_WATCH_BACKLOG || "").toLowerCase());
const startedAt = new Date();
const cutoffAt = includeBacklog ? new Date(startedAt.getTime() - startGraceMs) : startedAt;
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
const contextLimit = Number(process.env.MBOX_WATCH_CONTEXT_LIMIT || 30);

// ВНИМАНИЕ: главный цикл этого файла (`while (!stopping)`) работает на верхнем уровне модуля и
// никогда не завершается, поэтому до объявлений НИЖЕ него исполнение просто не доходит. Функции
// поднимаются и работают, а `const` остаётся в temporal dead zone: обращение к нему из обработчика
// падает с «Cannot access ... before initialization». Всё, что нужно обработчикам константой,
// объявляем здесь, до цикла.
// Из сообщения приходит чужой ввод — в аргументы командной строки он попадает только из этих
// списков, никогда как есть.
const CLAUDE_MODEL_CHOICES = new Set(["fable", "opus", "sonnet", "haiku"]);
// Модель по умолчанию — та же, что сервер показывает в поле ввода (см. jarvisModels).
const CLAUDE_DEFAULT_MODEL = "sonnet";
const CLAUDE_EFFORT_CHOICES = new Set(["low", "medium", "high", "xhigh", "max"]);
const pickModel = (value) => (CLAUDE_MODEL_CHOICES.has(String(value || "")) ? String(value) : "");
const pickEffort = (value) => (CLAUDE_EFFORT_CHOICES.has(String(value || "")) ? String(value) : "");

let cookie = "";
let stopping = false;
let lockFd = null;

acquireSingleInstanceLock();

process.on("SIGINT", () => { stopping = true; releaseSingleInstanceLock(); });
process.on("SIGTERM", () => { stopping = true; releaseSingleInstanceLock(); });
process.on("exit", releaseSingleInstanceLock);

await ping("session_start");

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
    await ping("heartbeat");
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
  await sleep(pollMs);
}

console.log(`${logPrefix} stopped`);
releaseSingleInstanceLock();

function acquireSingleInstanceLock() {
  try {
    lockFd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
  } catch (error) {
    const pid = readLockPid();
    if (pid && isProcessAlive(pid)) {
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
async function ping(event, phase) {
  await mboxFetch("/api/mbox/agent/ping", {
    method: "POST",
    body: JSON.stringify({ agent: agentName, event, kind: "local_watcher", client: "claude-inbox-watcher", scope: "agent_inbox", ...(phase === undefined ? {} : { phase }) }),
  });
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
        // След работы для чата: чипы инструментов, раскрывающийся список шагов и строка
        // «сколько думал / сколько заняло». Текста размышления у CLI нет — см. spawnStreaming.
        tools_used: outcome.toolsUsed,
        trace: outcome.trace,
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
      props: { in_reply_to: item.id, source: "claude-inbox-watcher" },
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
  const text = String([entry.title, entry.body].filter(Boolean).join(" — ")).replace(/\s+/g, " ").trim();
  const clipped = text.length > 900 ? `${text.slice(0, 900)}...` : text;
  return `[${at}] ${actor}${to} (${entry.item_type} #${entry.id}${re}): ${clipped}`;
}

async function runClaude(item) {
  const conversationContext = await recentConversationContext(item);
  const prompt = [
    "You were woken by MBOX agent_inbox.",
    `Your canonical agent name is ${agentName}.`,
    "Answer the inbox item below. If asked to do code work, do it in the repo and summarize the result.",
    "Do not create an MBOX inbox response yourself; the watcher will post your final answer.",
    "Keep the final answer concise and directly useful.",
    "Use the recent MBOX console context to resolve short messages, pronouns, follow-ups, and @mentions.",
    // MBOX — русскоязычный проект: владелец, Джарвис и вся консоль общаются по-русски. Без этой
    // строки ответ уходил на английском (нет другого языкового сигнала во всём промпте).
    "MBOX is a Russian-language project — the owner and all other agents communicate in Russian. Write your final answer in Russian, unless the user explicitly wrote in another language.",
    // Длинный отчёт в чате терялся — теперь он всегда отдельным файлом со ссылкой (MCP save_report).
    "If the answer is a report, audit, research or anything longer than ~20 lines, first save the full text as Markdown with the mbox-prod MCP tool save_report, then reply in chat with a short summary (5-10 lines) and the returned markdown_link — the owner must get a clickable link.",
    // Навык ведёт сценарий через интерфейс MBOX: форма, результат, папка открываются вкладкой, файлы навыка правятся на лету.
    "MBOX UI: to show the owner a skill form, a finished file or folder, use the MBOX MCP tool open_tab (skill-file:<skill>/<file>, skill-blocks:<skill>, path:<absolute path>). To change a skill's files (SKILL.md, forms, templates) use edit_skill_file / write_skill_file — live immediately, no deploy.",
    // Навыки ставятся с сервера MBOX (refreshSkills); без явного списка Claude в -p режиме их не замечал.
    installedSkills.length
      ? `MBOX skills are installed from the MBOX server in ~/.claude/skills. If the request matches one, invoke it with the Skill tool and follow its SKILL.md exactly: ${installedSkills.map((skill) => `${skill.id} — ${skill.description}`).join(" | ")}`
      : "",
    "",
    conversationContext,
    "",
    `Inbox id: ${item.id}`,
    // Ответ на конкретное сообщение (кнопка «Ответить» в чате MBOX): props.re — его id, текст есть в контексте выше.
    ...(item.props?.re || item.props?.in_reply_to ? [`In reply to message #${item.props.re || item.props.in_reply_to} — read that message in the context above and answer in its thread.`] : []),
    `From: ${item.agent_name || "unknown"}`,
    `Title: ${item.title || ""}`,
    `Body:\n${item.body || ""}`,
  ].join("\n");

  // stream-json вместо text: в человеке важен не только финальный ответ, но и то, что агент сейчас
  // делает. Текста размышления CLI не отдаёт ни при каких флагах (блоки thinking приходят пустыми,
  // сырую цепочку рассуждений API не возвращает), но отдаёт счётчик потраченных на размышление
  // токенов, перечень вызванных инструментов и состояние лимитов подписки — этого хватает на живую
  // строку «Думает · 1,3k токенов» в чате, как в VS Code.
  // --include-partial-messages не нужен: события system/thinking_tokens приходят и без него,
  // а с ним поток раздувается в двадцать раз на тех же данных (проверено).
  const args = ["-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "--input-format", "text"];
  // Модель и «усилие» человек выбирает рядом с полем ввода в MBOX (см. jarvisModels на сервере);
  // не выбрал — остаётся то, что настроено переменными окружения, а дальше умолчание самого CLI.
  const wantedModel = pickModel(item.props?.model) || claudeModel || CLAUDE_DEFAULT_MODEL;
  const wantedEffort = pickEffort(item.props?.effort);
  if (wantedModel) args.push("--model", wantedModel);
  if (wantedEffort) args.push("--effort", wantedEffort);

  return await spawnStreaming(claudeCommand, args, { cwd: workdir, env: process.env }, prompt);
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
function spawnStreaming(command, args, options, input = "") {
  return new Promise((resolve, reject) => {
    // windowsHide: наблюдатель сам работает без консоли, и без флага Windows открывала CLI агента
    // в отдельном видимом окне. claude на Windows — это claude.cmd, его запускает только cmd.exe.
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].join(" ")}"`], { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true })
      : spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    const state = { text: "", toolsUsed: [], trace: [], thinkingTokens: 0, rateLimit: null, stats: null, failure: "" };
    // Claude Code стартует несколько секунд (грузит MCP и навыки) и до первого события молчит —
    // без этой строки человек всё это время видел бы пустоту там, где агент уже занят.
    ping("heartbeat", "Запускается").catch(() => {});
    let buffer = "";
    let plain = "";
    let stderr = "";
    let lastPhaseAt = 0;

    // Фаза уходит на сервер не чаще раза в три секунды. Чаще незачем и вредно: каждая фаза — это
    // broadcast по вебсокету, а на него интерфейс перечитывает список агентов. Раз в три секунды
    // строка всё ещё читается как живая, но не дёргает клиент десятки раз в минуту.
    const pushPhase = (phase) => {
      const now = Date.now();
      if (now - lastPhaseAt < 3000) return;
      lastPhaseAt = now;
      ping("heartbeat", phase).catch(() => {});
    };

    const handle = (event) => {
      if (event.type === "system" && event.subtype === "thinking_tokens") {
        state.thinkingTokens = Math.max(state.thinkingTokens, Number(event.estimated_tokens) || 0);
        pushPhase("Думает");
        return;
      }
      if (event.type === "rate_limit_event" && event.rate_limit_info) {
        state.rateLimit = event.rate_limit_info;
        return;
      }
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type !== "tool_use") continue;
          const name = String(block.name || "?");
          const hint = toolHint(block.input);
          if (!state.toolsUsed.includes(name)) state.toolsUsed.push(name);
          state.trace.push(`${state.trace.length + 1}. ${name}${hint ? `\n   ${hint}` : ""}`);
          console.log(`${logPrefix}   ${name}${hint ? ` · ${hint}` : ""}`);
          // В чате — просто «Работает»: там нужен признак жизни, а не имя инструмента. Подробности
          // (что и с чем вызывалось) уходят в trace и видны под готовым ответом.
          pushPhase("Работает");
        }
        return;
      }
      if (event.type === "result") {
        state.text = String(event.result || "").trim();
        // total_cost_usd CLI считает по тарифам API, но отвечает-то он по подписке — показывать
        // эти доллары человеку значит врать о том, чего он не платит. Не берём.
        state.stats = {
          thinking_tokens: event.usage?.output_tokens_details?.thinking_tokens ?? state.thinkingTokens,
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
        try {
          handle(JSON.parse(trimmed));
        } catch {
          // Строка потока не разобралась — она не должна ронять ответ; держим её как обычный вывод.
          plain += `${trimmed}\n`;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    if (input) child.stdin?.end(input);

    child.on("error", reject);
    child.on("close", (code) => {
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

