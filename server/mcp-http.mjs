// MCP MBOX по HTTP: публичный адрес /mcp и ключ доступа, чтобы подключить MBOX к ChatGPT и другим клиентам,
// которые умеют только удалённые MCP-серверы (Streamable HTTP), а не запуск программы на компьютере.
//
// Инструменты те же, что у локального агента, — их даёт scripts/mbox-mcp-server.mjs. Поэтому шлюз не переписывает их,
// а на каждую сессию запускает этот сервер дочерним процессом (stdio) с ключом звонящего и гонит через него JSON-RPC.
// Все права проверяет обычный API MBOX по этому ключу: участник видит только свои проекты, как и везде.
//
// Ключ — личный токен аккаунта (Настройки → MCP; тот же механизм, что у /account/tokens), отзывается там же.
// Передаётся заголовком `Authorization: Bearer <ключ>` или частью адреса /mcp/<ключ> — для клиентов без своих заголовков.
//
//   POST   /mcp          — JSON-RPC (initialize открывает сессию, дальше заголовок Mcp-Session-Id)
//   DELETE /mcp          — закрыть сессию
//   GET    /mcp          — 405: потока от сервера нет (спецификация это разрешает)

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const MAX_BODY = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const IDLE_MS = 15 * 60_000;
const MAX_PER_USER = 3;
const MAX_TOTAL = 12;
const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 10 * 60_000;

/**
 * Что отдаём наружу по умолчанию: память, задачи, заметки, документы, таблицы, дизайн-системы, поиск. Без браузера и локальных папок
 * владельца, почты, Google, интеграций с чужими ключами, записи в хранилище, навыков, SEO и создания проектов: по публичному адресу с ключом
 * достаточно знаний и задач. Своё множество — MBOX_MCP_HTTP_TOOLS=имя,имя либо all.
 */
export const DEFAULT_HTTP_TOOLS = new Set([
  "describe_structure", "get_agent_context", "list_project_context", "get_next_task", "claim_task", "get_task", "get_task_trail", "create_task", "set_task_status",
  "finish_task", "create_inbox_item", "list_inbox", "get_inbox_item", "record_decision", "record_memory", "search", "search_memory", "get_memory", "get_memory_hierarchy",
  "list_memory_links", "list_companies", "list_recent_history", "get_project_access", "report_bug",
  "note_search", "note_read", "note_write", "note_edit", "doc_search", "doc_read", "doc_write", "doc_edit",
  "table_search", "table_read", "table_write_cells", "table_append_rows", "table_create",
  "design_system_list", "design_system_read", "design_system_write", "presentation_list", "presentation_read",
  "planner_read", "planner_task", "planner_event", "list_skills", "get_skill", "storage_list", "storage_read",
]);

export function httpToolFilter(setting = process.env.MBOX_MCP_HTTP_TOOLS) {
  const value = String(setting || "").trim();
  if (value === "all") return () => true;
  const names = value ? new Set(value.split(",").map((item) => item.trim()).filter(Boolean)) : DEFAULT_HTTP_TOOLS;
  return (name) => names.has(String(name));
}

export const MCP_PATH = /^\/mcp(?:\/([A-Za-z0-9_-]{20,200}))?\/?$/;

/** @type {Map<string, { id: string, userId: string, keyHash: string, child: import("node:child_process").ChildProcess, pending: Map<string | number, (message: unknown) => void>, lastUsed: number, buffer: string }>} */
const sessions = new Map();
const failures = new Map();

const hashOf = (value) => createHash("sha256").update(String(value)).digest("hex");

function clientIp(req) {
  return String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
}

function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((time) => now - time < FAIL_WINDOW_MS);
  failures.set(ip, list);
  return list.length >= FAIL_LIMIT;
}

function noteFailure(ip) {
  failures.set(ip, [...(failures.get(ip) || []), Date.now()]);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("too_large"), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function closeSession(session, reason = "closed") {
  if (!sessions.delete(session.id)) return;
  for (const resolve of session.pending.values()) resolve({ error: { code: -32000, message: `MBOX MCP session ${reason}` } });
  session.pending.clear();
  try { session.child.kill(); } catch { /* уже завершился */ }
}

// Сессия без вызовов 15 минут — закрываем: каждая держит процесс Node.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) if (now - session.lastUsed > IDLE_MS) closeSession(session, "idle");
}, 60_000);
sweeper.unref?.();

/** Остановить все сессии (при выключении сервера и в тестах). */
export function closeAllMcpSessions() {
  for (const session of [...sessions.values()]) closeSession(session, "shutdown");
}

export function mcpSessionCount() {
  return sessions.size;
}

function openSession({ userId, key, scriptPath, baseUrl, cwd, extraEnv }) {
  const id = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MBOX_URL: baseUrl,
      MBOX_TOKEN: key,
      MBOX_USERNAME: "",
      MBOX_PASSWORD: "",
      MBOX_AGENT_NAME: "ChatGPT",
      MBOX_AGENT_CLIENT: "mcp-http",
      MBOX_MCP_PUSH: "off",
      ...extraEnv,
    },
    windowsHide: true,
  });
  const session = { id, userId: String(userId), keyHash: hashOf(key), child, pending: new Map(), lastUsed: Date.now(), buffer: "" };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    session.buffer += chunk;
    let at;
    while ((at = session.buffer.indexOf("\n")) >= 0) {
      const line = session.buffer.slice(0, at).trim();
      session.buffer = session.buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      // Ответы возвращаем звонящему; запросы и уведомления сервера (журнал, прогресс) без потока доставить некуда.
      if (message && message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const resolve = session.pending.get(message.id);
        if (resolve) { session.pending.delete(message.id); resolve(message); }
      }
    }
  });
  child.stderr.on("data", () => { /* ключи и тексты запросов в журнал не пишем */ });
  child.on("exit", () => closeSession(session, "ended"));
  child.on("error", () => closeSession(session, "failed to start"));
  sessions.set(id, session);
  return session;
}

function exchange(session, message) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.pending.delete(message.id);
      resolve({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "MBOX MCP: ответ не пришёл за 120 с" } });
    }, REQUEST_TIMEOUT_MS);
    session.pending.set(message.id, (reply) => { clearTimeout(timer); resolve(reply); });
    try { session.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { clearTimeout(timer); session.pending.delete(message.id); resolve({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "MBOX MCP: сессия закрыта" } }); }
  });
}

const send = (res, status, body, headers = {}) => {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(text ? { "content-type": "application/json; charset=utf-8" } : {}), "cache-control": "no-store", ...headers });
  res.end(text);
};

/**
 * Вернуть true, если запрос был к /mcp и ответ отправлен.
 * authenticate(key) → { id } | null; baseUrl — куда дочерний MCP-сервер ходит за данными (сам этот процесс).
 */
export async function handleMcpHttp({ req, res, url, authenticate, scriptPath, baseUrl, cwd, extraEnv = {}, allowTool = httpToolFilter() }) {
  const match = url.pathname.match(MCP_PATH);
  if (!match) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, x-mbox-token", "access-control-expose-headers": "mcp-session-id" });
    res.end();
    return true;
  }
  const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "mcp-session-id" };

  const ip = clientIp(req);
  if (tooManyFailures(ip)) { send(res, 429, { error: "too_many_attempts" }, { ...cors, "retry-after": "600" }); return true; }
  const header = String(req.headers.authorization || "");
  const key = (header.startsWith("Bearer ") ? header.slice(7) : String(req.headers["x-mbox-token"] || "")).trim() || match[1] || "";
  const user = key ? await authenticate(key) : null;
  if (!user) {
    noteFailure(ip);
    send(res, 401, { error: "invalid_key", hint: "Создайте ключ: Настройки → MCP. Клиентам без своих заголовков (Claude.ai, приложения ChatGPT) вставляйте адрес вместе с ключом: /mcp/<ключ>. OAuth-входа у MBOX нет." }, { ...cors, "www-authenticate": 'Bearer realm="MBOX MCP"' });
    return true;
  }

  const sessionId = String(req.headers["mcp-session-id"] || "");
  const existing = sessionId ? sessions.get(sessionId) : null;
  if (existing && (existing.userId !== String(user.id) || existing.keyHash !== hashOf(key))) {
    send(res, 404, { error: "session_not_found" }, cors);
    return true;
  }

  if (req.method === "DELETE") {
    if (existing) closeSession(existing, "closed by client");
    send(res, existing ? 200 : 404, existing ? { ok: true } : { error: "session_not_found" }, cors);
    return true;
  }
  if (req.method === "GET") {
    send(res, 405, { error: "method_not_allowed", hint: "Потока от сервера нет: используйте POST" }, { ...cors, allow: "POST, DELETE, OPTIONS" });
    return true;
  }
  if (req.method !== "POST") { send(res, 405, { error: "method_not_allowed" }, { ...cors, allow: "POST, DELETE, OPTIONS" }); return true; }

  let body;
  try { body = JSON.parse(await readRaw(req)); } catch (error) {
    send(res, error?.status === 413 ? 413 : 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, cors);
    return true;
  }
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.length || messages.some((item) => !item || typeof item !== "object" || item.jsonrpc !== "2.0")) {
    send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, cors);
    return true;
  }

  let session = existing;
  if (!session) {
    if (!messages.some((item) => item.method === "initialize")) {
      send(res, sessionId ? 404 : 400, { jsonrpc: "2.0", id: null, error: { code: -32000, message: sessionId ? "Session not found: initialize again" : "Missing Mcp-Session-Id: send initialize first" } }, cors);
      return true;
    }
    const mine = [...sessions.values()].filter((item) => item.userId === String(user.id));
    if (mine.length >= MAX_PER_USER) closeSession(mine.sort((a, b) => a.lastUsed - b.lastUsed)[0], "replaced by a newer one");
    if (sessions.size >= MAX_TOTAL) { send(res, 503, { error: "too_many_sessions" }, { ...cors, "retry-after": "60" }); return true; }
    session = openSession({ userId: user.id, key, scriptPath, baseUrl, cwd, extraEnv });
  }
  session.lastUsed = Date.now();

  const requests = messages.filter((item) => item.method && item.id !== undefined);
  const others = messages.filter((item) => !(item.method && item.id !== undefined));
  for (const item of others) { try { session.child.stdin.write(`${JSON.stringify(item)}\n`); } catch { /* сессия закрылась */ } }
  if (!requests.length) { res.writeHead(202, { ...cors, "mcp-session-id": session.id }); res.end(); return true; }

  const replies = await Promise.all(requests.map(async (item) => {
    if (item.method === "tools/call" && !allowTool(item.params?.name)) {
      return { jsonrpc: "2.0", id: item.id, error: { code: -32602, message: `Инструмент ${String(item.params?.name)} недоступен по HTTP: он есть только у локального агента MBOX` } };
    }
    const reply = await exchange(session, item);
    if (item.method === "tools/list" && Array.isArray(reply?.result?.tools)) return { ...reply, result: { ...reply.result, tools: reply.result.tools.filter((tool) => allowTool(tool.name)) } };
    return reply;
  }));
  session.lastUsed = Date.now();
  send(res, 200, Array.isArray(body) ? replies : replies[0], { ...cors, "mcp-session-id": session.id });
  return true;
}
