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
const includeUnaddressed = !["0", "false", "no"].includes(String(config.MBOX_WATCH_UNADDRESSED || "true").toLowerCase());
const runOnce = ["1", "true", "yes"].includes(String(config.MBOX_WATCH_ONCE || "").toLowerCase());
const includeBacklog = ["1", "true", "yes"].includes(String(config.MBOX_WATCH_BACKLOG || "").toLowerCase());
const startGraceMs = Number(config.MBOX_WATCH_START_GRACE_MS || 15 * 60 * 1000);
const startedAt = new Date();
const cutoffAt = new Date(startedAt.getTime() - startGraceMs);
const agentAliases = [agentName, ...(config.MBOX_AGENT_ALIASES || "Кодекс").split(",")]
  .map((alias) => alias.trim())
  .filter(Boolean);
const broadcastAliases = (config.MBOX_BROADCAST_ALIASES || "Всем,Все,All,Everyone,Everybody")
  .split(",")
  .map((alias) => alias.trim())
  .filter(Boolean);
const codexCommand = config.CODEX_COMMAND || "codex";
const codexModel = config.CODEX_WATCH_MODEL || "";
const workdir = config.CODEX_WATCH_WORKDIR || root;
const logPrefix = `[${agentName} inbox]`;

let cookie = "";
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

await ping("session_start");
console.log(`${logPrefix} watching ${baseUrl} project=${project} every ${pollMs}ms`);
console.log(`${logPrefix} ${includeBacklog ? "including backlog" : `ignoring messages before ${cutoffAt.toISOString()}`}`);

while (!stopping) {
  try {
    await ping("heartbeat");
    const item = await nextInboxItem();
    if (item) await handleInboxItem(item);
    if (runOnce) break;
  } catch (error) {
    console.error(`${logPrefix} ${error.stack || error.message}`);
    if (runOnce) process.exitCode = 1;
    if (runOnce) break;
  }
  await sleep(pollMs);
}

console.log(`${logPrefix} stopped`);

function loadConfig() {
  const env = { ...process.env };
  const localMcp = path.resolve(root, "..", "..", ".mcp.json");
  if (fs.existsSync(localMcp)) {
    Object.assign(env, readMboxEnvFromMcpJson(localMcp));
  }
  const codexConfig = path.join(os.homedir(), ".codex", "config.toml");
  if (fs.existsSync(codexConfig)) {
    Object.assign(env, readMboxEnvFromCodexToml(codexConfig));
  }
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

function readMboxEnvFromMcpJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.["mbox-prod"]?.env || {};
  } catch {
    return {};
  }
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
      client: "codex-inbox-watcher",
      scope: "agent_inbox,codex_exec",
    }),
  });
}

async function nextInboxItem() {
  const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}&detail=short`);
  const target = projects.projects?.find((item) => item.name === project) || projects.projects?.[0];
  const data = await mboxFetch("/api/mbox/agent/inbox");
  const inbox = data.inbox || [];
  return inbox
    .filter((item) => item.status === "open")
    .filter((item) => item.agent_name !== agentName)
    .filter((item) => !["agent_response", "agent_error"].includes(item.item_type))
    .filter((item) => includeBacklog || new Date(item.created_at) >= cutoffAt)
    .filter((item) => !target || item.project_id == null || String(item.project_id) === String(target.id || ""))
    .filter((item) => isAddressedToMe(item))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || new Date(a.created_at) - new Date(b.created_at))[0];
}

function isAddressedToMe(item) {
  const text = `${item.title || ""}\n${item.body || ""}`;
  const to = item.props?.to || item.props?.target || item.props?.agent;
  if (agentAliases.some((alias) => String(to || "").toLowerCase() === alias.toLowerCase())) return true;
  if (broadcastAliases.some((alias) => String(to || "").toLowerCase() === alias.toLowerCase())) return true;
  if (agentAliases.some((alias) => new RegExp(`@${escapeRegExp(alias)}\\b`, "iu").test(text))) return true;
  if (broadcastAliases.some((alias) => new RegExp(`@${escapeRegExp(alias)}\\b`, "iu").test(text))) return true;
  if (agentAliases.some((alias) => text.toLowerCase().includes(alias.toLowerCase()))) return true;
  if (!includeUnaddressed) return false;
  return ["Человек", "Human", "User"].includes(item.agent_name) || item.item_type === "question";
}

function priorityRank(priority) {
  return { urgent: 0, high: 1, normal: 2, low: 3 }[priority] ?? 4;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function handleInboxItem(item) {
  console.log(`${logPrefix} handling #${item.id}: ${item.title}`);
  await patchInbox(item.id, {
    status: "doing",
    props: { ...(item.props || {}), handled_by: agentName, handling_started_at: new Date().toISOString() },
  });

  const run = await createRun(item);
  const startedAt = Date.now();
  try {
    const answer = await runCodex(item);
    await createInboxItem({
      title: `Codex ответил на #${item.id}: ${item.title}`,
      body: answer || "Готово.",
      item_type: "agent_response",
      priority: "normal",
      props: { in_reply_to: item.id, to: item.agent_name || "Человек", source: "codex-inbox-watcher" },
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
    const message = error.stack || error.message;
    await createInboxItem({
      title: `Codex не смог ответить на #${item.id}`,
      body: message,
      item_type: "agent_error",
      priority: "high",
      props: { in_reply_to: item.id, source: "codex-inbox-watcher" },
    });
    await patchInbox(item.id, {
      status: "open",
      props: { ...(item.props || {}), handled_by: agentName, last_error: error.message },
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
      goal: `Answer MBOX inbox #${item.id}: ${item.title}`,
      read_context: [`agent_inbox:${item.id}`],
      props: { source: "codex-inbox-watcher", inbox_id: item.id },
    }),
  });
  return data.run;
}

async function finishRun(id, status, result, elapsedMs) {
  if (!id) return;
  await mboxFetch(`/api/mbox/agent/runs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status,
      result,
      props: { source: "codex-inbox-watcher", elapsed_ms: elapsedMs },
    }),
  });
}

async function runCodex(item) {
  const outputFile = path.join(os.tmpdir(), `codex-mbox-${item.id}-${Date.now()}.txt`);
  const prompt = [
    "You were woken by MBOX agent_inbox.",
    `Your canonical agent name is ${agentName}.`,
    "Answer the inbox item below. If the user asks you to do code work, do it in the repo and summarize the result.",
    "Do not create an MBOX inbox response yourself; the watcher will post your final answer.",
    "Keep the final answer concise and directly useful.",
    "",
    `Inbox id: ${item.id}`,
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
