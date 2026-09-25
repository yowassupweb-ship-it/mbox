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
const agentName = config.MBOX_AGENT_NAME || "ChatGPT";
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
const codexCommand = resolveCodexCommand(config.CODEX_COMMAND || "codex");
const codexModel = config.CODEX_WATCH_MODEL || "";
const workdir = resolveWatchWorkdir(config.CODEX_WATCH_WORKDIR || root);
const contextLimit = Number(config.MBOX_WATCH_CONTEXT_LIMIT || 10);
const contextLineLimit = Number(config.MBOX_WATCH_CONTEXT_LINE_LIMIT || 420);
const codexEffort = config.CODEX_WATCH_EFFORT || "low";
const CODEX_EFFORT_CHOICES = new Set(["low", "medium", "high", "xhigh"]);
const pickModel = (value) => {
  const model = String(value || "").trim();
  if (!model || ["default", "auto", "codex default", "codex-cli-default"].includes(model.toLowerCase())) return "";
  // Модели Claude и Джарвиса (Gemini, Groq) Codex не знает — их выбор из чужого чата игнорируем.
  if (/^(claude|opus|sonnet|haiku|fable|gemini|openai\/|llama|meta-)/i.test(model)) return "";
  return /^[A-Za-z0-9._:/@-]{1,120}$/.test(model) ? model : "";
};
const pickEffort = (value) => (CODEX_EFFORT_CHOICES.has(String(value || "")) ? String(value) : "");
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
console.log(`${logPrefix} using Codex CLI: ${codexCommand}`);
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

async function ping(event, phase) {
  await mboxFetch("/api/mbox/agent/ping", {
    method: "POST",
    body: JSON.stringify({
      agent: agentName,
      event,
      kind: "local_watcher",
      client: "codex-inbox-watcher",
      scope: "agent_inbox,codex_exec",
      ...(phase === undefined ? {} : { phase }),
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
  // Адресовано другому (props.to или чат с конкретным агентом) — не отвечаем: 17.09 на «@Codex тут?» ответил Claude.
  if (String(to || "").trim()) return false;
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
  if (!(await claimInbox(item.id, { ...(item.props || {}), handled_by: agentName, handling_started_at: new Date().toISOString() }))) {
    console.log(`${logPrefix} #${item.id} already taken by another watcher; skipping`);
    return;
  }

  const run = await createRun(item);
  const startedAt = Date.now();
  try {
    const outcome = await runCodex(item);
    const answer = outcome.text;
    await createInboxItem({
      title: `ChatGPT ответил на #${item.id}: ${item.title}`,
      body: answer || "Готово.",
      item_type: "agent_response",
      priority: "normal",
      props: {
        in_reply_to: item.id,
        to: item.agent_name || "Человек",
        source: "codex-inbox-watcher",
        tools_used: outcome.toolsUsed,
        trace: outcome.trace,
        work: outcome.stats,
        model: outcome.model,
        effort: outcome.effort,
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
      title: `ChatGPT не смог ответить на #${item.id}`,
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
  const text = compactContextText(entry.body || entry.title || "");
  const clipped = clip(text, contextLineLimit);
  return `[${at}] ${actor}${to} (${entry.item_type} #${entry.id}${re}): ${clipped}`;
}

function clip(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : text;
}

function compactContextText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[inline image]")
    .replace(/[A-Za-z0-9+/]{180,}={0,2}/g, "[long encoded data]")
    .replace(/\s+/g, " ")
    .trim();
}

async function runCodex(item) {
  const outputFile = path.join(os.tmpdir(), `codex-mbox-${item.id}-${Date.now()}.txt`);
  const conversationContext = await recentConversationContext(item);
  const prompt = [
    "You were woken by MBOX agent_inbox.",
    `Your canonical agent name is ${agentName}.`,
    "Answer the inbox item below. If the user asks you to do code work, do it in the repo and summarize the result.",
    "Do not create an MBOX inbox response yourself; the watcher will post your final answer.",
    "Keep the final answer concise and directly useful.",
    "Spend tokens carefully: avoid broad repo scans and huge command outputs; prefer targeted rg with explicit paths and exclusions for build artifacts, binaries and generated assets.",
    "Use the recent MBOX console context to resolve short messages, pronouns, follow-ups, and @mentions.",
    // Навык ведёт сценарий через интерфейс MBOX: форма, результат, папка открываются вкладкой, файлы навыка правятся на лету.
    "MBOX UI: to show the owner a skill form, a finished file or folder, use the MBOX MCP tool open_tab (skill-file:<skill>/<file>, skill-blocks:<skill>, path:<absolute path>). To change a skill's files (SKILL.md, forms, templates) use edit_skill_file / write_skill_file — live immediately, no deploy.",
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

  const args = [
    "exec",
    "-C",
    workdir,
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--json",
    "--output-last-message",
    outputFile,
  ];
  const wantedModel = pickModel(item.props?.model) || pickModel(codexModel);
  const wantedEffort = pickEffort(item.props?.effort) || pickEffort(codexEffort);
  if (wantedModel) args.push("-m", wantedModel);
  if (wantedEffort) args.push("-c", `model_reasoning_effort="${wantedEffort}"`);
  args.push(prompt);

  const outcome = await spawnCodex(codexCommand, args, { cwd: workdir, env: { ...process.env, MBOX_AGENT_NAME: agentName } });
  const answer = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
  fs.rmSync(outputFile, { force: true });
  return { ...outcome, text: answer || outcome.text, model: wantedModel || "codex default", effort: wantedEffort || "" };
}

function spawnCodex(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const startedAt = Date.now();
    const state = { text: "", toolsUsed: [], trace: [], stats: null, failure: "" };
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
      for (const line of lines) handleCodexLine(line, state, startedAt, pushPhase);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) handleCodexLine(buffer, state, startedAt, pushPhase);
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

function handleCodexLine(line, state, startedAt, pushPhase) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !trimmed.startsWith("{")) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
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
      pushPhase("Работает");
    }
    return;
  }
  if ((event.type === "exec_command" || event.type === "apply_patch") && event.cmd) {
    addCodexTool(state, event.type, event, pushPhase);
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

function addCodexTool(state, name, item, pushPhase) {
  const tool = name === "exec_command" ? "shell_command" : name;
  const hint = toolHint(item);
  if (!state.toolsUsed.includes(tool)) state.toolsUsed.push(tool);
  state.trace.push(`${state.trace.length + 1}. ${tool}${hint ? `\n   ${hint}` : ""}`);
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

