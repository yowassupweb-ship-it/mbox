import "./server/env.mjs";
import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { UX_UI_SKILL_CATALOG } from "./server/ux-ui-skill-catalog.mjs";
import { SKILL_CATALOG } from "./server/skill-catalog.mjs";
import { ensureWorkspaceSchema, handleWorkspaceApi } from "./server/workspaces.mjs";
import { ensureNotesSchema, handleNotesApi, handleSharedNoteApi } from "./server/notes.mjs";
import { ensureAccountsSchema, handleAccountsApi } from "./server/accounts.mjs";
import { ensureStorageSchema, handleStorageApi, storagePutStream, storageSignedGet } from "./server/storage.mjs";
import { ensureSkillOverridesSchema, handleSkillPackagesApi } from "./server/skill-overrides.mjs";
import { handleEmailCheckerApi } from "./server/email-checker.mjs";
import { documentToDocx, docxFileName } from "./server/docx.mjs";
import { parseOpenRequest, sendOpenTab, tagSocketUser } from "./server/ui-open.mjs";
import {
  configureJarvis, JARVIS_NAME, jarvisPhase, setAgentPhase, getAgentPhase, activeJarvisRequests,
  bulkUpsertTourSheets, refreshDataSourceById, replyAsJarvis, searchTerms, type TourSheetItem,
} from "./server/jarvis.mjs";

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    process.env[trimmed.slice(0, index)] ||= trimmed.slice(index + 1);
  }
}

const INBOX_COLUMNS = "id::text, project_id::text, agent_name, item_type, title, body, status, priority, requires_human, props, pg_column_size(agent_inbox)::int AS memory_bytes, created_at::text, updated_at::text";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

const requestContext = new AsyncLocalStorage<{ actor: string }>();

// HTTP-заголовки — ASCII-only; клиенты шлют имя агента через encodeURIComponent, чтобы кириллица
// ("Архивариус") не валила fetch с "character ... greater than 255". decodeURIComponent на чистом
// ASCII — no-op, старые клиенты не ломаются.
function decodeAgentHeader(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function actorFromReq(req: IncomingMessage) {
  // Контекст резолвится один раз в middleware (см. resolveRequestActor) и покрывает и заголовок
  // доверенного агента, и вошедшего человека. Заголовок — фолбэк для мест до входа в контекст.
  const contextActor = requestContext.getStore()?.actor;
  if (contextActor) return contextActor;
  const header = req.headers["x-mbox-agent"] || req.headers["x-agent-name"];
  return header ? decodeAgentHeader(String(header)) : "Agent";
}

/**
 * Раньше любой запрос без заголовка x-mbox-agent (то есть действие человека через браузер)
 * не выставлял mbox.actor вовсе — dev писал такие правки в аудит как "system". Теперь для
 * мутирующих запросов без заголовка актёр берётся из вошедшей сессии (username).
 */
async function resolveRequestActor(req: IncomingMessage): Promise<string> {
  const header = req.headers["x-mbox-agent"] || req.headers["x-agent-name"];
  if (header) return decodeAgentHeader(String(header));
  try {
    const user = await currentUser(req);
    if (user?.username) return user.username;
  } catch {
    // без сессии — вернём пусто, вызывающая сторона решит фолбэк сама
  }
  return "";
}

function textPreview(value: unknown, limit = 240) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

function detailMode(url: URL, fallback = "full") {
  const detail = String(url.searchParams.get("detail") || fallback).toLowerCase();
  return detail === "full" ? "full" : "short";
}

function compactMemoryRow(memory: Record<string, any>, limit = 400) {
  const preview = textPreview(memory.content, limit);
  return {
    id: memory.id,
    project_id: memory.project_id || memory.metadata?.project_id || null,
    todo_id: memory.todo_id || memory.metadata?.todo_id || null,
    agent_run_id: memory.agent_run_id || memory.metadata?.agent_run_id || null,
    title: memory.title,
    content_preview: preview,
    content_bytes: Buffer.byteLength(String(memory.content || ""), "utf8"),
    content_truncated: String(memory.content || "").length > preview.length,
    entity_type: memory.entity_type,
    access_level: memory.access_level,
    tags: memory.tags,
    source_agent: memory.metadata?.source_agent || "",
    metadata: memory.metadata,
    score: typeof memory.score === "number" ? Number(memory.score.toFixed(6)) : 0,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  };
}

function memoryProject(memory: Record<string, any>) {
  const projectId = memory.project_id || memory.metadata?.project_id || null;
  return memory.project_name || memory.metadata?.project || projectId || "";
}

function compactRecallMemoryRow(memory: Record<string, any>, limit = 140) {
  const metadata = memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {};
  return {
    id: memory.id,
    title: memory.title,
    summary: textPreview(metadata.summary || memory.summary || memory.content, limit),
    score: typeof memory.score === "number" ? Number(memory.score.toFixed(6)) : 0,
    project: memoryProject(memory),
    project_id: memory.project_id || metadata.project_id || null,
    todo_id: memory.todo_id || metadata.todo_id || null,
    tags: memory.tags || [],
    source_agent: metadata.source_agent || "",
    updated_at: memory.updated_at,
  };
}

function broadcastRealtime(clients: Set<WebSocket>, type: string, payload: Record<string, unknown> = {}) {
  const message = JSON.stringify({ type, ...payload, at: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

type MemoryEmbeddingRow = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  updated_at: string;
  embedding_updated_at: string | null;
};

type TfidfVector = {
  id?: string;
  terms: Record<string, number>;
  norm: number;
};

type MemoryHierarchyNode = {
  name: string;
  path: string;
  count: number;
  memory_ids: unknown[];
  children: MemoryHierarchyNode[];
};

function tokenizeEmbeddingText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .match(/[a-z0-9а-яё]{2,}/giu) || [];
}

function memoryEmbeddingText(memory: MemoryEmbeddingRow) {
  return [
    memory.title,
    memory.content,
    Array.isArray(memory.tags) ? memory.tags.join(" ") : "",
    memory.metadata && typeof memory.metadata === "object" ? Object.values(memory.metadata).join(" ") : "",
  ].join(" ");
}

function tokenizeRecallText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]{2,}/gu) || [];
}

function expandRecallText(value: unknown) {
  const text = String(value || "");
  const synonyms: Record<string, string> = {
    "деплой": "deploy deployment vercel production",
    "прод": "prod production боевой",
    "боевой": "prod production live",
    "релиз": "release deploy",
  };
  const tokens = tokenizeRecallText(text);
  const expanded = tokens.flatMap((token) => [token, synonyms[token] || ""]);
  return `${text} ${expanded.join(" ")}`;
}

function vectorFromCounts(counts: Map<string, number>, documentFrequency: Map<string, number>, documentCount: number, id = ""): TfidfVector {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0) || 1;
  const terms: Record<string, number> = {};
  let normSquared = 0;
  for (const [token, hits] of counts.entries()) {
    const idf = Math.log((1 + documentCount) / (1 + (documentFrequency.get(token) || 0))) + 1;
    const weight = (hits / total) * idf;
    terms[token] = Number(weight.toFixed(6));
    normSquared += weight * weight;
  }
  return { id, terms, norm: Number(Math.sqrt(normSquared).toFixed(6)) };
}

function buildTfIdfIndex(documents: { id: string; text: string }[]) {
  const documentTerms = documents.map((doc) => {
    const counts = new Map<string, number>();
    for (const token of tokenizeEmbeddingText(doc.text)) counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  });
  const documentFrequency = new Map<string, number>();
  for (const counts of documentTerms) {
    for (const token of counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const count = Math.max(documents.length, 1);
  return documents.map((doc, index) => vectorFromCounts(documentTerms[index], documentFrequency, count, doc.id));
}

function vectorFromText(text: string, documentFrequency: Map<string, number>, documentCount: number) {
  const counts = new Map<string, number>();
  for (const token of tokenizeEmbeddingText(text)) counts.set(token, (counts.get(token) || 0) + 1);
  return vectorFromCounts(counts, documentFrequency, Math.max(documentCount, 1));
}

function cosineSimilarity(left: TfidfVector, right: TfidfVector) {
  if (!left.norm || !right.norm) return 0;
  const [small, large] = Object.keys(left.terms).length < Object.keys(right.terms).length
    ? [left.terms, right.terms]
    : [right.terms, left.terms];
  let dot = 0;
  for (const [token, weight] of Object.entries(small)) {
    if (large[token]) dot += weight * large[token];
  }
  return dot / (left.norm * right.norm);
}

function recallLexicalScore(queryText: string, memory: Record<string, any>) {
  const expandedQuery = expandRecallText(queryText);
  const queryTokens = [...new Set(tokenizeRecallText(expandedQuery))];
  if (!queryTokens.length) return { lexical: 0, title: 0, tags: 0, exact: 0 };
  const titleTokens = new Set(tokenizeRecallText(expandRecallText(memory.title)));
  const tagTokens = new Set(tokenizeRecallText(expandRecallText((memory.tags || []).join(" "))));
  const allTokens = new Set(tokenizeRecallText(expandRecallText(memoryEmbeddingText(memory as MemoryEmbeddingRow))));
  const matched = queryTokens.filter((token) => allTokens.has(token)).length;
  const titleMatched = queryTokens.filter((token) => titleTokens.has(token)).length;
  const tagMatched = queryTokens.filter((token) => tagTokens.has(token)).length;
  const haystack = expandRecallText(`${memory.title || ""}\n${memory.content || ""}`).toLowerCase();
  return {
    lexical: matched / queryTokens.length,
    title: titleMatched / queryTokens.length,
    tags: tagMatched / queryTokens.length,
    exact: haystack.includes(String(queryText || "").toLowerCase().trim()) ? 1 : 0,
  };
}

const agentStructure = {
  entity_model: {
    projects: "root work folders. Each project owns todos, git, deploy, stack and access scopes.",
    companies: "containers for related projects and participants. Link companies to projects through graph_edges with from_entity=company and to_entity=project.",
    project_entities: "project-owned entities: todos, git, relations, properties, philosophy, deploy, stack and access. UI tree nodes open dedicated editors for each entity.",
    project_relations: "direct graph edges between projects; edge_type can name a larger entity or relation context, e.g. company:Вокруг света.",
    project_props: "structured key/value facts about project owner, client, domain, environment, business context and philosophy.",
    philosophy: "project-level principles, taste, constraints and decision logic stored in project props, usually philosophy and principles keys.",
    todos: "note-like tasks attached to a project. The note field is the main working surface.",
    todo_props: "structured key/value task facts such as context, acceptance criteria, dependency, screen, owner and device.",
    memories: "database-backed knowledge records available for search and graph context. Agent-written memories must include source_agent plus project_id/todo_id in metadata when applicable.",
    folders: "hierarchical containers for projects, artifacts and memory areas.",
    protected_secrets: "credentials, visible to agents only after explicit approval.",
    audit_events: "append-only history of database changes.",
  },
  todo_statuses: {
    open: { label_ru: "Новая", ai_rule: "available but not the first priority" },
    next: { label_ru: "Следующая", ai_rule: "preferred next task" },
    doing: { label_ru: "В работе", ai_rule: "currently active" },
    blocked: { label_ru: "Заблокирована", ai_rule: "requires user input or external access" },
    review: { label_ru: "На проверке", ai_rule: "implementation needs human review" },
    done: { label_ru: "Готово", ai_rule: "completed; do not pick for work" },
    archived: { label_ru: "Архив", ai_rule: "historical; ignore unless asked" },
  },
  priorities: {
    low: { label_ru: "Низкий", weight: 4 },
    normal: { label_ru: "Обычный", weight: 3 },
    high: { label_ru: "Высокий", weight: 2 },
    urgent: { label_ru: "Срочно", weight: 1 },
  },
  agent_flow: [
    "Call /api/mbox/agent/structure first to understand schema.",
    "Call /api/mbox/projects and read props, relations, todos, git and deploy before changing code.",
    "Treat graph_edges as explicit truth about which projects belong to one larger entity.",
    "Call /api/mbox/agent/context?project=MBOX to get a compact snapshot.",
    "Call /api/mbox/agent/next-task?project=MBOX to pick work, then claim it before editing.",
    "Update todos through PATCH /api/mbox/todos/:id; keep notes concise and put structured facts into todo props.",
    "Create graph edges when the task reveals a project relation.",
    "Use /api/mbox/history to understand recent changes.",
    "Use approved secrets only through /api/mbox/agent/approved-secrets after user approval.",
  ],
  agent_instruction_ru: [
    "Перед работой агент читает /api/mbox/agent/structure, затем /api/mbox/projects и /api/mbox/history.",
    "Задачи MBOX живут в todos проекта MBOX. Новую задачу надо создавать там, а завершенную переводить в Готово.",
    "Связи проектов являются отдельной сущностью graph_edges. Если контекст связывает проекты, агент создает или учитывает связь.",
    "Короткие заметки остаются в note, структурные факты пишутся в props, чтобы их удобно читали другие агенты.",
    "Секреты доступны только через /api/mbox/agent/approved-secrets после явного одобрения человеком.",
  ],
  agent_contract: {
    before_work: ["describe_structure", "list_project_context", "get_next_task"],
    during_work: ["write important decisions to project props or memory", "create relations when context links projects", "keep todo note current"],
    after_work: [
      "prefer finish_task in MCP, or set task status plus record memory plus create agent run manually",
      "record a memory for significant work with source_agent, project_id, todo_id and touched_files in metadata",
      "server auto-creates an agent-work memory when a todo becomes done or an agent_run finishes; manual record_memory for the same todo_id/agent_run_id prevents duplicates",
      "use /api/mbox/todos/:id/trail to inspect the task -> decision -> change -> memory chain",
    ],
  },
};

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

function getCookie(req: IncomingMessage, name: string) {
  const cookie = req.headers.cookie ?? "";
  return cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

// Пул держит соединения тёплыми. Через SSH-туннель к прод-БД установка нового соединения стоит
// ~2с (несколько round-trip'ов), и 11 параллельных запросов на загрузке экрана топили самодельный
// форвардер — экран висел или отдавал нули. С пулом handshake один раз, дальше переиспользование.
let pgPool: Pool | null = null;
function getPool(): Pool {
  if (!pgPool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
    pgPool = new Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 30_000, keepAlive: true });
    pgPool.on("error", () => { /* соединение умерло в простое — пул заменит его сам */ });
  }
  return pgPool;
}

async function queryPostgres<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
  const actor = requestContext.getStore()?.actor;
  // Быстрый путь без лишнего round-trip'а — актёр в контексте есть только на мутирующих запросах
  // (см. resolveRequestActor), поэтому параллельные GET на загрузке экрана его не платят.
  if (!actor) return getPool().query<T>(sql, values);
  const client = await getPool().connect();
  try {
    await client.query("SELECT set_config('mbox.actor', $1, false)", [actor]);
    return await client.query<T>(sql, values);
  } finally {
    client.release();
  }
}

// Зеркало server/mbox-server.mjs — прямой ответ Джарвиса из POST /agent/inbox, без ожидания
// минутного тика systemd-таймера (scripts/mbox-archivist.mjs), который разбирает только память.
// Каталог инструментов — внешние проекты, дающие агентам новые действия. Живёт на сервере, а не
// во фронтенде, по двум причинам: страницу «Инструменты» видно из любого клиента одинаково, и
// desktop-оболочка берёт команды ИМЕННО отсюда, а не из того, что прислал интерфейс. Второе
// важно: Electron открывает удалённую страницу, и запускать произвольную строку из неё нельзя.
const TOOL_CATALOG = [
  {
    id: "obscura",
    name: "Obscura",
    kind: "headless browser",
    status: "локально подключается",
    path: "C:\\Users\\a.nikolyuk\\Desktop\\Mbox\\obscura",
    repo: "https://github.com/h4ckf0r0day/obscura",
    docs: "https://docs.obscura.sh",
    icon: "/assets/icons/tools/obscura.png",
    summary: "Лёгкий браузерный движок для агентной автоматизации: загрузка страниц, stealth, CDP, скриншоты, PDF и MCP без запуска Chromium.",
    capabilities: ["web extraction", "screenshots", "PDF export", "CDP", "Playwright/Puppeteer", "MCP browser"],
    commands: [
      { label: "Сборка с render", command: "cargo build --release -p obscura-cli --bins --features render", env: { CARGO_INCREMENTAL: "0", CARGO_BUILD_JOBS: "2" }, runnable: true },
      { label: "Сервер CDP", command: "target\\release\\obscura.exe serve --port 9222", runnable: true, long_running: true },
      { label: "MCP stdio", command: "target\\release\\obscura.exe mcp", runnable: false },
      { label: "MCP HTTP", command: "target\\release\\obscura.exe mcp --http --port 3000", runnable: true, long_running: true },
    ],
  },
  {
    id: "figma",
    name: "Figma MCP",
    kind: "design context",
    status: "нужна авторизация Figma",
    path: "C:\\Users\\a.nikolyuk\\Desktop\\Mbox",
    repo: "https://www.figma.com/mcp-catalog/",
    docs: "https://developers.figma.com/docs/figma-mcp-server/",
    icon: "/assets/icons/tools/figma.png",
    summary: "Официальный MCP Figma: читает дизайн-контекст, компоненты, переменные и Dev Mode данные; remote MCP требует авторизации, desktop MCP включается в Figma Desktop.",
    capabilities: ["design context", "components", "variables", "Dev Mode", "write to canvas"],
    commands: [
      { label: "Открыть Figma", command: "start \"\" \"figma://\"", runnable: true },
      { label: "Проверить desktop MCP", command: "powershell -NoProfile -Command \"try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3845/mcp -TimeoutSec 3).StatusCode } catch { $_.Exception.Message }\"", runnable: true },
      { label: "Codex remote MCP", command: "codex mcp add figma --url https://mcp.figma.com/mcp", runnable: true },
      { label: "Claude desktop MCP", command: "claude mcp add --transport http figma-desktop http://127.0.0.1:3845/mcp", runnable: true },
    ],
  },
  {
    id: "playwright-mcp",
    name: "Playwright MCP",
    kind: "browser automation",
    status: "установлен npm",
    path: "C:\\Users\\a.nikolyuk\\Desktop\\Mbox\\memora\\memora-graph",
    repo: "https://github.com/microsoft/playwright-mcp",
    docs: "https://playwright.dev/docs/getting-started-mcp",
    icon: "/assets/icons/tools/playwright.png",
    summary: "Официальный Playwright MCP для кликов, форм, снимков accessibility tree, скриншотов и browser QA. Настроен на системный Chrome, чтобы не ждать отдельный Chromium.",
    capabilities: ["clicks", "forms", "accessibility snapshots", "screenshots", "PDF", "local QA"],
    commands: [
      { label: "MCP HTTP", command: "npx @playwright/mcp --browser chrome --host 127.0.0.1 --port 9310 --caps vision,pdf", runnable: true, long_running: true },
      { label: "MCP stdio", command: "npx @playwright/mcp --browser chrome --caps vision,pdf", runnable: false },
      { label: "Установить Chromium", command: "npx playwright install chromium", env: { PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "120000" }, runnable: true },
    ],
  },
  {
    id: "chrome-devtools-mcp",
    name: "Chrome DevTools MCP",
    kind: "browser debugger",
    status: "установлен npm",
    path: "C:\\Users\\a.nikolyuk\\Desktop\\Mbox\\memora\\memora-graph",
    repo: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    docs: "https://developer.chrome.com/docs/devtools/agents/get-started",
    icon: "/assets/icons/tools/chrome-devtools.png",
    summary: "Официальный Chrome DevTools MCP для console/network/performance/DOM аудита и проверки живого Chrome из агента.",
    capabilities: ["console", "network", "performance", "DOM", "screenshots", "debugging"],
    commands: [
      { label: "MCP stable Chrome", command: "npx chrome-devtools-mcp --channel stable --viewport 1440x900", runnable: true, long_running: true },
      { label: "MCP slim", command: "npx chrome-devtools-mcp --channel stable --slim --viewport 1440x900", runnable: true, long_running: true },
      { label: "Chrome debug 9222", command: "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --remote-debugging-port=9222 --user-data-dir=\"%TEMP%\\mbox-chrome-debug\"", runnable: true, long_running: true },
      { label: "Подключиться к 9222", command: "npx chrome-devtools-mcp --browserUrl http://127.0.0.1:9222", runnable: true, long_running: true },
    ],
  },
  {
    id: "browserbase-stagehand",
    name: "Browserbase + Stagehand",
    kind: "cloud browser",
    status: "пакеты установлены, нужны ключи",
    path: "C:\\Users\\a.nikolyuk\\Desktop\\Mbox\\memora\\memora-graph",
    repo: "https://github.com/browserbase/mcp-server-browserbase",
    docs: "https://docs.browserbase.com/",
    icon: "/assets/icons/tools/browserbase.png",
    summary: "Облачный браузерный MCP на Browserbase со Stagehand для долгих web-сценариев, извлечения данных и сессий с прокси. Требует BROWSERBASE_API_KEY и BROWSERBASE_PROJECT_ID.",
    capabilities: ["cloud sessions", "Stagehand act/extract/observe", "proxies", "stealth", "long-running browsing"],
    commands: [
      { label: "MCP HTTP", command: "npx @browserbasehq/mcp --browserbaseApiKey %BROWSERBASE_API_KEY% --browserbaseProjectId %BROWSERBASE_PROJECT_ID% --host 127.0.0.1 --port 9320 --browserWidth 1440 --browserHeight 900", runnable: true, long_running: true },
      { label: "Stagehand check", command: "node -e \"import('@browserbasehq/stagehand').then(() => console.log('Stagehand OK'))\"", runnable: true },
    ],
  },
];

async function recordMemoryAction({ memoryId, actor = "agent", action, note = "", metadata = {} }: { memoryId?: unknown; actor?: string; action?: string; note?: string; metadata?: unknown }) {
  if (!memoryId || !action) return null;
  const result = await queryPostgres(
    `INSERT INTO memory_actions(memory_id, actor, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text, memory_id::text, actor, action, note, metadata, created_at::text`,
    [memoryId, actor, action, note, JSON.stringify(metadata && typeof metadata === "object" ? metadata : {})],
  );
  return result.rows[0] || null;
}

/** См. server/mbox-server.mjs — ранжированный поиск для инструмента search_memory Джарвиса. */
async function rankMemories(search: string, { minScore = 0.05, limit = 20 }: { minScore?: number; limit?: number } = {}): Promise<Record<string, any>[]> {
  const { documents } = await refreshMemoryEmbeddings();
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const token of new Set(tokenizeEmbeddingText(doc.text))) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const queryVector = vectorFromText(search, documentFrequency, documents.length);
  const result = await queryPostgres<Record<string, any>>(
    `SELECT m.id::text, m.project_id::text, p.name AS project_name, m.title, m.content, m.tags, m.metadata, m.updated_at::text, e.representation
     FROM memories m
     JOIN memory_embeddings e ON e.memory_id = m.id
     LEFT JOIN projects p ON p.id = m.project_id`,
  );
  return result.rows
    .map((memory): Record<string, any> => {
      const lexical = recallLexicalScore(search, memory);
      const vectorScore = cosineSimilarity(queryVector, (memory.representation || {}) as TfidfVector);
      const score = (vectorScore * 0.65) + (lexical.lexical * 0.25) + (lexical.title * 0.25) + (lexical.tags * 0.15) + (lexical.exact * 0.2);
      return { ...memory, score };
    })
    .filter((memory) => memory.score >= minScore)
    .sort((a, b) => b.score - a.score || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, limit)
    .map(({ representation, ...memory }) => memory);
}

async function refreshMemoryEmbeddings() {
  const memories = await queryPostgres<MemoryEmbeddingRow>(
    `SELECT m.id::text, m.title, m.content, m.tags, m.metadata, m.updated_at::text,
            e.updated_at::text AS embedding_updated_at
     FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     ORDER BY m.id`,
  );
  const documents = memories.rows.map((memory) => ({ id: memory.id, text: memoryEmbeddingText(memory), updated_at: memory.updated_at }));
  const vectors = buildTfIdfIndex(documents);
  // См. server/mbox-server.mjs — пишем только записи с отсутствующим/устаревшим эмбеддингом,
  // не все 1600+ при каждом вызове (эта функция вызывается и на чтение, из каждого поиска).
  const stale = memories.rows.filter((m) => !m.embedding_updated_at || new Date(m.updated_at) > new Date(m.embedding_updated_at));
  const staleIds = new Set(stale.map((m) => m.id));
  for (const vector of vectors) {
    if (!staleIds.has(String(vector.id))) continue;
    await queryPostgres(
      `INSERT INTO memory_embeddings(memory_id, representation, dimension, encoding_source, updated_at)
       VALUES ($1, $2, $3, 'tfidf-local-v1', now())
       ON CONFLICT (memory_id) DO UPDATE SET
         representation = EXCLUDED.representation,
         dimension = EXCLUDED.dimension,
         encoding_source = EXCLUDED.encoding_source,
         updated_at = now()`,
      [vector.id, JSON.stringify({ terms: vector.terms, norm: vector.norm }), Object.keys(vector.terms).length],
    );
  }
  return { documents, vectors };
}

async function relevantMemories(search: string, { projectId = "", todoId = "", limit = 5 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit || 5), 1), 5);
  const queryText = String(search || "").trim();
  if (!queryText) {
    const result = await queryPostgres(
      `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
              created_at::text, updated_at::text
       FROM memories
       WHERE ($1 = '' OR project_id::text = $1 OR metadata->>'project_id' = $1)
         AND ($2 = '' OR todo_id::text = $2 OR metadata->>'todo_id' = $2)
       ORDER BY updated_at DESC
       LIMIT $3`,
      [String(projectId || ""), String(todoId || ""), safeLimit],
    );
    return result.rows.map((memory) => compactMemoryRow(memory));
  }

  const { documents } = await refreshMemoryEmbeddings();
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const token of new Set(tokenizeEmbeddingText(doc.text))) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const queryVector = vectorFromText(queryText, documentFrequency, documents.length);
  const result = await queryPostgres<Record<string, any>>(
    `SELECT m.id::text, m.project_id::text, m.todo_id::text, m.agent_run_id::text, m.title, m.content, m.entity_type, m.access_level, m.tags, m.metadata,
            m.created_at::text, m.updated_at::text, e.representation
     FROM memories m
     JOIN memory_embeddings e ON e.memory_id = m.id`,
  );
  return result.rows
    .map((memory): Record<string, any> => {
      const projectMatch = projectId && (String(memory.project_id || "") === String(projectId) || String(memory.metadata?.project_id || "") === String(projectId));
      const todoMatch = todoId && (String(memory.todo_id || "") === String(todoId) || String(memory.metadata?.todo_id || "") === String(todoId));
      const score = cosineSimilarity(queryVector, memory.representation || { terms: {}, norm: 0 }) + (projectMatch ? 0.15 : 0) + (todoMatch ? 0.25 : 0);
      return { ...memory, score };
    })
    .filter((memory) => memory.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, safeLimit)
    .map((memory) => compactMemoryRow(memory));
}

async function autoRecordMemory({ projectId, todoId = null, agentRunId = null, sourceAgent, title, content, touchedFiles = [], reason }: {
  projectId: unknown;
  todoId?: unknown;
  agentRunId?: unknown;
  sourceAgent: unknown;
  title: string;
  content: unknown;
  touchedFiles?: unknown[];
  reason: string;
}) {
  if (!projectId || !String(content || "").trim()) return null;
  const existing = await queryPostgres(
    `SELECT id::text
     FROM memories
     WHERE ($1::bigint IS NULL OR todo_id = $1 OR metadata->>'todo_id' = $1::text)
       AND ($2::bigint IS NULL OR agent_run_id = $2 OR metadata->>'agent_run_id' = $2::text)
       AND (metadata->>'recorded_via' IN ('mbox MCP record_memory', 'auto') OR tags @> ARRAY['agent-work'])
     LIMIT 1`,
    [todoId, agentRunId],
  );
  if (existing.rows[0]) return { skipped: true, id: existing.rows[0].id };

  const metadata = {
    source_agent: String(sourceAgent || "Agent"),
    project_id: String(projectId),
    todo_id: todoId ? String(todoId) : null,
    agent_run_id: agentRunId ? String(agentRunId) : null,
    touched_files: Array.isArray(touchedFiles) ? touchedFiles : [],
    recorded_via: "auto",
    auto_reason: reason,
  };
  const result = await queryPostgres(
    `INSERT INTO memories(project_id, todo_id, agent_run_id, title, content, entity_type, access_level, tags, metadata)
     VALUES ($1, $2, $3, $4, $5, 'memory', 'agents', $6, $7)
     RETURNING id::text`,
    [projectId, todoId, agentRunId, textPreview(title, 160) || "Agent work result", textPreview(content, 2000), ["agent-work", "auto"], JSON.stringify(metadata)],
  );
  await refreshMemoryEmbeddings();
  const id = result.rows[0]?.id || null;
  await recordMemoryAction({ memoryId: id, actor: String(sourceAgent || "Agent"), action: "auto_create", note: reason, metadata });
  return { skipped: false, id };
}

async function closeStaleAgentRuns() {
  const result = await queryPostgres(
    `UPDATE agent_runs
     SET status = 'abandoned',
         finished_at = COALESCE(finished_at, heartbeat_at),
         props = COALESCE(props, '{}'::jsonb) || jsonb_build_object(
           'auto_closed', true,
           'auto_closed_reason', 'heartbeat_timeout',
           'auto_closed_after_minutes', 10,
           'auto_closed_at', now()
         )
     WHERE finished_at IS NULL
       AND status IN ('running', 'doing')
       AND heartbeat_at < now() - interval '10 minutes'
     RETURNING id::text`,
  );
  return result.rows;
}

function buildMemoryReview(memories: Record<string, any>[]) {
  const issues: Record<string, any>[] = [];
  const fingerprints = new Map<string, Record<string, any>>();
  for (const memory of memories) {
    const tags = Array.isArray(memory.tags) ? memory.tags : [];
    const metadata = memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {};
    const content = String(memory.content || "");
    const title = String(memory.title || "").trim();
    const fingerprint = createHash("sha1").update(normalizeMemoryText(`${title}\n${content}`)).digest("hex");
    const previous = fingerprints.get(fingerprint);
    if (previous) {
      issues.push(memoryReviewIssue(memory, "high", "duplicate", "Похоже на полный дубль другой записи памяти.", `Сравнить с memory #${previous.id}; одну запись объединить или архивировать.`, [previous.id]));
    } else {
      fingerprints.set(fingerprint, memory);
    }
    if (!title || !content.trim()) issues.push(memoryReviewIssue(memory, "high", "empty_or_incomplete", "У записи пустой title или content.", "Уточнить запись или удалить, если она техническая."));
    if (content.length > 4000) issues.push(memoryReviewIssue(memory, "normal", "oversized", "Запись слишком длинная для полезной памяти.", "Сжать до решения/факта/последствий; сырой лог вынести в artifact."));
    if (looksLikeRawLog(content)) issues.push(memoryReviewIssue(memory, "normal", "raw_log", "Запись похожа на сырой лог или дамп выполнения.", "Переписать как короткий итог: что изменилось, почему, какие файлы затронуты."));
    if ((tags.includes("agent-work") || metadata.recorded_via) && !(memory.project_id || metadata.project_id)) {
      issues.push(memoryReviewIssue(memory, "high", "missing_project_id", "Agent-work memory не привязана к project_id.", "Добавить project_id в колонку или metadata, иначе агент не найдёт память в контексте проекта."));
    }
    if ((tags.includes("agent-work") || metadata.recorded_via) && !metadata.source_agent) {
      issues.push(memoryReviewIssue(memory, "normal", "missing_source_agent", "Agent-work memory без metadata.source_agent.", "Добавить source_agent, чтобы было понятно, кто оставил факт."));
    }
    if (metadata.todo_id && !memory.todo_id) issues.push(memoryReviewIssue(memory, "low", "metadata_only_todo_link", "todo_id есть только в metadata, но не в колонке memories.todo_id.", "Продублировать связь в колонку для быстрых trail-запросов."));
    if (metadata.agent_run_id && !memory.agent_run_id) issues.push(memoryReviewIssue(memory, "low", "metadata_only_run_link", "agent_run_id есть только в metadata, но не в колонке memories.agent_run_id.", "Продублировать связь в колонку для быстрых trail-запросов."));
  }
  const order: Record<string, number> = { high: 1, normal: 2, low: 3 };
  issues.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9) || Number(a.memory_id) - Number(b.memory_id));
  return { checked: memories.length, issues: issues.length, queue: issues };
}

function normalizeMemoryText(value: unknown) {
  return String(value || "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function looksLikeRawLog(content: unknown) {
  const text = String(content || "");
  const lines = text.split(/\r?\n/);
  const jsonishLines = lines.filter((line) => /^\s*[{[]/.test(line)).length;
  return /Traceback|UnhandledPromiseRejection|^\s*at\s+\S+\s+\(|npm ERR!|SQLSTATE|ERROR:/m.test(text)
    || jsonishLines >= 5
    || (lines.length > 80 && /error|warn|debug|info/i.test(text));
}

function memoryReviewIssue(memory: Record<string, any>, severity: string, type: string, reason: string, suggestion: string, related_ids: string[] = []) {
  return { memory_id: memory.id, severity, type, title: memory.title, reason, suggestion, related_ids, updated_at: memory.updated_at };
}

function digestDocument({ title = "Document", content = "", maxFragments = 40, minChars = 80 }: { title?: unknown; content?: unknown; maxFragments?: unknown; minChars?: unknown } = {}) {
  const sourceTitle = String(title || "Document").trim() || "Document";
  const text = String(content || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { title: sourceTitle, fragments: [], stats: { characters: 0, lines: 0 } };

  const fragments: Record<string, any>[] = [];
  const lines = text.split("\n");
  const headingPath: string[] = [];
  let block: string[] = [];
  let blockKind = "paragraph";

  const flush = () => {
    const rawLines = block.map((line) => line.trim()).filter(Boolean);
    block = [];
    if (!rawLines.length) return;
    const normalized = normalizeDigestBlock(rawLines, blockKind);
    if (!normalized || normalized.length < Number(minChars || 0)) return;
    const path = headingPath.filter(Boolean);
    const fragmentTitle = path.length ? path.join(" / ") : sourceTitle;
    fragments.push({
      index: fragments.length + 1,
      kind: blockKind,
      title: fragmentTitle,
      path,
      content: normalized,
      tags: ["digest", `kind:${blockKind}`, ...path.slice(-2).map((item) => `section:${slugDigestToken(item)}`)],
      metadata: {
        source_title: sourceTitle,
        source_kind: "document_digest",
        digest_index: fragments.length + 1,
        digest_path: path,
      },
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = parseDigestHeading(trimmed);
    if (heading) {
      flush();
      headingPath.length = Math.max(heading.level - 1, 0);
      headingPath[heading.level - 1] = heading.text;
      blockKind = "paragraph";
      continue;
    }
    if (!trimmed) {
      flush();
      blockKind = "paragraph";
      continue;
    }
    const kind = digestLineKind(trimmed);
    if (block.length && kind !== blockKind) flush();
    blockKind = kind;
    block.push(trimmed);
  }
  flush();

  return {
    title: sourceTitle,
    fragments: fragments.slice(0, Math.max(1, Math.min(Number(maxFragments || 40), 100))),
    stats: { characters: text.length, lines: lines.length, generated_fragments: fragments.length },
  };
}

function parseDigestHeading(line: string) {
  const markdown = line.match(/^(#{1,6})\s+(.+)$/);
  if (markdown) return { level: markdown[1].length, text: markdown[2].trim() };
  const numbered = line.match(/^(\d+(?:\.\d+){0,4})[.)]\s+(.+)$/);
  if (numbered && line.length < 120) return { level: Math.min(numbered[1].split(".").length, 6), text: numbered[2].trim() };
  return null;
}

function digestLineKind(line: string) {
  if (line.includes("|") && line.split("|").filter((cell) => cell.trim()).length >= 2) return "table";
  if (line.includes("\t") && line.split("\t").filter((cell) => cell.trim()).length >= 2) return "table";
  if (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) return "list";
  return "paragraph";
}

function normalizeDigestBlock(lines: string[], kind: string) {
  if (kind === "table") return digestTable(lines);
  if (kind === "list") return lines.map((line) => line.replace(/^[-*+]\s+/, "- ").replace(/^\d+[.)]\s+/, "- ")).join("\n");
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function digestTable(lines: string[]) {
  const rows = lines
    .map((line) => line.split(line.includes("|") ? "|" : "\t").map((cell) => cell.trim()).filter(Boolean))
    .filter((row) => row.length >= 2 && !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
  if (!rows.length) return "";
  const header = rows[0];
  if (rows.length === 1) return header.join(" | ");
  return rows.slice(1).map((row, index) => {
    const pairs = row.map((cell, cellIndex) => `${header[cellIndex] || `col_${cellIndex + 1}`}: ${cell}`);
    return `Row ${index + 1}: ${pairs.join("; ")}`;
  }).join("\n");
}

function slugDigestToken(value: unknown) {
  return String(value || "").toLowerCase().normalize("NFKC").replace(/[^a-z0-9а-яё]+/giu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "section";
}

function buildMemoryHierarchy(memories: Record<string, any>[]) {
  const root: Record<string, any> = { name: "root", path: "", count: 0, memory_ids: [], children: {} };
  const paths = new Map<string, Record<string, any>>();
  for (const memory of memories) {
    const memoryPaths = hierarchyPathsForMemory(memory);
    for (const path of memoryPaths) {
      let node = root;
      root.count += 1;
      root.memory_ids.push(memory.id);
      const parts = path.split("/").filter(Boolean);
      const built: string[] = [];
      for (const part of parts) {
        built.push(part);
        node.children[part] ||= { name: part, path: built.join("/"), count: 0, memory_ids: [], children: {} };
        node = node.children[part];
        node.count += 1;
        node.memory_ids.push(memory.id);
        paths.set(node.path, { path: node.path, count: node.count, memory_ids: node.memory_ids });
      }
    }
  }
  return { tree: compactHierarchyNode(root), paths: [...paths.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)) };
}

function hierarchyPathsForMemory(memory: Record<string, any>) {
  const metadata = memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {};
  const tags = Array.isArray(memory.tags) ? memory.tags.map(String).filter(Boolean) : [];
  const paths: string[] = [];
  if (Array.isArray(metadata.digest_path) && metadata.digest_path.length) paths.push(metadata.digest_path.map(slugDigestToken).join("/"));
  for (const tag of tags) {
    if (tag.includes("/")) paths.push(tag.split("/").map(slugDigestToken).join("/"));
    else if (tag.includes(":")) {
      const [group, ...rest] = tag.split(":");
      paths.push([group, rest.join(":")].map(slugDigestToken).filter(Boolean).join("/"));
    } else {
      paths.push(slugDigestToken(tag));
    }
  }
  return [...new Set(paths.filter(Boolean))];
}

function compactHierarchyNode(node: Record<string, any>): MemoryHierarchyNode {
  return {
    name: node.name,
    path: node.path,
    count: node.count,
    memory_ids: [...new Set(node.memory_ids)].slice(0, 20),
    children: Object.values(node.children).map((child) => compactHierarchyNode(child as Record<string, any>)).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

function suggestMemoryHierarchy(input: Record<string, any>, memories: Array<MemoryEmbeddingRow & Record<string, any>>, limit = 8) {
  const queryText = memoryEmbeddingText({
    id: "",
    title: String(input.title || ""),
    content: String(input.content || ""),
    tags: Array.isArray(input.tags) ? input.tags : [],
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    updated_at: "",
    embedding_updated_at: null,
  });
  const documents = memories.map((memory) => ({ id: memory.id, text: memoryEmbeddingText(memory) }));
  const vectors = buildTfIdfIndex(documents);
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const token of new Set(tokenizeEmbeddingText(doc.text))) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const queryVector = vectorFromText(queryText, documentFrequency, documents.length);
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const similar = vectors
    .map((vector) => ({ memory: byId.get(vector.id || ""), score: cosineSimilarity(queryVector, vector) }))
    .filter((item) => item.memory && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(Number(limit || 8), 20)));
  const tagScores = new Map<string, number>();
  const pathScores = new Map<string, number>();
  for (const item of similar) {
    for (const tag of item.memory?.tags || []) tagScores.set(tag, (tagScores.get(tag) || 0) + item.score);
    for (const path of hierarchyPathsForMemory(item.memory || {})) pathScores.set(path, (pathScores.get(path) || 0) + item.score);
  }
  return {
    suggestions: {
      tags: [...tagScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, score]) => ({ tag, score: Number(score.toFixed(6)) })),
      paths: [...pathScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, score]) => ({ path, score: Number(score.toFixed(6)) })),
    },
    similar: similar.map(({ memory, score }) => ({ ...compactMemoryRow(memory || {}, 220), score: Number(score.toFixed(6)) })),
  };
}

async function currentUser(req: IncomingMessage) {
  const authorization = String(req.headers.authorization || "");
  const apiToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : String(req.headers["x-mbox-token"] || "").trim();
  if (apiToken) {
    const tokenHash = createHash("sha256").update(apiToken).digest("hex");
    const result = await queryPostgres<{ id: string; username: string; role: string; token_id: string; last_used_at: string | null }>(
      `SELECT u.id::text, u.username, u.role, t.id::text AS token_id, t.last_used_at::text
       FROM account_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1`,
      [tokenHash],
    );
    const found = result.rows[0];
    if (found && (!found.last_used_at || Date.now() - Date.parse(found.last_used_at) > 300000)) {
      await queryPostgres("UPDATE account_tokens SET last_used_at = now() WHERE id = $1", [found.token_id]);
    }
    return found ? { id: found.id, username: found.username, role: found.role } : null;
  }
  const token = getCookie(req, "mbox_session");
  if (!token) return null;
  const result = await queryPostgres<{ id: string; username: string; role: string }>(
    `SELECT u.id::text, u.username, u.role
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = encode(sha256($1::bytea), 'hex')
       AND s.expires_at > now()`,
    [token],
  );
  return result.rows[0] ?? null;
}

async function requireUser(req: IncomingMessage, res: ServerResponse) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  return user;
}

async function devProjectScope(user: { id: string; role: string }) {
  if (user.role === "owner") return { all: true, projectIds: [] as string[] };
  const result = await queryPostgres<{ project_id: string }>(
    "SELECT project_id::text FROM project_memberships WHERE user_id = $1 ORDER BY project_id",
    [user.id],
  );
  return { all: false, projectIds: result.rows.map((row) => row.project_id) };
}

function devHasProjectAccess(scope: { all: boolean; projectIds: string[] }, projectId: unknown) {
  return scope.all || (!projectId ? true : scope.projectIds.includes(String(projectId)));
}

function mboxDevApi() {
  return {
    name: "mbox-dev-api",
    configureServer(server: ViteDevServer) {
      loadLocalEnv();
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url || "/";
        if (!rawUrl.startsWith("/?") || !rawUrl.includes("tab=")) return next();
        const url = new URL(rawUrl, "http://localhost");
        const tab = url.searchParams.get("tab");
        if (!tab) return next();
        url.searchParams.set("tab", tab);
        const nextUrl = `${url.pathname}${url.search}`;
        if (nextUrl === rawUrl) return next();
        res.statusCode = 302;
        res.setHeader("location", nextUrl);
        res.end();
      });
      const realtimeClients = new Set<WebSocket>();
      configureJarvis({
        query: queryPostgres,
        broadcastRealtime: (type, payload) => broadcastRealtime(realtimeClients, type, payload),
        rankMemories,
        recordMemoryAction,
      });
      ensureWorkspaceSchema(queryPostgres).catch((error: Error) => console.error(`workspace schema: ${error.message}`));
      ensureNotesSchema(queryPostgres).catch((error: Error) => console.error(`notes schema: ${error.message}`));
      ensureAccountsSchema(queryPostgres).catch((error: Error) => console.error(`accounts schema: ${error.message}`));
      ensureStorageSchema(queryPostgres).catch((error: Error) => console.error(`storage schema: ${error.message}`));
      ensureSkillOverridesSchema(queryPostgres).catch((error: Error) => console.error(`skill overrides schema: ${error.message}`));
      const realtimeServer = new WebSocketServer({ noServer: true });

      realtimeServer.on("connection", (socket) => {
        realtimeClients.add(socket);
        socket.send(JSON.stringify({ type: "connected", at: new Date().toISOString() }));
        socket.on("close", () => realtimeClients.delete(socket));
      });

      server.httpServer?.on("upgrade", async (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/api/mbox/realtime") return;
        try {
          const user = await currentUser(req);
          if (!user) return socket.destroy();
          realtimeServer.handleUpgrade(req, socket, head, (ws) => {
            tagSocketUser(ws, user);
            realtimeServer.emit("connection", ws, req);
          });
        } catch {
          socket.destroy();
        }
      });

      const realtimeTimer = setInterval(() => broadcastRealtime(realtimeClients, "server_tick"), 5000);
      server.httpServer?.on("close", () => clearInterval(realtimeTimer));

      // publicDir: false (ниже в defineConfig) отключает автораздачу public/ — сделано специально,
      // чтобы Vite не путал его с outDir build (тоже public/, иначе предупреждение о конфликте).
      // Но это заодно ломает /fonts/*.ttf и любые другие статические файлы в dev: без обработчика
      // они улетают в SPA-фолбэк и отдаются как index.html (Content-Type: text/html), поэтому
      // @font-face с Press Start 2P тихо не грузился только в dev — на проде public/ раздаёт сервер.
      const PUBLIC_MIME: Record<string, string> = {
        ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
        ".ico": "image/x-icon", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain", ".json": "application/json",
      };
      server.middlewares.use((req, res, next) => {
        // req.url приходит percent-encoded (Node его не декодирует сам) — иконки с кириллицей в
        // имени (память.png и т.п.) никогда не совпадали с реальным файлом на диске и тихо
        // проваливались в next() -> SPA-фолбэк, который отдавал index.html с 200 OK вместо картинки.
        const pathname = decodeURIComponent((req.url || "").split("?")[0]);
        // /assets/ обычно зарезервирован под хешированный прод-бандл (index-*.js/css), которого в
        // dev не существует — но /assets/icons/ это настоящие статические файлы (иконки, аватарки),
        // не бандл, их эта раздача должна пропускать наравне с остальным public/.
        if (req.method !== "GET" || (pathname.startsWith("/assets/") && !pathname.startsWith("/assets/icons/")) || pathname === "/" || pathname === "/index.html") return next();
        const ext = path.extname(pathname);
        if (!ext || !(ext in PUBLIC_MIME)) return next();
        const filePath = path.join(process.cwd(), "public", pathname);
        if (!filePath.startsWith(path.join(process.cwd(), "public")) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next();
        res.setHeader("content-type", PUBLIC_MIME[ext]);
        // Иконки менялись несколько раз под одним и тем же путём во время итерации — без этого
        // браузер держал старую (сломанную) версию в кеше и путал "уже почини" с "ещё не почини".
        res.setHeader("cache-control", "no-cache");
        fs.createReadStream(filePath).pipe(res);
      });

      server.middlewares.use(async (req, res, next) => {
        // Зеркало прод-сервера: заметка по ссылке отвечает без входа (см. server/notes.mjs).
        if (req.url?.startsWith("/api/share/")) {
          const shareUrl = new URL(req.url, "http://localhost");
          const secretKey = process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";
          try {
            const handled = await handleSharedNoteApi({
              req, res, url: shareUrl, query: queryPostgres, readBody, sendJson,
              storage: {
                signedGet: (key) => storageSignedGet(queryPostgres, secretKey, key),
                putStream: (key, stream, length, type) => storagePutStream(queryPostgres, secretKey, key, stream, length, type),
              },
              broadcast: (payload) => broadcastRealtime(realtimeClients, "entity_changed", { ...payload, actor: "по ссылке" }),
            });
            if (!handled) sendJson(res, 404, { error: "not_found" });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (!req.url?.startsWith("/api/mbox/")) return next();
        const url = new URL(req.url, "http://localhost");
        const q = url.searchParams.get("q")?.trim() ?? "";
        // Актёр резолвится (и uses GUC mbox.actor через queryPostgres) только для мутирующих
        // запросов — на GET это лишний round-trip через SSH-туннель на каждый из 11 параллельных
        // запросов загрузки экрана, тот самый баг с зависанием, который уже однажды чинили.
        const actor = req.method && req.method !== "GET" ? await resolveRequestActor(req) : "";
        return requestContext.run({ actor }, async () => {

        try {
          if (url.pathname === "/api/mbox/auth/login" && req.method === "POST") {
            const body = await readBody<{ username: string; password: string }>(req);
            const user = await queryPostgres<{ id: string; username: string; role: string }>(
              `SELECT id::text, username, role
               FROM users
               WHERE username = $1 AND password_hash = crypt($2, password_hash)`,
              [body.username, body.password],
            );
            if (!user.rows[0]) return sendJson(res, 401, { error: "invalid_credentials" });
            const token = randomBytes(32).toString("hex");
            await queryPostgres(
              "INSERT INTO auth_sessions(user_id, token_hash, expires_at) VALUES ($1, encode(sha256($2::bytea), 'hex'), now() + interval '30 days')",
              [user.rows[0].id, token],
            );
            res.setHeader("set-cookie", `mbox_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
            return sendJson(res, 200, { user: user.rows[0] });
          }

          if (url.pathname === "/api/mbox/auth/logout" && req.method === "POST") {
            const token = getCookie(req, "mbox_session");
            if (token) await queryPostgres("DELETE FROM auth_sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')", [token]);
            res.setHeader("set-cookie", "mbox_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/auth/me") {
            return sendJson(res, 200, { user: await currentUser(req) });
          }

          const sessionUser = await requireUser(req, res);
          if (!sessionUser) return;
          const devScope = await devProjectScope(sessionUser);

          if (await handleAccountsApi({ req, res, url, query: queryPostgres, readBody, sendJson, user: sessionUser })) return;

          if (await handleWorkspaceApi({
            req, res, url, query: queryPostgres, readBody, sendJson,
            actor: actor || await resolveRequestActor(req),
            allowed: sessionUser.role === "owner",
            broadcast: (type, payload) => broadcastRealtime(realtimeClients, type, payload),
          })) return;
          const ownerOnly = sessionUser.role === "owner";
          const devActor = actor || await resolveRequestActor(req);
          if (await handleNotesApi({ req, res, url, query: queryPostgres, readBody, sendJson, actor: devActor, allowed: ownerOnly })) return;
          if (await handleStorageApi({ req, res, url, query: queryPostgres, readBody, sendJson, allowed: ownerOnly, secretKey: process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key" })) return;
          if (await handleEmailCheckerApi({ req, res, url, readBody, sendJson })) return;

          if (url.pathname === "/api/mbox/agent/structure") {
            return sendJson(res, 200, { structure: agentStructure });
          }

          if (url.pathname === "/api/mbox/agents") {
            await closeStaleAgentRuns();
            const result = await queryPostgres<{
              name: string;
              kind: string;
              client: string;
              scope: string;
              sessions: number;
              events: number;
              runs: number;
              live_runs: number;
              online: boolean | null;
              last_seen: string | null;
              first_seen: string | null;
            }>(
              `WITH presence AS (
                 SELECT agent_name AS name, kind, client, scope, sessions, first_seen, last_seen
                 FROM agent_presence
               ),
               audited AS (
                 SELECT actor AS name, count(*)::int AS events, max(created_at) AS last_seen
                 FROM audit_events
                 WHERE actor <> 'system' AND created_at > now() - interval '30 days'
                 GROUP BY actor
               ),
               ran AS (
                 SELECT agent_name AS name,
                        count(*)::int AS runs,
                        count(*) FILTER (WHERE finished_at IS NULL AND heartbeat_at > now() - interval '5 minutes')::int AS live_runs,
                        max(GREATEST(heartbeat_at, started_at)) AS last_seen
                 FROM agent_runs
                 GROUP BY agent_name
               ),
               names AS (
                 SELECT name FROM presence
               )
               SELECT n.name,
                      COALESCE(p.kind, 'ai_agent') AS kind,
                      COALESCE(p.client, '') AS client,
                      COALESCE(p.scope, '') AS scope,
                      COALESCE(p.sessions, 0) AS sessions,
                      COALESCE(a.events, 0) AS events,
                      COALESCE(r.runs, 0) AS runs,
                      COALESCE(r.live_runs, 0) AS live_runs,
                      (p.last_seen > now() - interval '2 minutes') AS online,
                      GREATEST(p.last_seen, a.last_seen, r.last_seen)::text AS last_seen,
                      COALESCE(p.first_seen, a.last_seen, r.last_seen)::text AS first_seen
               FROM names n
               LEFT JOIN presence p ON p.name = n.name
               LEFT JOIN audited a ON a.name = n.name
               LEFT JOIN ran r ON r.name = n.name
               ORDER BY GREATEST(p.last_seen, a.last_seen, r.last_seen) DESC NULLS LAST`,
            );

            const now = Date.now();
            const agents = result.rows.map((row) => {
              const seenAgo = row.last_seen ? now - new Date(row.last_seen).getTime() : Infinity;
              const online = Boolean(row.online) || row.live_runs > 0;
              return {
                id: row.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/(^-|-$)/g, "") || row.name,
                name: row.name,
                kind: row.kind,
                status: online ? "active" : seenAgo < 24 * 3600 * 1000 ? "idle" : "offline",
                scope: row.scope || "projects,todos,history,approved_secrets",
                client: row.client,
                active_sessions: row.sessions,
                live_connections: online ? 1 : 0,
                events: row.events,
                runs: row.runs,
                live_runs: row.live_runs,
                phase: getAgentPhase(row.name),
                first_seen: row.first_seen,
                last_seen: row.last_seen,
              };
            });

            return sendJson(res, 200, { agents, ui_clients: realtimeClients.size });
          }

          if (url.pathname === "/api/mbox/agent/ping" && req.method === "POST") {
            const body = await readBody<{ agent?: string; kind?: string; client?: string; scope?: string; event?: string; phase?: string }>(req);
            const name = String(body.agent || req.headers["x-mbox-agent"] || "Agent").trim() || "Agent";
            const started = body.event === "session_start";
            const result = await queryPostgres<{ agent_name: string; kind: string; client: string; scope: string; sessions: number; last_seen: string }>(
              `INSERT INTO agent_presence(agent_name, kind, client, scope, sessions)
               VALUES ($1, COALESCE(NULLIF($2, ''), 'ai_agent'), $3, $4, 1)
               ON CONFLICT (agent_name) DO UPDATE
                 SET last_seen = now(),
                     kind = COALESCE(NULLIF(EXCLUDED.kind, ''), agent_presence.kind),
                     client = COALESCE(NULLIF(EXCLUDED.client, ''), agent_presence.client),
                     scope = COALESCE(NULLIF(EXCLUDED.scope, ''), agent_presence.scope),
                     sessions = agent_presence.sessions + $5
               RETURNING agent_name, kind, client, scope, sessions, last_seen::text`,
              [name, String(body.kind || ""), String(body.client || ""), String(body.scope || ""), started ? 1 : 0],
            );
            if (started) broadcastRealtime(realtimeClients, "agent_presence", { agent: name, event: "session_start" });
            if (typeof body.phase === "string") {
              setAgentPhase(name, body.phase.trim());
              broadcastRealtime(realtimeClients, "agent_presence", { agent: name, event: "phase" });
            }
            return sendJson(res, 200, { presence: result.rows[0] });
          }

          // Каталог инструментов — зеркало server/mbox-server.mjs, см. пояснение там же.
          if (url.pathname === "/api/mbox/tools" && req.method === "GET") {
            return sendJson(res, 200, { tools: TOOL_CATALOG });
          }

          // Агент открывает вкладку в интерфейсе владельца — общий модуль server/ui-open.mjs, как у прода.
          if (url.pathname === "/api/mbox/ui/open" && req.method === "POST") {
            const user = await currentUser(req);
            if (!user) return sendJson(res, 401, { error: "unauthorized" });
            const parsed = parseOpenRequest(await readBody(req), actorFromReq(req));
            if (!parsed.event) return sendJson(res, 400, { error: parsed.error });
            return sendJson(res, 200, { delivered: sendOpenTab(realtimeClients, user.id, parsed.event), event: parsed.event });
          }

          // Пакеты навыков с правками агентов — общий модуль server/skill-overrides.mjs, как у прода.
          if (await handleSkillPackagesApi({
            req, res, url, query: queryPostgres, skillsRoot: path.resolve("skills"), actor: actorFromReq(req), sendJson, readBody,
            onChange: (change: Record<string, unknown>) => broadcastRealtime(realtimeClients, "skill_file_changed", change),
          })) return;

          // Каталог навыков — общий модуль server/skill-catalog.mjs, тот же, что у прода.
          if (url.pathname === "/api/mbox/agent/skills" && req.method === "GET") {
            const serviceModes: Record<string, string> = {
              reply: "Ответ в чате",
              cron: "Фоновый разбор по расписанию",
              "history-compression": "Сжатие истории диалога",
            };
            const usage = await queryPostgres<{ purpose: string; calls: number; tokens: string; calls_24h: number; last_used_at: string | null; last_model: string | null }>(
              `SELECT purpose,
                      count(*)::int AS calls,
                      COALESCE(sum(total_tokens), 0)::bigint AS tokens,
                      COALESCE(count(*) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::int AS calls_24h,
                      max(created_at)::text AS last_used_at,
                      (array_agg(model ORDER BY created_at DESC))[1] AS last_model
               FROM groq_usage GROUP BY purpose`,
            );
            const byPurpose = new Map(usage.rows.map((row) => [row.purpose, row]));
            const withUsage = (id: string) => {
              const row = byPurpose.get(id);
              return {
                calls: row?.calls || 0,
                calls_24h: row?.calls_24h || 0,
                tokens: Number(row?.tokens || 0),
                last_used_at: row?.last_used_at || null,
                last_model: row?.last_model || null,
              };
            };
            const catalog = [...SKILL_CATALOG, ...UX_UI_SKILL_CATALOG];
            const skills = catalog.map((skill) => ({ ...skill, ...withUsage(skill.id) }));
            const modes = Object.entries(serviceModes).map(([id, name]) => ({ id, name, ...withUsage(id) }));
            const unknown = usage.rows
              .filter((row) => row.purpose.startsWith("skill-") && !catalog.some((skill) => skill.id === row.purpose))
              .map((row) => ({ id: row.purpose, name: row.purpose, owner: "?", trigger: "", summary: "Навык есть в логе расхода, но не описан в каталоге сервера.", input: "", output: "", ...withUsage(row.purpose) }));
            return sendJson(res, 200, { skills: [...skills, ...unknown], modes });
          }

          if (url.pathname === "/api/mbox/agent/groq-usage" && req.method === "GET") {
            const result = await queryPostgres<{ total_tokens: string; tokens_24h: string; tokens_today: string; calls_total: number; calls_24h: number; last_call_at: string | null }>(
              `SELECT
                 (SELECT COALESCE(sum(total_tokens), 0) FROM groq_usage)::bigint AS total_tokens,
                 (SELECT COALESCE(sum(total_tokens), 0) FROM groq_usage WHERE created_at > now() - interval '24 hours')::bigint AS tokens_24h,
                 (SELECT COALESCE(sum(total_tokens), 0) FROM groq_usage WHERE created_at > date_trunc('day', now()))::bigint AS tokens_today,
                 (SELECT count(*) FROM groq_usage)::int AS calls_total,
                 (SELECT count(*) FROM groq_usage WHERE created_at > now() - interval '24 hours')::int AS calls_24h,
                 (SELECT max(created_at)::text FROM groq_usage) AS last_call_at`,
            );
            const byModel = await queryPostgres<{ model: string; total_tokens: string; tokens_24h: string; tokens_today: string; calls_total: number }>(
              `SELECT model,
                      COALESCE(sum(total_tokens), 0)::bigint AS total_tokens,
                      COALESCE(sum(total_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::bigint AS tokens_24h,
                      COALESCE(sum(total_tokens) FILTER (WHERE created_at > date_trunc('day', now())), 0)::bigint AS tokens_today,
                      count(*)::int AS calls_total
               FROM groq_usage GROUP BY model ORDER BY sum(total_tokens) DESC`,
            );
            return sendJson(res, 200, { ...result.rows[0], by_model: byModel.rows });
          }

          if (url.pathname === "/api/mbox/agent/groq-usage" && req.method === "POST") {
            const body = await readBody<{ purpose?: string; model?: string; prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }>(req);
            await queryPostgres(
              "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
              [String(body.purpose || "reply"), String(body.model || ""), Number(body.prompt_tokens) || 0, Number(body.completion_tokens) || 0, Number(body.total_tokens) || 0],
            );
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/agent/jarvis-errors" && req.method === "GET") {
            const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
            const inboxParam = url.searchParams.get("inbox_id") || "";
            const inboxId = /^\d+$/.test(inboxParam) ? inboxParam : "";
            const source = url.searchParams.get("source")?.trim() || "";
            const result = await queryPostgres(
              `SELECT id::text, source, tool_name, inbox_id::text, project_id::text, message, created_at::text
               FROM jarvis_errors
               WHERE (NULLIF($1, '') IS NULL OR inbox_id = NULLIF($1, '')::bigint) AND ($2 = '' OR source = $2)
               ORDER BY created_at DESC LIMIT $3`,
              [inboxId, source, limit],
            );
            return sendJson(res, 200, { errors: result.rows });
          }

          if (url.pathname === "/api/mbox/agent/jarvis-errors" && req.method === "POST") {
            const body = await readBody<{ source?: string; tool_name?: string; inbox_id?: string | number; project_id?: string | number; message?: string }>(req);
            await queryPostgres(
              "INSERT INTO jarvis_errors(source, tool_name, inbox_id, project_id, message) VALUES ($1, $2, $3, $4, $5)",
              [String(body.source || "reply"), String(body.tool_name || ""), body.inbox_id || null, body.project_id || null, String(body.message || "").slice(0, 2000)],
            );
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/status") {
            const result = await queryPostgres<{ now: string; database: string; server_addr: string | null }>(
              "SELECT now()::text, current_database() AS database, inet_server_addr()::text AS server_addr",
            );
            return sendJson(res, 200, { ok: true, postgres: result.rows[0] });
          }

          if (url.pathname === "/api/mbox/memory-links") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, any>>(req);
              const result = await queryPostgres(
                `INSERT INTO memory_links(from_memory_id, to_memory_id, link_type, title, description, confidence, metadata)
                 VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'related'), $4, $5, $6, $7)
                 ON CONFLICT (from_memory_id, to_memory_id, link_type) DO UPDATE SET
                   title = EXCLUDED.title,
                   description = EXCLUDED.description,
                   confidence = EXCLUDED.confidence,
                   metadata = EXCLUDED.metadata
                 RETURNING id::text, from_memory_id::text, to_memory_id::text, link_type, title, description, confidence, metadata, created_at::text`,
                [
                  body.from_memory_id,
                  body.to_memory_id,
                  String(body.link_type || ""),
                  String(body.title || "").trim(),
                  String(body.description || "").trim(),
                  Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : 1,
                  JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
                ],
              );
              await recordMemoryAction({ memoryId: body.from_memory_id, actor: String(actorFromReq(req)), action: "link_create", note: `linked to memory ${body.to_memory_id}`, metadata: result.rows[0] || {} });
              await recordMemoryAction({ memoryId: body.to_memory_id, actor: String(actorFromReq(req)), action: "link_create", note: `linked from memory ${body.from_memory_id}`, metadata: result.rows[0] || {} });
              return sendJson(res, 201, { link: result.rows[0] });
            }
            const memoryId = url.searchParams.get("memory_id") || "";
            const result = await queryPostgres(
              `SELECT l.id::text, l.from_memory_id::text, fm.title AS from_title, l.to_memory_id::text, tm.title AS to_title,
                      l.link_type, l.title, l.description, l.confidence, l.metadata, l.created_at::text
               FROM memory_links l
               JOIN memories fm ON fm.id = l.from_memory_id
               JOIN memories tm ON tm.id = l.to_memory_id
               WHERE $1 = '' OR l.from_memory_id::text = $1 OR l.to_memory_id::text = $1
               ORDER BY l.created_at DESC
               LIMIT 200`,
              [memoryId],
            );
            return sendJson(res, 200, { links: result.rows });
          }

          const memoryLinkMatch = url.pathname.match(/^\/api\/mbox\/memory-links\/(\d+)$/);
          if (memoryLinkMatch && req.method === "DELETE") {
            const link = await queryPostgres<Record<string, any>>("DELETE FROM memory_links WHERE id = $1 RETURNING id::text, from_memory_id::text, to_memory_id::text, link_type", [memoryLinkMatch[1]]);
            if (link.rows[0]) {
              await recordMemoryAction({ memoryId: link.rows[0].from_memory_id, actor: String(actorFromReq(req)), action: "link_delete", note: `unlinked memory ${link.rows[0].to_memory_id}`, metadata: link.rows[0] });
              await recordMemoryAction({ memoryId: link.rows[0].to_memory_id, actor: String(actorFromReq(req)), action: "link_delete", note: `unlinked memory ${link.rows[0].from_memory_id}`, metadata: link.rows[0] });
            }
            return sendJson(res, link.rows[0] ? 200 : 404, link.rows[0] ? { ok: true, link: link.rows[0] } : { error: "not_found" });
          }

          if (url.pathname === "/api/mbox/memories") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
              if (!devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
              const result = await queryPostgres(
                `INSERT INTO memories(project_id, todo_id, agent_run_id, title, content, entity_type, access_level, tags, metadata)
                 VALUES ($1, $2, $3, $4, $5, COALESCE(NULLIF($6, ''), 'memory'), COALESCE(NULLIF($7, ''), 'private'), $8, $9)
                 RETURNING id::text`,
                [body.project_id || null, body.todo_id || null, body.agent_run_id || null, String(body.title ?? "").trim(), String(body.content ?? ""), String(body.entity_type ?? ""), String(body.access_level ?? ""), Array.isArray(body.tags) ? body.tags : [], JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {})],
              );
              await recordMemoryAction({ memoryId: result.rows[0]?.id, actor: String(actorFromReq(req)), action: "create", note: "memory created via API", metadata: { title: String(body.title ?? "").trim() } });
              await refreshMemoryEmbeddings();
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
              return sendJson(res, 201, { memory: result.rows[0] });
            }
            const sortOldest = url.searchParams.get("sort") === "oldest";
            // См. server/mbox-server.mjs — поиск по словам с отрезанными окончаниями вместо целой подстроки.
            const memoryTerms = q ? (searchTerms(q).length ? searchTerms(q) : [q.toLowerCase()]) : [];
            const memoryHaystack = "(title || ' ' || coalesce(content, '') || ' ' || array_to_string(tags, ' '))";
            const selectMemories = (mode: string) => queryPostgres(
              `SELECT id::text, folder_id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
                      pg_column_size(memories)::int AS memory_bytes,
                      created_at::text, updated_at::text,
                      count(*) OVER()::int AS total_count,
                      sum(pg_column_size(memories)) OVER()::bigint AS total_bytes
               FROM memories
               ${mode
                 ? `WHERE ($3::boolean OR project_id = ANY($4::bigint[])) AND (SELECT ${mode}(${memoryHaystack} ILIKE '%' || term || '%') FROM unnest($1::text[]) AS term)`
                 : "WHERE ($1::boolean OR project_id = ANY($2::bigint[]))"}
               ORDER BY ${mode
            ? `(${memoryHaystack} ILIKE '%' || $2 || '%') DESC,
                  (SELECT count(*) FROM unnest($1::text[]) AS term WHERE title ILIKE '%' || term || '%') DESC,
                  (SELECT count(*) FROM unnest($1::text[]) AS term WHERE ${memoryHaystack} ILIKE '%' || term || '%') DESC,
                  updated_at DESC`
            : `updated_at ${sortOldest ? "ASC" : "DESC"}`}
               LIMIT 300`,
              mode ? [memoryTerms, q, devScope.all, devScope.projectIds] : [devScope.all, devScope.projectIds],
            );
            let result = await selectMemories(memoryTerms.length ? "bool_and" : "");
            if (!result.rows.length && memoryTerms.length > 1) result = await selectMemories("bool_or");
            const total = (result.rows[0] as { total_count?: number } | undefined)?.total_count ?? result.rows.length;
            const totalBytes = Number((result.rows[0] as { total_bytes?: number } | undefined)?.total_bytes ?? 0);
            return sendJson(res, 200, { memories: result.rows.map(({ total_count, total_bytes, ...row }: any) => row), total, total_bytes: totalBytes });
          }

          if (url.pathname === "/api/mbox/memories/search") {
            const search = url.searchParams.get("q")?.trim() ?? "";
            const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
            const detail = detailMode(url, "short");
            const minScore = Math.max(0, Number(url.searchParams.get("min_score") || (search ? 0.05 : 0)));
            const project = url.searchParams.get("project")?.trim() ?? "";
            const projectId = url.searchParams.get("project_id")?.trim() ?? "";
            const tags = (url.searchParams.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean);
            const recencyDays = Number(url.searchParams.get("recency_days") || 0);
            if (!search) {
              const recent = await queryPostgres(
                `SELECT m.id::text, m.project_id::text, p.name AS project_name, m.todo_id::text, m.agent_run_id::text, m.title, m.content, m.entity_type, m.access_level, m.tags, m.metadata,
                        pg_column_size(m)::int AS memory_bytes,
                        m.created_at::text, m.updated_at::text,
                        e.dimension, e.encoding_source, e.updated_at::text AS embedding_updated_at
                 FROM memories m
                 LEFT JOIN projects p ON p.id = m.project_id
                 LEFT JOIN memory_embeddings e ON e.memory_id = m.id
                 WHERE ($2 = '' OR m.project_id::text = $2 OR m.metadata->>'project_id' = $2)
                   AND ($3 = '' OR p.name = $3 OR m.metadata->>'project' = $3)
                   AND ($4::text[] = '{}'::text[] OR m.tags && $4::text[])
                   AND ($5::int <= 0 OR m.updated_at >= now() - ($5::int * interval '1 day'))
                 ORDER BY m.updated_at DESC
                 LIMIT $1`,
                [limit, projectId, project, tags, recencyDays],
              );
              const memories = recent.rows.map((memory) => ({ ...memory, score: 0 }));
              return sendJson(res, 200, { query: search, detail, memories: detail === "full" ? memories : memories.map((memory) => compactRecallMemoryRow(memory)) });
            }

            const { documents } = await refreshMemoryEmbeddings();
            const documentFrequency = new Map<string, number>();
            for (const doc of documents) {
              for (const token of new Set(tokenizeEmbeddingText(doc.text))) {
                documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
              }
            }
            const queryVector = vectorFromText(search, documentFrequency, documents.length);
            const result = await queryPostgres<{
              id: string;
              project_id: string;
              project_name: string;
              todo_id: string;
              agent_run_id: string;
              title: string;
              content: string;
              entity_type: string;
              access_level: string;
              tags: string[];
              metadata: Record<string, unknown>;
              memory_bytes: number;
              created_at: string;
              updated_at: string;
              representation: TfidfVector;
              dimension: number;
              encoding_source: string;
              embedding_updated_at: string;
            }>(
              `SELECT m.id::text, m.project_id::text, p.name AS project_name, m.todo_id::text, m.agent_run_id::text, m.title, m.content, m.entity_type, m.access_level, m.tags, m.metadata,
                      pg_column_size(m)::int AS memory_bytes,
                      m.created_at::text, m.updated_at::text,
                      e.representation, e.dimension, e.encoding_source, e.updated_at::text AS embedding_updated_at
               FROM memories m
               JOIN memory_embeddings e ON e.memory_id = m.id
               LEFT JOIN projects p ON p.id = m.project_id
               WHERE ($1 = '' OR m.project_id::text = $1 OR m.metadata->>'project_id' = $1)
                 AND ($2 = '' OR p.name = $2 OR m.metadata->>'project' = $2)
                 AND ($3::text[] = '{}'::text[] OR m.tags && $3::text[])
                 AND ($4::int <= 0 OR m.updated_at >= now() - ($4::int * interval '1 day'))`,
              [projectId, project, tags, recencyDays],
            );
            const memories = result.rows
              .map((memory) => {
                const lexical = recallLexicalScore(search, memory);
                const vectorScore = cosineSimilarity(queryVector, memory.representation || { terms: {}, norm: 0 });
                const score = (vectorScore * 0.65) + (lexical.lexical * 0.25) + (lexical.title * 0.25) + (lexical.tags * 0.15) + (lexical.exact * 0.2);
                return { ...memory, score };
              })
              .filter((memory) => memory.score >= minScore)
              .sort((a, b) => b.score - a.score || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
              .slice(0, limit)
              .map(({ representation, ...memory }) => ({ ...memory, score: Number(memory.score.toFixed(6)) }));
            return sendJson(res, 200, {
              query: search,
              detail,
              filters: { project: project || null, project_id: projectId || null, tags, recency_days: recencyDays || null, min_score: minScore },
              memories: detail === "full" ? memories : memories.map((memory) => compactRecallMemoryRow(memory)),
            });
          }

          if (url.pathname === "/api/mbox/memories/review") {
            const result = await queryPostgres<MemoryEmbeddingRow & Record<string, any>>(
              `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, tags, metadata,
                      created_at::text, updated_at::text
               FROM memories
               ORDER BY updated_at DESC`,
            );
            return sendJson(res, 200, buildMemoryReview(result.rows));
          }

          if (url.pathname === "/api/mbox/memories/hierarchy") {
            const result = await queryPostgres<Record<string, any>>(
              `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
                      created_at::text, updated_at::text
               FROM memories
               ORDER BY updated_at DESC`,
            );
            return sendJson(res, 200, { checked: result.rows.length, ...buildMemoryHierarchy(result.rows) });
          }

          if (url.pathname === "/api/mbox/memories/suggest-hierarchy" && req.method === "POST") {
            const body = await readBody<Record<string, any>>(req);
            const projectId = String(body.project_id || "");
            const result = await queryPostgres<MemoryEmbeddingRow & Record<string, any>>(
              `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
                      created_at::text, updated_at::text
               FROM memories
               WHERE $1 = '' OR project_id::text = $1 OR metadata->>'project_id' = $1
               ORDER BY updated_at DESC`,
              [projectId],
            );
            return sendJson(res, 200, suggestMemoryHierarchy(body, result.rows, body.limit));
          }

          if (url.pathname === "/api/mbox/memories/digest" && req.method === "POST") {
            const body = await readBody<Record<string, any>>(req);
            const digest = digestDocument({
              title: body.title,
              content: body.content,
              maxFragments: body.max_fragments,
              minChars: body.min_chars,
            });
            const baseTags = Array.isArray(body.tags) ? body.tags.map(String) : [];
            const baseMetadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
            const dryRun = body.dry_run !== false;
            if (dryRun) return sendJson(res, 200, { ...digest, dry_run: true });

            const created: Record<string, any>[] = [];
            for (const fragment of digest.fragments) {
              const tags = [...new Set([...baseTags, ...fragment.tags])];
              const metadata = {
                ...baseMetadata,
                ...fragment.metadata,
                source_agent: actorFromReq(req),
                source_content_bytes: Buffer.byteLength(String(body.content || ""), "utf8"),
              };
              const result = await queryPostgres(
                `INSERT INTO memories(project_id, todo_id, agent_run_id, title, content, entity_type, access_level, tags, metadata)
                 VALUES ($1, $2, $3, $4, $5, 'memory', COALESCE(NULLIF($6, ''), 'agents'), $7, $8)
                 RETURNING id::text, title`,
                [
                  body.project_id || null,
                  body.todo_id || null,
                  body.agent_run_id || null,
                  `${digest.title}: ${fragment.title}`.slice(0, 240),
                  fragment.content,
                  String(body.access_level || ""),
                  tags,
                  JSON.stringify(metadata),
                ],
              );
              await recordMemoryAction({ memoryId: result.rows[0]?.id, actor: String(actorFromReq(req)), action: "digest_fragment_create", note: `fragment ${fragment.index}`, metadata });
              created.push({ ...result.rows[0], fragment_index: fragment.index });
            }
            if (created.length) {
              await refreshMemoryEmbeddings();
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
            }
            return sendJson(res, 201, { ...digest, dry_run: false, created });
          }

          const memoryActionsMatch = url.pathname.match(/^\/api\/mbox\/memories\/(\d+)\/actions$/);
          if (memoryActionsMatch) {
            if (req.method === "POST") {
              const body = await readBody<Record<string, any>>(req);
              const action = await recordMemoryAction({
                memoryId: memoryActionsMatch[1],
                actor: String(actorFromReq(req)),
                action: String(body.action || "note"),
                note: String(body.note || ""),
                metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
              });
              return sendJson(res, 201, { action });
            }
            const result = await queryPostgres(
              `SELECT id::text, memory_id::text, actor, action, note, metadata, created_at::text
               FROM memory_actions
               WHERE memory_id = $1
               ORDER BY created_at DESC
               LIMIT 100`,
              [memoryActionsMatch[1]],
            );
            return sendJson(res, 200, { actions: result.rows });
          }

          const memoryMatch = url.pathname.match(/^\/api\/mbox\/memories\/(\d+)$/);
          if (memoryMatch && req.method === "GET") {
            const result = await queryPostgres(
              `SELECT m.id::text, m.folder_id::text, m.project_id::text, p.name AS project_name, m.todo_id::text, m.agent_run_id::text,
                      m.title, m.content, m.entity_type, m.access_level, m.tags, m.metadata,
                      pg_column_size(m)::int AS memory_bytes,
                      m.created_at::text, m.updated_at::text
               FROM memories m
               LEFT JOIN projects p ON p.id = m.project_id
               WHERE m.id = $1 AND ($2::boolean OR m.project_id = ANY($3::bigint[]))`,
              [memoryMatch[1], devScope.all, devScope.projectIds],
            );
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
          }

          if (memoryMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            if (Object.prototype.hasOwnProperty.call(body, "project_id") && !devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
            const result = await queryPostgres(
              `UPDATE memories SET
                 title = COALESCE(NULLIF($1, ''), title),
                 content = COALESCE($2, content),
                 access_level = COALESCE(NULLIF($3, ''), access_level),
                 tags = COALESCE($4, tags),
                 project_id = CASE WHEN $5 THEN $6::bigint ELSE project_id END,
                 entity_type = COALESCE(NULLIF($7, ''), entity_type),
                 updated_at = now()
               WHERE id = $8 AND ($9::boolean OR project_id = ANY($10::bigint[]))
               RETURNING id::text`,
              [String(body.title ?? "").trim(), body.content ?? null, String(body.access_level ?? ""), Array.isArray(body.tags) ? body.tags : null, Object.prototype.hasOwnProperty.call(body, "project_id"), (body.project_id as string) || null, String(body.entity_type ?? ""), memoryMatch[1], devScope.all, devScope.projectIds],
            );
            if (result.rows[0]) await recordMemoryAction({ memoryId: result.rows[0].id, actor: String(actorFromReq(req)), action: "update", note: "memory updated via API", metadata: { fields: Object.keys(body || {}) } });
            if (result.rows[0]) await refreshMemoryEmbeddings();
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
          }

          if (memoryMatch && req.method === "DELETE") {
            const allowed = await queryPostgres("SELECT 1 FROM memories WHERE id = $1 AND ($2::boolean OR project_id = ANY($3::bigint[]))", [memoryMatch[1], devScope.all, devScope.projectIds]);
            if (!allowed.rows[0]) return sendJson(res, 404, { error: "not_found" });
            await recordMemoryAction({ memoryId: memoryMatch[1], actor: String(actorFromReq(req)), action: "delete", note: "memory deleted via API" });
            await queryPostgres("DELETE FROM memories WHERE id = $1", [memoryMatch[1]]);
            await refreshMemoryEmbeddings();
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/folders") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
              if (!devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
              const result = await queryPostgres(
                `INSERT INTO folders(parent_id, name, entity_type, access_level, color, project_id)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id::text`,
                [body.parent_id || null, String(body.name ?? "").trim(), String(body.entity_type ?? "artifact"), String(body.access_level ?? "private"), String(body.color ?? "#2c2c2e"), body.project_id || null],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "folders" });
              return sendJson(res, 201, { folder: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, parent_id::text, project_id::text, name, entity_type, access_level, color, pg_column_size(folders)::int AS memory_bytes
               FROM folders
               WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
                 AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR entity_type ILIKE '%' || $1 || '%')
               ORDER BY COALESCE(parent_id, 0), name`,
              [q, devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, { folders: result.rows });
          }

          const folderMatch = url.pathname.match(/^\/api\/mbox\/folders\/(\d+)$/);
          if (folderMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const result = await queryPostgres(
              `UPDATE folders SET
                 parent_id = $1,
                 name = COALESCE(NULLIF($2, ''), name),
                 entity_type = COALESCE(NULLIF($3, ''), entity_type),
                 access_level = COALESCE(NULLIF($4, ''), access_level),
                 color = COALESCE(NULLIF($5, ''), color)
               WHERE id = $6
                 AND ($7::boolean OR project_id = ANY($8::bigint[]))
               RETURNING id::text`,
              [body.parent_id || null, String(body.name ?? "").trim(), String(body.entity_type ?? ""), String(body.access_level ?? ""), String(body.color ?? ""), folderMatch[1], devScope.all, devScope.projectIds],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "folders" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { folder: result.rows[0] } : { error: "not_found" });
          }

          if (folderMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM folders WHERE id = $1 AND ($2::boolean OR project_id = ANY($3::bigint[]))", [folderMatch[1], devScope.all, devScope.projectIds]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "folders" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/artifacts") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
              if (!devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
              const result = await queryPostgres(
                `INSERT INTO artifacts(folder_id, project_id, name, category, version, status, content, access_level)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE(NULLIF($8, ''), 'agents'))
                 RETURNING id::text`,
                [body.folder_id || null, body.project_id || null, String(body.name ?? "").trim(), String(body.category ?? "Code"), String(body.version ?? "v1"), String(body.status ?? "created"), String(body.content ?? ""), String(body.access_level ?? "")],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "artifacts" });
              return sendJson(res, 201, { artifact: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, folder_id::text, project_id::text, name, category, version, status, content, access_level, pg_column_size(artifacts)::int AS memory_bytes
               FROM artifacts
               WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
                 AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR category ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%')
               ORDER BY category, name
               LIMIT 300`,
              [q, devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, { artifacts: result.rows });
          }

          // Скачать документ в Word: тот же конвертер, что у боевого сервера (server/docx.mjs).
          const artifactDocxMatch = url.pathname.match(/^\/api\/mbox\/artifacts\/(\d+)\/docx$/);
          if (artifactDocxMatch && req.method === "GET") {
            const row = (await queryPostgres<{ name: string; content: string; project_id: string | null }>(
              "SELECT name, content, project_id::text FROM artifacts WHERE id = $1",
              [artifactDocxMatch[1]],
            )).rows[0];
            if (!row) return sendJson(res, 404, { error: "not_found" });
            if (!devHasProjectAccess(devScope, row.project_id)) return sendJson(res, 403, { error: "forbidden" });
            const file = documentToDocx({ content: row.content || "", name: row.name });
            res.writeHead(200, {
              "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "content-length": file.length,
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(docxFileName(row.name))}`,
            });
            return res.end(file);
          }

          const artifactMatch = url.pathname.match(/^\/api\/mbox\/artifacts\/(\d+)$/);
          if (artifactMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            if (!devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
            const result = await queryPostgres(
              `UPDATE artifacts SET
                 folder_id = $1,
                 project_id = $2,
                 name = COALESCE(NULLIF($3, ''), name),
                 category = COALESCE(NULLIF($4, ''), category),
                 version = COALESCE(NULLIF($5, ''), version),
                 status = COALESCE(NULLIF($6, ''), status),
                 content = COALESCE($7, content),
                 updated_at = now()
               WHERE id = $8 AND ($9::boolean OR project_id = ANY($10::bigint[]))
               RETURNING id::text`,
              [body.folder_id || null, body.project_id || null, String(body.name ?? "").trim(), String(body.category ?? ""), String(body.version ?? ""), String(body.status ?? ""), body.content ?? null, artifactMatch[1], devScope.all, devScope.projectIds],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "artifacts" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { artifact: result.rows[0] } : { error: "not_found" });
          }

          if (artifactMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM artifacts WHERE id = $1 AND ($2::boolean OR project_id = ANY($3::bigint[]))", [artifactMatch[1], devScope.all, devScope.projectIds]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "artifacts" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/companies") {
            if (req.method === "POST") {
              if (!devScope.all) return sendJson(res, 403, { error: "owner_required" });
              const body = await readBody<Record<string, unknown>>(req);
              const result = await queryPostgres(
                `INSERT INTO companies(folder_id, name, status, props, color, access_level)
                 VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'active'), $4, $5, COALESCE(NULLIF($6, ''), 'private'))
                 RETURNING id::text`,
                [body.folder_id || null, String(body.name ?? "").trim(), String(body.status ?? ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {}), String(body.color ?? "#2c2c2e"), String(body.access_level ?? "")],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "companies" });
              return sendJson(res, 201, { company: result.rows[0] });
            }
            const companies = await queryPostgres(
              `SELECT id::text, folder_id::text, name, status, props, color, access_level,
                      pg_column_size(companies)::int AS memory_bytes,
                      created_at::text, updated_at::text
               FROM companies
               WHERE ($2::boolean OR EXISTS (
                 SELECT 1 FROM graph_edges e
                 WHERE e.from_entity = 'company' AND e.from_id = companies.id
                   AND e.to_entity = 'project' AND e.to_id = ANY($3::bigint[])
               ))
                 AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR status ILIKE '%' || $1 || '%' OR props::text ILIKE '%' || $1 || '%')
               ORDER BY updated_at DESC
               LIMIT 200`,
              [q, devScope.all, devScope.projectIds],
            );
            const relations = await queryPostgres(
              `SELECT e.id::text, e.from_id::text AS company_id, c.name AS company_name,
                      e.to_id::text AS project_id, p.name AS project_name, e.edge_type,
                      e.title, e.description, e.owner, e.group_entity, e.strength, e.valid_until::text
               FROM graph_edges e
               JOIN companies c ON c.id = e.from_id AND e.from_entity = 'company'
               JOIN projects p ON p.id = e.to_id AND e.to_entity = 'project'
               WHERE $1::boolean OR e.to_id = ANY($2::bigint[])
               ORDER BY e.created_at DESC`,
              [devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, {
              companies: companies.rows.map((company) => ({
                ...company,
                projects: relations.rows.filter((edge) => edge.company_id === company.id),
              })),
            });
          }

          const dataSourceMatch = url.pathname.match(/^\/api\/mbox\/data-sources\/(\d+)$/);

          if (url.pathname === "/api/mbox/data-sources") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
              const name = String(body.name ?? "").trim();
              const sourceUrl = String(body.url ?? "").trim();
              if (!name || !sourceUrl) return sendJson(res, 400, { error: "name_and_url_required" });
              if (!body.project_id && !body.company_id) return sendJson(res, 400, { error: "project_id_or_company_id_required" });
              const result = await queryPostgres(
                `INSERT INTO data_sources(project_id, company_id, name, url, schedule_minutes, access_level, kind)
                 VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5, 0), 1440), COALESCE(NULLIF($6, ''), 'agents'), COALESCE(NULLIF($7, ''), 'webpage'))
                 RETURNING id::text`,
                [body.project_id || null, body.company_id || null, name, sourceUrl, Number(body.schedule_minutes) || 0, String(body.access_level ?? ""), String(body.kind ?? "")],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "data_sources" });
              return sendJson(res, 201, { source: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, project_id::text, company_id::text, name, url, schedule_minutes, kind,
                      last_fetched_at::text, last_status, last_summary, last_memory_id::text, access_level,
                      created_at::text, updated_at::text
               FROM data_sources
               ORDER BY name`,
            );
            return sendJson(res, 200, { sources: result.rows });
          }

          if (dataSourceMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const result = await queryPostgres(
              `UPDATE data_sources SET
                 name = COALESCE(NULLIF($1, ''), name),
                 url = COALESCE(NULLIF($2, ''), url),
                 schedule_minutes = COALESCE(NULLIF($3, 0), schedule_minutes),
                 last_fetched_at = COALESCE($4, last_fetched_at),
                 last_status = COALESCE(NULLIF($5, ''), last_status),
                 last_summary = COALESCE($6, last_summary),
                 last_memory_id = COALESCE($7, last_memory_id),
                 access_level = COALESCE(NULLIF($8, ''), access_level),
                 kind = COALESCE(NULLIF($10, ''), kind),
                 updated_at = now()
               WHERE id = $9
               RETURNING id::text`,
              [
                String(body.name ?? ""),
                String(body.url ?? ""),
                Number(body.schedule_minutes) || 0,
                body.last_fetched_at ? new Date(body.last_fetched_at as string) : null,
                String(body.last_status ?? ""),
                body.last_summary ?? null,
                body.last_memory_id || null,
                String(body.access_level ?? ""),
                dataSourceMatch[1],
                String(body.kind ?? ""),
              ],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "data_sources" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { source: result.rows[0] } : { error: "not_found" });
          }

          if (dataSourceMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM data_sources WHERE id = $1", [dataSourceMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "data_sources" });
            return sendJson(res, 200, { ok: true });
          }

          const dataSourceRefreshMatch = url.pathname.match(/^\/api\/mbox\/data-sources\/(\d+)\/refresh$/);
          if (dataSourceRefreshMatch && req.method === "POST") {
            const result = await refreshDataSourceById(dataSourceRefreshMatch[1]);
            if (result.error === "источник не найден") return sendJson(res, 404, { error: "not_found" });
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "data_sources" });
            return sendJson(res, result.ok ? 200 : 502, result);
          }

          if (url.pathname === "/api/mbox/tour-sheets/bulk" && req.method === "POST") {
            const body = await readBody<{ source_id?: string; items?: Partial<TourSheetItem>[] }>(req);
            if (!body.source_id) return sendJson(res, 400, { error: "source_id_required" });
            const items = (body.items || []).map((item) => ({
              tour_id: String(item.tour_id || ""),
              sheet_id: String(item.sheet_id || ""),
              tour_name: String(item.tour_name || "").slice(0, 500),
              route_name: String(item.route_name || "").slice(0, 1000),
              date_start: item.date_start || null,
              date_end: item.date_end || null,
              free_places: Number(item.free_places) || 0,
              price_from: Number(item.price_from) || 0,
            }));
            const result = await bulkUpsertTourSheets(body.source_id, items);
            return sendJson(res, 200, result);
          }

          if (url.pathname === "/api/mbox/tour-sheets" && req.method === "GET") {
            const search = String(url.searchParams.get("q") || "").trim();
            const onlyAvailable = url.searchParams.get("available") === "1";
            if (!search) return sendJson(res, 400, { error: "q_required" });
            const result = await queryPostgres(
              `SELECT tour_name, route_name, date_start::text, date_end::text, free_places, price_from
               FROM tour_sheets
               WHERE tour_name ILIKE '%' || $1 || '%'
                 AND (date_end IS NULL OR date_end >= CURRENT_DATE)
                 AND ($2 = false OR free_places > 0)
               ORDER BY date_start ASC NULLS LAST
               LIMIT 60`,
              [search, onlyAvailable],
            );
            return sendJson(res, 200, { sheets: result.rows });
          }

          if (url.pathname === "/api/mbox/projects") {
            const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 200), 1), 200);
            const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
            if (req.method === "POST") {
              if (!devScope.all) return sendJson(res, 403, { error: "owner_required" });
              const body = await readBody<Record<string, unknown>>(req);
              const result = await queryPostgres(
                `INSERT INTO projects(name, status, stack, git_url, deploy_provider, deploy_target, color, access_level, props)
                 VALUES ($1, COALESCE(NULLIF($2, ''), 'active'), $3, $4, $5, $6, $7, COALESCE(NULLIF($8, ''), 'private'), $9)
                 RETURNING id::text`,
                [String(body.name ?? "").trim(), String(body.status ?? ""), JSON.stringify(Array.isArray(body.stack) ? body.stack : []), String(body.git_url ?? ""), String(body.deploy_provider ?? ""), String(body.deploy_target ?? ""), String(body.color ?? "#2c2c2e"), String(body.access_level ?? ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "projects" });
              return sendJson(res, 201, { project: result.rows[0] });
            }
            const projects = await queryPostgres(
              `SELECT p.id::text, p.name, p.status, p.stack, p.git_url, p.deploy_target, p.deploy_provider, p.props, p.color, p.access_level,
                      pg_column_size(p)::int AS memory_bytes
               FROM projects p
               LEFT JOIN LATERAL (
                 SELECT (SELECT count(*) FROM todos t WHERE t.project_id = p.id)
                        + (SELECT count(*) FROM memories m WHERE m.project_id = p.id)
                        + 3 * (
                          (SELECT count(*) FROM todos t WHERE t.project_id = p.id AND t.updated_at >= now() - interval '30 days')
                          + (SELECT count(*) FROM memories m WHERE m.project_id = p.id AND m.updated_at >= now() - interval '30 days')
                        ) AS activity_score
               ) activity ON true
               WHERE ($4::boolean OR p.id = ANY($5::bigint[]))
                 AND ($1 = ''
                  OR p.name ILIKE '%' || $1 || '%'
                  OR p.status ILIKE '%' || $1 || '%'
                  OR p.git_url ILIKE '%' || $1 || '%'
                  OR p.deploy_target ILIKE '%' || $1 || '%'
                  OR p.deploy_provider ILIKE '%' || $1 || '%'
                  OR p.stack::text ILIKE '%' || $1 || '%'
                  OR p.props::text ILIKE '%' || $1 || '%'
                  OR EXISTS (
                    SELECT 1 FROM todos t
                    WHERE t.project_id = p.id
                      AND (t.title ILIKE '%' || $1 || '%' OR t.note ILIKE '%' || $1 || '%' OR t.status ILIKE '%' || $1 || '%' OR t.priority ILIKE '%' || $1 || '%' OR t.props::text ILIKE '%' || $1 || '%')
                  )
                  OR EXISTS (
                    SELECT 1 FROM memories m
                    WHERE m.project_id = p.id
                      AND (m.title ILIKE '%' || $1 || '%' OR m.content ILIKE '%' || $1 || '%' OR m.tags::text ILIKE '%' || $1 || '%' OR m.metadata::text ILIKE '%' || $1 || '%')
                  )
                  OR EXISTS (
                    SELECT 1 FROM decision_log d
                    WHERE d.project_id = p.id
                      AND (d.title ILIKE '%' || $1 || '%' OR d.decision ILIKE '%' || $1 || '%' OR d.rationale ILIKE '%' || $1 || '%' OR d.impact ILIKE '%' || $1 || '%')
                  )
                  OR EXISTS (
                    SELECT 1 FROM folders f
                    WHERE f.project_id = p.id
                      AND f.name ILIKE '%' || $1 || '%'
                  )
                  OR EXISTS (
                    SELECT 1 FROM protected_secrets s
                    WHERE s.project_id = p.id
                      AND (s.title ILIKE '%' || $1 || '%' OR s.login ILIKE '%' || $1 || '%' OR s.url ILIKE '%' || $1 || '%' OR s.agent_share_state ILIKE '%' || $1 || '%')
                  )
                  OR EXISTS (
                    SELECT 1 FROM graph_edges e
                    WHERE ((e.from_entity = 'project' AND e.from_id = p.id) OR (e.to_entity = 'project' AND e.to_id = p.id))
                      AND (e.edge_type ILIKE '%' || $1 || '%' OR e.title ILIKE '%' || $1 || '%' OR e.description ILIKE '%' || $1 || '%' OR e.owner ILIKE '%' || $1 || '%' OR e.group_entity ILIKE '%' || $1 || '%')
                  ))
               ORDER BY activity.activity_score DESC, p.updated_at DESC
               LIMIT $2 OFFSET $3`,
              [q, limit, offset, devScope.all, devScope.projectIds],
            );
            const todos = await queryPostgres(
              "SELECT id::text, project_id::text, title, note, status, priority, props, pg_column_size(todos)::int AS memory_bytes FROM todos WHERE $1::boolean OR project_id = ANY($2::bigint[]) ORDER BY updated_at DESC",
              [devScope.all, devScope.projectIds],
            );
            const relations = await queryPostgres(
              `SELECT e.id::text, e.from_id::text AS from_project_id, fp.name AS from_project_name,
                      e.to_id::text AS to_project_id, tp.name AS to_project_name, e.edge_type
               FROM graph_edges e
               JOIN projects fp ON fp.id = e.from_id AND e.from_entity = 'project'
               JOIN projects tp ON tp.id = e.to_id AND e.to_entity = 'project'
               WHERE e.from_entity = 'project' AND e.to_entity = 'project'
                 AND ($1::boolean OR e.from_id = ANY($2::bigint[]) OR e.to_id = ANY($2::bigint[]))
               ORDER BY e.created_at DESC`,
              [devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, {
              page: { limit, offset, count: projects.rows.length },
              projects: projects.rows.map((project) => ({
                ...project,
                todos: todos.rows.filter((todo) => todo.project_id === project.id),
                relations: relations.rows.filter((edge) => edge.from_project_id === project.id || edge.to_project_id === project.id),
              })),
            });
          }

          if (url.pathname === "/api/mbox/graph/edges") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
              const fromId = String(body.from_id ?? "");
              const toId = String(body.to_id ?? "");
              const fromEntity = String(body.from_entity || "project");
              const toEntity = String(body.to_entity || "project");
              if (!fromId || !toId || (fromEntity === toEntity && fromId === toId)) return sendJson(res, 400, { error: "invalid_edge" });
              if (!["project", "company"].includes(fromEntity) || !["project", "company"].includes(toEntity)) return sendJson(res, 400, { error: "invalid_entity" });
              if (!devScope.all && !((fromEntity === "project" && devScope.projectIds.includes(fromId)) || (toEntity === "project" && devScope.projectIds.includes(toId)))) return sendJson(res, 403, { error: "forbidden" });
              const result = await queryPostgres(
                `INSERT INTO graph_edges(from_entity, from_id, to_entity, to_id, edge_type, title, description, owner, group_entity, strength, valid_until, score)
                 VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5, ''), 'related'), $6, $7, $8, $9, COALESCE($10, 1), $11, 1)
                 ON CONFLICT DO NOTHING
                 RETURNING id::text`,
                [fromEntity, fromId, toEntity, toId, String(body.edge_type ?? ""), String(body.title ?? ""), String(body.description ?? ""), String(body.owner ?? ""), String(body.group_entity ?? ""), Number(body.strength || 1), body.valid_until || null],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "graph_edges" });
              return sendJson(res, 201, { edge: result.rows[0] ?? null });
            }
            const result = await queryPostgres(
              `SELECT e.id::text, e.from_entity, e.from_id::text, COALESCE(fp.name, fc.name, e.from_entity || ' #' || e.from_id::text) AS from_label,
                      e.to_entity, e.to_id::text, COALESCE(tp.name, tc.name, e.to_entity || ' #' || e.to_id::text) AS to_label,
                      e.edge_type, e.title, e.description, e.owner, e.group_entity, e.strength, e.valid_until::text
               FROM graph_edges e
               LEFT JOIN projects fp ON e.from_entity = 'project' AND fp.id = e.from_id
               LEFT JOIN companies fc ON e.from_entity = 'company' AND fc.id = e.from_id
               LEFT JOIN projects tp ON e.to_entity = 'project' AND tp.id = e.to_id
               LEFT JOIN companies tc ON e.to_entity = 'company' AND tc.id = e.to_id
               WHERE $1::boolean
                  OR (e.from_entity = 'project' AND e.from_id = ANY($2::bigint[]))
                  OR (e.to_entity = 'project' AND e.to_id = ANY($2::bigint[]))
               ORDER BY e.created_at DESC
               LIMIT 500`,
              [devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, { edges: result.rows });
          }

          const edgeMatch = url.pathname.match(/^\/api\/mbox\/graph\/edges\/(\d+)$/);
          if (edgeMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM graph_edges WHERE id = $1", [edgeMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "graph_edges" });
            return sendJson(res, 200, { ok: true });
          }

          const companyMatch = url.pathname.match(/^\/api\/mbox\/companies\/(\d+)$/);
          if (companyMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const color = String(body.color ?? "").trim();
            if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return sendJson(res, 400, { error: "invalid_color" });
            const result = await queryPostgres(
              `UPDATE companies
               SET folder_id = COALESCE($1, folder_id),
                   name = COALESCE(NULLIF($2, ''), name),
                   status = COALESCE(NULLIF($3, ''), status),
                   props = COALESCE($4, props),
                   color = COALESCE(NULLIF($5, ''), color),
                   access_level = COALESCE(NULLIF($6, ''), access_level),
                   updated_at = now()
               WHERE id = $7
               RETURNING id::text`,
              [body.folder_id || null, String(body.name ?? "").trim(), String(body.status ?? ""), body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, color, String(body.access_level ?? ""), companyMatch[1]],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "companies" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { company: result.rows[0] } : { error: "not_found" });
          }

          if (companyMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM companies WHERE id = $1", [companyMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "companies" });
            return sendJson(res, 200, { ok: true });
          }

          const projectMatch = url.pathname.match(/^\/api\/mbox\/projects\/(\d+)$/);
          if (projectMatch && req.method === "PATCH") {
            if (!devHasProjectAccess(devScope, projectMatch[1])) return sendJson(res, 403, { error: "forbidden" });
            const body = await readBody<Record<string, unknown>>(req);
            const color = String(body.color ?? "").trim();
            if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return sendJson(res, 400, { error: "invalid_color" });
            const result = await queryPostgres(
              `UPDATE projects
               SET name = COALESCE(NULLIF($1, ''), name),
                   status = COALESCE(NULLIF($2, ''), status),
                   stack = COALESCE($3, stack),
                   git_url = COALESCE($4, git_url),
                   deploy_provider = COALESCE($5, deploy_provider),
                   deploy_target = COALESCE($6, deploy_target),
                   color = COALESCE(NULLIF($7, ''), color),
                   access_level = COALESCE(NULLIF($8, ''), access_level),
                   props = COALESCE($10, props),
                   updated_at = now()
               WHERE id = $9
               RETURNING id::text, color`,
              [
                String(body.name ?? "").trim(),
                String(body.status ?? ""),
                Array.isArray(body.stack) ? JSON.stringify(body.stack) : null,
                body.git_url ?? null,
                body.deploy_provider ?? null,
                body.deploy_target ?? null,
                color,
                String(body.access_level ?? ""),
                projectMatch[1],
                body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null,
              ],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "projects" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { project: result.rows[0] } : { error: "not_found" });
          }

          if (projectMatch && req.method === "DELETE") {
            if (!devScope.all) return sendJson(res, 403, { error: "owner_required" });
            await queryPostgres("DELETE FROM projects WHERE id = $1", [projectMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "projects" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/todos" && req.method === "POST") {
            const body = await readBody<Record<string, unknown>>(req);
            if (!devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
            const result = await queryPostgres(
              `INSERT INTO todos(project_id, title, note, status, priority, props, access_level)
               VALUES ($1, $2, $3, COALESCE(NULLIF($4, ''), 'open'), COALESCE(NULLIF($5, ''), 'normal'), $6, COALESCE(NULLIF($7, ''), 'private'))
               RETURNING id::text, pg_column_size(todos)::int AS memory_bytes`,
              [body.project_id, String(body.title ?? "").trim(), String(body.note ?? ""), String(body.status ?? ""), String(body.priority ?? ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {}), String(body.access_level ?? "")],
            );
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "todos" });
            return sendJson(res, 201, { todo: result.rows[0] });
          }

          const todoMatch = url.pathname.match(/^\/api\/mbox\/todos\/(\d+)$/);
          if (todoMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const result = await queryPostgres(
              `UPDATE todos SET
                 title = COALESCE(NULLIF($1, ''), title),
                 note = COALESCE($2, note),
                 status = COALESCE(NULLIF($3, ''), status),
                 priority = COALESCE(NULLIF($4, ''), priority),
                 props = COALESCE($6, props),
                 updated_at = now()
               WHERE id = $5 AND ($7::boolean OR project_id = ANY($8::bigint[]))
               RETURNING id::text, project_id::text, title, note, status, claimed_by`,
              [String(body.title ?? "").trim(), body.note ?? null, String(body.status ?? ""), String(body.priority ?? ""), todoMatch[1], body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, devScope.all, devScope.projectIds],
            );
            let auto_memory = null;
            if (result.rows[0] && String(body.status ?? "") === "done") {
              auto_memory = await autoRecordMemory({
                projectId: result.rows[0].project_id,
                todoId: result.rows[0].id,
                sourceAgent: actorFromReq(req),
                title: `Итог задачи: ${result.rows[0].title}`,
                content: result.rows[0].note,
                reason: "todo_done",
              });
            }
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "todos" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { todo: result.rows[0], auto_memory } : { error: "not_found" });
          }

          if (todoMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM todos WHERE id = $1 AND ($2::boolean OR project_id = ANY($3::bigint[]))", [todoMatch[1], devScope.all, devScope.projectIds]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "todos" });
            return sendJson(res, 200, { ok: true });
          }

          const todoTrailMatch = url.pathname.match(/^\/api\/mbox\/todos\/(\d+)\/trail$/);
          if (todoTrailMatch) {
            const todo = await queryPostgres(
              `SELECT t.id::text, t.project_id::text, t.title, t.status, t.priority, t.props, t.created_at::text, t.updated_at::text, p.name AS project_name
               FROM todos t
               LEFT JOIN projects p ON p.id = t.project_id
               WHERE t.id = $1`,
              [todoTrailMatch[1]],
            );
            if (!todo.rows[0]) return sendJson(res, 404, { error: "not_found" });
            const decisions = await queryPostgres("SELECT id::text, todo_id::text, agent_run_id::text, actor, title, decision, rationale, impact, props, created_at::text FROM decision_log WHERE todo_id = $1 ORDER BY created_at", [todoTrailMatch[1]]);
            const runs = await queryPostgres("SELECT id::text, todo_id::text, agent_name, status, goal, commands, touched_files, result, props, started_at::text, heartbeat_at::text, finished_at::text FROM agent_runs WHERE todo_id = $1 ORDER BY started_at", [todoTrailMatch[1]]);
            const memories = await queryPostgres(
              `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata, created_at::text, updated_at::text
               FROM memories
               WHERE todo_id = $1 OR metadata->>'todo_id' = $1::text
               ORDER BY created_at`,
              [todoTrailMatch[1]],
            );
            const history = await queryPostgres(
              `SELECT id::text, actor, action, entity_type, entity_id::text, summary, metadata, created_at::text
               FROM audit_events
               WHERE (entity_type = 'todos' AND entity_id = $1)
                  OR (metadata->>'todo_id' = $1::text)
               ORDER BY created_at
               LIMIT 100`,
              [todoTrailMatch[1]],
            );
            const timeline = [
              ...decisions.rows.map((item) => ({ kind: "decision", at: item.created_at, item })),
              ...runs.rows.map((item) => ({ kind: "agent_run", at: item.finished_at || item.heartbeat_at || item.started_at, item })),
              ...memories.rows.map((item) => ({ kind: "memory", at: item.created_at, item: compactMemoryRow(item) })),
              ...history.rows.map((item) => ({ kind: "audit_event", at: item.created_at, item })),
            ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
            return sendJson(res, 200, { todo: todo.rows[0], decisions: decisions.rows, runs: runs.rows, memories: memories.rows.map((memory) => compactMemoryRow(memory)), history: history.rows, timeline });
          }

          if (url.pathname === "/api/mbox/server") {
            const result = await queryPostgres(
              "SELECT hostname, load_1, cpu_percent, memory_used_mb, memory_total_mb, disk_used_mb, disk_total_mb, docker_containers, captured_at::text FROM server_metrics ORDER BY captured_at DESC LIMIT 1",
            );
            return sendJson(res, 200, { metrics: result.rows[0] ?? null });
          }

          if (url.pathname === "/api/mbox/history") {
            const result = await queryPostgres(
              `SELECT id::text, actor, action, entity_type, entity_id::text, project_id::text, summary, metadata,
                      pg_column_size(audit_events)::int AS memory_bytes,
                      created_at::text
               FROM audit_events
               WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
                 AND ($1 = '' OR actor ILIKE '%' || $1 || '%' OR action ILIKE '%' || $1 || '%'
                  OR entity_type ILIKE '%' || $1 || '%' OR summary ILIKE '%' || $1 || '%' OR metadata::text ILIKE '%' || $1 || '%')
               ORDER BY created_at DESC
               LIMIT 200`,
              [q, devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, { events: result.rows });
          }

          // Расстановка узлов карты. Держать в паре с server/mbox-server.mjs.
          if (url.pathname === "/api/mbox/agent/context") {
            await closeStaleAgentRuns();
            const projectName = url.searchParams.get("project") || "MBOX";
            const detail = url.searchParams.get("detail") === "full" ? "full" : "short";
            const projects = await queryPostgres<Record<string, any>>(
              `SELECT id::text, name, status, stack, git_url, deploy_target, deploy_provider, props, color, access_level,
                      pg_column_size(projects)::int AS memory_bytes
               FROM projects
               WHERE name = $1
               LIMIT 1`,
              [projectName],
            );
            const project = projects.rows[0] || null;
            if (!project) return sendJson(res, 404, { error: "project_not_found" });
            const todos = await queryPostgres<Record<string, any>>(
              `SELECT id::text, project_id::text, title, note, status, priority, props, claimed_by, claimed_until::text, heartbeat_at::text,
                      pg_column_size(todos)::int AS memory_bytes
               FROM todos
               WHERE project_id = $1
               ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, updated_at DESC`,
              [project.id],
            );
            const decisions = await queryPostgres<Record<string, any>>("SELECT id::text, todo_id::text, agent_run_id::text, actor, title, decision, rationale, impact, props, created_at::text FROM decision_log WHERE project_id = $1 ORDER BY created_at DESC LIMIT 25", [project.id]);
            const runs = await queryPostgres<Record<string, any>>("SELECT id::text, todo_id::text, agent_name, status, goal, read_context, commands, touched_files, result, props, started_at::text, heartbeat_at::text, finished_at::text FROM agent_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 20", [project.id]);
            const history = await queryPostgres<Record<string, any>>("SELECT id::text, actor, action, entity_type, entity_id::text, summary, metadata, created_at::text FROM audit_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50", [project.id]);
            const memories = await relevantMemories(`${project.name} ${Array.isArray(project.stack) ? project.stack.join(" ") : ""} ${JSON.stringify(project.props || {})}`, { projectId: project.id, limit: 5 });
            if (detail === "full") return sendJson(res, 200, { project, detail, todos: todos.rows, decisions: decisions.rows, runs: runs.rows, history: history.rows, memories });
            return sendJson(res, 200, {
              project,
              detail,
              counts: { todos: todos.rows.length, decisions: decisions.rows.length, runs: runs.rows.length, history: history.rows.length, memories: memories.length },
              todos: todos.rows.map((todo) => ({
                id: todo.id,
                project_id: todo.project_id,
                title: todo.title,
                note_preview: textPreview(todo.note, 180),
                note_bytes: Buffer.byteLength(String(todo.note || ""), "utf8"),
                note_truncated: String(todo.note || "").length > textPreview(todo.note, 180).length,
                status: todo.status,
                priority: todo.priority,
                props_keys: Object.keys(todo.props || {}),
                claimed_by: todo.claimed_by,
                claimed_until: todo.claimed_until,
                heartbeat_at: todo.heartbeat_at,
                memory_bytes: todo.memory_bytes,
              })),
              decisions: decisions.rows.map((decision) => ({
                id: decision.id,
                todo_id: decision.todo_id,
                agent_run_id: decision.agent_run_id,
                actor: decision.actor,
                title: decision.title,
                decision_preview: textPreview(decision.decision, 180),
                rationale_preview: textPreview(decision.rationale, 120),
                impact_preview: textPreview(decision.impact, 120),
                props_keys: Object.keys(decision.props || {}),
                created_at: decision.created_at,
              })),
              runs: runs.rows.map((run) => ({
                id: run.id,
                todo_id: run.todo_id,
                agent_name: run.agent_name,
                status: run.status,
                goal: run.goal,
                touched_files: run.touched_files,
                result_preview: textPreview(run.result, 160),
                props_keys: Object.keys(run.props || {}),
                started_at: run.started_at,
                heartbeat_at: run.heartbeat_at,
                finished_at: run.finished_at,
              })),
              history: history.rows.map((event) => ({
                id: event.id,
                actor: event.actor,
                action: event.action,
                entity_type: event.entity_type,
                entity_id: event.entity_id,
                summary: event.summary,
                metadata_preview: textPreview(event.metadata, 160),
                created_at: event.created_at,
              })),
              memories,
            });
          }

          // Отметки «просмотрено». Держать в паре с server/mbox-server.mjs — реализации независимые.
          if (url.pathname === "/api/mbox/seen") {
            const user = await currentUser(req);
            const actor = (user as { username?: string } | null)?.username || "anonymous";

            if (req.method === "POST") {
              const body = await readBody<{ marks?: Array<{ entity_type?: string; entity_id?: string; bytes?: number }>; entity_type?: string; entity_id?: string; bytes?: number }>(req);
              const marks = Array.isArray(body.marks) ? body.marks : [body];
              const rows = marks
                .filter((mark) => mark && mark.entity_type && mark.entity_id)
                .map((mark) => [actor, String(mark.entity_type), String(mark.entity_id), Number(mark.bytes) || 0]);
              if (!rows.length) return sendJson(res, 400, { error: "marks_required" });

              const values = rows.map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4}, now())`).join(", ");
              await queryPostgres(
                `INSERT INTO seen_marks(actor, entity_type, entity_id, seen_bytes, seen_at)
                 VALUES ${values}
                 ON CONFLICT (actor, entity_type, entity_id)
                 DO UPDATE SET seen_bytes = EXCLUDED.seen_bytes, seen_at = EXCLUDED.seen_at`,
                rows.flat(),
              );
              return sendJson(res, 200, { ok: true, saved: rows.length });
            }

            const result = await queryPostgres(
              "SELECT entity_type, entity_id::text, seen_bytes, seen_at::text FROM seen_marks WHERE actor = $1",
              [actor],
            );
            return sendJson(res, 200, { marks: result.rows });
          }

          if (url.pathname === "/api/mbox/agent/inbox" && req.method === "POST") {
            const body = await readBody<{ project_id?: string | null; agent_name?: string; item_type?: string; title?: string; body?: string; status?: string; priority?: string; requires_human?: boolean; props?: Record<string, unknown> }>(req);
            const inboxProps = {
              ...(body.props && typeof body.props === "object" ? body.props : {}),
              mbox_user_id: String(sessionUser.id),
              mbox_owner: sessionUser.role === "owner",
            };
            const result = await queryPostgres(
              `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
               VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'notice'), $4, $5, COALESCE(NULLIF($6, ''), 'open'), COALESCE(NULLIF($7, ''), 'normal'), $8, $9)
               RETURNING id::text`,
              [
                body.project_id || null,
                String(body.agent_name || "Agent"),
                String(body.item_type || ""),
                String(body.title || "").trim(),
                String(body.body || ""),
                String(body.status || ""),
                String(body.priority || ""),
                Boolean(body.requires_human),
                JSON.stringify(inboxProps),
              ],
            );
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "agent_inbox" });
            const senderName = String(body.agent_name || "Agent");
            const addressedTo = body.props && typeof body.props === "object" ? String((body.props as Record<string, unknown>).to || "") : "";
            // См. server/mbox-server.mjs — только вопросы, служебные agent_error/agent_response не будят Джарвиса.
            const isQuestion = String(body.item_type || "") === "question";
            const isReplyToJarvis = String(body.item_type || "") === "answer" && senderName === "Человек" && addressedTo === JARVIS_NAME;
            if (result.rows[0] && ((isQuestion && (senderName === "Человек" || senderName === "Claude") && (!addressedTo || addressedTo === JARVIS_NAME)) || isReplyToJarvis)) {
              // См. server/mbox-server.mjs — тот же лимит против зацикливания агентов.
              let allowChain = senderName === "Человек";
              if (!allowChain) {
                const recentChain = await queryPostgres<{ agent_name: string }>(
                  `SELECT agent_name FROM agent_inbox
                   WHERE item_type IN ('question', 'answer') AND project_id IS NOT DISTINCT FROM $1
                     AND (props->>'mbox_user_id' = $2 OR ($3::boolean AND NOT (props ? 'mbox_user_id')))
                   ORDER BY created_at DESC LIMIT 6`,
                  [body.project_id || null, String(sessionUser.id), sessionUser.role === "owner"],
                );
                allowChain = recentChain.rows.some((row) => row.agent_name === "Человек");
              }
              if (allowChain) {
                replyAsJarvis({ id: result.rows[0].id, project_id: body.project_id || null, title: body.title, body: body.body, props: inboxProps })
                  .catch((error: Error) => console.error(`Jarvis reply totally uncaught: ${error.message}`));
              } else {
                console.log(`[jarvis] агент-агент цепочка достигла лимита без человека — авто-ответ на #${result.rows[0].id} пропущен`);
              }
            }
            if (addressedTo === "Claude" && result.rows[0]) {
              console.log(`[claude-ping] #${result.rows[0].id} ${String(body.title || "").replace(/\s+/g, " ").slice(0, 200)}`);
            }
            return sendJson(res, 201, { inbox_item: result.rows[0] });
          }

          if (url.pathname === "/api/mbox/agent/inbox" && req.method === "GET") {
            // См. server/mbox-server.mjs — фильтры для MCP list_inbox; без параметров ответ прежний.
            const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 500);
            const agent = url.searchParams.get("agent")?.trim() || "";
            const itemType = url.searchParams.get("item_type")?.trim() || "";
            const search = url.searchParams.get("q")?.trim() || "";
            const beforeParam = url.searchParams.get("before_id") || "";
            const beforeId = /^\d+$/.test(beforeParam) ? beforeParam : "";
            const filtered = Boolean(agent || itemType || search || beforeId);
            const result = await queryPostgres(
              `SELECT ${INBOX_COLUMNS} FROM agent_inbox
               WHERE ($1 = '' OR agent_name = $1)
                 AND ($2 = '' OR item_type = $2)
                 AND ($3 = '' OR title ILIKE '%' || $3 || '%' OR body ILIKE '%' || $3 || '%')
                 AND (NULLIF($4, '') IS NULL OR id < NULLIF($4, '')::bigint)
                 AND (props->>'mbox_user_id' = $6 OR ($7::boolean AND NOT (props ? 'mbox_user_id')))
               ORDER BY ${filtered ? "id DESC" : "updated_at DESC"}
               LIMIT $5`,
              [agent, itemType, search, beforeId, limit, String(sessionUser.id), sessionUser.role === "owner"],
            );
            return sendJson(res, 200, { inbox: result.rows });
          }

          const inboxMatch = url.pathname.match(/^\/api\/mbox\/agent\/inbox\/(\d+)$/);
          if (inboxMatch && req.method === "GET") {
            const item = (await queryPostgres(
              `SELECT ${INBOX_COLUMNS} FROM agent_inbox
               WHERE id = $1 AND (props->>'mbox_user_id' = $2 OR ($3::boolean AND NOT (props ? 'mbox_user_id')))`,
              [inboxMatch[1], String(sessionUser.id), sessionUser.role === "owner"],
            )).rows[0];
            if (!item) return sendJson(res, 404, { error: "not_found" });
            const replies = await queryPostgres(
              `SELECT ${INBOX_COLUMNS} FROM agent_inbox
               WHERE (props->>'re' = $1 OR props->>'in_reply_to' = $1)
                 AND (props->>'mbox_user_id' = $2 OR ($3::boolean AND NOT (props ? 'mbox_user_id')))
               ORDER BY created_at`,
              [inboxMatch[1], String(sessionUser.id), sessionUser.role === "owner"],
            );
            const errors = await queryPostgres("SELECT id::text, source, tool_name, message, created_at::text FROM jarvis_errors WHERE inbox_id = $1 ORDER BY created_at", [inboxMatch[1]]);
            return sendJson(res, 200, { inbox_item: item, replies: replies.rows, errors: errors.rows });
          }

          const answerMatch = url.pathname.match(/^\/api\/mbox\/agent\/inbox\/(\d+)\/answer$/);
          if (answerMatch && req.method === "POST") {
            // См. server/mbox-server.mjs — резервный путь архивариуса, атомарный захват вопроса.
            if (activeJarvisRequests.has(answerMatch[1])) return sendJson(res, 409, { error: "already_answering" });
            const row = (await queryPostgres<{ id: string; project_id: string | null; title: string; body: string; props: Record<string, unknown> }>(
              `UPDATE agent_inbox SET status = 'doing', updated_at = now()
               WHERE id = $1 AND (item_type = 'question' OR (item_type = 'answer' AND agent_name = 'Человек' AND props->>'to' = $2))
                 AND (props->>'mbox_user_id' = $3 OR ($4::boolean AND NOT (props ? 'mbox_user_id')))
                 AND (status = 'open' OR (status = 'doing' AND updated_at < now() - interval '10 minutes'))
               RETURNING id::text, project_id::text, title, body, props`,
              [answerMatch[1], JARVIS_NAME, String(sessionUser.id), sessionUser.role === "owner"],
            )).rows[0];
            if (!row) return sendJson(res, 409, { error: "not_answerable" });
            replyAsJarvis(row).catch((error: Error) => console.error(`Jarvis hand-off reply uncaught: ${error.message}`));
            return sendJson(res, 202, { ok: true, inbox_id: row.id });
          }
          if (inboxMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const ifStatus = String(body.if_status ?? "");
            const result = await queryPostgres(
              `UPDATE agent_inbox SET status = COALESCE(NULLIF($1, ''), status), priority = COALESCE(NULLIF($2, ''), priority), body = COALESCE($3, body), props = COALESCE($4, props), updated_at = now()
               WHERE id = $5 AND ($6 = '' OR status = $6)
                 AND (props->>'mbox_user_id' = $7 OR ($8::boolean AND NOT (props ? 'mbox_user_id')))
               RETURNING id::text`,
              [String(body.status ?? ""), String(body.priority ?? ""), body.body ?? null, body.props && typeof body.props === "object" ? JSON.stringify({ ...body.props, mbox_user_id: String(sessionUser.id), mbox_owner: sessionUser.role === "owner" }) : null, inboxMatch[1], ifStatus, String(sessionUser.id), sessionUser.role === "owner"],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "agent_inbox" });
            if (!result.rows[0] && ifStatus) return sendJson(res, 409, { error: "status_changed" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { inbox_item: result.rows[0] } : { error: "not_found" });
          }

          const phaseMatch = url.pathname.match(/^\/api\/mbox\/agent\/inbox\/(\d+)\/phase$/);
          if (phaseMatch && req.method === "GET") {
            const entry = jarvisPhase.get(phaseMatch[1]);
            return sendJson(res, 200, { phase: entry?.phase || null });
          }

          const cancelMatch = url.pathname.match(/^\/api\/mbox\/agent\/inbox\/(\d+)\/cancel$/);
          if (cancelMatch && req.method === "POST") {
            const controller = activeJarvisRequests.get(cancelMatch[1]);
            if (controller) controller.abort();
            await queryPostgres(
              `UPDATE agent_inbox SET status = 'done', updated_at = now()
               WHERE id = $1 AND (props->>'mbox_user_id' = $2 OR ($3::boolean AND NOT (props ? 'mbox_user_id')))`,
              [cancelMatch[1], String(sessionUser.id), sessionUser.role === "owner"],
            );
            return sendJson(res, 200, { ok: true, aborted: Boolean(controller) });
          }

          if (url.pathname === "/api/mbox/agent/runs") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
              if (!devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
              const result = await queryPostgres<Record<string, any>>(
                `INSERT INTO agent_runs(project_id, todo_id, agent_name, status, goal, read_context, commands, touched_files, result, props)
                 VALUES ($1, $2, $3, COALESCE(NULLIF($4, ''), 'running'), $5, $6, $7, $8, $9, $10)
                 RETURNING id::text, project_id::text, todo_id::text, agent_name, status, goal, touched_files, result`,
                [body.project_id || null, body.todo_id || null, String(body.agent_name || actorFromReq(req)), String(body.status || ""), String(body.goal || ""), JSON.stringify(Array.isArray(body.read_context) ? body.read_context : []), JSON.stringify(Array.isArray(body.commands) ? body.commands : []), JSON.stringify(Array.isArray(body.touched_files) ? body.touched_files : []), String(body.result || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
              );
              let auto_memory = null;
              if (result.rows[0] && ["done", "failed", "blocked"].includes(result.rows[0].status)) {
                auto_memory = await autoRecordMemory({
                  projectId: result.rows[0].project_id,
                  todoId: result.rows[0].todo_id,
                  agentRunId: result.rows[0].id,
                  sourceAgent: result.rows[0].agent_name || actorFromReq(req),
                  title: `РС‚РѕРі Р·Р°РїСѓСЃРєР°: ${result.rows[0].goal}`,
                  content: result.rows[0].result,
                  touchedFiles: result.rows[0].touched_files,
                  reason: "agent_run_created_finished",
                });
              }
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "agent_runs" });
              return sendJson(res, 201, { run: result.rows[0], auto_memory });
            }
            await closeStaleAgentRuns();
            const result = await queryPostgres(
              `SELECT id::text, project_id::text, todo_id::text, agent_name, status, goal, read_context, commands, touched_files, result, props,
                      pg_column_size(agent_runs)::int AS memory_bytes,
                      started_at::text, heartbeat_at::text, finished_at::text
               FROM agent_runs
               WHERE $1::boolean OR project_id = ANY($2::bigint[])
               ORDER BY started_at DESC
               LIMIT 100`,
              [devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, { runs: result.rows });
          }

          const runMatch = url.pathname.match(/^\/api\/mbox\/agent\/runs\/(\d+)$/);
          if (runMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const result = await queryPostgres<Record<string, any>>(
              `UPDATE agent_runs SET status = COALESCE(NULLIF($1, ''), status), result = COALESCE($2, result), commands = COALESCE($3, commands), touched_files = COALESCE($4, touched_files), props = COALESCE($5, props), heartbeat_at = now(), finished_at = CASE WHEN $6 THEN now() ELSE finished_at END
               WHERE id = $7
               RETURNING id::text, project_id::text, todo_id::text, agent_name, status, goal, touched_files, result`,
              [String(body.status || ""), body.result ?? null, Array.isArray(body.commands) ? JSON.stringify(body.commands) : null, Array.isArray(body.touched_files) ? JSON.stringify(body.touched_files) : null, body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, ["done", "failed", "blocked"].includes(String(body.status || "")), runMatch[1]],
            );
            let auto_memory = null;
            if (result.rows[0] && ["done", "failed", "blocked"].includes(String(body.status || ""))) {
              auto_memory = await autoRecordMemory({
                projectId: result.rows[0].project_id,
                todoId: result.rows[0].todo_id,
                agentRunId: result.rows[0].id,
                sourceAgent: result.rows[0].agent_name || actorFromReq(req),
                title: `Итог запуска: ${result.rows[0].goal}`,
                content: result.rows[0].result,
                touchedFiles: result.rows[0].touched_files,
                reason: "agent_run_finished",
              });
            }
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "agent_runs" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { run: result.rows[0], auto_memory } : { error: "not_found" });
          }

          if (url.pathname === "/api/mbox/decisions") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
              if (!devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
              const result = await queryPostgres(
                `INSERT INTO decision_log(project_id, todo_id, agent_run_id, actor, title, decision, rationale, impact, props)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING id::text`,
                [body.project_id || null, body.todo_id || null, body.agent_run_id || null, String(body.actor || actorFromReq(req)), String(body.title || "").trim(), String(body.decision || ""), String(body.rationale || ""), String(body.impact || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "decision_log" });
              return sendJson(res, 201, { decision: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, actor, title, decision, rationale, impact, props,
                      pg_column_size(decision_log)::int AS memory_bytes,
                      created_at::text
               FROM decision_log
               WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
                 AND ($1 = '' OR actor ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%' OR decision ILIKE '%' || $1 || '%'
                  OR rationale ILIKE '%' || $1 || '%' OR impact ILIKE '%' || $1 || '%')
               ORDER BY created_at DESC
               LIMIT 200`,
              [q, devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, { decisions: result.rows });
          }

          if (url.pathname === "/api/mbox/agent/next-task") {
            const projectName = url.searchParams.get("project") || "MBOX";
            const result = await queryPostgres(
              `SELECT t.id::text, t.title, t.note, t.status, t.priority, p.id::text AS project_id, p.name AS project_name
               FROM todos t
               JOIN projects p ON p.id = t.project_id
               WHERE p.name = $1 AND t.status IN ('next', 'open', 'doing', 'blocked', 'review')
               ORDER BY
                 CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                 CASE t.status WHEN 'doing' THEN 1 WHEN 'next' THEN 2 WHEN 'open' THEN 3 WHEN 'blocked' THEN 4 ELSE 5 END,
                 t.updated_at DESC
               LIMIT 1`,
              [projectName],
            );
            const task = result.rows[0] ?? null;
            if (task) task.memories = await relevantMemories(`${task.title}\n${task.note || ""}`, { projectId: task.project_id, todoId: task.id, limit: 5 });
            return sendJson(res, 200, { task });
          }

          if (url.pathname === "/api/mbox/agent/approved-secrets") {
            const projectName = url.searchParams.get("project") || "MBOX";
            const result = await queryPostgres(
              `SELECT s.id::text, s.title, s.login, s.url,
                      pgp_sym_decrypt(s.secret_ciphertext::bytea, $2) AS password,
                      s.approved_until::text, p.name AS project_name
               FROM protected_secrets s
               JOIN projects p ON p.id = s.project_id
               WHERE p.name = $1
                 AND s.agent_share_state = 'approved'
                 AND (s.approved_until IS NULL OR s.approved_until > now())
               ORDER BY s.updated_at DESC`,
              [projectName, process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key"],
            );
            return sendJson(res, 200, { secrets: result.rows });
          }

          if (url.pathname === "/api/mbox/secrets") {
            if (req.method === "POST") {
              const body = await readBody<{ project_id?: string | null; title?: string; login?: string; password?: string; url?: string }>(req);
              if (!devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
              const title = body.title?.trim() ?? "";
              const password = body.password ?? "";
              if (!title || !password) return sendJson(res, 400, { error: "title_and_password_required" });
              const result = await queryPostgres(
                `INSERT INTO protected_secrets(project_id, title, login, secret_ciphertext, url, access_level, agent_share_state)
                 VALUES ($6, $1, $2, pgp_sym_encrypt($3, $5), $4, 'private', 'locked')
                 RETURNING id::text, project_id::text, title, login, url, access_level, agent_share_state,
                           pg_column_size(protected_secrets)::int AS memory_bytes,
                           approved_until::text, updated_at::text`,
                [title, body.login?.trim() ?? "", password, body.url?.trim() ?? "", process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key", body.project_id || null],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "secrets" });
              return sendJson(res, 201, { secret: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, project_id::text, title, login, url, access_level, agent_share_state,
                      pg_column_size(protected_secrets)::int AS memory_bytes, approved_until::text, updated_at::text
               FROM protected_secrets
               WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
                 AND ($1 = '' OR title ILIKE '%' || $1 || '%' OR login ILIKE '%' || $1 || '%' OR url ILIKE '%' || $1 || '%')
               ORDER BY updated_at DESC LIMIT 100`,
              [q, devScope.all, devScope.projectIds],
            );
            return sendJson(res, 200, { secrets: result.rows });
          }

          const secretMatch = url.pathname.match(/^\/api\/mbox\/secrets\/(\d+)$/);
          if (secretMatch && req.method === "PATCH") {
            const body = await readBody<{ project_id?: string | null; agent_share_state?: string; approved_until?: string | null; title?: string; login?: string; password?: string; url?: string }>(req);
            if (body.project_id && !devHasProjectAccess(devScope, body.project_id)) return sendJson(res, 403, { error: "forbidden" });
            const title = body.title?.trim() ?? "";
            const login = typeof body.login === "string" ? body.login.trim() : null;
            const password = body.password ?? "";
            const secretKey = process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";
            const hasApprovedUntil = Object.prototype.hasOwnProperty.call(body, "approved_until");
            const result = await queryPostgres(
              `UPDATE protected_secrets
               SET project_id = COALESCE($1, project_id),
                   agent_share_state = COALESCE(NULLIF($2, ''), agent_share_state),
                   approved_until = CASE WHEN $10 THEN $3 ELSE approved_until END,
                   title = COALESCE(NULLIF($5, ''), title),
                   login = COALESCE($6, login),
                   url = COALESCE($7, url),
                   secret_ciphertext = CASE WHEN NULLIF($8, '') IS NULL THEN secret_ciphertext ELSE pgp_sym_encrypt($8, $9) END,
                   updated_at = now()
               WHERE id = $4 AND ($11::boolean OR project_id = ANY($12::bigint[]))
               RETURNING id::text, project_id::text, title, login, url, access_level, agent_share_state,
                         pg_column_size(protected_secrets)::int AS memory_bytes,
                         approved_until::text, updated_at::text`,
              [body.project_id || null, body.agent_share_state ?? "", body.approved_until || null, secretMatch[1], title, login, typeof body.url === "string" ? body.url.trim() : null, password, secretKey, hasApprovedUntil, devScope.all, devScope.projectIds],
            );
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "secrets" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { secret: result.rows[0] } : { error: "not_found" });
          }

          return sendJson(res, 404, { error: "not_found" });
        } catch (error) {
          return sendJson(res, 503, { error: error instanceof Error ? error.message : "unknown_error" });
        }
        });
      });
    },
  };
}

/**
 * Сборка пишет в public/ без очистки (там же лежат иконки), и каждый build оставлял прошлые
 * index-*.js/css рядом с новыми — в public/assets копились мегабайты мёртвых бандлов (их уже раз
 * вычищали руками, коммит 258c95c). После сборки убираем хешированные js/css/map, которых нет в новой.
 */
function pruneStaleBundles() {
  const produced = new Set<string>();
  let outDir = "";
  return {
    name: "mbox-prune-stale-bundles",
    apply: "build" as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      for (const fileName of Object.keys(bundle)) produced.add(path.basename(fileName));
    },
    closeBundle() {
      const assets = path.join(outDir, "assets");
      if (!produced.size || !fs.existsSync(assets)) return;
      for (const name of fs.readdirSync(assets)) {
        const hashed = /^[\w.-]+-[\w-]{8}\.(js|css)(\.map)?$/.test(name);
        if (hashed && !produced.has(name)) fs.rmSync(path.join(assets, name), { force: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), mboxDevApi(), pruneStaleBundles()],
  publicDir: false,
  server: { port: 5173 },
});
