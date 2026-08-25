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
const password = requireValue(config.MBOX_PASSWORD, "MBOX_PASSWORD");
const agentName = config.MBOX_AGENT_NAME || "Codex";
const project = config.MBOX_PROJECT || "MBOX";
const pollMs = Number(config.MBOX_WATCH_POLL_MS || 5000);
const startGraceMs = Number(config.MBOX_WATCH_START_GRACE_MS || 15 * 60 * 1000);
const includeBacklog = ["1", "true", "yes"].includes(String(config.MBOX_WATCH_BACKLOG || "").toLowerCase());
const startedAt = new Date();
const cutoffAt = new Date(startedAt.getTime() - startGraceMs);
const codexCommand = config.CODEX_COMMAND || "codex";
const codexModel = config.CODEX_WATCH_MODEL || "";
const workdir = config.CODEX_WATCH_WORKDIR || root;
const contextLimit = Number(config.MBOX_WATCH_CONTEXT_LIMIT || 30);
const aliases = (config.CODEX_CHAT_ALIASES || "codex,Codex,кодекс,Кодекс")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const seenPath = path.join(os.tmpdir(), `codex-chat-watcher-seen-${agentName}-${project}.json`);
const lockPath = path.join(os.tmpdir(), `codex-chat-watcher-${agentName}-${project}.lock`);
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
  if (!cookie) await login();
  const response = await fetch(`${baseUrl}${apiPath}`, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      cookie,
      "x-mbox-agent": agentName,
      ...(init.headers || {}),
    },
  });
  if (response.status === 401) {
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
    .filter((item) => ["question", "chat"].includes(item.item_type))
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
  await patchInbox(item.id, {
    status: "doing",
    props: { ...(item.props || {}), handled_by: agentName, handling_started_at: new Date().toISOString(), source: "codex-chat-watcher" },
  });

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
    const message = error.stack || error.message;
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
  const text = String(entry.body || entry.title || "").replace(/\s+/g, " ").trim();
  const clipped = text.length > 900 ? `${text.slice(0, 900)}...` : text;
  return `[${at}] ${actor} (${entry.item_type} #${entry.id}): ${clipped}`;
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
    "",
    conversationContext,
    "",
    `Chat item id: ${item.id}`,
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
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}
