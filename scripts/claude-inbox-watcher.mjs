import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const baseUrl = requireValue(process.env.MBOX_URL, "MBOX_URL");
const username = process.env.MBOX_USERNAME || "Admin";
const password = requireValue(process.env.MBOX_PASSWORD, "MBOX_PASSWORD");
const agentName = process.env.MBOX_AGENT_NAME || "Claude";
const project = process.env.MBOX_PROJECT || "MBOX";
const pollMs = Number(process.env.MBOX_WATCH_POLL_MS || 15000);
const includeUnaddressed = !["0", "false", "no"].includes(String(process.env.MBOX_WATCH_UNADDRESSED || "true").toLowerCase());
const startGraceMs = Number(process.env.MBOX_WATCH_START_GRACE_MS || 15 * 60 * 1000);
const cutoffAt = new Date(Date.now() - startGraceMs);
const agentAliases = [agentName, ...(process.env.MBOX_AGENT_ALIASES || "Клод").split(",")]
  .map((alias) => alias.trim())
  .filter(Boolean);
const broadcastAliases = (process.env.MBOX_BROADCAST_ALIASES || "Всем,Все,All,Everyone,Everybody")
  .split(",")
  .map((alias) => alias.trim())
  .filter(Boolean);
const logPrefix = `[${agentName} inbox]`;
const seenPath = path.join(os.tmpdir(), `claude-inbox-watcher-seen-${agentName}.json`);
const seen = new Set(loadSeen());
const claudeCommand = process.env.CLAUDE_COMMAND || "claude";
const claudeModel = process.env.CLAUDE_WATCH_MODEL || "";
const workdir = process.env.CLAUDE_WATCH_WORKDIR || path.resolve(__dirname, "..");
const autoRespond = !["0", "false", "no"].includes(String(process.env.MBOX_WATCH_AUTORESPOND || "true").toLowerCase());
const contextLimit = Number(process.env.MBOX_WATCH_CONTEXT_LIMIT || 30);

let cookie = "";
let stopping = false;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

await ping("session_start");
console.log(`${logPrefix} watching ${baseUrl} project=${project} every ${pollMs}ms`);

while (!stopping) {
  try {
    await ping("heartbeat");
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
    body: JSON.stringify({ agent: agentName, event, kind: "local_watcher", client: "claude-inbox-watcher", scope: "agent_inbox" }),
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
  if (agentAliases.some((alias) => text.toLowerCase().includes(alias.toLowerCase()))) return true;
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
  await patchInbox(item.id, {
    status: "doing",
    props: { ...(item.props || {}), handled_by: agentName, handling_started_at: new Date().toISOString() },
  });

  const run = await createRun(item);
  const startedAt = Date.now();
  try {
    const answer = await runClaude(item);
    await createInboxItem({
      title: `Claude ответил на #${item.id}: ${item.title || ""}`,
      body: answer || "Готово.",
      item_type: "agent_response",
      priority: "normal",
      props: { in_reply_to: item.id, to: item.agent_name || "Человек", source: "claude-inbox-watcher" },
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
  const text = String([entry.title, entry.body].filter(Boolean).join(" — ")).replace(/\s+/g, " ").trim();
  const clipped = text.length > 900 ? `${text.slice(0, 900)}...` : text;
  return `[${at}] ${actor}${to} (${entry.item_type} #${entry.id}): ${clipped}`;
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
    "",
    conversationContext,
    "",
    `Inbox id: ${item.id}`,
    `From: ${item.agent_name || "unknown"}`,
    `Title: ${item.title || ""}`,
    `Body:\n${item.body || ""}`,
  ].join("\n");

  const args = ["-p", "--permission-mode", "bypassPermissions", "--output-format", "text", "--input-format", "text"];
  if (claudeModel) args.push("--model", claudeModel);

  return await spawnCaptured(claudeCommand, args, { cwd: workdir, env: process.env }, prompt);
}

function spawnCaptured(command, args, options, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
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
      else reject(new Error(`${command} exited with ${code}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}
