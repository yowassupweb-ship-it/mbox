import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig();
const baseUrl = requireValue(config.MBOX_URL, "MBOX_URL");
const username = config.MBOX_USERNAME || "Admin";
const accessToken = String(config.MBOX_TOKEN || "").trim();
const password = accessToken ? "" : requireValue(config.MBOX_PASSWORD, "MBOX_PASSWORD or MBOX_TOKEN");
const agentName = config.MBOX_AGENT_NAME || "Codex";
const project = config.MBOX_PROJECT || "MBOX";
const pollMs = Number(config.MBOX_WATCH_POLL_MS || 5000);
const startGraceMs = Number(config.MBOX_WATCH_START_GRACE_MS || 15 * 60 * 1000);
const includeBacklog = ["1", "true", "yes"].includes(String(config.MBOX_WATCH_BACKLOG || "").toLowerCase());
const startedAt = new Date();
const cutoffAt = new Date(startedAt.getTime() - startGraceMs);
const codexCommand = resolveCodexCommand(config.CODEX_COMMAND || "codex");
const codexModel = config.CODEX_WATCH_MODEL || "";
const workdir = config.CODEX_WATCH_WORKDIR || root;
const contextLimit = Number(config.MBOX_WATCH_CONTEXT_LIMIT || 30);
const aliases = (config.CODEX_CHAT_ALIASES || "codex,Codex,кодекс,Кодекс")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const accountKey = username.replace(/[^a-z0-9_-]+/gi, "_");
const seenPath = path.join(os.tmpdir(), `codex-chat-watcher-seen-${accountKey}-${agentName}-${project}.json`);
const lockPath = path.join(os.tmpdir(), `codex-chat-watcher-${accountKey}-${agentName}-${project}.lock`);
const logPrefix = `[${agentName} chat]`;

let cookie = "";
let stopping = false;
let seen = loadSeen();
let lockFd = null;

acquireSingleInstanceLock();

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
console.log(`${logPrefix} watching @codex mentions on ${baseUrl} project=${project} every ${pollMs}ms`);
console.log(`${logPrefix} using Codex CLI: ${codexCommand}`);
console.log(`${logPrefix} ${includeBacklog ? "including backlog" : `ignoring chat before ${cutoffAt.toISOString()}`}`);

while (!stopping) {
  try {
    await ping("heartbeat");
    const item = await nextMention();
    if (item) await handleMention(item);
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

async function ping(event) {
  await mboxFetch("/api/mbox/agent/ping", {
    method: "POST",
    body: JSON.stringify({
      agent: agentName,
      event,
      kind: "local_watcher",
      client: "codex-chat-watcher",
      scope: "project_chat_mentions,codex_exec",
    }),
  });
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
    const answer = await runCodex(item);
    await createInboxItem({
      project_id: item.project_id || null,
      title: `Codex: ответ на #${item.id}`,
      body: answer || "Готово.",
      item_type: "agent_response",
      priority: "normal",
      props: { in_reply_to: item.id, to: item.agent_name || "Человек", source: "codex-chat-watcher" },
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
      title: `Codex не смог ответить на #${item.id}`,
      body: message,
      item_type: "agent_error",
      priority: "high",
      props: { in_reply_to: item.id, source: "codex-chat-watcher" },
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
  const text = String(entry.body || entry.title || "").replace(/\s+/g, " ").trim();
  const clipped = text.length > 900 ? `${text.slice(0, 900)}...` : text;
  return `[${at}] ${actor}${to} (${entry.item_type} #${entry.id}${re}): ${clipped}`;
}

async function runCodex(item) {
  const outputFile = path.join(os.tmpdir(), `codex-mbox-chat-${item.id}-${Date.now()}.txt`);
  const conversationContext = await recentConversationContext(item);
  const prompt = [
    "You were woken by an @codex mention in the MBOX project chat.",
    `Your canonical agent name is ${agentName}.`,
    "Answer the chat message below. If the user asks for code work, do it in the repo and summarize the result.",
    "Do not create an MBOX inbox response yourself; the watcher will post your final answer.",
    "Keep the final answer concise and directly useful.",
    "Use the recent MBOX console context to resolve short messages, pronouns, follow-ups, and @mentions.",
    // См. claude-inbox-watcher.mjs — тот же пробел без языкового сигнала уводил ответы на английский.
    "MBOX is a Russian-language project — the owner and all other agents communicate in Russian. Write your final answer in Russian, unless the user explicitly wrote in another language.",
    // Длинный отчёт в чате терялся — теперь он всегда отдельным файлом со ссылкой (MCP save_report).
    "If the answer is a report, audit, research or anything longer than ~20 lines, first save the full text as Markdown with the mbox-prod MCP tool save_report, then reply in chat with a short summary (5-10 lines) and the returned markdown_link — the owner must get a clickable link.",
    // Навык ведёт сценарий через интерфейс MBOX: форма, результат, папка открываются вкладкой, файлы навыка правятся на лету.
    "MBOX UI: to show the owner a skill form, a finished file or folder, use the MBOX MCP tool open_tab (skill-file:<skill>/<file>, skill-blocks:<skill>, path:<absolute path>). To change a skill's files (SKILL.md, forms, templates) use edit_skill_file / write_skill_file — live immediately, no deploy.",
    "",
    conversationContext,
    "",
    `Chat item id: ${item.id}`,
    // Ответ на конкретное сообщение (кнопка «Ответить» в чате MBOX): props.re — его id, текст есть в контексте выше.
    ...(item.props?.re || item.props?.in_reply_to ? [`In reply to message #${item.props.re || item.props.in_reply_to} — read that message in the context above and answer in its thread.`] : []),
    `From: ${item.agent_name || "unknown"}`,
    `Title: ${item.title || ""}`,
    `Body:\n${item.body || ""}`,
  ].join("\n");

  const args = [
    "exec",
    "-C",
    workdir,
    "--sandbox",
    "danger-full-access",
    "--output-last-message",
    outputFile,
  ];
  if (codexModel) args.push("-m", codexModel);
  args.push(prompt);

  await spawnChecked(codexCommand, args, { cwd: workdir, env: { ...process.env, MBOX_AGENT_NAME: agentName } });
  const answer = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
  fs.rmSync(outputFile, { force: true });
  return answer;
}

function spawnChecked(command, args, options) {
  return new Promise((resolve, reject) => {
    // windowsHide: без него Windows открывала CLI агента в отдельном видимом окне консоли.
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-8000);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
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

