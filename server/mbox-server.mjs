import "./env.mjs";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client, Pool } from "pg";
import {
  configureJarvis, JARVIS_NAME, jarvisPhase, setAgentPhase, getAgentPhase, activeJarvisRequests,
  groqComplete, geminiComplete, bulkUpsertTourSheets, refreshDataSourceById, replyAsJarvis, searchTerms,
} from "./jarvis.mjs";
import { WebSocketServer } from "ws";
import { UX_UI_SKILL_CATALOG } from "./ux-ui-skill-catalog.mjs";
import { SKILL_CATALOG } from "./skill-catalog.mjs";
import { ensureWorkspaceSchema, handleWorkspaceApi } from "./workspaces.mjs";
import { ensureNotesSchema, handleNotesApi } from "./notes.mjs";
import { ensureStorageSchema, handleStorageApi } from "./storage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");

configureJarvis({ query, broadcastRealtime, rankMemories, recordMemoryAction });
// Таблицы локальных папок создаются сами (IF NOT EXISTS): боевая база не обновляется init-скриптом.
ensureWorkspaceSchema(query).catch((error) => console.error(`workspace schema: ${error.message}`));
ensureNotesSchema(query).catch((error) => console.error(`notes schema: ${error.message}`));
ensureStorageSchema(query).catch((error) => console.error(`storage schema: ${error.message}`));

const port = Number(process.env.MBOX_PORT || process.env.PORT || 3000);
const host = process.env.MBOX_HOST || "127.0.0.1";
const realtimeClients = new Set();
const requestContext = new AsyncLocalStorage();
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
    agent_inbox: "agent-visible inbox for notices, proposals and human decisions.",
    agent_runs: "agent work sessions with goal, read context, commands, touched files, heartbeat and result.",
    agent_presence: "live agent roster: who is connected right now, session count and last heartbeat. Fed by POST /api/mbox/agent/ping.",
    decision_log: "durable decisions explaining why something was done.",
    task_leases: "todos can be claimed by one agent through claimed_by, claimed_until and heartbeat_at.",
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
    "Call /api/mbox/agent/context?project=MBOX to get a full compact snapshot.",
    "Call /api/mbox/agent/next-task?project=MBOX&agent=Codex to pick work, then /api/mbox/todos/:id/claim before editing.",
    "Update todos through PATCH /api/mbox/todos/:id; keep notes concise and put structured facts into todo props.",
    "Create graph edges when the task reveals a project relation.",
    "Use /api/mbox/history, /api/mbox/agent/inbox, /api/mbox/agent/runs and /api/mbox/decisions to understand recent work.",
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

const actionLabels = {
  create: "добавил",
  update: "отредактировал",
  delete: "удалил",
  claim: "взял в работу",
  heartbeat: "обновил работу",
  finish: "завершил",
};


const INBOX_COLUMNS = "id::text, project_id::text, agent_name, item_type, title, body, status, priority, requires_human, props, pg_column_size(agent_inbox)::int AS memory_bytes, created_at::text, updated_at::text";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function broadcastRealtime(type, payload = {}) {
  const message = JSON.stringify({ type, ...payload, at: new Date().toISOString() });
  for (const client of realtimeClients) {
    if (client.readyState === 1) client.send(message);
  }
}

// HTTP-заголовки — ASCII-only (ByteString); клиенты (mbox-mcp-server.mjs, mbox-archivist.mjs)
// шлют имя агента через encodeURIComponent, чтобы кириллица ("Архивариус") не валила fetch.
// Старые клиенты присылают чистый ASCII — decodeURIComponent на нём тоже безопасен (no-op).
function decodeAgentHeader(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function actorFromReq(req) {
  // Контекст на запрос резолвится один раз в handleApi (см. resolveRequestActor) и покрывает
  // и заголовок доверенного агента, и вошедшего человека. Заголовок — фолбэк на случай вызова
  // до входа в контекст (не должно происходить в обычном потоке).
  const contextActor = requestContext.getStore()?.actor;
  if (contextActor) return contextActor;
  const header = req.headers["x-mbox-agent"] || req.headers["x-agent-name"];
  return header ? decodeAgentHeader(header) : "Agent";
}

/**
 * Раньше любой запрос без заголовка x-mbox-agent (то есть ЛЮБОЕ действие человека через браузер)
 * писался в аудит как безликий actor "Agent" — то же имя, что и у настоящих ботов. Теперь для
 * запросов без заголовка актёр берётся из вошедшей сессии (username), и правки человека в истории
 * видны как он сам, а не как агент.
 */
async function resolveRequestActor(req) {
  const header = req.headers["x-mbox-agent"] || req.headers["x-agent-name"];
  if (header) return decodeAgentHeader(header);
  try {
    const user = await currentUser(req);
    if (user?.username) return user.username;
  } catch {
    // Сессии ещё нет (например, сам /auth/login) — останется дефолт ниже.
  }
  return "Agent";
}

function readableDetail(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const questionMarks = (text.match(/\?/g) || []).length;
  const letters = (text.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
  if (questionMarks >= 4 && questionMarks >= letters) return fallback;
  return text;
}

function broadcastChange(req, action, entity, detail = "") {
  const actor = String(actorFromReq(req));
  const verb = actionLabels[action] || action;
  const safeDetail = readableDetail(detail, entity);
  broadcastRealtime("entity_changed", {
    entity,
    action,
    actor,
    detail: safeDetail,
    notification: `Агент ${actor} ${verb} ${safeDetail}`,
  });
}

function detailMode(url, fallback = "full") {
  const detail = String(url.searchParams.get("detail") || fallback).toLowerCase();
  return detail === "full" ? "full" : "short";
}

function textPreview(value, limit = 240) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

function compactTextRow(row, fields, limit = 240) {
  const compact = { ...row };
  for (const field of fields) {
    const raw = compact[field];
    const rawText = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    compact[`${field}_preview`] = textPreview(raw, limit);
    compact[`${field}_bytes`] = Buffer.byteLength(rawText, "utf8");
    compact[`${field}_truncated`] = rawText.length > compact[`${field}_preview`].length;
    delete compact[field];
  }
  return compact;
}

function compactMemoryRow(memory, limit = 400) {
  return {
    id: memory.id,
    project_id: memory.project_id || memory.metadata?.project_id || null,
    todo_id: memory.todo_id || memory.metadata?.todo_id || null,
    agent_run_id: memory.agent_run_id || memory.metadata?.agent_run_id || null,
    title: memory.title,
    content_preview: textPreview(memory.content, limit),
    content_bytes: Buffer.byteLength(String(memory.content || ""), "utf8"),
    content_truncated: String(memory.content || "").length > textPreview(memory.content, limit).length,
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

function memoryProject(memory) {
  const projectId = memory.project_id || memory.metadata?.project_id || null;
  return memory.project_name || memory.metadata?.project || projectId || "";
}

function compactRecallMemoryRow(memory, limit = 140) {
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

function tokenizeEmbeddingText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .match(/[a-z0-9а-яё]{2,}/giu) || [];
}

function memoryEmbeddingText(memory) {
  return [
    memory.title,
    memory.content,
    Array.isArray(memory.tags) ? memory.tags.join(" ") : "",
    memory.metadata && typeof memory.metadata === "object" ? Object.values(memory.metadata).join(" ") : "",
  ].join(" ");
}

function tokenizeRecallText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]{2,}/gu) || [];
}

function expandRecallText(value) {
  const text = String(value || "");
  const synonyms = {
    "деплой": "deploy deployment vercel production",
    "прод": "prod production боевой",
    "боевой": "prod production live",
    "релиз": "release deploy",
  };
  const tokens = tokenizeRecallText(text);
  const expanded = tokens.flatMap((token) => [token, synonyms[token] || ""]);
  return `${text} ${expanded.join(" ")}`;
}

function buildTfIdfIndex(documents) {
  const documentTerms = documents.map((doc) => {
    const counts = new Map();
    for (const token of tokenizeEmbeddingText(doc.text)) counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  });
  const documentFrequency = new Map();
  for (const counts of documentTerms) {
    for (const token of counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const count = Math.max(documents.length, 1);
  return documents.map((doc, index) => vectorFromCounts(documentTerms[index], documentFrequency, count, doc.id));
}

function vectorFromText(text, documentFrequency, documentCount) {
  const counts = new Map();
  for (const token of tokenizeEmbeddingText(text)) counts.set(token, (counts.get(token) || 0) + 1);
  return vectorFromCounts(counts, documentFrequency, Math.max(documentCount, 1));
}

function vectorFromCounts(counts, documentFrequency, documentCount, id = "") {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0) || 1;
  const terms = {};
  let normSquared = 0;
  for (const [token, hits] of counts.entries()) {
    const idf = Math.log((1 + documentCount) / (1 + (documentFrequency.get(token) || 0))) + 1;
    const weight = (hits / total) * idf;
    terms[token] = Number(weight.toFixed(6));
    normSquared += weight * weight;
  }
  return { id, terms, norm: Number(Math.sqrt(normSquared).toFixed(6)) };
}

function cosineSimilarity(left, right) {
  if (!left?.norm || !right?.norm) return 0;
  const [small, large] = Object.keys(left.terms).length < Object.keys(right.terms).length
    ? [left.terms, right.terms]
    : [right.terms, left.terms];
  let dot = 0;
  for (const [token, weight] of Object.entries(small)) {
    if (large[token]) dot += weight * large[token];
  }
  return dot / (left.norm * right.norm);
}

function recallLexicalScore(queryText, memory) {
  const expandedQuery = expandRecallText(queryText);
  const queryTokens = [...new Set(tokenizeRecallText(expandedQuery))];
  if (!queryTokens.length) return { lexical: 0, title: 0, tags: 0, exact: 0 };
  const titleTokens = new Set(tokenizeRecallText(expandRecallText(memory.title)));
  const tagTokens = new Set(tokenizeRecallText(expandRecallText((memory.tags || []).join(" "))));
  const allTokens = new Set(tokenizeRecallText(expandRecallText(memoryEmbeddingText(memory))));
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

/** Ранжированный поиск по памяти: TF-IDF-вектор плюс лексика. Общий для /memories/search (им пользуются
 * внешние агенты через MCP) и инструмента search_memory Джарвиса — у того раньше был свой ILIKE по
 * всей фразе целиком и без номеров записей. */
async function rankMemories(search, { projectId = "", project = "", tags = [], recencyDays = 0, minScore = 0.05, limit = 20, allowedProjectIds = null } = {}) {
  const { documents } = await refreshMemoryEmbeddings();
  const documentFrequency = new Map();
  for (const doc of documents) {
    for (const token of new Set(tokenizeEmbeddingText(doc.text))) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const queryVector = vectorFromText(search, documentFrequency, documents.length);
  const result = await query(
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
       AND ($4::int <= 0 OR m.updated_at >= now() - ($4::int * interval '1 day'))
       AND ($5::boolean OR m.project_id = ANY($6::bigint[]))`,
    [projectId, project, tags, recencyDays, allowedProjectIds == null, allowedProjectIds || []],
  );
  return result.rows
    .map((memory) => {
      const lexical = recallLexicalScore(search, memory);
      const vectorScore = cosineSimilarity(queryVector, memory.representation || {});
      const score = (vectorScore * 0.65) + (lexical.lexical * 0.25) + (lexical.title * 0.25) + (lexical.tags * 0.15) + (lexical.exact * 0.2);
      return { ...memory, score };
    })
    .filter((memory) => memory.score >= minScore)
    .sort((a, b) => b.score - a.score || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, limit)
    .map(({ representation, ...memory }) => ({ ...memory, score: Number(memory.score.toFixed(6)) }));
}

async function refreshMemoryEmbeddings() {
  const memories = await query(
    `SELECT m.id::text, m.title, m.content, m.tags, m.metadata, m.updated_at::text,
            e.updated_at::text AS embedding_updated_at
     FROM memories m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
     ORDER BY m.id`,
  );
  const documents = memories.rows.map((memory) => ({ id: memory.id, text: memoryEmbeddingText(memory), updated_at: memory.updated_at }));
  const vectors = buildTfIdfIndex(documents);
  // Раньше это был безусловный UPSERT на КАЖДУЮ запись памяти при КАЖДОМ вызове — а вызывается
  // эта функция и на чтение (relevantMemories для любого непустого поиска, значит из каждого
  // search_todos/get_next_task через /agent/context). query() открывает новое соединение на
  // каждый вызов (CLAUDE.md, подводный камень 4) — при 1600+ записях памяти это тысячи
  // последовательных подключений к БД на один поиск, была основная причина многоминутных
  // зависаний. Теперь пишем только записи с отсутствующим или устаревшим эмбеддингом.
  const stale = memories.rows.filter((m) => !m.embedding_updated_at || new Date(m.updated_at) > new Date(m.embedding_updated_at));
  const staleIds = new Set(stale.map((m) => m.id));
  for (const vector of vectors) {
    if (!staleIds.has(vector.id)) continue;
    await query(
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

async function relevantMemories(search, { projectId = "", todoId = "", limit = 5 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit || 5), 1), 5);
  const queryText = String(search || "").trim();
  if (!queryText) {
    const result = await query(
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
  const documentFrequency = new Map();
  for (const doc of documents) {
    for (const token of new Set(tokenizeEmbeddingText(doc.text))) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const queryVector = vectorFromText(queryText, documentFrequency, documents.length);
  const result = await query(
    `SELECT m.id::text, m.project_id::text, m.todo_id::text, m.agent_run_id::text, m.title, m.content, m.entity_type, m.access_level, m.tags, m.metadata,
            m.created_at::text, m.updated_at::text, e.representation
     FROM memories m
     JOIN memory_embeddings e ON e.memory_id = m.id`,
  );
  return result.rows
    .map((memory) => {
      const projectMatch = projectId && (String(memory.project_id || "") === String(projectId) || String(memory.metadata?.project_id || "") === String(projectId));
      const todoMatch = todoId && (String(memory.todo_id || "") === String(todoId) || String(memory.metadata?.todo_id || "") === String(todoId));
      const score = cosineSimilarity(queryVector, memory.representation || {}) + (projectMatch ? 0.15 : 0) + (todoMatch ? 0.25 : 0);
      return { ...memory, score };
    })
    .filter((memory) => memory.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, safeLimit)
    .map((memory) => compactMemoryRow(memory));
}

async function autoRecordMemory({ projectId, todoId = null, agentRunId = null, sourceAgent, title, content, touchedFiles = [], reason }) {
  if (!projectId || !String(content || "").trim()) return null;
  const existing = await query(
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
    source_agent: sourceAgent || "Agent",
    project_id: String(projectId),
    todo_id: todoId ? String(todoId) : null,
    agent_run_id: agentRunId ? String(agentRunId) : null,
    touched_files: Array.isArray(touchedFiles) ? touchedFiles : [],
    recorded_via: "auto",
    auto_reason: reason,
  };
  const result = await query(
    `INSERT INTO memories(project_id, todo_id, agent_run_id, title, content, entity_type, access_level, tags, metadata)
     VALUES ($1, $2, $3, $4, $5, 'memory', 'agents', $6, $7)
     RETURNING id::text`,
    [projectId, todoId, agentRunId, textPreview(title, 160) || "Agent work result", textPreview(content, 2000), ["agent-work", "auto"], JSON.stringify(metadata)],
  );
  await refreshMemoryEmbeddings();
  const id = result.rows[0]?.id || null;
  await recordMemoryAction({ memoryId: id, actor: sourceAgent || "Agent", action: "auto_create", note: reason, metadata });
  return { skipped: false, id };
}

async function closeStaleAgentRuns() {
  const result = await query(
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

function buildMemoryReview(memories) {
  const issues = [];
  const fingerprints = new Map();
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
  const order = { high: 1, normal: 2, low: 3 };
  issues.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9) || Number(a.memory_id) - Number(b.memory_id));
  return { checked: memories.length, issues: issues.length, queue: issues };
}

function normalizeMemoryText(value) {
  return String(value || "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function looksLikeRawLog(content) {
  const text = String(content || "");
  const lines = text.split(/\r?\n/);
  const jsonishLines = lines.filter((line) => /^\s*[{[]/.test(line)).length;
  return /Traceback|UnhandledPromiseRejection|^\s*at\s+\S+\s+\(|npm ERR!|SQLSTATE|ERROR:/m.test(text)
    || jsonishLines >= 5
    || (lines.length > 80 && /error|warn|debug|info/i.test(text));
}

function memoryReviewIssue(memory, severity, type, reason, suggestion, related_ids = []) {
  return { memory_id: memory.id, severity, type, title: memory.title, reason, suggestion, related_ids, updated_at: memory.updated_at };
}

function digestDocument({ title = "Document", content = "", maxFragments = 40, minChars = 80 } = {}) {
  const sourceTitle = String(title || "Document").trim() || "Document";
  const text = String(content || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { title: sourceTitle, fragments: [], stats: { characters: 0, lines: 0 } };

  const fragments = [];
  const lines = text.split("\n");
  const headingPath = [];
  let block = [];
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

function parseDigestHeading(line) {
  const markdown = line.match(/^(#{1,6})\s+(.+)$/);
  if (markdown) return { level: markdown[1].length, text: markdown[2].trim() };
  const numbered = line.match(/^(\d+(?:\.\d+){0,4})[.)]\s+(.+)$/);
  if (numbered && line.length < 120) return { level: Math.min(numbered[1].split(".").length, 6), text: numbered[2].trim() };
  return null;
}

function digestLineKind(line) {
  if (line.includes("|") && line.split("|").filter((cell) => cell.trim()).length >= 2) return "table";
  if (line.includes("\t") && line.split("\t").filter((cell) => cell.trim()).length >= 2) return "table";
  if (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) return "list";
  return "paragraph";
}

function normalizeDigestBlock(lines, kind) {
  if (kind === "table") return digestTable(lines);
  if (kind === "list") return lines.map((line) => line.replace(/^[-*+]\s+/, "- ").replace(/^\d+[.)]\s+/, "- ")).join("\n");
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function digestTable(lines) {
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

function slugDigestToken(value) {
  return String(value || "").toLowerCase().normalize("NFKC").replace(/[^a-z0-9а-яё]+/giu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "section";
}

function buildMemoryHierarchy(memories) {
  const root = { name: "root", path: "", count: 0, memory_ids: [], children: {} };
  const paths = new Map();
  for (const memory of memories) {
    const memoryPaths = hierarchyPathsForMemory(memory);
    for (const path of memoryPaths) {
      let node = root;
      root.count += 1;
      root.memory_ids.push(memory.id);
      const parts = path.split("/").filter(Boolean);
      const built = [];
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

function hierarchyPathsForMemory(memory) {
  const metadata = memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {};
  const tags = Array.isArray(memory.tags) ? memory.tags.map(String).filter(Boolean) : [];
  const paths = [];
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

function compactHierarchyNode(node) {
  return {
    name: node.name,
    path: node.path,
    count: node.count,
    memory_ids: [...new Set(node.memory_ids)].slice(0, 20),
    children: Object.values(node.children).map(compactHierarchyNode).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

function suggestMemoryHierarchy(input, memories, limit = 8) {
  const queryText = memoryEmbeddingText({
    id: "",
    title: String(input.title || ""),
    content: String(input.content || ""),
    tags: Array.isArray(input.tags) ? input.tags : [],
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    updated_at: "",
  });
  const documents = memories.map((memory) => ({ id: memory.id, text: memoryEmbeddingText(memory) }));
  const vectors = buildTfIdfIndex(documents);
  const documentFrequency = new Map();
  for (const doc of documents) {
    for (const token of new Set(tokenizeEmbeddingText(doc.text))) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const queryVector = vectorFromText(queryText, documentFrequency, documents.length);
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const similar = vectors
    .map((vector) => ({ memory: byId.get(vector.id), score: cosineSimilarity(queryVector, vector) }))
    .filter((item) => item.memory && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(Number(limit || 8), 20)));
  const tagScores = new Map();
  const pathScores = new Map();
  for (const item of similar) {
    for (const tag of item.memory.tags || []) tagScores.set(tag, (tagScores.get(tag) || 0) + item.score);
    for (const path of hierarchyPathsForMemory(item.memory)) pathScores.set(path, (pathScores.get(path) || 0) + item.score);
  }
  return {
    suggestions: {
      tags: [...tagScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, score]) => ({ tag, score: Number(score.toFixed(6)) })),
      paths: [...pathScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, score]) => ({ path, score: Number(score.toFixed(6)) })),
    },
    similar: similar.map(({ memory, score }) => ({ ...compactMemoryRow(memory, 220), score: Number(score.toFixed(6)) })),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function isSecureRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (proto) return proto === "https";
  return Boolean(req.socket?.encrypted);
}

function sessionCookie(req, value, maxAge) {
  // Secure ставим только на HTTPS: в проде этот файл стоит за Caddy (см. docker-compose.production.yml),
  // а локально тот же сервер поднимается на http://localhost:3000 — там Secure-cookie браузер просто
  // не сохраняет, и после login все запросы уходят без сессии (пустой UI).
  // Часть аудита CSRF-риска из CLAUDE.md (todo #164).
  const secure = isSecureRequest(req) ? " Secure;" : "";
  return `mbox_session=${value}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  const part = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

let pgPool = null;

// Пул вместо соединения на каждый вызов — то же, что давно сделано в vite.config.ts (dev-API).
// На проде база локальная и разница почти незаметна, но при локальном запуске через ssh-туннель
// каждое новое подключение стоило ~2 секунды: экран грузился больше десяти секунд и выглядел
// как пустой, из-за чего 5173 "работал с базой", а 3000 нет.
function getPool() {
  if (!pgPool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, idleTimeoutMillis: 30_000, keepAlive: true });
    pgPool.on("error", () => { /* соединение умерло в простое — пул заменит его сам */ });
  }
  return pgPool;
}

async function query(sql, values = []) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  const actor = requestContext.getStore()?.actor;
  if (!actor) return getPool().query(sql, values);
  // Актор ставится сессионно и переживает возврат соединения в пул, но каждый запрос с актором
  // выставляет свой перед обращением, а аудит пишется только на мутациях — чужой актор протечь
  // в audit_events не может.
  const client = await getPool().connect();
  try {
    await client.query("SELECT set_config('mbox.actor', $1, false)", [actor]);
    return await client.query(sql, values);
  } finally {
    client.release();
  }
}

async function recordMemoryAction({ memoryId, actor = "agent", action, note = "", metadata = {} }) {
  if (!memoryId || !action) return null;
  const result = await query(
    `INSERT INTO memory_actions(memory_id, actor, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text, memory_id::text, actor, action, note, metadata, created_at::text`,
    [memoryId, actor, action, note, JSON.stringify(metadata && typeof metadata === "object" ? metadata : {})],
  );
  return result.rows[0] || null;
}

async function currentUser(req) {
  const token = getCookie(req, "mbox_session");
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await query(
    `SELECT u.id::text, u.username, u.role
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] || null;
}

async function requireUser(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  return user;
}

function isOwner(user) {
  return user?.role === "owner";
}

async function projectScope(user) {
  if (isOwner(user)) return { all: true, projectIds: [] };
  const result = await query(
    "SELECT project_id::text FROM project_memberships WHERE user_id = $1 ORDER BY project_id",
    [user.id],
  );
  return { all: false, projectIds: result.rows.map((row) => row.project_id) };
}

function hasProjectAccess(scope, projectId) {
  return scope.all || (projectId != null && scope.projectIds.includes(String(projectId)));
}

function sendForbidden(res) {
  return sendJson(res, 403, { error: "project_access_denied" });
}

// Members use the same console, but are fail-closed for endpoints which do not
// have a project filter.  New endpoints must be deliberately added here.
function memberRouteAllowed(pathname) {
  return pathname === "/api/mbox/auth/me"
    || pathname === "/api/mbox/agent/skills"
    || pathname === "/api/mbox/projects"
    || pathname === "/api/mbox/memories"
    || pathname === "/api/mbox/memories/search"
    || pathname === "/api/mbox/folders"
    || pathname === "/api/mbox/artifacts"
    || pathname === "/api/mbox/history"
    || pathname === "/api/mbox/graph/edges"
    || pathname === "/api/mbox/agent/runs"
    || pathname === "/api/mbox/decisions"
    || pathname === "/api/mbox/todos"
    || pathname === "/api/mbox/agent/inbox"
    || /^\/api\/mbox\/(projects|memories|folders|artifacts|todos|agent\/inbox|agent\/runs)\/\d+(?:\/trail)?$/.test(pathname);
}

// Каталог навыков — одноразовые вызовы модели без оркестрации инструментами (см. /jarvis в
// AgentChat.tsx). Он объявлен здесь, а не в базе, потому что навык существует ровно постольку,
// поскольку в этом файле есть вызывающий его код: purpose ниже — тот же литерал, что уходит в
// groqComplete, и по нему же считается живой расход из groq_usage.
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

// Служебные режимы — не навыки, но тот же счётчик токенов; показываем рядом, чтобы расход
// младшей модели было с чем сравнивать.
const SERVICE_MODES = {
  reply: "Ответ в чате",
  cron: "Фоновый разбор по расписанию",
  "history-compression": "Сжатие истории диалога",
};

async function handleApi(req, res, url) {
  const actor = await resolveRequestActor(req);
  return requestContext.run({ actor }, () => handleApiWithContext(req, res, url));
}

async function handleApiWithContext(req, res, url) {
  const q = url.searchParams.get("q")?.trim() || "";

  if (url.pathname === "/api/mbox/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const user = await query(
      `SELECT id::text, username, role
       FROM users
       WHERE username = $1 AND password_hash = crypt($2, password_hash)`,
      [body.username, body.password],
    );
    if (!user.rows[0]) return sendJson(res, 401, { error: "invalid_credentials" });

    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await query("INSERT INTO auth_sessions(user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')", [user.rows[0].id, tokenHash]);
    await query(
      `DELETE FROM auth_sessions
       WHERE expires_at < now()
          OR (user_id = $1 AND id NOT IN (
                SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20
              ))`,
      [user.rows[0].id],
    );
    res.setHeader("set-cookie", sessionCookie(req, encodeURIComponent(token), 2592000));
    return sendJson(res, 200, { user: user.rows[0] });
  }

  if (url.pathname === "/api/mbox/auth/logout" && req.method === "POST") {
    const token = getCookie(req, "mbox_session");
    if (token) await query("DELETE FROM auth_sessions WHERE token_hash = $1", [createHash("sha256").update(token).digest("hex")]);
    res.setHeader("set-cookie", sessionCookie(req, "", 0));
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/auth/me") {
    return sendJson(res, 200, { user: await currentUser(req) });
  }

  const user = await requireUser(req, res);
  if (!user) return;
  const scope = await projectScope(user);

  if (url.pathname === "/api/mbox/admin/users" && req.method === "POST") {
    if (!isOwner(user)) return sendForbidden(res);
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const projectId = String(body.project_id || "").trim();
    if (!username || password.length < 8 || !/^\d+$/.test(projectId)) {
      return sendJson(res, 400, { error: "username_password_and_project_required" });
    }
    const email = String(body.email || `${username.toLowerCase()}@mbox.local`).trim();
    const created = await query(
      `INSERT INTO users(email, username, password_hash, role)
       VALUES ($1, $2, crypt($3, gen_salt('bf')), 'member')
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'member'
       RETURNING id::text, username, role`,
      [email, username, password],
    );
    const member = created.rows[0];
    const project = await query("SELECT id::text, name FROM projects WHERE id = $1", [projectId]);
    if (!project.rows[0]) return sendJson(res, 404, { error: "project_not_found" });
    await query(
      `INSERT INTO project_memberships(project_id, user_id, role) VALUES ($1, $2, 'editor')
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'editor'`,
      [projectId, member.id],
    );
    return sendJson(res, 201, { user: member, project: project.rows[0] });
  }

  if (!scope.all && !memberRouteAllowed(url.pathname)) return sendForbidden(res);

  if (await handleWorkspaceApi({ req, res, url, query, readBody, sendJson, actor: actorFromReq(req), allowed: scope.all, broadcast: broadcastRealtime })) return;
  if (await handleNotesApi({ req, res, url, query, readBody, sendJson, actor: actorFromReq(req), allowed: scope.all })) return;
  if (await handleStorageApi({ req, res, url, query, readBody, sendJson, allowed: scope.all, secretKey: process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key" })) return;

  if (url.pathname === "/api/mbox/agent/structure") {
    return sendJson(res, 200, { structure: agentStructure });
  }

  if (url.pathname === "/api/mbox/agent/ping" && req.method === "POST") {
    const body = await readBody(req);
    const name = String(body.agent || actorFromReq(req)).trim() || "Agent";
    const started = body.event === "session_start";
    const result = await query(
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
    if (started) broadcastRealtime("agent_presence", { agent: name, event: "session_start" });
    if (typeof body.phase === "string") {
      setAgentPhase(name, body.phase.trim());
      broadcastRealtime("agent_presence", { agent: name, event: "phase" });
    }
    return sendJson(res, 200, { presence: result.rows[0] });
  }

  if (url.pathname === "/api/mbox/tools" && req.method === "GET") {
    return sendJson(res, 200, { tools: TOOL_CATALOG });
  }

  if (url.pathname === "/api/mbox/agent/skills" && req.method === "GET") {
    const usage = await query(
      `SELECT purpose,
              count(*)::int AS calls,
              COALESCE(sum(total_tokens), 0)::bigint AS tokens,
              COALESCE(count(*) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::int AS calls_24h,
              max(created_at)::text AS last_used_at,
              (array_agg(model ORDER BY created_at DESC))[1] AS last_model
       FROM groq_usage GROUP BY purpose`,
    );
    const byPurpose = new Map(usage.rows.map((row) => [row.purpose, row]));
    const withUsage = (id) => {
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
    const modes = Object.entries(SERVICE_MODES).map(([id, name]) => ({ id, name, ...withUsage(id) }));
    // Навык, который кто-то залогировал, но забыл описать в каталоге — иначе он молча пропал бы из UI.
    const unknown = usage.rows
      .filter((row) => row.purpose.startsWith("skill-") && !catalog.some((skill) => skill.id === row.purpose))
      .map((row) => ({ id: row.purpose, name: row.purpose, owner: "?", trigger: "", summary: "Навык есть в логе расхода, но не описан в каталоге сервера.", input: "", output: "", ...withUsage(row.purpose) }));
    return sendJson(res, 200, { skills: [...skills, ...unknown], modes });
  }

  if (url.pathname === "/api/mbox/agent/groq-usage" && req.method === "GET") {
    const result = await query(
      `SELECT
         (SELECT COALESCE(sum(total_tokens), 0) FROM groq_usage)::bigint AS total_tokens,
         (SELECT COALESCE(sum(total_tokens), 0) FROM groq_usage WHERE created_at > now() - interval '24 hours')::bigint AS tokens_24h,
         (SELECT COALESCE(sum(total_tokens), 0) FROM groq_usage WHERE created_at > date_trunc('day', now()))::bigint AS tokens_today,
         (SELECT count(*) FROM groq_usage)::int AS calls_total,
         (SELECT count(*) FROM groq_usage WHERE created_at > now() - interval '24 hours')::int AS calls_24h,
         (SELECT max(created_at)::text FROM groq_usage) AS last_call_at`,
    );
    // by_model — добавлено для delegate/get_groq_usage-инструмента резервного cron-пути
    // (scripts/mbox-archivist.mjs), у которого нет прямого доступа к БД, только REST. Поля выше
    // (total_tokens и т.п.) — блендированная сумма по ОБЕИМ моделям (см. INSERT из geminiComplete),
    // старые потребители этой ручки не ломаются, by_model — чистое дополнение.
    const byModel = await query(
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
    // Резервный cron-путь (scripts/mbox-archivist.mjs) не имеет прямого доступа к БД, только REST —
    // логирует свой расход через этот же счётчик, чтобы цифра в UI была честной, а не только по
    // мгновенным ответам.
    const body = await readBody(req);
    await query(
      "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
      [String(body.purpose || "reply"), String(body.model || ""), Number(body.prompt_tokens) || 0, Number(body.completion_tokens) || 0, Number(body.total_tokens) || 0],
    );
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/agent/jarvis-errors" && req.method === "GET") {
    // Раньше падения Джарвиса были видны только в docker logs контейнера — то есть нигде, кто
    // не читает логи сервера руками. Здесь их видно и человеку (через историю), и самому Джарвису
    // (см. tool list_recent_errors), если спросят "что у тебя ломалось".
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    const inboxId = /^\d+$/.test(url.searchParams.get("inbox_id") || "") ? url.searchParams.get("inbox_id") : "";
    const source = url.searchParams.get("source")?.trim() || "";
    const result = await query(
      `SELECT id::text, source, tool_name, inbox_id::text, project_id::text, message, created_at::text
       FROM jarvis_errors
       WHERE (NULLIF($1, '') IS NULL OR inbox_id = NULLIF($1, '')::bigint) AND ($2 = '' OR source = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [inboxId, source, limit],
    );
    return sendJson(res, 200, { errors: result.rows });
  }

  if (url.pathname === "/api/mbox/agent/jarvis-errors" && req.method === "POST") {
    // Резервный cron-путь логирует сюда же через REST, как и groq-usage выше.
    const body = await readBody(req);
    await query(
      "INSERT INTO jarvis_errors(source, tool_name, inbox_id, project_id, message) VALUES ($1, $2, $3, $4, $5)",
      [String(body.source || "reply"), String(body.tool_name || ""), body.inbox_id || null, body.project_id || null, String(body.message || "").slice(0, 2000)],
    );
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/agents") {
    await closeStaleAgentRuns();
    const result = await query(
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
      const online = row.online || row.live_runs > 0;
      return {
        // [^a-z0-9] раньше резало кириллицу целиком — "Джарвис" схлопывался в "" и падал на
        // фолбэк "agent", который совпадал с id реального агента с именем "Agent". Общий React-key
        // на двух разных агентах — и ростер начинал плодить призрачные дубли строк при пересортировке.
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

  if (url.pathname === "/api/mbox/memory-links") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
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
      await recordMemoryAction({ memoryId: body.from_memory_id, actor: actorFromReq(req), action: "link_create", note: `linked to memory ${body.to_memory_id}`, metadata: result.rows[0] || {} });
      await recordMemoryAction({ memoryId: body.to_memory_id, actor: actorFromReq(req), action: "link_create", note: `linked from memory ${body.from_memory_id}`, metadata: result.rows[0] || {} });
      return sendJson(res, 201, { link: result.rows[0] });
    }
    const memoryId = url.searchParams.get("memory_id") || "";
    const result = await query(
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
    const link = await query("DELETE FROM memory_links WHERE id = $1 RETURNING id::text, from_memory_id::text, to_memory_id::text, link_type", [memoryLinkMatch[1]]);
    if (link.rows[0]) {
      await recordMemoryAction({ memoryId: link.rows[0].from_memory_id, actor: actorFromReq(req), action: "link_delete", note: `unlinked memory ${link.rows[0].to_memory_id}`, metadata: link.rows[0] });
      await recordMemoryAction({ memoryId: link.rows[0].to_memory_id, actor: actorFromReq(req), action: "link_delete", note: `unlinked memory ${link.rows[0].from_memory_id}`, metadata: link.rows[0] });
    }
    return sendJson(res, link.rows[0] ? 200 : 404, link.rows[0] ? { ok: true, link: link.rows[0] } : { error: "not_found" });
  }

  if (url.pathname === "/api/mbox/memories") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
        `INSERT INTO memories(folder_id, project_id, todo_id, agent_run_id, title, content, entity_type, access_level, tags, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE(NULLIF($7, ''), 'memory'), COALESCE(NULLIF($8, ''), 'private'), $9, $10)
         RETURNING id::text`,
        [
          body.folder_id || null,
          body.project_id || null,
          body.todo_id || null,
          body.agent_run_id || null,
          String(body.title || "").trim(),
          String(body.content || ""),
          String(body.entity_type || ""),
          String(body.access_level || ""),
          Array.isArray(body.tags) ? body.tags : [],
          JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
        ],
      );
      await recordMemoryAction({ memoryId: result.rows[0]?.id, actor: actorFromReq(req), action: "create", note: "memory created via API", metadata: { title: String(body.title || "").trim() } });
      await refreshMemoryEmbeddings();
      broadcastChange(req, "create", "memories", String(body.title || "").trim());
      return sendJson(res, 201, { memory: result.rows[0] });
    }
    // sort=oldest — для фоновой уборки памяти (архивариус ищет кандидатов на удаление среди
    // старых записей), без него ORDER BY updated_at DESC LIMIT 300 отдавал бы только САМЫЕ
    // СВЕЖИЕ записи — ровно противоположность тому, что нужно для поиска устаревшего.
    const sortOldest = url.searchParams.get("sort") === "oldest";
    // Поиск в интерфейсе. 15 сентября владелец: «поиск по памяти не работает». Вся строка искалась одной
    // подстрокой, а plainto_tsquery требовал каждое слово в точной форме: «пересборке фронта», «Electron
    // сборка», «релиз шара» не находили запись «Процесс сборки и релиза Electron-клиента Шара», и выдача шла
    // по дате. Теперь как у Джарвиса (searchTerms): слова по отдельности с отрезанными окончаниями, сначала
    // записи со всеми словами, иначе хотя бы с частью; выше совпадение всей фразы и слов в заголовке.
    const memoryTerms = q ? (searchTerms(q).length ? searchTerms(q) : [q.toLowerCase()]) : [];
    const memoryHaystack = "(title || ' ' || coalesce(content, '') || ' ' || array_to_string(tags, ' '))";
    const selectMemories = (mode) => {
      const values = mode ? [memoryTerms, q] : [];
      const projectFilter = scope.all
        ? ""
        : `${mode ? " AND" : " WHERE"} project_id = ANY($${values.push(scope.projectIds)}::bigint[])`;
      return query(
      `SELECT id::text, folder_id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
              pg_column_size(memories)::int AS memory_bytes,
              created_at::text, updated_at::text,
              count(*) OVER()::int AS total_count,
              sum(pg_column_size(memories)) OVER()::bigint AS total_bytes
       FROM memories
       ${mode ? `WHERE (SELECT ${mode}(${memoryHaystack} ILIKE '%' || term || '%') FROM unnest($1::text[]) AS term)` : ""}${projectFilter}
       ORDER BY ${mode
    ? `(${memoryHaystack} ILIKE '%' || $2 || '%') DESC,
          (SELECT count(*) FROM unnest($1::text[]) AS term WHERE title ILIKE '%' || term || '%') DESC,
          (SELECT count(*) FROM unnest($1::text[]) AS term WHERE ${memoryHaystack} ILIKE '%' || term || '%') DESC,
          updated_at DESC`
    : `updated_at ${sortOldest ? "ASC" : "DESC"}`}
       LIMIT 300`,
      values,
      );
    };
    let result = await selectMemories(memoryTerms.length ? "bool_and" : "");
    if (!result.rows.length && memoryTerms.length > 1) result = await selectMemories("bool_or");
    // total/totalBytes — реальные числа по ВСЕМ подходящим записям (до LIMIT 300), не по
    // result.rows.length/сумме memory_bytes отданных строк. Раньше карточка "Память" на Обзоре
    // считала по data.memories (обрезанному до 300), то есть буквально упиралась в потолок LIMIT.
    const total = result.rows[0]?.total_count ?? result.rows.length;
    const totalBytes = Number(result.rows[0]?.total_bytes ?? 0);
    return sendJson(res, 200, { memories: result.rows.map(({ total_count, total_bytes, ...row }) => row), total, total_bytes: totalBytes });
  }

  if (url.pathname === "/api/mbox/memories/search") {
    const search = url.searchParams.get("q")?.trim() || "";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
    const detail = detailMode(url, "short");
    const minScore = Math.max(0, Number(url.searchParams.get("min_score") || (search ? 0.05 : 0)));
    const project = url.searchParams.get("project")?.trim() || "";
    const projectId = url.searchParams.get("project_id")?.trim() || "";
    if (!scope.all && projectId && !hasProjectAccess(scope, projectId)) return sendForbidden(res);
    const tags = (url.searchParams.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    const recencyDays = Number(url.searchParams.get("recency_days") || 0);
    if (!search) {
      const recent = await query(
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
           AND ($6::boolean OR m.project_id = ANY($7::bigint[]))
         ORDER BY m.updated_at DESC
         LIMIT $1`,
        [limit, projectId, project, tags, recencyDays, scope.all, scope.projectIds],
      );
      const memories = recent.rows.map((memory) => ({ ...memory, score: 0 }));
      return sendJson(res, 200, { query: search, detail, memories: detail === "full" ? memories : memories.map((memory) => compactRecallMemoryRow(memory)) });
    }

    const memories = await rankMemories(search, { projectId, project, tags, recencyDays, minScore, limit, allowedProjectIds: scope.all ? null : scope.projectIds });
    return sendJson(res, 200, {
      query: search,
      detail,
      filters: { project: project || null, project_id: projectId || null, tags, recency_days: recencyDays || null, min_score: minScore },
      memories: detail === "full" ? memories : memories.map((memory) => compactRecallMemoryRow(memory)),
    });
  }

  if (url.pathname === "/api/mbox/memories/review") {
    const result = await query(
      `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, tags, metadata,
              created_at::text, updated_at::text
       FROM memories
       ORDER BY updated_at DESC`,
    );
    return sendJson(res, 200, buildMemoryReview(result.rows));
  }

  if (url.pathname === "/api/mbox/memories/hierarchy") {
    const result = await query(
      `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
              created_at::text, updated_at::text
       FROM memories
       ORDER BY updated_at DESC`,
    );
    return sendJson(res, 200, { checked: result.rows.length, ...buildMemoryHierarchy(result.rows) });
  }

  if (url.pathname === "/api/mbox/memories/suggest-hierarchy" && req.method === "POST") {
    const body = await readBody(req);
    const projectId = String(body.project_id || "");
    const result = await query(
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
    const body = await readBody(req);
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

    const created = [];
    for (const fragment of digest.fragments) {
      const tags = [...new Set([...baseTags, ...fragment.tags])];
      const metadata = {
        ...baseMetadata,
        ...fragment.metadata,
        source_agent: actorFromReq(req),
        source_content_bytes: Buffer.byteLength(String(body.content || ""), "utf8"),
      };
      const result = await query(
        `INSERT INTO memories(folder_id, project_id, todo_id, agent_run_id, title, content, entity_type, access_level, tags, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, 'memory', COALESCE(NULLIF($7, ''), 'agents'), $8, $9)
         RETURNING id::text, title`,
        [
          body.folder_id || null,
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
      await recordMemoryAction({ memoryId: result.rows[0]?.id, actor: actorFromReq(req), action: "digest_fragment_create", note: `fragment ${fragment.index}`, metadata });
      created.push({ ...result.rows[0], fragment_index: fragment.index });
    }
    if (created.length) {
      await refreshMemoryEmbeddings();
      broadcastChange(req, "create", "memories", `digest ${digest.title}`);
    }
    return sendJson(res, 201, { ...digest, dry_run: false, created });
  }

  const memoryActionsMatch = url.pathname.match(/^\/api\/mbox\/memories\/(\d+)\/actions$/);
  if (memoryActionsMatch) {
    if (req.method === "POST") {
      const body = await readBody(req);
      const action = await recordMemoryAction({
        memoryId: memoryActionsMatch[1],
        actor: actorFromReq(req),
        action: String(body.action || "note"),
        note: String(body.note || ""),
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
      });
      return sendJson(res, 201, { action });
    }
    const result = await query(
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
    const result = await query(
      `SELECT m.id::text, m.folder_id::text, m.project_id::text, p.name AS project_name, m.todo_id::text, m.agent_run_id::text,
              m.title, m.content, m.entity_type, m.access_level, m.tags, m.metadata,
              pg_column_size(m)::int AS memory_bytes,
              m.created_at::text, m.updated_at::text
       FROM memories m
       LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.id = $1 AND ($2::boolean OR m.project_id = ANY($3::bigint[]))`,
      [memoryMatch[1], scope.all, scope.projectIds],
    );
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
  }

  if (memoryMatch && req.method === "PATCH") {
    const body = await readBody(req);
    if (!scope.all) {
      const current = await query("SELECT project_id::text FROM memories WHERE id = $1", [memoryMatch[1]]);
      if (!hasProjectAccess(scope, current.rows[0]?.project_id) || (Object.prototype.hasOwnProperty.call(body, "project_id") && !hasProjectAccess(scope, body.project_id))) return sendForbidden(res);
    }
    const result = await query(
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
      [String(body.title || "").trim(), body.content ?? null, String(body.access_level || ""), Array.isArray(body.tags) ? body.tags : null, Object.prototype.hasOwnProperty.call(body, "project_id"), body.project_id || null, String(body.entity_type || ""), memoryMatch[1]],
    );
    if (result.rows[0]) await recordMemoryAction({ memoryId: result.rows[0].id, actor: actorFromReq(req), action: "update", note: "memory updated via API", metadata: { fields: Object.keys(body || {}) } });
    if (result.rows[0]) await refreshMemoryEmbeddings();
    if (result.rows[0]) broadcastChange(req, "update", "memories", String(body.title || "").trim() || `#${memoryMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
  }

  if (memoryMatch && req.method === "DELETE") {
    if (!scope.all) {
      const current = await query("SELECT project_id::text FROM memories WHERE id = $1", [memoryMatch[1]]);
      if (!hasProjectAccess(scope, current.rows[0]?.project_id)) return sendForbidden(res);
    }
    await recordMemoryAction({ memoryId: memoryMatch[1], actor: actorFromReq(req), action: "delete", note: "memory deleted via API" });
    await query("DELETE FROM memories WHERE id = $1", [memoryMatch[1]]);
    await refreshMemoryEmbeddings();
    broadcastChange(req, "delete", "memories", `#${memoryMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/folders") {
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!hasProjectAccess(scope, body.project_id)) return sendForbidden(res);
      const result = await query(
        `INSERT INTO folders(parent_id, name, entity_type, access_level, color, project_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text`,
        [body.parent_id || null, String(body.name || "").trim(), String(body.entity_type || "artifact"), String(body.access_level || "private"), String(body.color || "#2c2c2e"), body.project_id || null],
      );
      broadcastChange(req, "create", "folders", String(body.name || "").trim());
      return sendJson(res, 201, { folder: result.rows[0] });
    }
    const result = await query(
      `WITH RECURSIVE own AS (
         SELECT f.id,
                pg_column_size(f)::int
                  + COALESCE((SELECT sum(pg_column_size(m))::int FROM memories m WHERE m.folder_id = f.id), 0)
                  + COALESCE((SELECT sum(pg_column_size(p))::int FROM projects p WHERE p.folder_id = f.id), 0)
                  + COALESCE((SELECT sum(pg_column_size(c))::int FROM companies c WHERE c.folder_id = f.id), 0)
                  + COALESCE((SELECT sum(pg_column_size(a))::int FROM artifacts a
                              WHERE a.folder_id = f.id
                                 OR (a.folder_id IS NULL AND f.entity_type = 'artifact' AND a.category = f.name)), 0)
                  + COALESCE((SELECT sum(pg_column_size(s))::int FROM protected_secrets s WHERE s.folder_id = f.id), 0) AS bytes,
                COALESCE((SELECT count(*) FROM memories m WHERE m.folder_id = f.id), 0)
                  + COALESCE((SELECT count(*) FROM projects p WHERE p.folder_id = f.id), 0)
                  + COALESCE((SELECT count(*) FROM companies c WHERE c.folder_id = f.id), 0)
                  + COALESCE((SELECT count(*) FROM artifacts a
                              WHERE a.folder_id = f.id
                                 OR (a.folder_id IS NULL AND f.entity_type = 'artifact' AND a.category = f.name)), 0)
                  + COALESCE((SELECT count(*) FROM protected_secrets s WHERE s.folder_id = f.id), 0) AS items
         FROM folders f
       ),
       tree AS (
         SELECT f.id AS root_id, f.id AS node_id, 0 AS depth FROM folders f
         UNION ALL
         SELECT t.root_id, c.id, t.depth + 1 FROM tree t JOIN folders c ON c.parent_id = t.node_id WHERE t.depth < 20
       ),
       rollup AS (
         SELECT t.root_id AS id, sum(o.bytes)::int AS content_bytes, sum(o.items)::int AS content_items
         FROM tree t JOIN own o ON o.id = t.node_id
         GROUP BY t.root_id
       )
       SELECT id::text, parent_id::text, project_id::text, name, entity_type, access_level, color,
              pg_column_size(folders)::int AS memory_bytes,
              COALESCE((SELECT content_bytes FROM rollup WHERE rollup.id = folders.id), 0) AS content_bytes,
              COALESCE((SELECT content_items FROM rollup WHERE rollup.id = folders.id), 0) AS content_items
       FROM folders
       WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
         AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR entity_type ILIKE '%' || $1 || '%')
       ORDER BY COALESCE(parent_id, 0), name`,
      [q, scope.all, scope.projectIds],
    );
    return sendJson(res, 200, { folders: result.rows });
  }

  const folderMatch = url.pathname.match(/^\/api\/mbox\/folders\/(\d+)$/);
  if (folderMatch && req.method === "PATCH") {
    const body = await readBody(req);
    if (!scope.all) {
      const current = await query("SELECT project_id::text FROM folders WHERE id = $1", [folderMatch[1]]);
      if (!hasProjectAccess(scope, current.rows[0]?.project_id)) return sendForbidden(res);
    }
    const result = await query(
      `UPDATE folders SET
         parent_id = $1,
         name = COALESCE(NULLIF($2, ''), name),
         entity_type = COALESCE(NULLIF($3, ''), entity_type),
         access_level = COALESCE(NULLIF($4, ''), access_level),
         color = COALESCE(NULLIF($5, ''), color)
       WHERE id = $6
       RETURNING id::text`,
      [body.parent_id || null, String(body.name || "").trim(), String(body.entity_type || ""), String(body.access_level || ""), String(body.color || ""), folderMatch[1]],
    );
    if (result.rows[0]) broadcastChange(req, "update", "folders", String(body.name || "").trim() || `#${folderMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { folder: result.rows[0] } : { error: "not_found" });
  }

  if (folderMatch && req.method === "DELETE") {
    if (!scope.all) {
      const current = await query("SELECT project_id::text FROM folders WHERE id = $1", [folderMatch[1]]);
      if (!hasProjectAccess(scope, current.rows[0]?.project_id)) return sendForbidden(res);
    }
    await query("DELETE FROM folders WHERE id = $1", [folderMatch[1]]);
    broadcastChange(req, "delete", "folders", `#${folderMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/artifacts") {
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!hasProjectAccess(scope, body.project_id)) return sendForbidden(res);
      const result = await query(
        `INSERT INTO artifacts(folder_id, project_id, name, category, version, status, content, access_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE(NULLIF($8, ''), 'agents'))
         RETURNING id::text`,
        [body.folder_id || null, body.project_id || null, String(body.name || "").trim(), String(body.category || "Code"), String(body.version || "v1"), String(body.status || "created"), String(body.content || ""), String(body.access_level || "")],
      );
      broadcastChange(req, "create", "artifacts", String(body.name || "").trim());
      return sendJson(res, 201, { artifact: result.rows[0] });
    }
    const result = await query(
      `SELECT id::text, folder_id::text, project_id::text, name, category, version, status, content, access_level, pg_column_size(artifacts)::int AS memory_bytes
       FROM artifacts
       WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
         AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR category ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%')
       ORDER BY category, name
       LIMIT 300`,
      [q, scope.all, scope.projectIds],
    );
    return sendJson(res, 200, { artifacts: result.rows });
  }

  const artifactMatch = url.pathname.match(/^\/api\/mbox\/artifacts\/(\d+)$/);
  if (artifactMatch && req.method === "PATCH") {
    const body = await readBody(req);
    if (!scope.all) {
      const current = await query("SELECT project_id::text FROM artifacts WHERE id = $1", [artifactMatch[1]]);
      if (!hasProjectAccess(scope, current.rows[0]?.project_id) || (body.project_id && !hasProjectAccess(scope, body.project_id))) return sendForbidden(res);
    }
    const result = await query(
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
      [body.folder_id || null, body.project_id || null, String(body.name || "").trim(), String(body.category || ""), String(body.version || ""), String(body.status || ""), body.content ?? null, artifactMatch[1]],
    );
    if (result.rows[0]) broadcastChange(req, "update", "artifacts", String(body.name || "").trim() || `#${artifactMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { artifact: result.rows[0] } : { error: "not_found" });
  }

  if (artifactMatch && req.method === "DELETE") {
    if (!scope.all) {
      const current = await query("SELECT project_id::text FROM artifacts WHERE id = $1", [artifactMatch[1]]);
      if (!hasProjectAccess(scope, current.rows[0]?.project_id)) return sendForbidden(res);
    }
    await query("DELETE FROM artifacts WHERE id = $1", [artifactMatch[1]]);
    broadcastChange(req, "delete", "artifacts", `#${artifactMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/companies") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
        `INSERT INTO companies(folder_id, name, status, props, color, access_level)
         VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'active'), $4, $5, COALESCE(NULLIF($6, ''), 'private'))
         RETURNING id::text`,
        [body.folder_id || null, String(body.name || "").trim(), String(body.status || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {}), String(body.color || "#2c2c2e"), String(body.access_level || "")],
      );
      broadcastChange(req, "create", "companies", String(body.name || "").trim());
      return sendJson(res, 201, { company: result.rows[0] });
    }
    const companies = await query(
      `SELECT id::text, folder_id::text, name, status, props, color, access_level,
              pg_column_size(companies)::int AS memory_bytes,
              created_at::text, updated_at::text
       FROM companies
       WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR status ILIKE '%' || $1 || '%' OR props::text ILIKE '%' || $1 || '%'
       ORDER BY updated_at DESC
       LIMIT 200`,
      [q],
    );
    const relations = await query(
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

  /*
   * Источники данных: внешний URL (сайт, API), который периодически перечитывается сам, без
   * ручного напоминания. Живёт у проекта или у компании (см. CHECK в schema). Обновление —
   * не здесь: тикает scripts/mbox-archivist.mjs, эта ручка только хранит настройку и последний
   * известный результат (last_status/last_summary/last_memory_id).
   */
  const dataSourceMatch = url.pathname.match(/^\/api\/mbox\/data-sources\/(\d+)$/);

  if (url.pathname === "/api/mbox/data-sources") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const sourceUrl = String(body.url || "").trim();
      if (!name || !sourceUrl) return sendJson(res, 400, { error: "name_and_url_required" });
      if (!body.project_id && !body.company_id) return sendJson(res, 400, { error: "project_id_or_company_id_required" });
      const result = await query(
        `INSERT INTO data_sources(project_id, company_id, name, url, schedule_minutes, access_level, kind)
         VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5, 0), 1440), COALESCE(NULLIF($6, ''), 'agents'), COALESCE(NULLIF($7, ''), 'webpage'))
         RETURNING id::text`,
        [body.project_id || null, body.company_id || null, name, sourceUrl, Number(body.schedule_minutes) || 0, String(body.access_level || ""), String(body.kind || "")],
      );
      broadcastChange(req, "create", "data_sources", name);
      return sendJson(res, 201, { source: result.rows[0] });
    }
    const result = await query(
      `SELECT id::text, project_id::text, company_id::text, name, url, schedule_minutes, kind,
              last_fetched_at::text, last_status, last_summary, last_memory_id::text, access_level,
              created_at::text, updated_at::text
       FROM data_sources
       ORDER BY name`,
    );
    return sendJson(res, 200, { sources: result.rows });
  }

  if (dataSourceMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const result = await query(
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
        String(body.name || ""),
        String(body.url || ""),
        Number(body.schedule_minutes) || 0,
        body.last_fetched_at ? new Date(body.last_fetched_at) : null,
        String(body.last_status || ""),
        body.last_summary ?? null,
        body.last_memory_id || null,
        String(body.access_level || ""),
        dataSourceMatch[1],
        String(body.kind || ""),
      ],
    );
    if (result.rows[0]) broadcastChange(req, "update", "data_sources", `#${dataSourceMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { source: result.rows[0] } : { error: "not_found" });
  }

  if (dataSourceMatch && req.method === "DELETE") {
    await query("DELETE FROM data_sources WHERE id = $1", [dataSourceMatch[1]]);
    broadcastChange(req, "delete", "data_sources", `#${dataSourceMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  const dataSourceRefreshMatch = url.pathname.match(/^\/api\/mbox\/data-sources\/(\d+)\/refresh$/);
  if (dataSourceRefreshMatch && req.method === "POST") {
    // Синхронно: тянет URL и гоняет Groq прямо в этом запросе — кнопка «Обновить сейчас» в UI ждёт
    // реальный результат, а не ставит флаг для тика архивариуса раз в минуту.
    const result = await refreshDataSourceById(dataSourceRefreshMatch[1]);
    if (result.error === "источник не найден") return sendJson(res, 404, { error: "not_found" });
    broadcastChange(req, "update", "data_sources", `#${dataSourceRefreshMatch[1]}`);
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  /*
   * Тур-фид (kind='tours_xml' в data_sources) — структурированные данные, не веб-страница: их
   * не пересказывают через Groq, а разбирают в таблицу и ищут точным запросом. Разбор делает
   * архивариус (scripts/mbox-archivist.mjs, парсит XML целиком) и шлёт результат сюда одним
   * bulk-запросом на пачку — 1500 отдельных INSERT убили бы соединение (query() открывает новый
   * pg.Client на каждый вызов, см. CLAUDE.md). jsonb_to_recordset превращает JSON-массив в строки
   * одним запросом вместо ручной сборки $1..$12000 плейсхолдеров.
   */
  if (url.pathname === "/api/mbox/tour-sheets/bulk" && req.method === "POST") {
    // Резервный HTTP-путь для архивариуса (scripts/mbox-archivist.mjs — он ходит только по REST,
    // не через прямой client.query). Прод сам себя через эту ручку не дёргает — см.
    // bulkUpsertTourSheets, вызывается напрямую из refreshDataSourceById.
    const body = await readBody(req);
    const sourceId = body.source_id;
    const items = Array.isArray(body.items) ? body.items : [];
    if (!sourceId) return sendJson(res, 400, { error: "source_id_required" });
    const result = await bulkUpsertTourSheets(sourceId, items.map((item) => ({
      tour_id: String(item.tour_id || ""),
      sheet_id: String(item.sheet_id || ""),
      tour_name: String(item.tour_name || "").slice(0, 500),
      route_name: String(item.route_name || "").slice(0, 1000),
      date_start: item.date_start || null,
      date_end: item.date_end || null,
      free_places: Number(item.free_places) || 0,
      price_from: Number(item.price_from) || 0,
    })));
    return sendJson(res, 200, result);
  }

  if (url.pathname === "/api/mbox/tour-sheets" && req.method === "GET") {
    const search = String(url.searchParams.get("q") || "").trim();
    const onlyAvailable = url.searchParams.get("available") === "1";
    if (!search) return sendJson(res, 400, { error: "q_required" });
    const result = await query(
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

  if (url.pathname === "/api/mbox/telegram-posts" && req.method === "GET") {
    const sourceId = String(url.searchParams.get("source_id") || "").trim();
    if (!sourceId) return sendJson(res, 400, { error: "source_id_required" });
    const result = await query(
      `SELECT id::text, title, content, metadata
       FROM memories WHERE entity_type = 'post' AND metadata->>'source_id' = $1
       ORDER BY (metadata->>'reactions_total')::int DESC NULLS LAST LIMIT 300`,
      [sourceId],
    );
    return sendJson(res, 200, { posts: result.rows });
  }


  if (url.pathname === "/api/mbox/projects") {
    const detail = detailMode(url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 200), 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
        `INSERT INTO projects(name, status, stack, git_url, deploy_provider, deploy_target, color, access_level, props)
         VALUES ($1, COALESCE(NULLIF($2, ''), 'active'), $3, $4, $5, $6, $7, COALESCE(NULLIF($8, ''), 'private'), $9)
         RETURNING id::text`,
        [String(body.name || "").trim(), String(body.status || ""), JSON.stringify(Array.isArray(body.stack) ? body.stack : []), String(body.git_url || ""), String(body.deploy_provider || ""), String(body.deploy_target || ""), String(body.color || "#2c2c2e"), String(body.access_level || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
      );
      broadcastChange(req, "create", "projects", String(body.name || "").trim());
      return sendJson(res, 201, { project: result.rows[0] });
    }
    const projects = await query(
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
       WHERE ($4::boolean OR p.id = ANY($5::bigint[])) AND ($1 = ''
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
      [q, limit, offset, scope.all, scope.projectIds],
    );
    const todos = await query(
      "SELECT id::text, project_id::text, title, note, status, priority, props, claimed_by, claimed_until::text, heartbeat_at::text, pg_column_size(todos)::int AS memory_bytes FROM todos WHERE $1::boolean OR project_id = ANY($2::bigint[]) ORDER BY updated_at DESC",
      [scope.all, scope.projectIds],
    );
    const relations = await query(
      `SELECT e.id::text, e.from_id::text AS from_project_id, fp.name AS from_project_name,
              e.to_id::text AS to_project_id, tp.name AS to_project_name, e.edge_type,
              e.title, e.description, e.owner, e.group_entity, e.strength, e.valid_until::text
       FROM graph_edges e
       JOIN projects fp ON fp.id = e.from_id AND e.from_entity = 'project'
       JOIN projects tp ON tp.id = e.to_id AND e.to_entity = 'project'
       WHERE e.from_entity = 'project' AND e.to_entity = 'project'
         AND ($1::boolean OR (e.from_id = ANY($2::bigint[]) AND e.to_id = ANY($2::bigint[])))
       ORDER BY e.created_at DESC`,
      [scope.all, scope.projectIds],
    );
    return sendJson(res, 200, {
      page: { limit, offset, count: projects.rows.length },
      projects: projects.rows.map((project) => ({
        ...project,
        todos: todos.rows
          .filter((todo) => todo.project_id === project.id)
          .map((todo) => (detail === "short" ? compactTextRow(todo, ["note"]) : todo)),
        relations: relations.rows.filter((edge) => edge.from_project_id === project.id || edge.to_project_id === project.id),
      })),
    });
  }

  if (url.pathname === "/api/mbox/graph/edges") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const fromId = String(body.from_id || "");
      const toId = String(body.to_id || "");
      const fromEntity = String(body.from_entity || "project");
      const toEntity = String(body.to_entity || "project");
      if (!fromId || !toId || (fromEntity === toEntity && fromId === toId)) return sendJson(res, 400, { error: "invalid_edge" });
      if (!["project", "company"].includes(fromEntity) || !["project", "company"].includes(toEntity)) return sendJson(res, 400, { error: "invalid_entity" });
      const result = await query(
        `INSERT INTO graph_edges(from_entity, from_id, to_entity, to_id, edge_type, title, description, owner, group_entity, strength, valid_until, score)
         VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5, ''), 'related'), $6, $7, $8, $9, COALESCE($10, 1), $11, 1)
         ON CONFLICT DO NOTHING
         RETURNING id::text`,
        [fromEntity, fromId, toEntity, toId, String(body.edge_type || ""), String(body.title || ""), String(body.description || ""), String(body.owner || ""), String(body.group_entity || ""), Number(body.strength || 1), body.valid_until || null],
      );
      broadcastChange(req, "create", "graph_edges", String(body.edge_type || "related"));
      return sendJson(res, 201, { edge: result.rows[0] || null });
    }
    const result = await query(
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
    await query("DELETE FROM graph_edges WHERE id = $1", [edgeMatch[1]]);
    broadcastChange(req, "delete", "graph_edges", `#${edgeMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  const companyMatch = url.pathname.match(/^\/api\/mbox\/companies\/(\d+)$/);
  if (companyMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const color = typeof body.color === "string" ? body.color.trim() : "";
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return sendJson(res, 400, { error: "invalid_color" });
    const result = await query(
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
      [body.folder_id || null, String(body.name || "").trim(), String(body.status || ""), body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, color, String(body.access_level || ""), companyMatch[1]],
    );
    if (result.rows[0]) broadcastChange(req, "update", "companies", String(body.name || "").trim() || `#${companyMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { company: result.rows[0] } : { error: "not_found" });
  }

  if (companyMatch && req.method === "DELETE") {
    await query("DELETE FROM companies WHERE id = $1", [companyMatch[1]]);
    broadcastChange(req, "delete", "companies", `#${companyMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  const projectMatch = url.pathname.match(/^\/api\/mbox\/projects\/(\d+)$/);
  if (projectMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const color = typeof body.color === "string" ? body.color.trim() : "";
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return sendJson(res, 400, { error: "invalid_color" });
    const result = await query(
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
        String(body.name || "").trim(),
        String(body.status || ""),
        Array.isArray(body.stack) ? JSON.stringify(body.stack) : null,
        body.git_url ?? null,
        body.deploy_provider ?? null,
        body.deploy_target ?? null,
        color,
        String(body.access_level || ""),
        projectMatch[1],
        body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null,
      ],
    );
    if (result.rows[0]) broadcastChange(req, "update", "projects", String(body.name || "").trim() || `#${projectMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { project: result.rows[0] } : { error: "not_found" });
  }

  if (projectMatch && req.method === "DELETE") {
    await query("DELETE FROM projects WHERE id = $1", [projectMatch[1]]);
    broadcastChange(req, "delete", "projects", `#${projectMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/todos" && req.method === "POST") {
    const body = await readBody(req);
    if (!hasProjectAccess(scope, body.project_id)) return sendForbidden(res);
    const result = await query(
      `INSERT INTO todos(project_id, title, note, status, priority, props, access_level)
       VALUES ($1, $2, $3, COALESCE(NULLIF($4, ''), 'open'), COALESCE(NULLIF($5, ''), 'normal'), $6, COALESCE(NULLIF($7, ''), 'private'))
       RETURNING id::text, pg_column_size(todos)::int AS memory_bytes`,
      [body.project_id, String(body.title || "").trim(), String(body.note || ""), String(body.status || ""), String(body.priority || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {}), String(body.access_level || "")],
    );
    broadcastChange(req, "create", "todos", String(body.title || "").trim());
    return sendJson(res, 201, { todo: result.rows[0] });
  }

  const todoMatch = url.pathname.match(/^\/api\/mbox\/todos\/(\d+)$/);
  if (todoMatch && req.method === "GET") {
    const result = await query(
      `SELECT id::text, project_id::text, title, note, status, priority, props, claimed_by, claimed_until::text, heartbeat_at::text,
              access_level, pg_column_size(todos)::int AS memory_bytes, created_at::text, updated_at::text
       FROM todos
       WHERE id = $1 AND ($2::boolean OR project_id = ANY($3::bigint[]))`,
      [todoMatch[1], scope.all, scope.projectIds],
    );
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { todo: result.rows[0] } : { error: "not_found" });
  }

  if (todoMatch && req.method === "PATCH") {
    const body = await readBody(req);
    if (!scope.all) {
      const current = await query("SELECT project_id::text FROM todos WHERE id = $1", [todoMatch[1]]);
      if (!hasProjectAccess(scope, current.rows[0]?.project_id)) return sendForbidden(res);
    }
    const result = await query(
      `UPDATE todos SET
         title = COALESCE(NULLIF($1, ''), title),
         note = COALESCE($2, note),
         status = COALESCE(NULLIF($3, ''), status),
         priority = COALESCE(NULLIF($4, ''), priority),
         props = COALESCE($6, props),
         claimed_by = CASE WHEN $3 IN ('done', 'archived') THEN '' ELSE COALESCE($7, claimed_by) END,
         claimed_until = CASE WHEN $3 IN ('done', 'archived') THEN NULL ELSE COALESCE($8, claimed_until) END,
         heartbeat_at = CASE WHEN $3 IN ('done', 'archived') THEN NULL WHEN $9 THEN now() ELSE heartbeat_at END,
         updated_at = now()
       WHERE id = $5
       RETURNING id::text, project_id::text, title, note, status, claimed_by`,
      [String(body.title || "").trim(), body.note ?? null, String(body.status || ""), String(body.priority || ""), todoMatch[1], body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, typeof body.claimed_by === "string" ? body.claimed_by : null, body.claimed_until || null, Boolean(body.heartbeat)],
    );
    let auto_memory = null;
    if (result.rows[0] && String(body.status || "") === "done") {
      auto_memory = await autoRecordMemory({
        projectId: result.rows[0].project_id,
        todoId: result.rows[0].id,
        sourceAgent: actorFromReq(req),
        title: `Итог задачи: ${result.rows[0].title}`,
        content: result.rows[0].note,
        reason: "todo_done",
      });
    }
    if (result.rows[0]) broadcastChange(req, "update", "todos", String(body.title || "").trim() || `#${todoMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { todo: result.rows[0], auto_memory } : { error: "not_found" });
  }

  if (todoMatch && req.method === "DELETE") {
    if (!scope.all) {
      const current = await query("SELECT project_id::text FROM todos WHERE id = $1", [todoMatch[1]]);
      if (!hasProjectAccess(scope, current.rows[0]?.project_id)) return sendForbidden(res);
    }
    await query("DELETE FROM todos WHERE id = $1", [todoMatch[1]]);
    broadcastChange(req, "delete", "todos", `#${todoMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/server") {
    const result = await query("SELECT hostname, load_1, cpu_percent, memory_used_mb, memory_total_mb, disk_used_mb, disk_total_mb, docker_containers, captured_at::text FROM server_metrics ORDER BY captured_at DESC LIMIT 1");
    return sendJson(res, 200, { metrics: result.rows[0] || null });
  }

  if (url.pathname === "/api/mbox/history") {
    const result = await query(
      `SELECT id::text, actor, action, entity_type, entity_id::text, project_id::text, summary, metadata,
              pg_column_size(audit_events)::int AS memory_bytes,
              created_at::text
       FROM audit_events
       WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
         AND ($1 = '' OR actor ILIKE '%' || $1 || '%' OR action ILIKE '%' || $1 || '%'
          OR entity_type ILIKE '%' || $1 || '%' OR summary ILIKE '%' || $1 || '%' OR metadata::text ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC
       LIMIT 200`,
      [q, scope.all, scope.projectIds],
    );
    return sendJson(res, 200, { events: result.rows });
  }

  if (url.pathname === "/api/mbox/agent/context") {
    await closeStaleAgentRuns();
    const projectName = url.searchParams.get("project") || "MBOX";
    const detail = detailMode(url, "short");
    const projects = await query(
      `SELECT id::text, name, status, stack, git_url, deploy_target, deploy_provider, props, color, access_level,
              pg_column_size(projects)::int AS memory_bytes
       FROM projects
       WHERE name = $1
       LIMIT 1`,
      [projectName],
    );
    const project = projects.rows[0] || null;
    if (!project) return sendJson(res, 404, { error: "project_not_found" });
    const todos = await query(
      `SELECT id::text, project_id::text, title, note, status, priority, props, claimed_by, claimed_until::text, heartbeat_at::text,
              pg_column_size(todos)::int AS memory_bytes
       FROM todos
       WHERE project_id = $1
       ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, updated_at DESC`,
      [project.id],
    );
    const relations = await query(
      `SELECT e.id::text, e.from_entity, e.from_id::text, COALESCE(fp.name, fc.name, e.from_entity || ' #' || e.from_id::text) AS from_label,
              e.to_entity, e.to_id::text, COALESCE(tp.name, tc.name, e.to_entity || ' #' || e.to_id::text) AS to_label,
              e.edge_type, e.title, e.description, e.owner, e.group_entity, e.strength, e.valid_until::text
       FROM graph_edges e
       LEFT JOIN projects fp ON e.from_entity = 'project' AND fp.id = e.from_id
       LEFT JOIN companies fc ON e.from_entity = 'company' AND fc.id = e.from_id
       LEFT JOIN projects tp ON e.to_entity = 'project' AND tp.id = e.to_id
       LEFT JOIN companies tc ON e.to_entity = 'company' AND tc.id = e.to_id
       WHERE (e.from_entity = 'project' AND e.from_id = $1) OR (e.to_entity = 'project' AND e.to_id = $1)
       ORDER BY e.created_at DESC`,
      [project.id],
    );
    const decisions = await query("SELECT id::text, todo_id::text, agent_run_id::text, actor, title, decision, rationale, impact, props, created_at::text FROM decision_log WHERE project_id = $1 ORDER BY created_at DESC LIMIT 25", [project.id]);
    const inbox = await query("SELECT id::text, agent_name, item_type, title, body, status, priority, requires_human, props, created_at::text, updated_at::text FROM agent_inbox WHERE project_id = $1 AND status <> 'done' ORDER BY created_at DESC LIMIT 50", [project.id]);
    const runs = await query("SELECT id::text, todo_id::text, agent_name, status, goal, read_context, commands, touched_files, result, props, started_at::text, heartbeat_at::text, finished_at::text FROM agent_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 20", [project.id]);
    const history = await query("SELECT id::text, actor, action, entity_type, entity_id::text, summary, metadata, created_at::text FROM audit_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50", [project.id]);
    const memories = await relevantMemories(`${project.name} ${project.stack.join(" ")} ${JSON.stringify(project.props || {})}`, { projectId: project.id, limit: 5 });
    const secrets = await query(
      `SELECT s.id::text, s.title, s.login, s.url,
              pgp_sym_decrypt(s.secret_ciphertext::bytea, $2) AS password,
              s.approved_until::text
       FROM protected_secrets s
       WHERE s.project_id = $1
         AND s.agent_share_state = 'approved'
         AND (s.approved_until IS NULL OR s.approved_until > now())
      ORDER BY s.updated_at DESC`,
      [project.id, process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key"],
    );
    if (detail === "full") {
      return sendJson(res, 200, { project, detail, todos: todos.rows, relations: relations.rows, decisions: decisions.rows, inbox: inbox.rows, runs: runs.rows, history: history.rows, memories, approved_secrets: secrets.rows });
    }
    return sendJson(res, 200, {
      project,
      detail,
      counts: {
        todos: todos.rows.length,
        relations: relations.rows.length,
        decisions: decisions.rows.length,
        inbox: inbox.rows.length,
        runs: runs.rows.length,
        history: history.rows.length,
        approved_secrets: secrets.rows.length,
        memories: memories.length,
      },
      todos: todos.rows.map((todo) => compactTextRow({
        id: todo.id,
        project_id: todo.project_id,
        title: todo.title,
        note: todo.note,
        status: todo.status,
        priority: todo.priority,
        props_keys: Object.keys(todo.props || {}),
        claimed_by: todo.claimed_by,
        claimed_until: todo.claimed_until,
        heartbeat_at: todo.heartbeat_at,
        memory_bytes: todo.memory_bytes,
      }, ["note"], 180)),
      relations: relations.rows.map((relation) => ({
        id: relation.id,
        from_entity: relation.from_entity,
        from_id: relation.from_id,
        from_label: relation.from_label,
        to_entity: relation.to_entity,
        to_id: relation.to_id,
        to_label: relation.to_label,
        edge_type: relation.edge_type,
        title: relation.title,
        description_preview: textPreview(relation.description, 160),
        owner: relation.owner,
        group_entity: relation.group_entity,
        strength: relation.strength,
        valid_until: relation.valid_until,
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
      inbox: inbox.rows.map((item) => ({
        id: item.id,
        agent_name: item.agent_name,
        item_type: item.item_type,
        title: item.title,
        body_preview: textPreview(item.body, 180),
        status: item.status,
        priority: item.priority,
        requires_human: item.requires_human,
        props_keys: Object.keys(item.props || {}),
        created_at: item.created_at,
        updated_at: item.updated_at,
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
      approved_secrets: secrets.rows.map((secret) => ({ id: secret.id, title: secret.title, login: secret.login, url: secret.url, approved_until: secret.approved_until })),
    });
  }

  // Отметки «просмотрено», привязанные к пользователю, а не к браузеру.
  if (url.pathname === "/api/mbox/seen") {
    const user = await currentUser(req);
    const actor = user?.username || "anonymous";

    if (req.method === "POST") {
      const body = await readBody(req);
      const marks = Array.isArray(body.marks) ? body.marks : [body];
      const rows = marks
        .filter((mark) => mark && mark.entity_type && mark.entity_id)
        .map((mark) => [actor, String(mark.entity_type), String(mark.entity_id), Number(mark.bytes) || 0]);
      if (!rows.length) return sendJson(res, 400, { error: "marks_required" });

      // Одним запросом на всю пачку: пула соединений нет, каждый query() открывает новый клиент.
      const values = rows.map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4}, now())`).join(", ");
      await query(
        `INSERT INTO seen_marks(actor, entity_type, entity_id, seen_bytes, seen_at)
         VALUES ${values}
         ON CONFLICT (actor, entity_type, entity_id)
         DO UPDATE SET seen_bytes = EXCLUDED.seen_bytes, seen_at = EXCLUDED.seen_at`,
        rows.flat(),
      );
      return sendJson(res, 200, { ok: true, saved: rows.length });
    }

    const result = await query(
      "SELECT entity_type, entity_id::text, seen_bytes, seen_at::text FROM seen_marks WHERE actor = $1",
      [actor],
    );
    return sendJson(res, 200, { marks: result.rows });
  }

  if (url.pathname === "/api/mbox/agent/inbox") {
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!hasProjectAccess(scope, body.project_id)) return sendForbidden(res);
      const result = await query(
        `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
         VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'notice'), $4, $5, COALESCE(NULLIF($6, ''), 'open'), COALESCE(NULLIF($7, ''), 'normal'), $8, $9)
         RETURNING id::text`,
        [body.project_id || null, String(body.agent_name || actorFromReq(req)), String(body.item_type || ""), String(body.title || "").trim(), String(body.body || ""), String(body.status || ""), String(body.priority || ""), Boolean(body.requires_human), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
      );
      broadcastChange(req, "create", "agent_inbox", String(body.title || "").trim());
      const senderName = String(body.agent_name || actorFromReq(req));
      const addressedTo = body.props && typeof body.props === "object" ? String(body.props.to || "") : "";
      // Только вопросы. Служебные записи с agent_name "Claude" (agent_error/agent_response от
      // scripts/claude-inbox-watcher.mjs, без props.to) тоже проходили — и Джарвис 14 сентября отвечал на
      // «Claude не смог ответить на #928» так, будто это вопрос человека.
      const isQuestion = String(body.item_type || "") === "question";
      // Ответ человека на вопрос самого Джарвиса (кнопки в «Требуют ответа»: item_type answer, props.to —
      // Джарвис, props.re — его вопрос) тоже к нему: так человек одобряет уборку памяти.
      const isReplyToJarvis = String(body.item_type || "") === "answer" && senderName === "Человек" && addressedTo === JARVIS_NAME;
      if (result.rows[0] && ((isQuestion && (senderName === "Человек" || senderName === "Claude") && (!addressedTo || addressedTo === JARVIS_NAME)) || isReplyToJarvis)) {
        // Claude тоже может триггерить живой ответ Джарвиса (по просьбе человека — "агенты
        // общаются, но с ограничениями") — но без верхнего предела это открытая дверь для
        // зацикливания ботов друг на друге. Ограничение: если среди последних 6 сообщений треда
        // не было ни одного от живого "Человек", новый агент-агент автоответ не запускаем — ждём,
        // пока человек снова включится. У самого "Человек" лимита нет и не будет.
        let allowChain = senderName === "Человек";
        if (!allowChain) {
          const recentChain = await query(
            "SELECT agent_name FROM agent_inbox WHERE item_type IN ('question', 'answer') AND project_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC LIMIT 6",
            [body.project_id || null],
          );
          allowChain = recentChain.rows.some((row) => row.agent_name === "Человек");
        }
        if (allowChain) {
          // .catch() обязателен на fire-and-forget вызове: необработанный reject роняет весь процесс.
          // replyAsJarvis теперь сама не должна выбрасывать наружу, но это последний рубеж, не первый.
          replyAsJarvis({
            id: result.rows[0].id,
            project_id: body.project_id || null,
            title: body.title,
            body: body.body,
            props: { ...(body.props && typeof body.props === "object" ? body.props : {}), allowed_project_ids: scope.all ? null : scope.projectIds },
          })
            .catch((error) => console.error(`Jarvis reply totally uncaught: ${error.message}`));
        } else {
          console.log(`[jarvis] агент-агент цепочка достигла лимита без человека — авто-ответ на #${result.rows[0].id} пропущен`);
        }
      }
      // Маркер для внешнего слежения (Claude через SSH-тейл логов вместо опроса по таймеру) —
      // адресату "Claude" ответ не генерируется автоматически, только этот сигнал в stdout.
      // Ловит и человека, и Джарвиса (если тот сам адресует ответ Claude через props.to).
      if (addressedTo === "Claude" && result.rows[0]) {
        console.log(`[claude-ping] #${result.rows[0].id} ${String(body.title || "").replace(/\s+/g, " ").slice(0, 200)}`);
      }
      if (addressedTo === "Codex" && result.rows[0]) {
        console.log(`[codex-ping] #${result.rows[0].id} ${String(body.title || "").replace(/\s+/g, " ").slice(0, 200)}`);
      }
      return sendJson(res, 201, { inbox_item: result.rows[0] });
    }
    // Фильтры для агентов (MCP list_inbox, todo #259): без них агенты видели только заголовки чата и
    // отлаживали Джарвиса вслепую. Без параметров ответ прежний — 200 последних по updated_at: на него
    // рассчитаны UI, MCP-пуш и архивариус.
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 500);
    const agent = url.searchParams.get("agent")?.trim() || "";
    const itemType = url.searchParams.get("item_type")?.trim() || "";
    const search = url.searchParams.get("q")?.trim() || "";
    const beforeId = /^\d+$/.test(url.searchParams.get("before_id") || "") ? url.searchParams.get("before_id") : "";
    const filtered = Boolean(agent || itemType || search || beforeId);
    const result = await query(
      `SELECT ${INBOX_COLUMNS} FROM agent_inbox
       WHERE ($1 = '' OR agent_name = $1)
         AND ($2 = '' OR item_type = $2)
         AND ($3 = '' OR title ILIKE '%' || $3 || '%' OR body ILIKE '%' || $3 || '%')
         AND (NULLIF($4, '') IS NULL OR id < NULLIF($4, '')::bigint)
         AND ($6::boolean OR project_id = ANY($7::bigint[]))
       ORDER BY ${filtered ? "id DESC" : "updated_at DESC"}
       LIMIT $5`,
      [agent, itemType, search, beforeId, limit, scope.all, scope.projectIds],
    );
    return sendJson(res, 200, { inbox: result.rows });
  }

  const inboxMatch = url.pathname.match(/^\/api\/mbox\/agent\/inbox\/(\d+)$/);
  if (inboxMatch && req.method === "GET") {
    // Одно сообщение целиком: тело, props со следом инструментов, ответы на него и ошибки Джарвиса по нему.
    const item = (await query(`SELECT ${INBOX_COLUMNS} FROM agent_inbox WHERE id = $1`, [inboxMatch[1]])).rows[0];
    if (!item) return sendJson(res, 404, { error: "not_found" });
    const replies = await query(`SELECT ${INBOX_COLUMNS} FROM agent_inbox WHERE props->>'re' = $1 OR props->>'in_reply_to' = $1 ORDER BY created_at`, [inboxMatch[1]]);
    const errors = await query("SELECT id::text, source, tool_name, message, created_at::text FROM jarvis_errors WHERE inbox_id = $1 ORDER BY created_at", [inboxMatch[1]]);
    return sendJson(res, 200, { inbox_item: item, replies: replies.rows, errors: errors.rows });
  }

  const answerMatch = url.pathname.match(/^\/api\/mbox\/agent\/inbox\/(\d+)\/answer$/);
  if (answerMatch && req.method === "POST") {
    // Резервный путь (scripts/mbox-archivist.mjs) отдаёт сюда вопрос, который пропустил мгновенный ответ:
    // open — ответ не запускался, doing старше 10 минут — его оборвал перезапуск. Захват вопроса (doing)
    // атомарен, поэтому два тика не дадут двух ответов.
    if (activeJarvisRequests.has(answerMatch[1])) return sendJson(res, 409, { error: "already_answering" });
    const row = (await query(
      `UPDATE agent_inbox SET status = 'doing', updated_at = now()
       WHERE id = $1 AND (item_type = 'question' OR (item_type = 'answer' AND agent_name = 'Человек' AND props->>'to' = $2))
         AND (status = 'open' OR (status = 'doing' AND updated_at < now() - interval '10 minutes'))
       RETURNING id::text, project_id::text, title, body, props`,
      [answerMatch[1], JARVIS_NAME],
    )).rows[0];
    if (!row) return sendJson(res, 409, { error: "not_answerable" });
    replyAsJarvis(row).catch((error) => console.error(`Jarvis hand-off reply uncaught: ${error.message}`));
    return sendJson(res, 202, { ok: true, inbox_id: row.id });
  }
  if (inboxMatch && req.method === "PATCH") {
    const body = await readBody(req);
    // if_status — атомарный захват: наблюдатели одного агента на двух машинах (или установленный
    // MBOX Desktop и тестовый) видят одно и то же open-сообщение, и оба отвечали. Второй получает 409.
    const ifStatus = String(body.if_status || "");
    const result = await query(
      `UPDATE agent_inbox SET status = COALESCE(NULLIF($1, ''), status), priority = COALESCE(NULLIF($2, ''), priority), body = COALESCE($3, body), props = COALESCE($4, props), updated_at = now()
       WHERE id = $5 AND ($6 = '' OR status = $6) RETURNING id::text`,
      [String(body.status || ""), String(body.priority || ""), body.body ?? null, body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, inboxMatch[1], ifStatus],
    );
    if (result.rows[0]) broadcastChange(req, "update", "agent_inbox", `#${inboxMatch[1]}`);
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
    // Прерывание реального запроса, а не просто спрятать спиннер: abort() режет fetch к Groq
    // на полпути, и помечаем сообщение done, чтобы резервный cron его не подобрал следом.
    const controller = activeJarvisRequests.get(cancelMatch[1]);
    if (controller) controller.abort();
    await query("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [cancelMatch[1]]);
    return sendJson(res, 200, { ok: true, aborted: Boolean(controller) });
  }

  if (url.pathname === "/api/mbox/agent/runs") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
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
          title: `Итог запуска: ${result.rows[0].goal}`,
          content: result.rows[0].result,
          touchedFiles: result.rows[0].touched_files,
          reason: "agent_run_created_finished",
        });
      }
      broadcastChange(req, "create", "agent_runs", String(body.goal || "run"));
      return sendJson(res, 201, { run: result.rows[0], auto_memory });
    }
    await closeStaleAgentRuns();
    const result = await query("SELECT id::text, project_id::text, todo_id::text, agent_name, status, goal, read_context, commands, touched_files, result, props, pg_column_size(agent_runs)::int AS memory_bytes, started_at::text, heartbeat_at::text, finished_at::text FROM agent_runs WHERE $1::boolean OR project_id = ANY($2::bigint[]) ORDER BY started_at DESC LIMIT 100", [scope.all, scope.projectIds]);
    return sendJson(res, 200, { runs: result.rows });
  }

  const runMatch = url.pathname.match(/^\/api\/mbox\/agent\/runs\/(\d+)$/);
  if (runMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const result = await query(
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
    if (result.rows[0]) broadcastChange(req, ["done", "failed", "blocked"].includes(String(body.status || "")) ? "finish" : "heartbeat", "agent_runs", `#${runMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { run: result.rows[0], auto_memory } : { error: "not_found" });
  }

  if (url.pathname === "/api/mbox/decisions") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
        `INSERT INTO decision_log(project_id, todo_id, agent_run_id, actor, title, decision, rationale, impact, props)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id::text`,
        [body.project_id || null, body.todo_id || null, body.agent_run_id || null, String(body.actor || actorFromReq(req)), String(body.title || "").trim(), String(body.decision || ""), String(body.rationale || ""), String(body.impact || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
      );
      broadcastChange(req, "create", "decision_log", String(body.title || "").trim());
      return sendJson(res, 201, { decision: result.rows[0] });
    }
    const result = await query(
      `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, actor, title, decision, rationale, impact, props,
              pg_column_size(decision_log)::int AS memory_bytes, created_at::text
       FROM decision_log
       WHERE ($2::boolean OR project_id = ANY($3::bigint[]))
         AND ($1 = '' OR actor ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%' OR decision ILIKE '%' || $1 || '%'
          OR rationale ILIKE '%' || $1 || '%' OR impact ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC LIMIT 200`,
      [q, scope.all, scope.projectIds],
    );
    return sendJson(res, 200, { decisions: result.rows });
  }

  const todoTrailMatch = url.pathname.match(/^\/api\/mbox\/todos\/(\d+)\/trail$/);
  if (todoTrailMatch) {
    const todo = await query(
      `SELECT t.id::text, t.project_id::text, t.title, t.status, t.priority, t.props, t.created_at::text, t.updated_at::text, p.name AS project_name
       FROM todos t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = $1`,
      [todoTrailMatch[1]],
    );
    if (!todo.rows[0]) return sendJson(res, 404, { error: "not_found" });
    const decisions = await query("SELECT id::text, todo_id::text, agent_run_id::text, actor, title, decision, rationale, impact, props, created_at::text FROM decision_log WHERE todo_id = $1 ORDER BY created_at", [todoTrailMatch[1]]);
    const runs = await query("SELECT id::text, todo_id::text, agent_name, status, goal, commands, touched_files, result, props, started_at::text, heartbeat_at::text, finished_at::text FROM agent_runs WHERE todo_id = $1 ORDER BY started_at", [todoTrailMatch[1]]);
    const memories = await query(
      `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata, created_at::text, updated_at::text
       FROM memories
       WHERE todo_id = $1 OR metadata->>'todo_id' = $1::text
       ORDER BY created_at`,
      [todoTrailMatch[1]],
    );
    const history = await query(
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

  const claimMatch = url.pathname.match(/^\/api\/mbox\/todos\/(\d+)\/claim$/);
  if (claimMatch && req.method === "POST") {
    const body = await readBody(req);
    const agent = String(body.agent_name || actorFromReq(req));
    const minutes = Math.max(5, Math.min(240, Number(body.minutes || 45)));
    const result = await query(
      `UPDATE todos
       SET claimed_by = $1, claimed_until = now() + ($2 || ' minutes')::interval, heartbeat_at = now(), status = CASE WHEN status = 'open' THEN 'doing' ELSE status END, updated_at = now()
       WHERE id = $3 AND (claimed_until IS NULL OR claimed_until < now() OR claimed_by = $1)
       RETURNING id::text, claimed_by, claimed_until::text, heartbeat_at::text`,
      [agent, minutes, claimMatch[1]],
    );
    if (!result.rows[0]) return sendJson(res, 409, { error: "already_claimed" });
    broadcastChange(req, "claim", "todos", `#${claimMatch[1]}`);
    return sendJson(res, 200, { todo: result.rows[0] });
  }

  if (url.pathname === "/api/mbox/agent/next-task") {
    const projectName = url.searchParams.get("project") || "MBOX";
    const agent = url.searchParams.get("agent") || String(actorFromReq(req));
    const result = await query(
      `SELECT t.id::text, t.title, t.note, t.status, t.priority, t.props, t.claimed_by, t.claimed_until::text, t.heartbeat_at::text, p.id::text AS project_id, p.name AS project_name
       FROM todos t
       JOIN projects p ON p.id = t.project_id
       WHERE p.name = $1 AND t.status IN ('next', 'open', 'doing', 'blocked', 'review')
         AND (t.claimed_until IS NULL OR t.claimed_until < now() OR t.claimed_by = $2)
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
         CASE t.status WHEN 'doing' THEN 1 WHEN 'next' THEN 2 WHEN 'open' THEN 3 WHEN 'blocked' THEN 4 ELSE 5 END,
         t.updated_at DESC
       LIMIT 1`,
      [projectName, agent],
    );
    const task = result.rows[0] || null;
    if (!task) return sendJson(res, 200, { task: null });
    const lease = await query(
      `UPDATE todos SET claimed_by = $1, claimed_until = now() + interval '45 minutes', heartbeat_at = now(), status = CASE WHEN status = 'open' THEN 'doing' ELSE status END, updated_at = now()
       WHERE id = $2 AND (claimed_until IS NULL OR claimed_until < now() OR claimed_by = $1)
       RETURNING claimed_by, claimed_until::text, heartbeat_at::text, status`,
      [agent, task.id],
    );
    if (lease.rows[0]) {
      broadcastChange(req, "claim", "todos", task.title);
      Object.assign(task, lease.rows[0]);
    }
    task.memories = await relevantMemories(`${task.title}\n${task.note || ""}`, { projectId: task.project_id, todoId: task.id, limit: 5 });
    return sendJson(res, 200, { task });
  }

  if (url.pathname === "/api/mbox/agent/approved-secrets") {
    const projectName = url.searchParams.get("project") || "MBOX";
    const result = await query(
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
      const body = await readBody(req);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!title || !password) return sendJson(res, 400, { error: "title_and_password_required" });
      const result = await query(
        `INSERT INTO protected_secrets(project_id, title, login, secret_ciphertext, url, access_level, agent_share_state)
         VALUES ($6, $1, $2, pgp_sym_encrypt($3, $5), $4, 'private', 'locked')
         RETURNING id::text, project_id::text, title, login, url, access_level, agent_share_state,
                   pg_column_size(protected_secrets)::int AS memory_bytes,
                   approved_until::text, updated_at::text`,
        [
          title,
          typeof body.login === "string" ? body.login.trim() : "",
          password,
          typeof body.url === "string" ? body.url.trim() : "",
          process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key",
          body.project_id || null,
        ],
      );
      broadcastChange(req, "create", "secrets", title);
      return sendJson(res, 201, { secret: result.rows[0] });
    }
    const result = await query(
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
    const body = await readBody(req);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const login = typeof body.login === "string" ? body.login.trim() : null;
    const password = typeof body.password === "string" ? body.password : "";
    const secretKey = process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";
    const hasApprovedUntil = Object.prototype.hasOwnProperty.call(body, "approved_until");
    const result = await query(
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
      [body.project_id || null, String(body.agent_share_state || ""), body.approved_until || null, secretMatch[1], title, login, typeof body.url === "string" ? body.url.trim() : null, password, secretKey, hasApprovedUntil],
    );
    broadcastChange(req, "update", "secrets", title || `#${secretMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { secret: result.rows[0] } : { error: "not_found" });
  }

  return sendJson(res, 404, { error: "not_found" });
}

function serveStatic(req, res, url) {
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const target = path.resolve(publicDir, relative);
  const safeTarget = target.startsWith(publicDir) ? target : path.join(publicDir, "index.html");
  const file = fs.existsSync(safeTarget) && fs.statSync(safeTarget).isFile() ? safeTarget : path.join(publicDir, "index.html");
  const ext = path.extname(file);
  const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".html" ? "text/html; charset=utf-8" : ext === ".webmanifest" ? "application/manifest+json" : ext === ".png" ? "image/png" : ext === ".ico" ? "image/x-icon" : "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": ext === ".html" ? "no-store" : "no-cache" });
  fs.createReadStream(file).pipe(res);
}

// MBOX_LOG_REQUESTS=1 — построчный журнал обращений: метод, путь, код, время, была ли cookie.
// Нужен, когда UI выглядит пустым и надо понять, доходит ли до сервера то, что шлёт браузер.
const logRequests = process.env.MBOX_LOG_REQUESTS === "1";

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (logRequests) {
    const startedAt = Date.now();
    const hasSession = Boolean(getCookie(req, "mbox_session"));
    res.on("finish", () => {
      console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode} ${Date.now() - startedAt}ms cookie=${hasSession ? "да" : "НЕТ"} origin=${req.headers.origin || "-"}`);
    });
    res.on("close", () => {
      if (!res.writableEnded) console.log(`${req.method} ${url.pathname}${url.search} -> ОБОРВАН клиентом ${Date.now() - startedAt}ms`);
    });
  }
  try {
    if (url.pathname.startsWith("/api/mbox/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    return sendJson(res, 503, { error: error instanceof Error ? error.message : "unknown_error" });
  }
});

const realtimeServer = new WebSocketServer({ noServer: true });

realtimeServer.on("connection", (socket) => {
  realtimeClients.add(socket);
  socket.send(JSON.stringify({ type: "connected", at: new Date().toISOString() }));
  socket.on("close", () => realtimeClients.delete(socket));
});

httpServer.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/mbox/realtime") return socket.destroy();
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

setInterval(() => broadcastRealtime("server_tick"), 5000).unref();

httpServer.listen(port, host, () => {
  console.log(`MBOX listening on http://${host}:${port}`);
});
