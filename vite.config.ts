import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { WebSocket, WebSocketServer } from "ws";

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
const JARVIS_NAME = process.env.MBOX_AGENT_NAME || "Джарвис";

/** Подробный трейс поведения Джарвиса — шаг цикла, какой инструмент с какими аргументами,
 * что вернул. Раньше в логах было видно только финальный успех/провал, а не то, ПОЧЕМУ модель
 * решила вызвать именно этот инструмент или почему застряла. dev-сервер держит эти логи в stdout
 * терминала, где `npm run dev` запущен. */
function jlog(inboxId: unknown, message: string) {
  console.log(`[jarvis #${inboxId}] ${message}`);
}

// См. server/mbox-server.mjs — тот же живой фазовый статус для консоли в UI, опрашивается через
// GET /agent/inbox/:id/phase, пока висит "думает…".
const jarvisPhase = new Map<string, { phase: string; at: number }>();
function setPhase(inboxId: unknown, phase: string) {
  if (!inboxId) return;
  jarvisPhase.set(String(inboxId), { phase, at: Date.now() });
  setAgentPhase(JARVIS_NAME, phase);
}

const AGENT_PHASE_TTL_MS = 5 * 60 * 1000;
const agentPhase = new Map<string, { phase: string; at: number }>();
function setAgentPhase(agentName: string, phase: string) {
  if (!agentName) return;
  if (phase) agentPhase.set(agentName, { phase, at: Date.now() });
  else agentPhase.delete(agentName);
}
function getAgentPhase(agentName: string): string | null {
  const entry = agentPhase.get(agentName);
  if (!entry || Date.now() - entry.at > AGENT_PHASE_TTL_MS) return null;
  return entry.phase;
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// См. server/mbox-server.mjs — "Прораб" (GROQ_MODEL) ведёт диалог, "младший" — своя, куда более
// щедрая квота Groq для одноразовых скиллов вроде пересказа страницы, без оркестрации инструментами.
const GROQ_MODEL_JUNIOR = process.env.GROQ_MODEL_JUNIOR || "openai/gpt-oss-20b";
// См. server/mbox-server.mjs — Gemini теперь "прораб" вместо gpt-oss-120b (250K TPM против 8000),
// gpt-oss-120b остаётся резервом на этот же ответ при ошибке/лимите Gemini.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// См. server/mbox-server.mjs — сжатие истории диалога перед отправкой Прорабу, третий провайдер
// (Cloudflare Workers AI), опционально: без обоих значений сжатие просто не включается.
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_MODEL = process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.1-8b-instruct";

async function cloudflareSummarize(transcript: string): Promise<string | null> {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) return null;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_MODEL}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content: "Сожми переписку в компактную сводку на русском для другой модели, которая продолжит "
                + "разговор: кто о чём просил, что уже сделано или решено, какие конкретные факты (ID, даты, "
                + "числа, названия) упоминались — их терять нельзя. 4-8 предложений, без вступлений вроде "
                + "\"вот сводка\", сразу по делу.",
            },
            { role: "user", content: transcript },
          ],
        }),
      },
    );
    if (!response.ok) return null;
    const data = await response.json() as { result?: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } } };
    // См. server/mbox-server.mjs — Cloudflare-расход раньше нигде не логировался.
    const usage = data?.result?.usage || {};
    queryPostgres(
      "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
      ["history-compression", CLOUDFLARE_MODEL, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0],
    ).catch((error: Error) => console.error(`cloudflare usage insert failed: ${error.message}`));
    const text = data?.result?.response;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

// Fast-path — см. server/mbox-server.mjs. Детерминированные факты из БД, отвечаем мгновенно
// без обращения к Gemini/Groq. Намеренно узкий список паттернов.
async function tryFastPath(client: PoolClient, text: unknown): Promise<string | null> {
  const q = String(text || "").toLowerCase();

  if (/токен/.test(q) && /(сколько|расход|потрач|статистик|баланс)/.test(q)) {
    const rows = (await client.query(
      `SELECT model,
              sum(total_tokens)::bigint AS total,
              sum(total_tokens) FILTER (WHERE created_at > date_trunc('day', now()))::bigint AS today,
              sum(total_tokens) FILTER (WHERE created_at > now() - interval '24 hours')::bigint AS last24h,
              count(*)::int AS calls
       FROM groq_usage GROUP BY model ORDER BY sum(total_tokens) DESC`,
    )).rows as { model: string; total: string; today: string | null; last24h: string | null; calls: number }[];
    if (!rows.length) return "⚡ Расход токенов пока нулевой — ни одного вызова ещё не залогировано.";
    const lines = rows.map((r) => `${r.model}: сегодня ${r.today || 0}, за 24ч ${r.last24h || 0}, всего ${r.total} (${r.calls} вызовов)`);
    const grandTotal = rows.reduce((sum, r) => sum + Number(r.total), 0);
    return `⚡ Расход токенов по моделям:\n${lines.join("\n")}\n\nИтого по всем моделям: ${grandTotal}.`;
  }

  if (/(сколько|число|количество).*(задач|todo)/.test(q) && !/(в проекте|по проекту|про |о\s)/.test(q)) {
    const row = (await client.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status NOT IN ('done', 'archived'))::int AS open
       FROM todos`,
    )).rows[0] as { total: number; open: number };
    return `⚡ Задач всего: ${row.total}, из них не закрыто (open/next/doing/blocked/review): ${row.open}.`;
  }

  if (/(сколько|число|количество).*(запис|памят)/.test(q)) {
    const row = (await client.query("SELECT count(*)::int AS total FROM memories")).rows[0] as { total: number };
    return `⚡ Записей в памяти: ${row.total}.`;
  }

  if (/(статус|состояние).*сервер|как\s+(там\s+)?сервер/.test(q)) {
    const row = (await client.query(
      "SELECT hostname, load_1, cpu_percent, memory_used_mb, memory_total_mb, disk_used_mb, disk_total_mb, captured_at::text FROM server_metrics ORDER BY captured_at DESC LIMIT 1",
    )).rows[0] as { hostname: string; load_1: number; cpu_percent: number; memory_used_mb: number; memory_total_mb: number; disk_used_mb: number; disk_total_mb: number; captured_at: string } | undefined;
    if (!row) return "⚡ Метрик сервера пока нет.";
    return `⚡ Сервер ${row.hostname}: CPU ${row.cpu_percent}%, память ${row.memory_used_mb}/${row.memory_total_mb} МБ, `
      + `диск ${row.disk_used_mb}/${row.disk_total_mb} МБ, нагрузка ${row.load_1} (снято ${row.captured_at}).`;
  }

  return null;
}

type GroqMessage = {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; thoughtSignature?: string; function?: { name?: string; arguments?: string } }>;
};

// Запрос человека может лежать в очереди на прерывание (см. POST /agent/inbox/:id/cancel).
const activeJarvisRequests = new Map<string, AbortController>();

async function groqComplete(messages: GroqMessage[], tools?: unknown[], purpose = "reply", signal?: AbortSignal, attempt = 0, model = GROQ_MODEL): Promise<GroqMessage> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, ...(tools ? { tools, tool_choice: "auto" } : {}) }),
    signal,
  });
  // См. server/mbox-server.mjs — тот же ретрай на 429 с уважением Retry-After.
  if (response.status === 429) {
    // Живое наблюдение вечером 20 августа: формат ошибки бывает с часами/минутами ("1h23m4.5s"),
    // старый разбор ловил только число перед "s" и путал 4.5с с 1ч23м4.5с — ждал на порядки
    // меньше нужного. В тот же вечер дневной лимит (TPD) 200К токенов на gpt-oss-120b оказался
    // исчерпан целиком (реально потрачено 274К) — ждать в этом случае имеет смысл только до
    // полуночи. Если ожидание больше минуты — ретраить бессмысленно, падаем сразу честной ошибкой.
    const bodyText = await response.text();
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    const bodyMatch = bodyText.match(/try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
    const bodyWaitSec = bodyMatch ? Number(bodyMatch[1] || 0) * 3600 + Number(bodyMatch[2] || 0) * 60 + Number(bodyMatch[3]) : NaN;
    const waitSec = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader
      : Number.isFinite(bodyWaitSec) && bodyWaitSec > 0 ? bodyWaitSec
      : 3 * (attempt + 1);
    if (waitSec > 60 || attempt >= 2) throw new Error(`groq 429: лимит исчерпан, ждать ${Math.ceil(waitSec)}с — ${bodyText.slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitSec * 1000) + 500));
    return groqComplete(messages, tools, purpose, signal, attempt + 1, model);
  }
  if (!response.ok) throw new Error(`groq ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const usage = data.usage || {};
  queryPostgres(
    "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
    [purpose, model, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0],
  ).catch((error: Error) => console.error(`groq_usage insert failed: ${error.message}`));
  return data.choices?.[0]?.message ?? { role: "assistant", content: "" };
}

// См. server/mbox-server.mjs для полного объяснения этой пары функций (JSON Schema -> Gemini
// functionDeclarations, OpenAI-messages -> Gemini contents, thoughtSignature round-trip).
function toGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const out: any = Array.isArray(schema) ? [...schema] : { ...schema };
  if (typeof out.type === "string") out.type = out.type.toUpperCase();
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  if (out.items) out.items = toGeminiSchema(out.items);
  return out;
}

function toGeminiTools(openAiTools?: any[]) {
  if (!openAiTools?.length) return undefined;
  return [{ functionDeclarations: openAiTools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: toGeminiSchema(t.function.parameters) })) }];
}

function toGeminiContents(messages: GroqMessage[]) {
  const contents: Array<{ role: string; parts: any[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") { contents.push({ role: "user", parts: [{ text: m.content || "" }] }); continue; }
    if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        contents.push({
          role: "model",
          parts: m.tool_calls.map((tc) => ({
            functionCall: { name: tc.function?.name, args: JSON.parse(tc.function?.arguments || "{}") },
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          })),
        });
      } else {
        contents.push({ role: "model", parts: [{ text: m.content || "" }] });
      }
      continue;
    }
    if (m.role === "tool") {
      contents.push({ role: "user", parts: [{ functionResponse: { name: m.name || "tool", response: { result: m.content } } }] });
    }
  }
  return contents;
}

async function geminiComplete(messages: GroqMessage[], tools: unknown[] | undefined, purpose = "reply", signal?: AbortSignal): Promise<GroqMessage> {
  const systemText = messages.find((m) => m.role === "system")?.content || "";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(tools ? { tools: toGeminiTools(tools as any[]) } : {}),
      generationConfig: { temperature: 0.2 },
    }),
    signal,
  });
  if (!response.ok) {
    const error: any = new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const usage = data.usageMetadata || {};
  queryPostgres(
    "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
    [purpose, GEMINI_MODEL, usage.promptTokenCount || 0, usage.candidatesTokenCount || 0, usage.totalTokenCount || 0],
  ).catch((error: Error) => console.error(`gemini usage insert failed: ${error.message}`));
  const parts = data.candidates?.[0]?.content?.parts || [];
  const functionParts = parts.filter((p: any) => p.functionCall);
  const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join("");
  if (!functionParts.length) return { role: "assistant", content: text };
  return {
    role: "assistant",
    content: text,
    tool_calls: functionParts.map((p: any, index: number) => ({
      id: p.functionCall.id || `gem_${Date.now()}_${index}`,
      thoughtSignature: p.thoughtSignature,
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
    })),
  };
}

// Раньше Джарвис только писал текстом "задача добавлена", ничего не создав — модель не отличает
// выполненное действие от вежливой выдумки. Даём набор настоящих инструментов через tool calling.
const TODO_STATUSES = ["open", "next", "doing", "blocked", "review", "done", "archived"];
const TODO_PRIORITIES = ["low", "normal", "high", "urgent"];
// Инструменты, чей результат стоит показать сразу, не разворачивая весь трейс — создание/
// удаление/объединение сущностей, то, что человек реально хочет видеть с первого взгляда.
const HIGHLIGHT_TOOLS = new Set([
  "create_todo", "delete_todo", "merge_todos",
  "record_memory", "update_memory", "delete_memory",
  "create_project", "create_company", "create_artifact",
]);

const JARVIS_TOOLS = [
  {
    type: "function",
    function: {
      name: "create_todo",
      description: "Создать новую задачу (todo) в существующем проекте MBOX.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" },
          title: { type: "string", description: "Короткий заголовок задачи" },
          note: { type: "string", description: "Подробности задачи, необязательно" },
        },
        required: ["project_name", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description: "Создать новый проект в MBOX. Можно только с названием (пустой), а можно сразу заполнить то, что пользователь уже сказал словами — не переспрашивай то, что уже прозвучало в разговоре.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название нового проекта" },
          stack: { type: "array", items: { type: "string" }, description: "Технологический стек, если упомянут, необязательно" },
          git_url: { type: "string", description: "Ссылка на репозиторий, если упомянута, необязательно" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_project",
      description: "Удалить существующий проект вместе со всеми его задачами. Необратимо — название должно совпадать ТОЧНО.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Точное название проекта для удаления" } },
        required: ["project_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo_status",
      description: "Сменить статус существующей задачи, например пометить готовой или заблокированной.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живёт задача" },
          todo_title: { type: "string", description: "Заголовок задачи, максимально похожий на существующий" },
          status: { type: "string", enum: TODO_STATUSES, description: "Новый статус" },
        },
        required: ["project_name", "todo_title", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_todo_priority",
      description: "Сменить приоритет существующей задачи.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живёт задача" },
          todo_title: { type: "string", description: "Заголовок задачи, максимально похожий на существующий" },
          priority: { type: "string", enum: TODO_PRIORITIES, description: "Новый приоритет" },
        },
        required: ["project_name", "todo_title", "priority"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_todo",
      description: "Удалить задачу насовсем. Необратимо — заголовок задачи должен совпадать ТОЧНО.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живёт задача" },
          todo_title: { type: "string", description: "Точный заголовок задачи для удаления" },
        },
        required: ["project_name", "todo_title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "merge_todos",
      description: "Объединить несколько существующих задач одного проекта в одну новую. Используй, когда в проекте "
        + "накопилось несколько мелких/дублирующих задач по одной теме и явно лучше вести их одной — например, "
        + "просят «прибраться в задачах» или «объедини всё про X в одну». Не жди явной просьбы с готовыми ID: "
        + "если list_project_todos/search_todos показал россыпь мелких открытых задач на одну тему (например "
        + "несколько разных «сделай Джарвису инструменты для X», «доработай интерфейс Y») — САМ заметь кластеры "
        + "и предложи их объединить, прежде чем звать этот инструмент — дай человеку кратко увидеть, что именно "
        + "и во что объединится, и дождись согласия — крупными пачками по темам вести проще, чем десятком "
        + "мелких дублей. Исходные задачи не удаляются необратимо — переводятся в архив с пометкой, во что "
        + "объединены, их можно найти и восстановить. Для составления заголовка/описания объединённой задачи "
        + "из текста исходных удобно сперва воспользоваться delegate_to_junior, чтобы не тратить свой контекст "
        + "на черновик.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живут задачи" },
          todo_ids: { type: "array", items: { type: "string" }, description: "ID (числа) объединяемых задач, минимум два, все должны принадлежать этому проекту" },
          merged_title: { type: "string", description: "Заголовок новой объединённой задачи" },
          merged_note: { type: "string", description: "Описание новой объединённой задачи, необязательно" },
        },
        required: ["project_name", "todo_ids", "merged_title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_memory_cleanup",
      description: "Найти кандидатов на удаление в памяти — устаревшие технические логи (не факты/решения), "
        + "которые старше stale_days и привязаны к уже закрытым задачам (или вовсе без привязки). Вся тяжёлая "
        + "работа (поиск по базе, сверка со статусами задач) происходит на сервере — ты получаешь только "
        + "готовый компактный список ID, не тратишь свой контекст на чтение самих записей. Используй, когда "
        + "просят «прибраться в памяти» или «удали старые логи» — это НЕ то же самое, что глубокий смысловой "
        + "разбор дублей, для которого зовут Claude. После вызова ПОКАЖИ список человеку и жди подтверждения, "
        + "прежде чем звать delete_memory на конкретные ID — не удаляй сразу без явного согласия в этом же "
        + "разговоре.",
      parameters: {
        type: "object",
        properties: {
          stale_days: { type: "number", description: "Считать устаревшим то, что не менялось дольше стольких дней. По умолчанию 21." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_memory",
      description: "Записать факт в память MBOX — то, что стоит запомнить надолго (предпочтение пользователя, удачный или неудачный подход, важное решение).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Короткий заголовок факта" },
          content: { type: "string", description: "Сам факт" },
          project_name: { type: "string", description: "Название проекта, если факт относится к конкретному проекту, необязательно" },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_project_todos",
      description: "Посмотреть список задач конкретного проекта с их статусом и приоритетом.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" } },
        required: ["project_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_info",
      description: "Посмотреть карточку проекта: ссылку на git, стек, деплой, уровень доступа.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" } },
        required: ["project_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_companies",
      description: "Список компаний в MBOX — это НЕ проекты: компания объединяет несколько связанных проектов. Вопросы про юрлицо, контакты, бренд, реквизиты, тон общения, бизнес-контекст — это компания.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_company_info",
      description: "Посмотреть карточку компании целиком: юрлицо, контакты, бренд, продукты, связанные проекты. Используй вместо get_project_info, когда речь о компании, а не о конкретном техническом проекте.",
      parameters: {
        type: "object",
        properties: { company_name: { type: "string", description: "Название компании, максимально похожее на одну из существующих" } },
        required: ["company_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "Поискать в записанной памяти MBOX по ключевым словам (факты, предпочтения, решения).",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Ключевые слова для поиска" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory",
      description: "Вывести ПОЛНЫЙ текст записи памяти по её номеру (ID) — search_memory отдаёт только короткий обрезанный summary, этим инструментом читай запись целиком, когда попросят «выведи полностью», «покажи запись #N» и т.п.",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Номер записи (ID), обычно виден в результатах search_memory" } },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory_actions",
      description: "История изменений конкретной записи памяти по её ID (кто и когда создавал/правил/удалял) — используй для вопросов «кто это записал», «когда правили в последний раз».",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Номер записи (ID)" } },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memory_links",
      description: "Связанные записи памяти для конкретной записи по её ID — используй на вопросы «с чем это связано», «что ещё касается этой темы».",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Номер записи (ID)" } },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task",
      description: "Вывести ПОЛНУЮ карточку задачи (описание, статус, приоритет, проект) по её номеру (ID) — list_project_todos и search_todos отдают только обрезанные превью, этим инструментом читай задачу целиком по номеру.",
      parameters: {
        type: "object",
        properties: { todo_id: { type: "string", description: "Номер задачи (ID)" } },
        required: ["todo_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_todos",
      description: "Найти задачи по тексту в заголовке ИЛИ в описании (note) — list_project_todos видит только заголовки, этот инструмент ищет по содержимому задачи.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Текст для поиска" },
          project_name: { type: "string", description: "Ограничить поиск одним проектом, необязательно" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo_note",
      description: "Записать или дополнить описание (note) существующей задачи — например, зафиксировать детали, найденные в разговоре.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живёт задача" },
          todo_title: { type: "string", description: "Заголовок задачи, максимально похожий на существующий" },
          note: { type: "string", description: "Текст, который нужно записать в описание" },
          mode: { type: "string", enum: ["append", "replace"], description: "append — дописать к текущему описанию (по умолчанию), replace — заменить целиком" },
        },
        required: ["project_name", "todo_title", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_projects",
      description: "Связать два существующих проекта отношением (например «использует», «зависит от», «часть»). Появится в графе связей.",
      parameters: {
        type: "object",
        properties: {
          project_a: { type: "string", description: "Название первого проекта" },
          project_b: { type: "string", description: "Название второго проекта" },
          relation: { type: "string", description: "Тип связи одним-двумя словами, например «зависит от», «использует», «часть»" },
          description: { type: "string", description: "Пояснение связи, необязательно" },
        },
        required: ["project_a", "project_b"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_decision",
      description: "Записать важное решение с обоснованием (не просто факт — именно ВЫБОР между вариантами и почему). Для фактов используй record_memory.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Короткий заголовок решения" },
          decision: { type: "string", description: "Что именно решили" },
          rationale: { type: "string", description: "Почему так решили, необязательно" },
          project_name: { type: "string", description: "Название проекта, если решение относится к конкретному, необязательно" },
        },
        required: ["title", "decision"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_groq_usage",
      description: "Посмотреть расход токенов ПО ВСЕМ моделям, которыми ты говоришь — и Groq, и Gemini (обе логируются в один и тот же счётчик) — с разбивкой по модели, сегодня/за сутки/всего. Название историческое, но это НЕ только Groq: используй именно этот инструмент, если спросят про расход Gemini, а не отвечай, что не умеешь это узнать.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_recent_activity",
      description: "Посмотреть последние события в MBOX — что менялось (созданные/изменённые задачи, проекты, записи). Можно ограничить одним проектом.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Ограничить одним проектом, необязательно" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_file",
      description: "Найти путь к файлу в структуре репозитория проекта — только список путей, без содержимого файлов (у тебя нет доступа к файловой системе). Структуру публикуют локальные агенты через set_repo_structure, если проект ещё не публиковал — так и скажи.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта" },
          query: { type: "string", description: "Часть имени файла или пути" },
        },
        required: ["project_name", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_data_sources",
      description: "Список источников данных — внешних сайтов/API, которые MBOX сам периодически перечитывает по графику и держит в памяти свежую сводку.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Ограничить одним проектом, необязательно" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_data_source",
      description: "Завести новый источник данных: URL, который MBOX будет сам периодически перечитывать и класть сводку в память. Нужен проект ИЛИ компания, к которой привязать.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Короткое название источника, например «Сайт vs-travel.ru»" },
          url: { type: "string", description: "Полный адрес страницы или API" },
          project_name: { type: "string", description: "Проект, к которому привязать — если это не компания" },
          company_name: { type: "string", description: "Компания, к которой привязать — если это не проект" },
          schedule_minutes: { type: "number", description: "Как часто перечитывать, в минутах. По умолчанию раз в сутки (1440)." },
          kind: { type: "string", enum: ["webpage", "tours_xml"], description: "webpage (по умолчанию) — обычная страница, пересказывается через Groq. tours_xml — структурированный XML-фид туров вида vs-travel.ru/prices/tours.xml, разбирается в таблицу дат/мест, не пересказывается." },
        },
        required: ["name", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_data_source",
      description: "Перечитать источник данных прямо сейчас, не дожидаясь графика.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Название источника, максимально похожее на существующее" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tour_dates",
      description: "Найти ближайшие даты и свободные места по названию тура из разобранного фида vs-travel.ru (kind='tours_xml' источник данных). Отвечай ЭТИМ инструментом на вопросы вроде «какие даты у тура X» или «сколько мест на ближайшую дату тура Y» — не придумывай цифры и не ищи в памяти.",
      parameters: {
        type: "object",
        properties: {
          tour_name: { type: "string", description: "Название тура или его часть, максимально похожее на реальное" },
          only_available: { type: "boolean", description: "Только даты со свободными местами, по умолчанию false" },
        },
        required: ["tour_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_posts",
      description: "Найти реальные инсайты по постам Telegram-канала (memories entity_type='post', папка «Посты»): что заходит, что нет, сравнение с фото/без, топ и антитоп. Считает по-настоящему из сырых данных (лайки/дата публикации) — не выдумывай цифры и форматы, отвечай на вопросы про эффективность контента ТОЛЬКО этим инструментом.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["summary", "top", "bottom", "by_photo"],
            description: "summary (по умолчанию) — общая сводка; top/bottom — лучшие/худшие посты по скорости набора реакций (с поправкой на давность публикации); by_photo — сравнение постов с фото и без.",
          },
          limit: { type: "number", description: "Сколько постов показать для top/bottom, по умолчанию 10" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description: "Отредактировать существующую запись памяти по её ID — заголовок, содержание (дописать или заменить) или теги.",
      parameters: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Номер записи (ID)" },
          title: { type: "string", description: "Новый заголовок, необязательно" },
          content: { type: "string", description: "Новое содержание, необязательно" },
          mode: { type: "string", enum: ["append", "replace"], description: "Как применить content: append — дописать к текущему, replace (по умолчанию) — заменить целиком" },
          tags: { type: "array", items: { type: "string" }, description: "Новый набор тегов — ЗАМЕНЯЕТ старый целиком, необязательно" },
        },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description: "Удалить запись памяти насовсем по её ID. Необратимо.",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Номер записи (ID) для удаления" } },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_company",
      description: "Завести новую компанию в MBOX — контейнер верхнего уровня, который потом может владеть несколькими проектами.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название новой компании" },
          props: { type: "object", description: "Произвольные свойства ключ-значение (юрлицо, контакты и т.п.), необязательно" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_company_info",
      description: "Дополнить или изменить карточку компании — записать новые свойства (юрлицо, контакты, бренд и т.п.) поверх существующих, старые не заполненные поля не трогает.",
      parameters: {
        type: "object",
        properties: {
          company_name: { type: "string", description: "Название компании, максимально похожее на существующую" },
          props: { type: "object", description: "Свойства ключ-значение для добавления/обновления" },
        },
        required: ["company_name", "props"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project_info",
      description: "Изменить карточку проекта — стек, ссылку на git, деплой или статус. Указывай только то, что нужно поменять.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" },
          stack: { type: "array", items: { type: "string" }, description: "Новый технологический стек, необязательно" },
          git_url: { type: "string", description: "Новая ссылка на репозиторий, необязательно" },
          deploy_provider: { type: "string", description: "Новый провайдер деплоя, необязательно" },
          deploy_target: { type: "string", description: "Новая цель деплоя, необязательно" },
          status: { type: "string", description: "Новый статус проекта, необязательно" },
        },
        required: ["project_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_folder",
      description: "Создать новую папку для организации памяти/артефактов/проектов/задач/скриптов/агентских областей.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название новой папки" },
          entity_type: { type: "string", enum: ["memory", "artifact", "project", "todo", "script", "agent_scope"], description: "Тип содержимого папки" },
          parent_name: { type: "string", description: "Название родительской папки, если это вложенная папка, необязательно" },
        },
        required: ["name", "entity_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_folders",
      description: "Посмотреть список существующих папок, можно ограничить типом содержимого.",
      parameters: {
        type: "object",
        properties: { entity_type: { type: "string", enum: ["memory", "artifact", "project", "todo", "script", "agent_scope"], description: "Ограничить одним типом, необязательно" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_memories",
      description: "Связать две записи памяти между собой отношением — например «связано», «противоречит», «уточняет».",
      parameters: {
        type: "object",
        properties: {
          memory_a_id: { type: "string", description: "Номер первой записи (ID)" },
          memory_b_id: { type: "string", description: "Номер второй записи (ID)" },
          relation: { type: "string", description: "Тип связи одним-двумя словами, по умолчанию «related»" },
          description: { type: "string", description: "Пояснение связи, необязательно" },
        },
        required: ["memory_a_id", "memory_b_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_artifacts",
      description: "Посмотреть список артефактов (осознанных находок/материалов, не сырого контента) — можно ограничить проектом.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Ограничить одним проектом, необязательно" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_artifact",
      description: "Создать новый артефакт — осознанную находку или материал (например компонент, конфиг, решение), в отличие от сырой записи памяти.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название артефакта" },
          category: { type: "string", description: "Категория артефакта, например «component», «config», «decision»" },
          content: { type: "string", description: "Содержимое артефакта" },
          project_name: { type: "string", description: "Проект, к которому привязать, необязательно" },
        },
        required: ["name", "category", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_to_junior",
      description: "Делегировать младшей модели небольшую самостоятельную текстовую подзадачу (черновик, сводка, пересказ, классификация) внутри цепочки действий — экономит твой контекст: результат приходит готовым, ты не тратишь токены на сам черновик. НЕ для задач, которые сами требуют вызова инструментов — младшая модель не имеет доступа к инструментам, только текст на входе и текст на выходе.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Что должна сделать младшая модель, одним предложением" },
          input: { type: "string", description: "Исходный текст/данные для обработки" },
        },
        required: ["task", "input"],
      },
    },
  },
];

type PostStat = { id: string; title: string; hasPhoto: boolean; reactionsTotal: number; postedAt: string | null; rate: number };

function postEngagementRate(reactionsTotal: number, postedAt: string | null) {
  const posted = postedAt ? new Date(postedAt).getTime() : NaN;
  const days = Number.isFinite(posted) ? Math.max(1, (Date.now() - posted) / 86400000) : 1;
  return reactionsTotal / days;
}

async function loadPostStats(): Promise<PostStat[]> {
  const rows = (await queryPostgres("SELECT id::text, title, metadata FROM memories WHERE entity_type = 'post'", [])).rows as { id: string; title: string; metadata: Record<string, unknown> }[];
  return rows.map((row) => {
    const metadata = row.metadata || {};
    const reactionsTotal = Number(metadata.reactions_total) || 0;
    const postedAt = typeof metadata.posted_at === "string" ? metadata.posted_at : null;
    return { id: row.id, title: row.title, hasPhoto: Boolean(metadata.has_photo), reactionsTotal, postedAt, rate: postEngagementRate(reactionsTotal, postedAt) };
  });
}

function excerptAround(text: string, query: string, radius: number) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return text.slice(start, end);
}

function matchProjectFuzzy(projectName: unknown, projectList: { id: string; name: string }[]) {
  const q = String(projectName || "").trim().toLowerCase();
  return projectList.find((p) => p.name.toLowerCase() === q)
    || projectList.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
}

function matchCompanyFuzzy(companyName: unknown, companyList: { id: string; name: string }[]) {
  const q = String(companyName || "").trim().toLowerCase();
  return companyList.find((c) => c.name.toLowerCase() === q)
    || companyList.find((c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()));
}

async function matchTodoFuzzy(client: PoolClient, projectId: string, todoTitle: unknown, exact = false) {
  const rows = (await client.query("SELECT id::text, title, status, priority, note FROM todos WHERE project_id = $1", [projectId])).rows as { id: string; title: string; status: string; priority: string; note: string }[];
  const q = String(todoTitle || "").trim();
  if (exact) return rows.find((t) => t.title === q);
  const qLower = q.toLowerCase();
  return rows.find((t) => t.title.toLowerCase() === qLower)
    || rows.find((t) => t.title.toLowerCase().includes(qLower) || qLower.includes(t.title.toLowerCase()));
}

/** См. server/mbox-server.mjs — тот же разбор, тот же фикс (упавший инструмент не роняет весь ответ). */
function describeToolFailure(name: string, error: { code?: string; message?: string } | unknown): string {
  const err = error as { code?: string; message?: string };
  if (err?.code === "23505") return `${name}: такая запись уже существует — не создаю дубликат`;
  const message = String(err?.message || error || "").slice(0, 200);
  return `${name}: не выполнено (${message || "внутренняя ошибка"})`;
}

async function logJarvisError({ source = "reply", toolName = "", inboxId = null, projectId = null, message }: { source?: string; toolName?: string; inboxId?: string | number | null; projectId?: string | number | null; message: string }) {
  try {
    await queryPostgres(
      "INSERT INTO jarvis_errors(source, tool_name, inbox_id, project_id, message) VALUES ($1, $2, $3, $4, $5)",
      [source, toolName, inboxId, projectId, String(message || "").slice(0, 2000)],
    );
  } catch (error) {
    console.error(`jarvis_errors insert failed: ${(error as Error).message}`);
  }
}

/** См. server/mbox-server.mjs — общая логика для REST-ручки refresh и инструмента Джарвиса. */
type TourSheetItem = { tour_id: string; sheet_id: string; tour_name: string; route_name: string; date_start: string | null; date_end: string | null; free_places: number; price_from: number };

function parseFeedDate(raw: string | undefined): string | null {
  const match = String(raw || "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function decodeXmlEntities(text: string | undefined): string {
  return String(text || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** См. server/mbox-server.mjs — тот же разбор фида туров vs-travel.ru, тот же порядок совпадений. */
function parseTourFeed(xml: string): TourSheetItem[] {
  const items: TourSheetItem[] = [];
  const tourRe = /<tour>([\s\S]*?)<\/tour>/g;
  let tourMatch: RegExpExecArray | null;
  while ((tourMatch = tourRe.exec(xml))) {
    const tourBlock = tourMatch[1];
    const tourId = (tourBlock.match(/<tour_id>([\s\S]*?)<\/tour_id>/) || [])[1] || "";
    const tourName = decodeXmlEntities((tourBlock.match(/<tour_name>([\s\S]*?)<\/tour_name>/) || [])[1]).trim();
    const routeName = decodeXmlEntities((tourBlock.match(/<route_name>([\s\S]*?)<\/route_name>/) || [])[1]).trim();
    if (!tourName) continue;
    const sheetRe = /<sheets>([\s\S]*?)<\/sheets>/g;
    let sheetMatch: RegExpExecArray | null;
    while ((sheetMatch = sheetRe.exec(tourBlock))) {
      const sheetBlock = sheetMatch[1];
      const sheetId = (sheetBlock.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "";
      if (!sheetId) continue;
      items.push({
        tour_id: tourId,
        sheet_id: sheetId,
        tour_name: tourName,
        route_name: routeName,
        date_start: parseFeedDate((sheetBlock.match(/<date_start>([\s\S]*?)<\/date_start>/) || [])[1]),
        date_end: parseFeedDate((sheetBlock.match(/<date_end>([\s\S]*?)<\/date_end>/) || [])[1]),
        free_places: Number((sheetBlock.match(/<free_places>([\s\S]*?)<\/free_places>/) || [])[1]) || 0,
        price_from: Number((sheetBlock.match(/<price_from>([\s\S]*?)<\/price_from>/) || [])[1]) || 0,
      });
    }
  }
  return items;
}

async function bulkUpsertTourSheets(sourceId: string, items: TourSheetItem[]): Promise<{ upserted: number; removed: number }> {
  // См. server/mbox-server.mjs — сравнение по времени между JS-клиентом и Postgres ловит рассинхрон
  // часов (живой прогон стёр все только что вставленные строки). Ключ теперь — множество sheet_id.
  const BATCH = 400;
  const seenSheetIds: string[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH).map((item) => ({ source_id: sourceId, ...item }));
    await queryPostgres(
      `INSERT INTO tour_sheets (source_id, tour_id, sheet_id, tour_name, route_name, date_start, date_end, free_places, price_from, updated_at)
       SELECT v.source_id::bigint, v.tour_id, v.sheet_id, v.tour_name, v.route_name, v.date_start::date, v.date_end::date, v.free_places::int, v.price_from::int, now()
       FROM jsonb_to_recordset($1::jsonb) AS v(source_id text, tour_id text, sheet_id text, tour_name text, route_name text, date_start text, date_end text, free_places int, price_from int)
       ON CONFLICT (source_id, sheet_id) DO UPDATE SET
         tour_name = EXCLUDED.tour_name, route_name = EXCLUDED.route_name,
         date_start = EXCLUDED.date_start, date_end = EXCLUDED.date_end,
         free_places = EXCLUDED.free_places, price_from = EXCLUDED.price_from,
         updated_at = now()`,
      [JSON.stringify(chunk)],
    );
    seenSheetIds.push(...chunk.map((item) => item.sheet_id));
  }
  if (!seenSheetIds.length) return { upserted: 0, removed: 0 };
  const removed = await queryPostgres(
    "DELETE FROM tour_sheets WHERE source_id = $1 AND NOT (sheet_id = ANY($2::text[])) RETURNING id",
    [sourceId, seenSheetIds],
  );
  return { upserted: items.length, removed: removed.rows.length };
}

async function refreshDataSourceById(id: string, opts: { inboxId?: unknown } = {}): Promise<{ ok: boolean; summary: string; error?: string }> {
  const { inboxId } = opts;
  const row = (await queryPostgres("SELECT id::text, project_id::text, name, url, access_level, kind, last_memory_id::text FROM data_sources WHERE id = $1", [id])).rows[0] as { id: string; project_id: string | null; name: string; url: string; access_level: string; kind: string; last_memory_id: string | null } | undefined;
  if (!row) return { ok: false, summary: "", error: "источник не найден" };

  if (row.kind === "tours_xml") {
    try {
      const response = await fetch(row.url, { redirect: "follow" });
      if (!response.ok) throw new Error(`fetch ${response.status}`);
      const xml = await response.text();
      const items = parseTourFeed(xml);
      const { upserted, removed } = await bulkUpsertTourSheets(row.id, items);
      const summary = `разобрано ${upserted} дат, снято с продажи ${removed}`;
      await queryPostgres("UPDATE data_sources SET last_fetched_at = now(), last_status = 'ok', last_summary = $1, updated_at = now() WHERE id = $2", [summary, row.id]);
      return { ok: true, summary };
    } catch (error) {
      await queryPostgres("UPDATE data_sources SET last_fetched_at = now(), last_status = 'error', last_summary = $1, updated_at = now() WHERE id = $2", [String((error as Error).message || error).slice(0, 500), row.id]);
      return { ok: false, summary: "", error: (error as Error).message || String(error) };
    }
  }

  try {
    const response = await fetch(row.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`fetch ${response.status}`);
    const html = await response.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
    // Одноразовый пересказ, не оркестрация — отдаём младшей модели, см. server/mbox-server.mjs.
    setPhase(inboxId, "Делегирует младшему агенту");
    const digestMessage = await groqComplete(
      [
        { role: "system", content: "Сделай короткую сводку веб-страницы для системы памяти: 5-10 пунктов, факты и цифры, без воды, на русском." },
        { role: "user", content: text || "(пустая страница)" },
      ],
      undefined,
      "skill-webpage-summary",
      undefined,
      0,
      GROQ_MODEL_JUNIOR,
    );
    const digest = String(digestMessage.content || "").trim().slice(0, 3000);
    let memoryId = row.last_memory_id;
    if (memoryId) {
      await queryPostgres("UPDATE memories SET content = $1, updated_at = now() WHERE id = $2", [digest, memoryId]);
    } else {
      const createdMemory = await queryPostgres(
        `INSERT INTO memories(project_id, title, content, entity_type, access_level, tags, metadata)
         VALUES ($1, $2, $3, 'fact', $4, $5, $6) RETURNING id::text`,
        [row.project_id, `Источник: ${row.name}`, digest, row.access_level || "agents", ["источник-данных"], JSON.stringify({ source_agent: JARVIS_NAME, data_source_id: row.id, data_source_url: row.url })],
      );
      memoryId = (createdMemory.rows[0] as { id: string }).id;
    }
    await queryPostgres(
      "UPDATE data_sources SET last_fetched_at = now(), last_status = 'ok', last_summary = $1, last_memory_id = $2, updated_at = now() WHERE id = $3",
      [digest.slice(0, 500), memoryId, row.id],
    );
    return { ok: true, summary: digest };
  } catch (error) {
    await queryPostgres("UPDATE data_sources SET last_fetched_at = now(), last_status = 'error', last_summary = $1, updated_at = now() WHERE id = $2", [String((error as Error).message || error).slice(0, 500), row.id]);
    return { ok: false, summary: "", error: (error as Error).message || String(error) };
  }
}

async function runJarvisTool(client: PoolClient, name: string | undefined, rawArgs: string | undefined, projectList: { id: string; name: string }[], inboxId?: unknown): Promise<string> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(rawArgs || "{}"); } catch { /* кривой JSON от модели — работаем без аргументов */ }

  if (name === "create_project") {
    const projectName = String(args.name || "").trim();
    if (!projectName) return "не создал проект — нет названия";
    const stack = Array.isArray(args.stack) ? args.stack.map(String) : [];
    const gitUrl = String(args.git_url || "").trim();
    const inserted = await client.query(
      `INSERT INTO projects(name, status, stack, git_url, access_level, props) VALUES ($1, 'active', $2, $3, 'private', '{}') RETURNING id::text`,
      [projectName, JSON.stringify(stack), gitUrl || null],
    );
    projectList.push({ id: inserted.rows[0].id as string, name: projectName });
    const extra = [stack.length ? `стек: ${stack.join(", ")}` : "", gitUrl ? `git: ${gitUrl}` : ""].filter(Boolean).join(", ");
    return `создан проект «${projectName}»${extra ? ` (${extra})` : ""} (#${inserted.rows[0].id})`;
  }

  if (name === "delete_project") {
    const projectName = String(args.project_name || "").trim();
    const match = projectList.find((p) => p.name === projectName);
    if (!match) return `не нашёл проект «${projectName}» с точным названием — есть: ${projectList.map((p) => p.name).join(", ")}`;
    await client.query("DELETE FROM projects WHERE id = $1", [match.id]);
    const index = projectList.indexOf(match);
    if (index !== -1) projectList.splice(index, 1);
    return `удалён проект «${match.name}» (#${match.id})`;
  }

  if (name === "create_todo") {
    const title = String(args.title || "").trim();
    if (!title) return "не создал задачу — нет заголовка";
    const match = matchProjectFuzzy(args.project_name, projectList);
    if (!match) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const inserted = await client.query(
      `INSERT INTO todos(project_id, title, note, status, priority, props, access_level)
       VALUES ($1, $2, $3, 'open', 'normal', '{}', 'private') RETURNING id::text`,
      [match.id, title, String(args.note || "")],
    );
    return `создана задача «${title}» в проекте «${match.name}» (#${inserted.rows[0].id})`;
  }

  if (name === "update_todo_status" || name === "set_todo_priority") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(client, project.id, args.todo_title);
    if (!todo) return `не нашёл задачу «${args.todo_title}» в проекте «${project.name}»`;
    if (name === "update_todo_status") {
      const status = TODO_STATUSES.includes(String(args.status)) ? String(args.status) : null;
      if (!status) return `неизвестный статус «${args.status}» — доступны: ${TODO_STATUSES.join(", ")}`;
      await client.query("UPDATE todos SET status = $1, updated_at = now() WHERE id = $2", [status, todo.id]);
      return `задача «${todo.title}» теперь в статусе «${status}» (была «${todo.status}»)`;
    }
    const priority = TODO_PRIORITIES.includes(String(args.priority)) ? String(args.priority) : null;
    if (!priority) return `неизвестный приоритет «${args.priority}» — доступны: ${TODO_PRIORITIES.join(", ")}`;
    await client.query("UPDATE todos SET priority = $1, updated_at = now() WHERE id = $2", [priority, todo.id]);
    return `у задачи «${todo.title}» теперь приоритет «${priority}» (был «${todo.priority}»)`;
  }

  if (name === "delete_todo") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(client, project.id, args.todo_title, true);
    if (!todo) return `не нашёл задачу с точным заголовком «${args.todo_title}» в проекте «${project.name}»`;
    await client.query("DELETE FROM todos WHERE id = $1", [todo.id]);
    return `удалена задача «${todo.title}» из проекта «${project.name}»`;
  }

  if (name === "merge_todos") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const ids = Array.isArray(args.todo_ids) ? [...new Set((args.todo_ids as unknown[]).map((id) => String(id).trim()).filter((id) => /^\d+$/.test(id)))] : [];
    if (ids.length < 2) return "нужно минимум два числовых ID задачи в todo_ids";
    const mergedTitle = String(args.merged_title || "").trim();
    if (!mergedTitle) return "не объединил — нужен заголовок объединённой задачи";
    const rows = (await client.query("SELECT id::text, title, priority, note FROM todos WHERE id = ANY($1::bigint[]) AND project_id = $2", [ids, project.id])).rows as { id: string; title: string; priority: string; note: string }[];
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !found.has(id));
      return `не нашёл в проекте «${project.name}» задачи с ID: ${missing.join(", ")} — объединение отменено, ничего не тронуто`;
    }
    const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    const mergedPriority = rows.reduce((best, r) => (priorityRank[r.priority] ?? 9) < (priorityRank[best] ?? 9) ? r.priority : best, "low");
    const inserted = await client.query(
      `INSERT INTO todos(project_id, title, note, status, priority, props, access_level)
       VALUES ($1, $2, $3, 'open', $4, '{}', 'private') RETURNING id::text`,
      [project.id, mergedTitle, String(args.merged_note || ""), mergedPriority],
    );
    const newId = (inserted.rows[0] as { id: string }).id;
    await client.query(
      `UPDATE todos SET status = 'archived', note = note || $1, claimed_by = '', claimed_until = NULL, updated_at = now() WHERE id = ANY($2::bigint[])`,
      [`\n\n[Объединено в «${mergedTitle}» #${newId}]`, ids],
    );
    return `объединил ${rows.length} задач (${rows.map((r) => `#${r.id} «${r.title}»`).join(", ")}) в новую «${mergedTitle}» (#${newId}, приоритет ${mergedPriority}); исходные переведены в архив с пометкой`;
  }

  if (name === "review_memory_cleanup") {
    const staleDays = Math.min(Math.max(Number(args.stale_days) || 21, 7), 90);
    const rows = (await client.query(
      `SELECT id::text, title, todo_id::text, metadata, updated_at::text
       FROM memories
       WHERE updated_at < now() - ($1 || ' days')::interval
         AND (entity_type = 'log' OR tags @> ARRAY['agent-work']::text[])
       ORDER BY updated_at ASC
       LIMIT 15`,
      [staleDays],
    )).rows as { id: string; title: string; todo_id: string | null; metadata: Record<string, unknown> }[];
    if (!rows.length) return `не нашёл кандидатов на уборку — нет технических логов старше ${staleDays} дней`;
    const doneTodoIds = new Set((await client.query("SELECT id::text FROM todos WHERE status IN ('done', 'archived')")).rows.map((r: { id: string }) => r.id));
    const candidates = rows.filter((m) => {
      const linkedTodoId = m.todo_id || (m.metadata?.todo_id as string | undefined);
      return !linkedTodoId || doneTodoIds.has(String(linkedTodoId));
    });
    if (!candidates.length) return `нашёл ${rows.length} старых технических логов, но все привязаны к ещё открытым задачам — не трогаю`;
    const lines = candidates.map((m) => `#${m.id} «${m.title}»`).join(", ");
    return `кандидаты на удаление (${candidates.length} из ${rows.length} проверенных, технические логи старше ${staleDays} дней, без связи с открытыми задачами): ${lines}. Покажи это человеку и жди подтверждения, прежде чем звать delete_memory на конкретные ID.`;
  }

  if (name === "record_memory") {
    const title = String(args.title || "").trim();
    const content = String(args.content || "").trim();
    if (!title || !content) return "не записал факт — нужны и заголовок, и содержание";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const inserted = await client.query(
      `INSERT INTO memories(project_id, title, content, entity_type, access_level, tags, metadata)
       VALUES ($1, $2, $3, 'fact', 'agents', '{}', $4) RETURNING id::text`,
      [project?.id || null, title, content, JSON.stringify({ source_agent: JARVIS_NAME })],
    );
    return `записал в память: «${title}»${project ? ` (проект «${project.name}»)` : ""} (#${inserted.rows[0].id})`;
  }

  if (name === "list_project_todos") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const rows = (await client.query(
      `SELECT title, status, priority, count(*) OVER()::int AS total_count
       FROM todos WHERE project_id = $1
       ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, updated_at DESC
       LIMIT 20`,
      [project.id],
    )).rows as { title: string; status: string; priority: string; total_count: number }[];
    if (!rows.length) return `у проекта «${project.name}» пока нет задач`;
    const total = rows[0].total_count;
    const truncated = total > rows.length;
    const lines = rows.map((t) => `[${t.status}/${t.priority}] ${t.title}`);
    return `задачи проекта «${project.name}» (показаны ${rows.length}${truncated ? ` из ${total} — список НЕ полный, для остальных используй search_todos` : ""}): ${lines.join("; ")}`;
  }

  if (name === "get_project_info") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const row = (await client.query(
      "SELECT git_url, stack, deploy_provider, deploy_target, access_level, props FROM projects WHERE id = $1",
      [project.id],
    )).rows[0] as { git_url: string | null; stack: string[]; deploy_provider: string | null; deploy_target: string | null; access_level: string; props: Record<string, unknown> | null };
    const parts = [
      row.git_url ? `git: ${row.git_url}` : "git не указан",
      Array.isArray(row.stack) && row.stack.length ? `стек: ${row.stack.join(", ")}` : "стек не указан",
      row.deploy_target || row.deploy_provider ? `деплой: ${[row.deploy_provider, row.deploy_target].filter(Boolean).join(" / ")}` : "деплой не указан",
      `доступ: ${row.access_level}`,
    ];
    const props = row.props && typeof row.props === "object" ? row.props : {};
    const descriptiveKeys = Object.keys(props).filter((key) => !key.startsWith("deploy_"));
    if (descriptiveKeys.length) {
      const propsText = descriptiveKeys.map((key) => `${key}: ${String(props[key]).slice(0, 200)}`).join("; ");
      parts.push(`описание из props — ${propsText}`);
    }
    return `проект «${project.name}»: ${parts.join("; ")}`;
  }

  if (name === "list_companies") {
    const rows = (await client.query("SELECT name, props FROM companies ORDER BY name")).rows as { name: string; props: Record<string, unknown> | null }[];
    if (!rows.length) return "компаний в MBOX пока нет";
    const lines = rows.map((c) => {
      const hint = (c.props?.profile as string) || (c.props?.role as string) || "";
      return hint ? `${c.name} — ${String(hint).slice(0, 120)}` : c.name;
    });
    return `компании (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "get_company_info") {
    const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows as { id: string; name: string }[];
    const company = matchCompanyFuzzy(args.company_name, companyList);
    if (!company) return `не нашёл компанию «${args.company_name}» — есть: ${companyList.map((c) => c.name).join(", ") || "компаний пока нет"}`;
    const row = (await client.query("SELECT props, access_level FROM companies WHERE id = $1", [company.id])).rows[0] as { props: Record<string, unknown> | null; access_level: string };
    const props = row.props && typeof row.props === "object" ? row.props : {};
    const keys = Object.keys(props);
    if (!keys.length) return `компания «${company.name}»: свойства не заполнены`;
    // См. server/mbox-server.mjs — резать целиком, а не по 180 символов на поле: обрывало
    // содержательные поля (например tone_of_voice) на середине фразы.
    const propsText = keys.map((key) => `${key}: ${String(props[key])}`).join("\n");
    return `компания «${company.name}» (доступ: ${row.access_level}):\n${propsText}`.slice(0, 6000);
  }

  if (name === "search_memory") {
    const q = String(args.query || "").trim();
    if (!q) return "не искал — пустой запрос";
    const rows = (await client.query(
      `SELECT m.title, m.content, p.name AS project_name
       FROM memories m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.title ILIKE '%' || $1 || '%' OR m.content ILIKE '%' || $1 || '%'
       ORDER BY m.updated_at DESC LIMIT 5`,
      [q],
    )).rows as { title: string; content: string; project_name: string | null }[];
    if (!rows.length) return `по запросу «${q}» в памяти ничего не нашлось`;
    return rows.map((m) => `«${m.title}»${m.project_name ? ` (${m.project_name})` : ""}: ${m.content.slice(0, 160)}`).join(" | ");
  }

  if (name === "get_memory") {
    const id = String(args.memory_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи — возьми его из результатов search_memory";
    const row = (await client.query(
      `SELECT m.title, m.content, m.tags, p.name AS project_name
       FROM memories m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.id = $1`,
      [id],
    )).rows[0] as { title: string; content: string; tags: string[]; project_name: string | null } | undefined;
    if (!row) return `запись #${id} не нашлась — возможно, удалена или номер неверный`;
    const tags = Array.isArray(row.tags) && row.tags.length ? ` [теги: ${row.tags.join(", ")}]` : "";
    return `«${row.title}»${row.project_name ? ` (${row.project_name})` : ""}${tags}:\n${row.content}`;
  }

  if (name === "get_memory_actions") {
    const id = String(args.memory_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи";
    const rows = (await client.query(
      "SELECT actor, action, note, created_at::text FROM memory_actions WHERE memory_id = $1 ORDER BY created_at DESC LIMIT 20",
      [id],
    )).rows as { actor: string; action: string; note: string; created_at: string }[];
    if (!rows.length) return `по записи #${id} истории действий нет`;
    return rows.map((r) => `${r.actor} — ${r.action}${r.note ? ` (${r.note})` : ""} · ${r.created_at}`).join("; ");
  }

  if (name === "list_memory_links") {
    const id = String(args.memory_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи";
    const rows = (await client.query(
      `SELECT l.link_type, l.description,
              CASE WHEN l.from_memory_id = $1 THEN mt.title ELSE mf.title END AS other_title,
              CASE WHEN l.from_memory_id = $1 THEN mt.id ELSE mf.id END AS other_id
       FROM memory_links l
       JOIN memories mf ON mf.id = l.from_memory_id
       JOIN memories mt ON mt.id = l.to_memory_id
       WHERE l.from_memory_id = $1 OR l.to_memory_id = $1`,
      [id],
    )).rows as { link_type: string; description: string; other_title: string; other_id: string }[];
    if (!rows.length) return `у записи #${id} связей пока нет`;
    return rows.map((r) => `«${r.other_title}» (#${r.other_id}) — ${r.link_type}${r.description ? `: ${r.description}` : ""}`).join("; ");
  }

  if (name === "get_task") {
    const id = String(args.todo_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID задачи";
    const row = (await client.query(
      `SELECT t.title, t.note, t.status, t.priority, t.claimed_by, p.name AS project_name
       FROM todos t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = $1`,
      [id],
    )).rows[0] as { title: string; note: string; status: string; priority: string; claimed_by: string; project_name: string | null } | undefined;
    if (!row) return `задача #${id} не нашлась — возможно, удалена или номер неверный`;
    return `«${row.title}»${row.project_name ? ` (${row.project_name})` : ""} — статус: ${row.status}, приоритет: ${row.priority}${row.claimed_by ? `, в работе у: ${row.claimed_by}` : ""}. Описание: ${row.note || "пусто"}`;
  }

  if (name === "search_todos") {
    const q = String(args.query || "").trim();
    if (!q) return "не искал — пустой запрос";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const rows = (await client.query(
      `SELECT t.title, t.note, t.status, t.priority, p.name AS project_name
       FROM todos t JOIN projects p ON p.id = t.project_id
       WHERE (t.title ILIKE '%' || $1 || '%' OR t.note ILIKE '%' || $1 || '%')
         AND ($2::bigint IS NULL OR t.project_id = $2::bigint)
       ORDER BY t.updated_at DESC LIMIT 10`,
      [q, project?.id || null],
    )).rows as { title: string; note: string; status: string; priority: string; project_name: string }[];
    if (!rows.length) return `по запросу «${q}» задач не нашлось`;
    // Раньше возвращали только заголовок — если совпадение было в note, а не в title, модель
    // видела заголовок без query и решала, что задача не подходит, хотя SQL нашёл её верно.
    return rows.map((t) => {
      const noteMatch = t.note && t.note.toLowerCase().includes(q.toLowerCase());
      const snippet = noteMatch ? `, в описании: "...${excerptAround(t.note, q, 60)}..."` : "";
      return `[${t.project_name}] «${t.title}» (${t.status}/${t.priority})${snippet}`;
    }).join("; ");
  }

  if (name === "update_todo_note") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(client, project.id, args.todo_title);
    if (!todo) return `не нашёл задачу «${args.todo_title}» в проекте «${project.name}»`;
    const note = String(args.note || "").trim();
    if (!note) return "нечего записывать — пустое описание";
    const mode = args.mode === "replace" ? "replace" : "append";
    const newNote = mode === "replace" || !todo.note ? note : `${todo.note}\n${note}`;
    await client.query("UPDATE todos SET note = $1, updated_at = now() WHERE id = $2", [newNote, todo.id]);
    return `у задачи «${todo.title}» ${mode === "replace" ? "заменено" : "дополнено"} описание`;
  }

  if (name === "link_projects") {
    const a = matchProjectFuzzy(args.project_a, projectList);
    if (!a) return `не нашёл проект «${args.project_a}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const b = matchProjectFuzzy(args.project_b, projectList);
    if (!b) return `не нашёл проект «${args.project_b}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    if (a.id === b.id) return "нельзя связать проект сам с собой";
    const relation = String(args.relation || "").trim() || "related";
    await client.query(
      `INSERT INTO graph_edges(from_entity, from_id, to_entity, to_id, edge_type, description)
       VALUES ('project', $1, 'project', $2, $3, $4) ON CONFLICT DO NOTHING`,
      [a.id, b.id, relation, String(args.description || "")],
    );
    return `связал «${a.name}» → «${b.name}» отношением «${relation}»`;
  }

  if (name === "record_decision") {
    const title = String(args.title || "").trim();
    const decision = String(args.decision || "").trim();
    if (!title || !decision) return "не записал решение — нужны и заголовок, и само решение";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const inserted = await client.query(
      `INSERT INTO decision_log(project_id, actor, title, decision, rationale)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
      [project?.id || null, JARVIS_NAME, title, decision, String(args.rationale || "")],
    );
    return `записал решение: «${title}»${project ? ` (проект «${project.name}»)` : ""} (#${inserted.rows[0].id})`;
  }

  if (name === "get_groq_usage") {
    const rows = (await client.query(
      `SELECT model,
              COALESCE(SUM(total_tokens), 0)::text AS total,
              COALESCE(SUM(total_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::text AS last_24h,
              COALESCE(SUM(total_tokens) FILTER (WHERE created_at > date_trunc('day', now())), 0)::text AS today,
              COUNT(*)::int AS calls_total
       FROM groq_usage GROUP BY model ORDER BY SUM(total_tokens) DESC`,
    )).rows as { model: string; total: string; last_24h: string; today: string; calls_total: number }[];
    if (!rows.length) return "расхода токенов пока не зафиксировано";
    const lines = rows.map((r) => `${r.model || "?"}: сегодня ${r.today}, за 24ч ${r.last_24h}, всего ${r.total} (${r.calls_total} вызовов)`);
    return `расход токенов по моделям — ${lines.join("; ")}. У Gemini нет известного жёсткого лимита в этом коде, это только счётчик фактического расхода, не "остаток".`;
  }

  if (name === "list_recent_activity") {
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const rows = (await client.query(
      `SELECT actor, action, entity_type, summary, created_at::text
       FROM audit_events
       WHERE ($1::bigint IS NULL OR project_id = $1::bigint)
       ORDER BY created_at DESC LIMIT 10`,
      [project?.id || null],
    )).rows as { actor: string; action: string; entity_type: string; summary: string }[];
    if (!rows.length) return "недавних событий не нашлось";
    const lines = rows.map((e) => `${e.actor} ${e.action} ${e.entity_type}${e.summary ? ` (${e.summary})` : ""}`);
    return `последние события${project ? ` в «${project.name}»` : ""}: ${lines.join("; ")}`;
  }

  if (name === "find_file") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const row = (await client.query("SELECT props FROM projects WHERE id = $1", [project.id])).rows[0] as { props: Record<string, any> | null };
    const structure = row?.props?.repo_structure;
    if (!structure || !Array.isArray(structure.paths) || !structure.paths.length) {
      return `у проекта «${project.name}» ещё нет опубликованной структуры репозитория`;
    }
    const q = String(args.query || "").trim().toLowerCase();
    const matches = (structure.paths as string[]).filter((p) => String(p).toLowerCase().includes(q)).slice(0, 20);
    if (!matches.length) return `по запросу «${args.query}» в структуре «${project.name}» ничего не нашлось (всего файлов: ${structure.paths.length})`;
    return `найдено в «${project.name}»: ${matches.join(", ")}`;
  }

  if (name === "list_data_sources") {
    let where = "";
    const params: unknown[] = [];
    if (args.project_name) {
      const project = matchProjectFuzzy(args.project_name, projectList);
      if (project) { where = "WHERE project_id = $1"; params.push(project.id); }
    }
    const rows = (await client.query(`SELECT name, url, schedule_minutes, last_fetched_at::text, last_status FROM data_sources ${where} ORDER BY name`, params)).rows as { name: string; url: string; schedule_minutes: number; last_fetched_at: string | null; last_status: string }[];
    if (!rows.length) return "источников данных пока нет";
    const lines = rows.map((s) => `${s.name} (${s.url}) — ${s.last_status}, последнее обновление: ${s.last_fetched_at || "ещё не было"}`);
    return `источники данных (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "create_data_source") {
    const sourceName = String(args.name || "").trim();
    const sourceUrl = String(args.url || "").trim();
    if (!sourceName || !sourceUrl) return "не создал источник — нужны и название, и адрес";
    let projectId: string | null = null;
    let companyId: string | null = null;
    if (args.project_name) {
      const project = matchProjectFuzzy(args.project_name, projectList);
      if (!project) return `не нашёл проект «${args.project_name}»`;
      projectId = project.id;
    }
    if (args.company_name) {
      const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows as { id: string; name: string }[];
      const company = matchCompanyFuzzy(args.company_name, companyList);
      if (!company) return `не нашёл компанию «${args.company_name}»`;
      companyId = company.id;
    }
    if (!projectId && !companyId) return "не создал источник — укажи проект или компанию, к которой привязать";
    const kind = args.kind === "tours_xml" ? "tours_xml" : "webpage";
    const inserted = await client.query(
      `INSERT INTO data_sources(project_id, company_id, name, url, schedule_minutes, kind)
       VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5, 0), 1440), $6) RETURNING id::text`,
      [projectId, companyId, sourceName, sourceUrl, Number(args.schedule_minutes) || 0, kind],
    );
    return `создан источник «${sourceName}» (#${(inserted.rows[0] as { id: string }).id}), первое чтение — на ближайшем тике архивариуса`;
  }

  if (name === "refresh_data_source") {
    const q = String(args.name || "").trim().toLowerCase();
    const rows = (await client.query("SELECT id::text, name FROM data_sources")).rows as { id: string; name: string }[];
    const source = rows.find((s) => s.name.toLowerCase() === q) || rows.find((s) => s.name.toLowerCase().includes(q));
    if (!source) return `не нашёл источник «${args.name}» — есть: ${rows.map((s) => s.name).join(", ") || "источников пока нет"}`;
    const result = await refreshDataSourceById(source.id, { inboxId });
    return result.ok ? `источник «${source.name}» обновлён: ${result.summary.slice(0, 200)}` : `не удалось обновить «${source.name}»: ${result.error}`;
  }

  if (name === "search_tour_dates") {
    const q = String(args.tour_name || "").trim();
    if (!q) return "не искал — не указано название тура";
    const rows = (await client.query(
      `SELECT tour_name, route_name, date_start::text, date_end::text, free_places, price_from
       FROM tour_sheets
       WHERE tour_name ILIKE '%' || $1 || '%'
         AND (date_end IS NULL OR date_end >= CURRENT_DATE)
         AND ($2 = false OR free_places > 0)
       ORDER BY date_start ASC NULLS LAST
       LIMIT 20`,
      [q, Boolean(args.only_available)],
    )).rows as { tour_name: string; route_name: string; date_start: string | null; date_end: string | null; free_places: number; price_from: number }[];
    if (!rows.length) return `по запросу «${q}» дат не нашлось — либо тура с таким названием нет в фиде, либо все места и даты прошли`;
    const lines = rows.map((r) => `${r.tour_name}: ${r.date_start || "?"}${r.date_end && r.date_end !== r.date_start ? `–${r.date_end}` : ""}, мест: ${r.free_places}, от ${r.price_from}₽`);
    return `найдено (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "analyze_posts") {
    const posts = await loadPostStats();
    if (!posts.length) return "постов в базе пока нет — папка «Посты» пуста";
    const mode = ["top", "bottom", "by_photo"].includes(String(args.mode)) ? String(args.mode) : "summary";
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);

    if (mode === "top" || mode === "bottom") {
      const sorted = [...posts].sort((a, b) => mode === "top" ? b.rate - a.rate : a.rate - b.rate).slice(0, limit);
      const lines = sorted.map((p) => `«${p.title}» — ${p.reactionsTotal} реакций${p.postedAt ? `, ${p.postedAt.slice(0, 10)}` : ""}, скорость ${p.rate.toFixed(2)}/день${p.hasPhoto ? ", с фото" : ""}`);
      return `${mode === "top" ? "лучшие" : "худшие"} по скорости набора реакций (${sorted.length} из ${posts.length}): ${lines.join("; ")}`;
    }

    if (mode === "by_photo") {
      const withPhoto = posts.filter((p) => p.hasPhoto);
      const withoutPhoto = posts.filter((p) => !p.hasPhoto);
      const avg = (list: PostStat[]) => list.length ? list.reduce((sum, p) => sum + p.rate, 0) / list.length : 0;
      return `с фото: ${withPhoto.length} постов, средняя скорость ${avg(withPhoto).toFixed(2)}/день; без фото: ${withoutPhoto.length} постов, средняя скорость ${avg(withoutPhoto).toFixed(2)}/день`;
    }

    const total = posts.length;
    const withReactions = posts.filter((p) => p.reactionsTotal > 0).length;
    const avgRate = posts.reduce((sum, p) => sum + p.rate, 0) / total;
    const withPhoto = posts.filter((p) => p.hasPhoto).length;
    return `постов в базе: ${total}, с реакциями: ${withReactions} (${((withReactions / total) * 100).toFixed(0)}%), с фото: ${withPhoto} (${((withPhoto / total) * 100).toFixed(0)}%), средняя скорость реакций ${avgRate.toFixed(2)}/день. Для конкретики используй mode=top/bottom/by_photo.`;
  }

  if (name === "update_memory") {
    const id = String(args.memory_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи — возьми его из результатов search_memory";
    const existing = (await client.query("SELECT id::text, title, content, tags FROM memories WHERE id = $1", [id])).rows[0] as { id: string; title: string; content: string; tags: string[] } | undefined;
    if (!existing) return `запись #${id} не нашлась — возможно, удалена или номер неверный`;
    const title = args.title !== undefined ? String(args.title).trim() : existing.title;
    let content = existing.content;
    if (args.content !== undefined) {
      const newContent = String(args.content);
      const mode = args.mode === "append" ? "append" : "replace";
      content = mode === "append" && existing.content ? `${existing.content}\n\n${newContent}` : newContent;
    }
    const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : existing.tags;
    await client.query(
      "UPDATE memories SET title = $1, content = $2, tags = $3, updated_at = now() WHERE id = $4",
      [title, content, tags, id],
    );
    await recordMemoryAction({ memoryId: id, actor: JARVIS_NAME, action: "update", note: "memory updated via Jarvis tool" });
    return `обновлена запись памяти «${title}» (#${id})`;
  }

  if (name === "delete_memory") {
    const id = String(args.memory_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи для удаления";
    const existing = (await client.query("SELECT id::text, title FROM memories WHERE id = $1", [id])).rows[0] as { id: string; title: string } | undefined;
    if (!existing) return `запись #${id} не нашлась — возможно, уже удалена или номер неверный`;
    await recordMemoryAction({ memoryId: id, actor: JARVIS_NAME, action: "delete", note: "memory deleted via Jarvis tool" });
    await client.query("DELETE FROM memories WHERE id = $1", [id]);
    return `удалена запись памяти «${existing.title}» (#${id})`;
  }

  if (name === "create_company") {
    const companyName = String(args.name || "").trim();
    if (!companyName) return "не создал компанию — нет названия";
    const existing = (await client.query("SELECT id::text, name FROM companies WHERE lower(name) = lower($1)", [companyName])).rows[0] as { id: string; name: string } | undefined;
    if (existing) return `компания «${existing.name}» уже существует — используй update_company_info, чтобы дополнить её`;
    const props = args.props && typeof args.props === "object" ? args.props : {};
    const inserted = await client.query(
      "INSERT INTO companies(name, status, props, access_level) VALUES ($1, 'active', $2, 'private') RETURNING id::text",
      [companyName, JSON.stringify(props)],
    );
    return `создана компания «${companyName}» (#${(inserted.rows[0] as { id: string }).id})`;
  }

  if (name === "update_company_info") {
    const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows as { id: string; name: string }[];
    const company = matchCompanyFuzzy(args.company_name, companyList);
    if (!company) return `не нашёл компанию «${args.company_name}» — есть: ${companyList.map((c) => c.name).join(", ") || "компаний пока нет"}`;
    const props = args.props && typeof args.props === "object" ? args.props as Record<string, unknown> : null;
    if (!props || !Object.keys(props).length) return "нечего обновлять — не переданы свойства";
    await client.query("UPDATE companies SET props = props || $1::jsonb, updated_at = now() WHERE id = $2", [JSON.stringify(props), company.id]);
    return `у компании «${company.name}» обновлены свойства: ${Object.keys(props).join(", ")}`;
  }

  if (name === "update_project_info") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (args.stack !== undefined) { params.push(JSON.stringify(Array.isArray(args.stack) ? (args.stack as unknown[]).map(String) : [])); sets.push(`stack = $${params.length}`); }
    if (args.git_url !== undefined) { params.push(String(args.git_url).trim()); sets.push(`git_url = $${params.length}`); }
    if (args.deploy_provider !== undefined) { params.push(String(args.deploy_provider).trim()); sets.push(`deploy_provider = $${params.length}`); }
    if (args.deploy_target !== undefined) { params.push(String(args.deploy_target).trim()); sets.push(`deploy_target = $${params.length}`); }
    if (args.status !== undefined) { params.push(String(args.status).trim()); sets.push(`status = $${params.length}`); }
    if (!sets.length) return "нечего обновлять — не переданы новые значения";
    params.push(project.id);
    await client.query(`UPDATE projects SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
    return `у проекта «${project.name}» обновлено: ${sets.map((s) => s.split(" = ")[0]).join(", ")}`;
  }

  if (name === "create_folder") {
    const folderName = String(args.name || "").trim();
    const entityTypes = ["memory", "artifact", "project", "todo", "script", "agent_scope"];
    const entityType = entityTypes.includes(String(args.entity_type)) ? String(args.entity_type) : null;
    if (!folderName || !entityType) return "не создал папку — нужны и название, и корректный тип (memory/artifact/project/todo/script/agent_scope)";
    let parentId: string | null = null;
    if (args.parent_name) {
      const parent = (await client.query("SELECT id::text, name FROM folders WHERE name = $1", [String(args.parent_name).trim()])).rows[0] as { id: string; name: string } | undefined;
      if (!parent) return `не нашёл родительскую папку «${args.parent_name}»`;
      parentId = parent.id;
    }
    const existing = (await client.query(
      "SELECT id::text FROM folders WHERE name = $1 AND parent_id IS NOT DISTINCT FROM $2",
      [folderName, parentId],
    )).rows[0];
    if (existing) return `папка «${folderName}» уже существует на этом уровне`;
    const inserted = await client.query(
      "INSERT INTO folders(parent_id, name, entity_type, access_level) VALUES ($1, $2, $3, 'agents') RETURNING id::text",
      [parentId, folderName, entityType],
    );
    return `создана папка «${folderName}» (тип ${entityType}${args.parent_name ? `, внутри «${args.parent_name}»` : ""}) (#${(inserted.rows[0] as { id: string }).id})`;
  }

  if (name === "list_folders") {
    const entityTypes = ["memory", "artifact", "project", "todo", "script", "agent_scope"];
    const entityType = entityTypes.includes(String(args.entity_type)) ? String(args.entity_type) : null;
    const rows = (await client.query(
      `SELECT f.name, f.entity_type, pf.name AS parent_name
       FROM folders f LEFT JOIN folders pf ON pf.id = f.parent_id
       WHERE $1::text IS NULL OR f.entity_type = $1
       ORDER BY f.entity_type, f.name`,
      [entityType],
    )).rows as { name: string; entity_type: string; parent_name: string | null }[];
    if (!rows.length) return entityType ? `папок типа «${entityType}» пока нет` : "папок пока нет";
    const lines = rows.map((f) => `${f.name}${f.parent_name ? ` (в «${f.parent_name}»)` : ""} [${f.entity_type}]`);
    return `папки (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "link_memories") {
    const idA = String(args.memory_a_id || "").trim();
    const idB = String(args.memory_b_id || "").trim();
    if (!idA || !/^\d+$/.test(idA) || !idB || !/^\d+$/.test(idB)) return "нужны числовые ID обеих записей";
    if (idA === idB) return "нельзя связать запись саму с собой";
    const rows = (await client.query("SELECT id::text, title FROM memories WHERE id IN ($1, $2)", [idA, idB])).rows as { id: string; title: string }[];
    const memA = rows.find((r) => r.id === idA);
    const memB = rows.find((r) => r.id === idB);
    if (!memA) return `запись #${idA} не нашлась`;
    if (!memB) return `запись #${idB} не нашлась`;
    const relation = String(args.relation || "").trim() || "related";
    await client.query(
      `INSERT INTO memory_links(from_memory_id, to_memory_id, link_type, description)
       VALUES ($1, $2, $3, $4)`,
      [idA, idB, relation, String(args.description || "")],
    );
    return `связал «${memA.title}» (#${idA}) → «${memB.title}» (#${idB}) отношением «${relation}»`;
  }

  if (name === "list_artifacts") {
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    if (args.project_name && !project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const rows = (await client.query(
      `SELECT name, category, version, status FROM artifacts
       WHERE $1::bigint IS NULL OR project_id = $1::bigint
       ORDER BY updated_at DESC LIMIT 20`,
      [project?.id || null],
    )).rows as { name: string; category: string; version: string; status: string }[];
    if (!rows.length) return project ? `у проекта «${project.name}» артефактов пока нет` : "артефактов пока нет";
    const lines = rows.map((a) => `«${a.name}» (${a.category}, ${a.version}, ${a.status})`);
    return `артефакты${project ? ` проекта «${project.name}»` : ""} (${rows.length}${rows.length === 20 ? "+" : ""}): ${lines.join("; ")}`;
  }

  if (name === "create_artifact") {
    const artifactName = String(args.name || "").trim();
    const category = String(args.category || "").trim();
    const content = String(args.content || "").trim();
    if (!artifactName || !category || !content) return "не создал артефакт — нужны название, категория и содержание";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    if (args.project_name && !project) return `не нашёл проект «${args.project_name}»`;
    const inserted = await client.query(
      `INSERT INTO artifacts(project_id, name, category, version, status, content, access_level)
       VALUES ($1, $2, $3, 'v1', 'created', $4, 'agents') RETURNING id::text`,
      [project?.id || null, artifactName, category, content],
    );
    return `создан артефакт «${artifactName}» (${category})${project ? ` в проекте «${project.name}»` : ""} (#${(inserted.rows[0] as { id: string }).id})`;
  }

  if (name === "delegate_to_junior") {
    const task = String(args.task || "").trim();
    if (!task) return "не делегировал — нет описания задачи";
    setPhase(inboxId, "Делегирует младшему агенту");
    const delegateMessage = await groqComplete(
      [
        { role: "system", content: `Выполни задачу коротко и по делу, на русском: ${task}` },
        { role: "user", content: String(args.input || "") || "(нет входных данных)" },
      ],
      undefined,
      "skill-delegate-junior",
      undefined,
      0,
      GROQ_MODEL_JUNIOR,
    );
    return String(delegateMessage.content || "").trim().slice(0, 3000) || "младший агент не вернул ответ";
  }

  return `неизвестное действие: ${name}`;
}

async function replyAsJarvis(item: { id: unknown; project_id?: unknown; title?: unknown; body?: unknown; props?: Record<string, unknown> }, clients: Set<WebSocket>) {
  if (!GROQ_API_KEY) return;
  const controller = new AbortController();
  activeJarvisRequests.set(String(item.id), controller);
  try {
    const client = await getPool().connect();
    try {
      await client.query("SELECT set_config('mbox.actor', $1, false)", [JARVIS_NAME]);

      const fastPathReply = await tryFastPath(client, item.body || item.title);
      if (fastPathReply) {
        jlog(item.id, `fast-path: "${String(item.body || "").slice(0, 80)}" -> без обращения к LLM`);
        await client.query(
          `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
           VALUES ($1, $2, 'answer', $3, $4, 'open', 'normal', false, $5)`,
          [item.project_id || null, JARVIS_NAME, `Ответ: ${String(item.title || "").slice(0, 100)}`, fastPathReply, JSON.stringify({ to: "Человек", re: item.id, tools_used: [], fast_path: true })],
        );
        await client.query("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.id]);
        broadcastRealtime(clients, "entity_changed", { entity: "agent_inbox" });
        return;
      }

      const projectList = (await client.query("SELECT id::text, name FROM projects ORDER BY name")).rows as { id: string; name: string }[];
      const companyNames = ((await client.query("SELECT name FROM companies ORDER BY name")).rows as { name: string }[]).map((c) => c.name);
      const stats = (await client.query(
        `SELECT (SELECT count(*) FROM todos)::int AS todos_total,
                (SELECT count(*) FROM todos WHERE status NOT IN ('done', 'archived'))::int AS todos_open,
                (SELECT count(*) FROM memories)::int AS memories_total`,
      )).rows[0] as { todos_total: number; todos_open: number; memories_total: number };
      const systemPrompt = `Ты ${JARVIS_NAME} — лёгкий постоянный помощник в MBOX (личная система памяти и проектов). `
        + "Имя не просто так: держи тон робота-дворецкого — вежливо, чуть церемонно, обращайся на «вы», "
        + "уместны фразы вроде «Конечно, сэр», «Слушаюсь», «Жду ваших указаний», лёгкая ирония допустима, но "
        + "не в ущерб делу — это тон, а не ролевая игра, отчёты и цифры остаются точными, никакой отсебятины "
        + "ради характера. "
        + `Ты обычно работаешь на модели ${GEMINI_MODEL} (Gemini), а если она недоступна — на резервной `
        + `${GROQ_MODEL} через Groq API. Если спросят, какая ты модель — называй ту, что реально сейчас `
        + "отвечает (обычно Gemini), не выдумывай третье название. Отвечай коротко и по делу, на русском. У тебя есть НАСТОЯЩИЕ инструменты: "
        + "create_todo, create_project, delete_project (необратимо, точное название), update_todo_status, "
        + "set_todo_priority, delete_todo (необратимо, точный заголовок), merge_todos (объединить несколько задач "
        + "проекта в одну по их числовым ID — исходные не удаляются, уходят в архив с пометкой; сам подбирай "
        + "ID через list_project_todos/search_todos, если просят «прибраться» или «объедини задачи про X»), "
        + "review_memory_cleanup (найти в памяти устаревшие технические логи по уже закрытым задачам — вся "
        + "тяжёлая работа на сервере, тебе приходит готовый компактный список ID, не сама память; после вызова "
        + "покажи список человеку и жди подтверждения, прежде чем звать delete_memory — не удаляй сразу; для "
        + "глубокого смыслового разбора дублей это не замена, такое — к Claude), "
        + "record_memory (записать долгоживущий "
        + "факт), list_project_todos (заголовки задач проекта), get_project_info (git/стек/деплой/доступ и "
        + "описание проекта из props — если просят РАССКАЗАТЬ/ОПИСАТЬ проект, роль, контекст, что это такое — "
        + "используй именно этот инструмент, не search_memory: там технические итоги прогонов агентов, а не "
        + "описание проекта), search_todos (искать по тексту задачи, включая описание — если list_project_todos "
        + "не нашёл нужное, попробуй search_todos, там ищется больше, чем просто заголовок), search_memory "
        + "(искать конкретные факты/решения по ключевым словам, НЕ для общего описания проекта — отдаёт только "
        + "обрезанный отрывок; если попросят «выведи полностью» или дали номер записи — дочитывай get_memory), "
        + "get_memory (полный текст записи памяти по ID), get_memory_actions (кто и когда правил запись по её ID), "
        + "list_memory_links (что связано с записью по её ID), get_task (полная карточка задачи по её ID — в "
        + "отличие от list_project_todos/search_todos, которые отдают только обрезанные превью), update_todo_note "
        + "(дописать или заменить описание задачи), link_projects (связать два проекта отношением — «использует», "
        + "«зависит от» и т.п.), record_decision (записать ВЫБОР между вариантами и почему — не факт, для фактов "
        + "record_memory), get_groq_usage (расход токенов по моделям, которыми ты говоришь — и Groq, и Gemini, "
        + "сегодня/за сутки/всего; у Gemini нет известного жёсткого лимита, это просто счётчик расхода), "
        + "list_recent_activity (последние события в проекте или во всём MBOX), find_file (найти путь "
        + "к файлу в структуре репозитория — только пути, без содержимого, ты не читаешь файлы), "
        + "list_companies и get_company_info (КОМПАНИЯ — не проект: контейнер верхнего уровня, "
        + "владеет несколькими проектами; вопросы про юрлицо, контакты, бренд, реквизиты, тон общения — "
        + "это компания, используй эти инструменты, а не get_project_info), "
        + "list_data_sources, create_data_source и refresh_data_source (источник данных — внешний сайт или "
        + "API, который MBOX сам периодически перечитывает по графику и кладёт короткую сводку в память; "
        + "если просят «следи за сайтом X» или «проверяй раз в день Y» — заведи источник, не record_memory), "
        + "search_tour_dates (даты и свободные места по названию тура из разобранного фида vs-travel.ru — "
        + "используй это для вопросов «какие даты у тура X» или «сколько мест на тур Y», не выдумывай цифры "
        + "и не ищи в памяти), analyze_posts (реальные инсайты по постам Telegram-канала — что заходит, что "
        + "нет, топ/антитоп по скорости набора реакций с поправкой на давность, сравнение с фото/без — "
        + "используй это на вопросы про эффективность контента, не выдумывай форматы и цифры), "
        + "update_memory (отредактировать запись памяти по ID — заголовок/содержание/теги, content можно "
        + "дописать или заменить целиком), delete_memory (удалить запись памяти по ID, необратимо), "
        + "create_company (завести новую компанию, необязательно сразу со свойствами), update_company_info "
        + "(дописать/обновить свойства существующей компании поверх текущих, не стирая остальные), "
        + "update_project_info (изменить стек/git/деплой/статус проекта — указывай только то, что реально "
        + "меняешь), create_folder и list_folders (папки для организации памяти/артефактов/проектов/задач/"
        + "скриптов/агентских областей), link_memories (связать две записи памяти отношением — «связано», "
        + "«противоречит», «уточняет» и т.п., по ID), list_artifacts и create_artifact (артефакт — осознанная "
        + "находка/материал вроде компонента, конфига или зафиксированного решения, в отличие от сырой записи "
        + "памяти через record_memory), delegate_to_junior (скинуть младшей модели маленький самостоятельный "
        + "текстовый кусок — черновик, сводку, пересказ, классификацию — внутри цепочки действий, чтобы не "
        + "тратить свой контекст на сам черновик; не годится для того, что само требует вызова инструментов). "
        + "Если просят "
        + "одно из этого — вызови функцию, не пиши текстом, что сделал это. "
        + "Если в одном сообщении просят НЕСКОЛЬКО действий (может быть комбо из разных инструментов, не "
        + "только повтор одного и того же, например «создай 3 задачи с названиями A/B/C») — по возможности "
        + "вызывай ВСЕ нужные функции ОДНИМ ответом (несколько tool_calls разом), а не по одной с отдельным "
        + "шагом на каждую — так быстрее для человека, каждый лишний шаг это отдельный медленный запрос к "
        + "модели. Если так не получилось — вызывай их одно за другим по очереди, пока не выполнишь все, не "
        + "только первое; не останавливайся после первого шага и не переспрашивай подтверждение между шагами, "
        + "если человек уже описал всю последовательность в одном сообщении — уверенно доводи комбо из 3-5 "
        + "инструментов до конца за один ответ, а мелкие текстовые подзадачи внутри такой цепочки отдавай "
        + "delegate_to_junior вместо того, чтобы писать черновик самому. Если просят что-то другое, для чего нет функции — "
        + "честно скажи, что не умеешь этого делать, а не притворяйся, что сделал. Кроме тебя в MBOX работает "
        + "Claude — отдельный, куда более мощный агент (через Claude Code), который занимается тяжёлыми "
        + "задачами: разработкой самого MBOX, деплоем на прод, глубоким анализом больших массивов данных "
        + "(например, разбором постов Telegram-канала для скилла контента). Если просят что-то из этого — не "
        + "делай вид, что справишься сам, скажи прямо, что это к Claude, не к тебе. Модели, которые говорят "
        + "твоим голосом: сам ты обычно на Gemini, в резерве — Groq (\"Прораб\", openai/gpt-oss-120b — ведёт "
        + "диалог и решает, какой инструмент вызвать; \"Младший\", openai/gpt-oss-20b — разовые задачи без "
        + "диалога вроде пересказа страницы или классификации памяти). Claude — это отдельный агент на своей "
        + "модели (Claude Sonnet), не ещё одна твоя резервная модель, не путай. Тебе видна история разговора "
        + "(не только последнее сообщение), но действие вызывай ТОЛЬКО когда об этом явно просят прямо сейчас — "
        + "фразы вроде «буду делать проект на стеке X» или «планирую X» это описание планов, а не команда, не "
        + "создавай ничего в ответ на них. Когда человек явно просит создать проект, а раньше в разговоре уже "
        + "называл детали (стек, ссылку и т.п.) — подставь их в create_project сам, не переспрашивай то, что уже "
        + "прозвучало. Если деталей вообще не было — создавай хотя бы с одним названием, не устраивай анкету из "
        + "вопросов, человек всегда может дополнить проект следующим сообщением. Известные проекты: "
        + `${projectList.map((p) => p.name).join(", ") || "нет проектов"}. Известные компании: `
        + `${companyNames.join(", ") || "нет компаний"}. Сводка по MBOX прямо сейчас: всего задач `
        + `${stats.todos_total}, из них незакрытых ${stats.todos_open}, записей в памяти ${stats.memories_total}. `
        + "Если спросят общее число задач/проектов — отвечай из этой сводки, не выдумывай и не говори, что не умеешь. "
        + "Если результат инструмента явно помечен как неполный (например «показаны 20 из 102 — список НЕ "
        + "полный») — никогда не достраивай остальное своими словами («всё остальное готово/сделано» и т.п.), "
        + "это додумывание за пределами того, что реально видно; честно скажи, что показана только часть, и "
        + "предложи уточнить через search_todos или другой конкретный запрос."
        + (item.props?.current_project_name
          ? ` Пользователь сейчас открыл в интерфейсе проект «${item.props.current_project_name}» — если он не называет проект явно в вопросе или команде, подразумевай именно этот, не переспрашивай.`
          : "");

      // KEEP_RAW/OLDER_CAP — см. комментарий в server/mbox-server.mjs (inbox #546, todo #214):
      // последние 50 сообщений дословно, до 60 старых сверх того сжимаются в сводку за раз.
      const KEEP_RAW = 50;
      const OLDER_CAP = 60;
      // Раньше каждый ответ видел ТОЛЬКО текущее сообщение — подтягиваем реальную историю
      // разговора (см. комментарий в server/mbox-server.mjs), включая только что вставленное.
      const history = (await client.query(
        `SELECT agent_name, body, title FROM agent_inbox
         WHERE item_type IN ('question', 'answer') AND (agent_name = 'Человек' OR agent_name = $1)
         ORDER BY created_at DESC LIMIT ${KEEP_RAW + OLDER_CAP}`,
        [JARVIS_NAME],
      )).rows.reverse() as { agent_name: string; body: string; title: string }[];

      const toRole = (row: { agent_name: string; body: string; title: string }) => ({ role: row.agent_name === JARVIS_NAME ? "assistant" : "user", content: row.body || row.title });
      const actionLog: string[] = [];
      const toolsUsed: string[] = [];
      // Полный пошаговый трейс — см. server/mbox-server.mjs. В props, не в body: props не
      // попадают в historyMessages, так что этот подробный вывод не вернётся Джарвису на
      // следующем шаге — только человеку в консоль. Уведомление о сжатии истории тоже сюда.
      const detailedTrace: string[] = [];
      // Заметные действия — см. server/mbox-server.mjs. Видны сразу, без разворачивания трейса.
      const highlights: string[] = [];
      // Сжатие — см. комментарий в server/mbox-server.mjs. Срабатывает только когда сообщений
      // реально больше 50 — короткие быстрые обмены не платят цену лишнего запроса к Cloudflare.
      let historyMessages: GroqMessage[] = history.map(toRole);
      let finalSystemPrompt = systemPrompt;
      if (history.length > KEEP_RAW && CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN) {
        const older = history.slice(0, history.length - KEEP_RAW);
        const recent = history.slice(history.length - KEEP_RAW);
        const transcript = older.map((row) => `${row.agent_name === JARVIS_NAME ? JARVIS_NAME : "Человек"}: ${row.body || row.title}`).join("\n");
        setPhase(item.id, "Сжимает историю диалога (Cloudflare)");
        const summary = await cloudflareSummarize(transcript);
        if (summary) {
          jlog(item.id, `история сжата Cloudflare: ${older.length} сообщений -> сводка ${summary.length} символов`);
          detailedTrace.push(`Сжатие истории: ${older.length} старых сообщений упакованы в сводку (${summary.length} символов), последние ${recent.length} остались как есть.`);
          finalSystemPrompt = `${systemPrompt} Сводка более раннего разговора: ${summary}`;
          historyMessages = recent.map(toRole);
        }
      }

      // Agentic-цикл вместо надежды на параллельные tool_calls за один запрос — см. комментарий
      // в server/mbox-server.mjs. Модель часто выполняет только первое из нескольких запрошенных
      // действий за раз; цикл даёт ей шанс продолжить следующим шагом.
      const messages: GroqMessage[] = [
        { role: "system", content: finalSystemPrompt },
        ...historyMessages,
      ];
      let reply = "";
      // См. server/mbox-server.mjs — Gemini-прораб с переключением на Groq при ошибке, не мечась
      // между провайдерами внутри одного цикла.
      let provider = GEMINI_API_KEY ? "gemini" : "groq";
      async function complete(msgs: GroqMessage[]): Promise<GroqMessage> {
        if (provider === "gemini") {
          try {
            return await geminiComplete(msgs, JARVIS_TOOLS, "reply", controller.signal);
          } catch (error) {
            jlog(item.id, `Gemini недоступен (${(error as Error).message}) — переключаюсь на Groq до конца этого ответа`);
            provider = "groq";
          }
        }
        return groqComplete(msgs, JARVIS_TOOLS, "reply", controller.signal);
      }
      jlog(item.id, `старт: "${String(item.body || "").slice(0, 160)}"`);
      for (let step = 0; step < 8; step += 1) {
        jlog(item.id, `шаг ${step}: запрос к ${provider} (${messages.length} сообщений в контексте)`);
        setPhase(item.id, "Подбирает инструмент/навык");
        const message = await complete(messages);
        if (!message.tool_calls?.length) {
          reply = message.content || "";
          jlog(item.id, `шаг ${step}: без tool_calls, финальный текст (${reply.length} символов)`);
          break;
        }
        jlog(item.id, `шаг ${step}: ${message.tool_calls.length} tool_calls — ${message.tool_calls.map((c) => `${c.function?.name}(${c.function?.arguments})`).join(", ")}`);
        messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
          let result: string;
          setPhase(item.id, `Применяет инструмент/навык: ${call.function?.name || "?"}`);
          try {
            result = await runJarvisTool(client, call.function?.name, call.function?.arguments, projectList, item.id);
            jlog(item.id, `  ${call.function?.name} -> ${result.slice(0, 200)}`);
          } catch (error) {
            result = describeToolFailure(call.function?.name || "инструмент", error);
            jlog(item.id, `  ${call.function?.name} -> ОШИБКА: ${(error as Error).stack || error}`);
            await logJarvisError({ source: "reply", toolName: call.function?.name || "", inboxId: item.id as string, projectId: (item.project_id as string) || null, message: (error as Error).message || String(error) });
          }
          actionLog.push(result);
          if (call.function?.name && !toolsUsed.includes(call.function.name)) toolsUsed.push(call.function.name);
          detailedTrace.push(`${detailedTrace.length + 1}. ${call.function?.name || "?"}\n   аргументы: ${call.function?.arguments || "—"}\n   результат: ${result}`);
          if (call.function?.name && HIGHLIGHT_TOOLS.has(call.function.name)) highlights.push(result);
          messages.push({ role: "tool", tool_call_id: call.id, name: call.function?.name, content: result });
        }
      }
      if (!reply) reply = actionLog.join("; ") || "не смог выполнить действие";
      jlog(item.id, `готово: инструменты=[${toolsUsed.join(", ")}], ответ="${reply.slice(0, 200)}"`);
      jarvisPhase.delete(String(item.id));

      await client.query(
        `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
         VALUES ($1, $2, 'answer', $3, $4, 'open', 'normal', false, $5)`,
        [item.project_id || null, JARVIS_NAME, `Ответ: ${String(item.title || "").slice(0, 100)}`, reply, JSON.stringify({ to: "Человек", re: item.id, tools_used: toolsUsed, trace: detailedTrace, highlights })],
      );
      await client.query("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.id]);
    } finally {
      client.release();
    }
    broadcastRealtime(clients, "entity_changed", { entity: "agent_inbox" });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      console.error(`Jarvis reply for #${item.id} cancelled by user`);
    } else {
      console.error(`Jarvis inline reply failed for #${item.id}: ${(error as Error).stack || error}`);
      await logJarvisError({ source: "reply", inboxId: item.id as string, projectId: (item.project_id as string) || null, message: (error as Error).message || String(error) });
      // См. server/mbox-server.mjs — молчание после сбоя неотличимо от "ещё думает", лучше честное "не получилось".
      try {
        await queryPostgres(
          `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
           VALUES ($1, $2, 'answer', $3, $4, 'open', 'normal', false, $5)`,
          [item.project_id || null, JARVIS_NAME, `Ответ: ${String(item.title || "").slice(0, 100)}`, `Не получилось ответить: ${String((error as Error).message || error).slice(0, 200)}. Попробуй ещё раз.`, JSON.stringify({ to: "Человек", re: item.id, tools_used: [], failed: true })],
        );
        await queryPostgres("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.id]);
        broadcastRealtime(clients, "entity_changed", { entity: "agent_inbox" });
      } catch (fallbackError) {
        console.error(`Jarvis fallback answer for #${item.id} also failed: ${(fallbackError as Error).message}`);
      }
    }
  } finally {
    activeJarvisRequests.delete(String(item.id));
    jarvisPhase.delete(String(item.id));
    setAgentPhase(JARVIS_NAME, "");
  }
}

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

function mboxDevApi() {
  return {
    name: "mbox-dev-api",
    configureServer(server: ViteDevServer) {
      loadLocalEnv();
      const realtimeClients = new Set<WebSocket>();
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

          if (!(await requireUser(req, res))) return;

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
                 UNION SELECT name FROM audited
                 UNION SELECT name FROM ran
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
            const result = await queryPostgres(
              `SELECT id::text, source, tool_name, inbox_id::text, project_id::text, message, created_at::text
               FROM jarvis_errors ORDER BY created_at DESC LIMIT 50`,
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
            const result = await queryPostgres(
              `SELECT id::text, folder_id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
                      pg_column_size(memories)::int AS memory_bytes,
                      created_at::text, updated_at::text,
                      count(*) OVER()::int AS total_count,
                      sum(pg_column_size(memories)) OVER()::bigint AS total_bytes
               FROM memories
               WHERE $1 = '' OR search_vector @@ plainto_tsquery('simple', $1) OR title ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%' OR tags::text ILIKE '%' || $1 || '%'
               ORDER BY updated_at ${sortOldest ? "ASC" : "DESC"}
               LIMIT 300`,
              [q],
            );
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
               WHERE m.id = $1`,
              [memoryMatch[1]],
            );
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
          }

          if (memoryMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const result = await queryPostgres(
              `UPDATE memories SET
                 title = COALESCE(NULLIF($1, ''), title),
                 content = COALESCE($2, content),
                 access_level = COALESCE(NULLIF($3, ''), access_level),
                 tags = COALESCE($4, tags),
                 project_id = CASE WHEN $5 THEN $6::bigint ELSE project_id END,
                 entity_type = COALESCE(NULLIF($7, ''), entity_type),
                 updated_at = now()
               WHERE id = $8
               RETURNING id::text`,
              [String(body.title ?? "").trim(), body.content ?? null, String(body.access_level ?? ""), Array.isArray(body.tags) ? body.tags : null, Object.prototype.hasOwnProperty.call(body, "project_id"), (body.project_id as string) || null, String(body.entity_type ?? ""), memoryMatch[1]],
            );
            if (result.rows[0]) await recordMemoryAction({ memoryId: result.rows[0].id, actor: String(actorFromReq(req)), action: "update", note: "memory updated via API", metadata: { fields: Object.keys(body || {}) } });
            if (result.rows[0]) await refreshMemoryEmbeddings();
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
          }

          if (memoryMatch && req.method === "DELETE") {
            await recordMemoryAction({ memoryId: memoryMatch[1], actor: String(actorFromReq(req)), action: "delete", note: "memory deleted via API" });
            await queryPostgres("DELETE FROM memories WHERE id = $1", [memoryMatch[1]]);
            await refreshMemoryEmbeddings();
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/folders") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
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
               WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR entity_type ILIKE '%' || $1 || '%'
               ORDER BY COALESCE(parent_id, 0), name`,
              [q],
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
               RETURNING id::text`,
              [body.parent_id || null, String(body.name ?? "").trim(), String(body.entity_type ?? ""), String(body.access_level ?? ""), String(body.color ?? ""), folderMatch[1]],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "folders" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { folder: result.rows[0] } : { error: "not_found" });
          }

          if (folderMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM folders WHERE id = $1", [folderMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "folders" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/artifacts") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
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
               WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR category ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%'
               ORDER BY category, name
               LIMIT 300`,
              [q],
            );
            return sendJson(res, 200, { artifacts: result.rows });
          }

          const artifactMatch = url.pathname.match(/^\/api\/mbox\/artifacts\/(\d+)$/);
          if (artifactMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
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
               WHERE id = $8
               RETURNING id::text`,
              [body.folder_id || null, body.project_id || null, String(body.name ?? "").trim(), String(body.category ?? ""), String(body.version ?? ""), String(body.status ?? ""), body.content ?? null, artifactMatch[1]],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "artifacts" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { artifact: result.rows[0] } : { error: "not_found" });
          }

          if (artifactMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM artifacts WHERE id = $1", [artifactMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "artifacts" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/companies") {
            if (req.method === "POST") {
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
               WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR status ILIKE '%' || $1 || '%' OR props::text ILIKE '%' || $1 || '%'
               ORDER BY updated_at DESC
               LIMIT 200`,
              [q],
            );
            const relations = await queryPostgres(
              `SELECT e.id::text, e.from_id::text AS company_id, c.name AS company_name,
                      e.to_id::text AS project_id, p.name AS project_name, e.edge_type,
                      e.title, e.description, e.owner, e.group_entity, e.strength, e.valid_until::text
               FROM graph_edges e
               JOIN companies c ON c.id = e.from_id AND e.from_entity = 'company'
               JOIN projects p ON p.id = e.to_id AND e.to_entity = 'project'
               ORDER BY e.created_at DESC`,
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
               WHERE $1 = ''
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
                  )
               ORDER BY activity.activity_score DESC, p.updated_at DESC
               LIMIT $2 OFFSET $3`,
              [q, limit, offset],
            );
            const todos = await queryPostgres(
              "SELECT id::text, project_id::text, title, note, status, priority, props, pg_column_size(todos)::int AS memory_bytes FROM todos ORDER BY updated_at DESC",
            );
            const relations = await queryPostgres(
              `SELECT e.id::text, e.from_id::text AS from_project_id, fp.name AS from_project_name,
                      e.to_id::text AS to_project_id, tp.name AS to_project_name, e.edge_type
               FROM graph_edges e
               JOIN projects fp ON fp.id = e.from_id AND e.from_entity = 'project'
               JOIN projects tp ON tp.id = e.to_id AND e.to_entity = 'project'
               WHERE e.from_entity = 'project' AND e.to_entity = 'project'
               ORDER BY e.created_at DESC`,
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
               ORDER BY e.created_at DESC
               LIMIT 500`,
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
            await queryPostgres("DELETE FROM projects WHERE id = $1", [projectMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "projects" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/todos" && req.method === "POST") {
            const body = await readBody<Record<string, unknown>>(req);
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
               WHERE id = $5
               RETURNING id::text, project_id::text, title, note, status, claimed_by`,
              [String(body.title ?? "").trim(), body.note ?? null, String(body.status ?? ""), String(body.priority ?? ""), todoMatch[1], body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null],
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
            await queryPostgres("DELETE FROM todos WHERE id = $1", [todoMatch[1]]);
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
               WHERE $1 = '' OR actor ILIKE '%' || $1 || '%' OR action ILIKE '%' || $1 || '%'
                  OR entity_type ILIKE '%' || $1 || '%' OR summary ILIKE '%' || $1 || '%' OR metadata::text ILIKE '%' || $1 || '%'
               ORDER BY created_at DESC
               LIMIT 200`,
              [q],
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
                JSON.stringify(body.props && typeof body.props === "object" ? body.props : {}),
              ],
            );
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "agent_inbox" });
            const senderName = String(body.agent_name || "Agent");
            const addressedTo = body.props && typeof body.props === "object" ? String((body.props as Record<string, unknown>).to || "") : "";
            if (senderName === "Человек" && (!addressedTo || addressedTo === JARVIS_NAME) && result.rows[0]) {
              replyAsJarvis({ id: result.rows[0].id, project_id: body.project_id || null, title: body.title, body: body.body, props: body.props }, realtimeClients)
                .catch((error: Error) => console.error(`Jarvis reply totally uncaught: ${error.message}`));
            }
            if (addressedTo === "Claude" && result.rows[0]) {
              console.log(`[claude-ping] #${result.rows[0].id} ${String(body.title || "").replace(/\s+/g, " ").slice(0, 200)}`);
            }
            return sendJson(res, 201, { inbox_item: result.rows[0] });
          }

          if (url.pathname === "/api/mbox/agent/inbox" && req.method === "GET") {
            const result = await queryPostgres(
              `SELECT id::text, project_id::text, agent_name, item_type, title, body, status, priority, requires_human, props,
                      pg_column_size(agent_inbox)::int AS memory_bytes,
                      created_at::text, updated_at::text
               FROM agent_inbox
               ORDER BY updated_at DESC
               LIMIT 200`,
            );
            return sendJson(res, 200, { inbox: result.rows });
          }

          const inboxMatch = url.pathname.match(/^\/api\/mbox\/agent\/inbox\/(\d+)$/);
          if (inboxMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const result = await queryPostgres(
              `UPDATE agent_inbox SET status = COALESCE(NULLIF($1, ''), status), priority = COALESCE(NULLIF($2, ''), priority), body = COALESCE($3, body), props = COALESCE($4, props), updated_at = now()
               WHERE id = $5 RETURNING id::text`,
              [String(body.status ?? ""), String(body.priority ?? ""), body.body ?? null, body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, inboxMatch[1]],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "agent_inbox" });
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
            await queryPostgres("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [cancelMatch[1]]);
            return sendJson(res, 200, { ok: true, aborted: Boolean(controller) });
          }

          if (url.pathname === "/api/mbox/agent/runs") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
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
               ORDER BY started_at DESC
               LIMIT 100`,
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
               WHERE $1 = '' OR actor ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%' OR decision ILIKE '%' || $1 || '%'
                  OR rationale ILIKE '%' || $1 || '%' OR impact ILIKE '%' || $1 || '%'
               ORDER BY created_at DESC
               LIMIT 200`,
              [q],
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
               WHERE $1 = '' OR title ILIKE '%' || $1 || '%' OR login ILIKE '%' || $1 || '%' OR url ILIKE '%' || $1 || '%'
               ORDER BY updated_at DESC LIMIT 100`,
              [q],
            );
            return sendJson(res, 200, { secrets: result.rows });
          }

          const secretMatch = url.pathname.match(/^\/api\/mbox\/secrets\/(\d+)$/);
          if (secretMatch && req.method === "PATCH") {
            const body = await readBody<{ project_id?: string | null; agent_share_state?: string; approved_until?: string | null; title?: string; login?: string; password?: string; url?: string }>(req);
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
               WHERE id = $4
               RETURNING id::text, project_id::text, title, login, url, access_level, agent_share_state,
                         pg_column_size(protected_secrets)::int AS memory_bytes,
                         approved_until::text, updated_at::text`,
              [body.project_id || null, body.agent_share_state ?? "", body.approved_until || null, secretMatch[1], title, login, typeof body.url === "string" ? body.url.trim() : null, password, secretKey, hasApprovedUntil],
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

export default defineConfig({
  plugins: [react(), mboxDevApi()],
  publicDir: false,
  server: { port: 5173 },
});
