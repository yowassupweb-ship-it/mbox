import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "pg";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");

loadEnv(path.join(root, ".env"));
loadEnv(path.join(root, ".env.local"));

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

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    process.env[trimmed.slice(0, index)] ||= trimmed.slice(index + 1);
  }
}

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

async function refreshMemoryEmbeddings() {
  const memories = await query(
    `SELECT id::text, title, content, tags, metadata, updated_at::text
     FROM memories
     ORDER BY id`,
  );
  const documents = memories.rows.map((memory) => ({ id: memory.id, text: memoryEmbeddingText(memory), updated_at: memory.updated_at }));
  const vectors = buildTfIdfIndex(documents);
  for (const vector of vectors) {
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

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  const part = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

async function query(sql, values = []) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const actor = requestContext.getStore()?.actor;
    if (actor) await client.query("SELECT set_config('mbox.actor', $1, false)", [actor]);
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}

// Джарвис раньше жил только в systemd-таймере (см. scripts/mbox-archivist.mjs) с шагом в минуту —
// для чата это ощущалось как "не отвечает". Здесь та же логика ответа на прямое сообщение, но
// вызывается синхронно из POST /agent/inbox сразу после вставки, без ожидания следующего тика.
// Разбор памяти (fact/log) по-прежнему остаётся за таймером — там мгновенность не нужна.
const JARVIS_NAME = process.env.MBOX_AGENT_NAME || "Джарвис";

/** См. vite.config.ts — подробный трейс шагов агентного цикла в stdout. */
function jlog(inboxId, message) {
  console.log(`[jarvis #${inboxId}] ${message}`);
}

// Пока в jlog идёт только stdout-трейс, консоль в UI видела один и тот же текст "думает… Nс" от
// отправки до ответа — по жалобе пользователя (76с на простой поиск, непонятно, что происходит)
// нужен живой фазовый статус, который фронт может опрашивать. Память только на время запроса,
// без БД: фаза интересна ровно пока ждём ответ, история не нужна.
const jarvisPhase = new Map();
function setPhase(inboxId, phase) {
  if (!inboxId) return;
  jarvisPhase.set(String(inboxId), { phase, at: Date.now() });
}
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// "Прораб" (GROQ_MODEL, gpt-oss-120b) ведёт диалог и решает, какой инструмент вызвать — сюда лимиты
// самые тесные (8000 TPM), и загружать его же простым однократным пересказом или классификацией
// расточительно. "Младший агент" (GROQ_MODEL_JUNIOR) — своя, отдельная квота Groq: у
// llama-3.1-8b-instant по наблюдению человека 14 400 запросов/сутки и 500К токенов/сутки против
// 1000 запросов и 200К токенов у 120b. Классификация памяти и пересказ веб-страницы не требуют
// оркестрации инструментами — это и есть "скиллы", которые логично отдать младшему.
// llama-3.1-8b-instant снят Groq с обслуживания (404 model_not_found на боевом трафике,
// 2026-08-21) — переведено на GPT-семейство Groq (openai/gpt-oss-20b), как просил владелец.
const GROQ_MODEL_JUNIOR = process.env.GROQ_MODEL_JUNIOR || "openai/gpt-oss-20b";
// Gemini берёт роль "прораба" у gpt-oss-120b: та же оркестрация диалога и выбора инструмента, но
// TPM-квота на порядок шире (250K против 8000 у Groq), поэтому именно gpt-oss-120b постоянно
// упирался в лимиты на живом трафике. gpt-oss-120b не выброшен — это резерв: если Gemini недоступен
// или упал по лимиту, тот же самый agentic-цикл на этом же ответе доигрывается на Groq (см. complete()
// в replyAsJarvis). Токен и раскладку моделей человек оставил в todo #197.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// Сжатие истории диалога перед отправкой Прорабу (см. cloudflareSummarize ниже, todo #195) —
// третий, независимый провайдер: Cloudflare Workers AI, не Groq/Gemini. Опционально: если оба
// значения не заданы, сжатие просто не включается и история идёт как раньше, без деградации.
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_MODEL = process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.1-8b-instruct";

// Бот на getUpdates (не webhook, не MTProto) — один токен на всю систему, как GROQ_API_KEY/
// GEMINI_API_KEY: используется только data_sources с kind='telegram_channel'.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// Запрос человека может лежать в очереди на прерывание (см. POST /agent/inbox/:id/cancel) —
// контроллер живёт, пока идёт агентский цикл, и удаляется в finally у replyAsJarvis.
const activeJarvisRequests = new Map();

/** Бесплатный тир Groq режет по запросам в минуту — при живом чате (несколько шагов цикла подряд,
 * несколько тиков cron) 429 не редкость. Раньше первая же 429 роняла весь ответ Джарвиса без единой
 * повторной попытки. Retry-After Groq присылает в секундах — уважаем его, если есть. */
async function groqComplete(messages, tools, purpose = "reply", signal, attempt = 0, model = GROQ_MODEL) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, ...(tools ? { tools, tool_choice: "auto" } : {}) }),
    signal,
  });
  if (response.status === 429) {
    // Живое наблюдение 20 августа: TPM-лимит на этом аккаунте — 8000 токенов/минуту, и Groq прямо
    // просит подождать "Please try again in 22.7s" в теле ошибки, а не в заголовке Retry-After
    // (его тут просто нет). Формат бывает и с часами/минутами ("1h23m4.5s") — старый разбор ловил
    // только последнее число перед "s" и путал 4.5с с 1ч23м4.5с, поэтому ждал на порядки меньше
    // нужного и снова бился в тот же лимит. Живое наблюдение 20 августа вечером: дневной лимит
    // (TPD) 200К токенов на gpt-oss-120b оказался исчерпан ПОЛНОСТЬЮ (реально потрачено 274К) —
    // в этом случае ждать имеет смысл только до полуночи, а не секунды. Раз ожидание больше
    // минуты — ретраить бессмысленно и жестоко к живому чату: падаем сразу честной ошибкой,
    // пусть человек увидит "не получилось", а не молчание на несколько минут.
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
  // Пользователь хочет видеть расход токенов, а не гадать — пишем каждый вызов, не только успешные
  // ответы. Best-effort: если запись в БД не удалась, это не должно ронять сам ответ Джарвиса.
  const usage = data.usage || {};
  query(
    "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
    [purpose, model, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0],
  ).catch((error) => console.error(`groq_usage insert failed: ${error.message}`));
  return data.choices?.[0]?.message ?? { content: "" };
}

/** JSON Schema (lowercase-типы OpenAI style) -> Gemini functionDeclarations (типы UPPERCASE). */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = Array.isArray(schema) ? [...schema] : { ...schema };
  if (typeof out.type === "string") out.type = out.type.toUpperCase();
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  if (out.items) out.items = toGeminiSchema(out.items);
  return out;
}

function toGeminiTools(openAiTools) {
  if (!openAiTools?.length) return undefined;
  return [{ functionDeclarations: openAiTools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: toGeminiSchema(t.function.parameters) })) }];
}

/** Общий формат истории цикла — OpenAI-стиль messages (Groq понимает его нативно), превращаем в
 * Gemini contents прямо перед вызовом. thoughtSignature — обязательный непрозрачный токен, который
 * Gemini выдаёт вместе с functionCall и требует назад при следующем шаге того же диалога (иначе
 * 400 "missing thought_signature"), поэтому храним его на самом tool_call (см. geminiComplete) и
 * подставляем обратно здесь же. */
function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") { contents.push({ role: "user", parts: [{ text: m.content || "" }] }); continue; }
    if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        contents.push({
          role: "model",
          parts: m.tool_calls.map((tc) => ({
            functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") },
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

/** Gemini как "прораб" вместо gpt-oss-120b — см. GEMINI_API_KEY выше. Бросает на 429/ошибке, чтобы
 * вызывающий код (complete() в replyAsJarvis) мог переключиться на Groq для остатка того же ответа. */
async function geminiComplete(messages, tools, purpose = "reply", signal) {
  const systemText = messages.find((m) => m.role === "system")?.content || "";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(tools ? { tools: toGeminiTools(tools) } : {}),
      generationConfig: { temperature: 0.2 },
    }),
    signal,
  });
  if (!response.ok) {
    const error = new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const usage = data.usageMetadata || {};
  query(
    "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
    [purpose, GEMINI_MODEL, usage.promptTokenCount || 0, usage.candidatesTokenCount || 0, usage.totalTokenCount || 0],
  ).catch((error) => console.error(`gemini usage insert failed: ${error.message}`));
  const parts = data.candidates?.[0]?.content?.parts || [];
  const functionParts = parts.filter((p) => p.functionCall);
  const text = parts.filter((p) => p.text).map((p) => p.text).join("");
  if (!functionParts.length) return { content: text };
  return {
    content: text,
    tool_calls: functionParts.map((p, index) => ({
      id: p.functionCall.id || `gem_${Date.now()}_${index}`,
      thoughtSignature: p.thoughtSignature,
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
    })),
  };
}

// Сжимает старую часть истории диалога в компактную сводку на русском — не оркестрация
// инструментами, одноразовый вызов текст-в-текст, поэтому отдельный дешёвый провайдер (Cloudflare
// Workers AI), не Прораб. Возвращает null при любой проблеме (нет ключа, сеть, пустой ответ) —
// вызывающий код обязан откатиться на несжатую историю, не пробрасывать ошибку в живой ответ.
async function cloudflareSummarize(transcript) {
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
    const data = await response.json();
    const text = data?.result?.response;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

// Раньше Джарвис только генерировал текст и мог написать "задача добавлена", ничего не сделав —
// модель не отличает выполненное действие от вежливой выдумки. Даём ей набор настоящих инструментов
// через tool calling; всё остальное подтверждается только текстом, с явным предупреждением в
// системном промпте не выдумывать выполненные действия.
const TODO_STATUSES = ["open", "next", "doing", "blocked", "review", "done", "archived"];
const TODO_PRIORITIES = ["low", "normal", "high", "urgent"];

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
        + "просят «прибраться в задачах» или «объедини всё про X в одну». Исходные задачи не удаляются "
        + "необратимо — переводятся в архив с пометкой, во что объединены, их можно найти и восстановить. "
        + "Для составления заголовка/описания объединённой задачи из текста исходных удобно сперва "
        + "воспользоваться delegate_to_junior, чтобы не тратить свой контекст на черновик.",
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
      description: "Список компаний в MBOX — это НЕ проекты: компания объединяет несколько связанных проектов (например «Вокруг света» владеет проектами vs-works, vs-mail и другими). Спроси себя: если вопрос про юрлицо, контакты, бренд, реквизиты, тон общения или бизнес-контекст в целом — скорее всего это компания, а не отдельный проект.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_company_info",
      description: "Посмотреть карточку компании целиком: юрлицо, контакты, бренд, продукты, связанные проекты и любые другие сведения, которые про неё записали. Используй это, а не get_project_info, когда речь о компании, а не о конкретном техническом проекте.",
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
          kind: { type: "string", enum: ["webpage", "tours_xml", "telegram_channel"], description: "webpage (по умолчанию) — обычная страница, пересказывается через Groq. tours_xml — структурированный XML-фид туров вида vs-travel.ru/prices/tours.xml, разбирается в таблицу дат/мест, не пересказывается. telegram_channel — бот (TELEGRAM_BOT_TOKEN), добавленный админом в канал, забирает новые посты и реакции через getUpdates; url — ссылка на канал (справочно, для чтения не используется)." },
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

/** Скорость набора реакций с поправкой на давность — иначе пост, висящий сутки, нечестно
 * проигрывает посту, висящему год. Та же формула, что задокументирована в скилле "Обучение на
 * контенте" (MBOX memory #148) — держать в одном месте нельзя, инструмент и текст скилла живут
 * в разных системах, но логика должна совпадать буквально. */
function postEngagementRate(reactionsTotal, postedAt) {
  const posted = postedAt ? new Date(postedAt).getTime() : NaN;
  const days = Number.isFinite(posted) ? Math.max(1, (Date.now() - posted) / 86400000) : 1;
  return reactionsTotal / days;
}

async function loadPostStats() {
  const rows = (await query(
    "SELECT id::text, title, content, metadata FROM memories WHERE entity_type = 'post'",
  )).rows;
  return rows.map((row) => {
    const metadata = row.metadata || {};
    const reactionsTotal = Number(metadata.reactions_total) || 0;
    const postedAt = typeof metadata.posted_at === "string" ? metadata.posted_at : null;
    return {
      id: row.id,
      title: row.title,
      hasPhoto: Boolean(metadata.has_photo),
      reactionsTotal,
      postedAt,
      rate: postEngagementRate(reactionsTotal, postedAt),
    };
  });
}

/** Кусок текста вокруг найденного совпадения — иначе модель видит заголовок без query и решает,
 * что результат нерелевантный, хотя совпадение реально есть в note. */
function excerptAround(text, query, radius) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return text.slice(start, end);
}

function matchProjectFuzzy(projectName, projectList) {
  const q = String(projectName || "").trim().toLowerCase();
  return projectList.find((p) => p.name.toLowerCase() === q)
    || projectList.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
}

/** Компании — отдельная сущность верхнего уровня, не строка в projectList; свой fuzzy-match. */
function matchCompanyFuzzy(companyName, companyList) {
  const q = String(companyName || "").trim().toLowerCase();
  return companyList.find((c) => c.name.toLowerCase() === q)
    || companyList.find((c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()));
}

async function matchTodoFuzzy(client, projectId, todoTitle, { exact = false } = {}) {
  const rows = (await client.query("SELECT id::text, title, status, priority, note FROM todos WHERE project_id = $1", [projectId])).rows;
  const q = String(todoTitle || "").trim();
  if (exact) return rows.find((t) => t.title === q);
  const qLower = q.toLowerCase();
  return rows.find((t) => t.title.toLowerCase() === qLower)
    || rows.find((t) => t.title.toLowerCase().includes(qLower) || qLower.includes(t.title.toLowerCase()));
}

/**
 * Один упавший инструмент раньше рвал весь агентный цикл: 20 августа человек трижды подряд
 * (315, 316, 323 в agent_inbox) просил Джарвиса создать 4 задачи разом — каждый раз он падал
 * на INSERT INTO todos с уже существующим заголовком (idx_todos_project_title уникален по
 * project_id+title) и не отвечал НИЧЕГО: ни успевшие пройти задачи не подтверждались, ни причина
 * не объяснялась. Отсюда и общее ощущение "работает через раз, ломается на 2-3 задаче".
 *
 * Теперь ошибка одного вызова инструмента превращается в понятный текст для модели — цикл
 * продолжается на следующий вызов, а не падает целиком.
 */
function describeToolFailure(name, error) {
  if (error?.code === "23505") return `${name}: такая запись уже существует — не создаю дубликат`;
  const message = String(error?.message || error || "").slice(0, 200);
  return `${name}: не выполнено (${message || "внутренняя ошибка"})`;
}

/** Лучше потерять запись об ошибке, чем уронить ответ Джарвиса ИЗ-ЗА записи об ошибке. */
async function logJarvisError({ source = "reply", toolName = "", inboxId = null, projectId = null, message }) {
  try {
    await query(
      "INSERT INTO jarvis_errors(source, tool_name, inbox_id, project_id, message) VALUES ($1, $2, $3, $4, $5)",
      [source, toolName, inboxId, projectId, String(message || "").slice(0, 2000)],
    );
  } catch (error) {
    console.error(`jarvis_errors insert failed: ${error.message}`);
  }
}

/**
 * Единая логика обновления источника: и REST-ручка POST /data-sources/:id/refresh (кнопка «Обновить
 * сейчас» в UI), и инструмент Джарвиса refresh_data_source вызывают ЭТУ функцию — раньше она была
 * скопирована в тело инструмента и ничем не отличалась бы от второй копии в ручке, разошлись бы
 * при первой же правке.
 */
/** XML-число вида 03.11.2026 -> ISO-дата для колонки DATE. Не парсится — не дата, null. */
function parseFeedDate(raw) {
  const match = String(raw || "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Разбор XML-фида туров vs-travel.ru (kind='tours_xml'). Регулярками, не DOM-парсером: файл до
 * 24МБ+, схема простая и плоская (проверено — free_places/id верхнего уровня <sheets> идут ДО
 * вложенного price_list/hotels/price, поэтому первое совпадение .match() — всегда нужное, не
 * случайно попавшее из вложенности). Никаких новых зависимостей — проект намеренно без них.
 */
function parseTourFeed(xml) {
  const items = [];
  const tourRe = /<tour>([\s\S]*?)<\/tour>/g;
  let tourMatch;
  while ((tourMatch = tourRe.exec(xml))) {
    const tourBlock = tourMatch[1];
    const tourId = (tourBlock.match(/<tour_id>([\s\S]*?)<\/tour_id>/) || [])[1] || "";
    const tourName = decodeXmlEntities((tourBlock.match(/<tour_name>([\s\S]*?)<\/tour_name>/) || [])[1]).trim();
    const routeName = decodeXmlEntities((tourBlock.match(/<route_name>([\s\S]*?)<\/route_name>/) || [])[1]).trim();
    if (!tourName) continue;
    const sheetRe = /<sheets>([\s\S]*?)<\/sheets>/g;
    let sheetMatch;
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

/** Тот же bulk-upsert, что и REST-ручка POST /tour-sheets/bulk — вызывается напрямую, без
 * HTTP-круга через себя же (сервер не ходит в свой собственный localhost:3000). */
async function bulkUpsertTourSheets(sourceId, items) {
  // Раньше "снятые с продажи" считались по updated_at < cutoff, где cutoff брался из JS Date() на
  // клиенте, а сами updated_at пишутся через now() на стороне Postgres. Живой прогон 20 августа
  // удалил ВСЕ 1528 только что вставленных строк за один проход — часы клиента и сервера БД
  // (разные машины, ssh-туннель) разошлись ровно настолько, чтобы cutoff оказался позже, чем now()
  // на сервере. Сравнение времени между машинами непредсказуемо в принципе; правильный ключ —
  // множество sheet_id, которые реально пришли в этом разборе, а не момент времени.
  const BATCH = 400;
  const seenSheetIds = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH).map((item) => ({ source_id: String(sourceId), ...item }));
    await query(
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
  // Пустой items — не "все туры сняты с продажи", а скорее сломанный fetch/пустой ответ. Не даём
  // единственному неудачному разбору стереть всё, что уже было накоплено.
  if (!seenSheetIds.length) return { upserted: 0, removed: 0 };
  const removed = await query(
    "DELETE FROM tour_sheets WHERE source_id = $1 AND NOT (sheet_id = ANY($2::text[])) RETURNING id",
    [sourceId, seenSheetIds],
  );
  return { upserted: items.length, removed: removed.rows.length };
}

/** Пост — не артефакт (артефакт — осознанная находка, пост — сырая масса контента), поэтому
 * живёт в memories с entity_type='post': эта сущность уже умеет folder_id + tags + metadata +
 * поиск, ровно то, что нужно, без новой таблицы. Дедуп по (source_id, message_id) в metadata —
 * см. idx_memories_telegram_post. */
async function findTelegramPostMemory(sourceId, messageId) {
  const result = await query(
    "SELECT id::text, metadata FROM memories WHERE entity_type = 'post' AND metadata->>'source_id' = $1 AND metadata->>'message_id' = $2",
    [String(sourceId), String(messageId)],
  );
  return result.rows[0] || null;
}

/** Ленивое создание папки "Посты" (folders.entity_type='memory') на первом тике источника —
 * id кладётся в data_sources.props.telegram_folder_id, чтобы не искать/создавать её каждый раз.
 * Ищем по имени БЕЗ привязки к parent_id/project_id: папку "Посты" под проектом "Вокруг света"
 * владелец уже завёл руками через UI (id 21) — переиспользуем её, а не плодим вторую global. */
async function ensureTelegramPostsFolder(row) {
  const cached = row.props?.telegram_folder_id;
  if (cached) return cached;
  const existing = await query("SELECT id::text FROM folders WHERE name = 'Посты' ORDER BY id LIMIT 1");
  const folderId = existing.rows[0]?.id
    || (await query("INSERT INTO folders(parent_id, name, entity_type, access_level) VALUES (NULL, 'Посты', 'memory', 'agents') RETURNING id::text")).rows[0].id;
  await query("UPDATE data_sources SET props = props || $1::jsonb WHERE id = $2", [JSON.stringify({ telegram_folder_id: folderId }), row.id]);
  return folderId;
}

/** Telegram Bot API отдаёт факт реакции отдельным апдейтом message_reaction_count — только
 * агрегированные счётчики по каналу (боты не видят, кто именно поставил реакцию), и он может
 * прийти раньше или позже самого channel_post с тем же message_id. Апсертим оба по частям: если
 * записи под message_id ещё нет, реакция создаёт "заготовку" без текста, а пост её потом дополняет
 * (или наоборот). Раскладка на подробное суммари по каждому посту (редакционный разбор) — отдельная,
 * сознательно не автоматическая задача поверх этих сырых записей, не часть этого тика; здесь только
 * сырые факты в metadata. "Полезная математика" (процентиль с поправкой на длительность с момента
 * публикации) не считается и не хранится здесь — строится из metadata по требованию (см. скилл
 * "Обучение на контенте"), чтобы не протухала. */
async function refreshTelegramChannel(row) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN не задан — источник kind='telegram_channel' не может обновиться");
  const folderId = await ensureTelegramPostsFolder(row);
  const offset = Number(row.props?.telegram_offset) || 0;
  const allowedUpdates = encodeURIComponent(JSON.stringify(["channel_post", "edited_channel_post", "message_reaction_count"]));
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${allowedUpdates}`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `telegram getUpdates ${response.status}`);
  const updates = data.result || [];

  let newPosts = 0;
  let reactionUpdates = 0;
  let maxUpdateId = offset - 1;
  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);
    const post = update.channel_post || update.edited_channel_post;
    if (post) {
      const text = post.text || post.caption || "";
      const hasPhoto = Array.isArray(post.photo) && post.photo.length > 0;
      const mediaType = post.video ? "video_file" : post.voice ? "voice_message" : post.audio ? "audio_file"
        : post.animation ? "animation" : post.sticker ? "sticker" : post.document ? "document" : "";
      const postedAt = new Date(post.date * 1000);
      const title = text.trim().slice(0, 80) || `Пост от ${postedAt.toLocaleDateString("ru-RU")}`;
      const existing = await findTelegramPostMemory(row.id, post.message_id);
      const metadata = {
        source_id: String(row.id), message_id: String(post.message_id), posted_at: postedAt.toISOString(),
        has_photo: hasPhoto, media_type: mediaType,
        reactions_total: existing?.metadata?.reactions_total || 0, reactions_breakdown: existing?.metadata?.reactions_breakdown || {},
      };
      if (existing) {
        await query("UPDATE memories SET title = $1, content = $2, metadata = $3, updated_at = now() WHERE id = $4", [title, text, JSON.stringify(metadata), existing.id]);
      } else {
        await query(
          "INSERT INTO memories(folder_id, title, content, entity_type, access_level, metadata) VALUES ($1, $2, $3, 'post', 'agents', $4)",
          [folderId, title, text, JSON.stringify(metadata)],
        );
      }
      newPosts += 1;
    }
    const reactionCount = update.message_reaction_count;
    if (reactionCount) {
      const breakdown = {};
      let total = 0;
      for (const r of reactionCount.reactions || []) {
        const key = r.type?.emoji || r.type?.custom_emoji_id || r.type?.type || "?";
        breakdown[key] = r.total_count;
        total += r.total_count;
      }
      const existing = await findTelegramPostMemory(row.id, reactionCount.message_id);
      if (existing) {
        const metadata = { ...existing.metadata, reactions_total: total, reactions_breakdown: breakdown };
        await query("UPDATE memories SET metadata = $1, updated_at = now() WHERE id = $2", [JSON.stringify(metadata), existing.id]);
      } else {
        const metadata = { source_id: String(row.id), message_id: String(reactionCount.message_id), reactions_total: total, reactions_breakdown: breakdown };
        await query(
          "INSERT INTO memories(folder_id, title, content, entity_type, access_level, metadata) VALUES ($1, $2, '', 'post', 'agents', $3)",
          [folderId, `Пост #${reactionCount.message_id}`, JSON.stringify(metadata)],
        );
      }
      reactionUpdates += 1;
    }
  }
  await query("UPDATE data_sources SET props = props || $1::jsonb WHERE id = $2", [JSON.stringify({ telegram_offset: maxUpdateId + 1 }), row.id]);
  return `новых/изменённых постов: ${newPosts}, обновлений реакций: ${reactionUpdates}`;
}

async function refreshDataSourceById(id, { inboxId } = {}) {
  const row = (await query("SELECT id::text, project_id::text, name, url, access_level, kind, last_memory_id::text, props FROM data_sources WHERE id = $1", [id])).rows[0];
  if (!row) return { ok: false, summary: "", error: "источник не найден" };

  if (row.kind === "telegram_channel") {
    try {
      const summary = await refreshTelegramChannel(row);
      await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'ok', last_summary = $1, updated_at = now() WHERE id = $2", [summary, row.id]);
      return { ok: true, summary };
    } catch (error) {
      await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'error', last_summary = $1, updated_at = now() WHERE id = $2", [String(error.message || error).slice(0, 500), row.id]);
      return { ok: false, summary: "", error: error.message || String(error) };
    }
  }

  if (row.kind === "tours_xml") {
    try {
      const response = await fetch(row.url, { redirect: "follow" });
      if (!response.ok) throw new Error(`fetch ${response.status}`);
      const xml = await response.text();
      const items = parseTourFeed(xml);
      const { upserted, removed } = await bulkUpsertTourSheets(row.id, items);
      const summary = `разобрано ${upserted} дат, снято с продажи ${removed}`;
      await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'ok', last_summary = $1, updated_at = now() WHERE id = $2", [summary, row.id]);
      return { ok: true, summary };
    } catch (error) {
      await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'error', last_summary = $1, updated_at = now() WHERE id = $2", [String(error.message || error).slice(0, 500), row.id]);
      return { ok: false, summary: "", error: error.message || String(error) };
    }
  }

  try {
    const response = await fetch(row.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`fetch ${response.status}`);
    const html = await response.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
    // Пересказ страницы в 5-10 пунктов — не оркестрация инструментами, а одноразовый "скилл".
    // Отдаём младшей модели: своя, куда более щедрая квота, не трогает тесный бюджет "Прораба".
    setPhase(inboxId, "Делегирует младшему агенту");
    const digestMessage = await groqComplete(
      [
        { role: "system", content: "Сделай короткую сводку веб-страницы для системы памяти: 5-10 пунктов, факты и цифры, без воды, на русском." },
        { role: "user", content: text || "(пустая страница)" },
      ],
      null,
      "skill-webpage-summary",
      undefined,
      0,
      GROQ_MODEL_JUNIOR,
    );
    const digest = String(digestMessage.content || "").trim().slice(0, 3000);
    let memoryId = row.last_memory_id;
    if (memoryId) {
      await query("UPDATE memories SET content = $1, updated_at = now() WHERE id = $2", [digest, memoryId]);
    } else {
      const createdMemory = await query(
        `INSERT INTO memories(project_id, title, content, entity_type, access_level, tags, metadata)
         VALUES ($1, $2, $3, 'fact', $4, $5, $6) RETURNING id::text`,
        [row.project_id, `Источник: ${row.name}`, digest, row.access_level || "agents", ["источник-данных"], JSON.stringify({ source_agent: JARVIS_NAME, data_source_id: row.id, data_source_url: row.url })],
      );
      memoryId = createdMemory.rows[0].id;
    }
    await query(
      "UPDATE data_sources SET last_fetched_at = now(), last_status = 'ok', last_summary = $1, last_memory_id = $2, updated_at = now() WHERE id = $3",
      [digest.slice(0, 500), memoryId, row.id],
    );
    return { ok: true, summary: digest };
  } catch (error) {
    await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'error', last_summary = $1, updated_at = now() WHERE id = $2", [String(error.message || error).slice(0, 500), row.id]);
    return { ok: false, summary: "", error: error.message || String(error) };
  }
}

async function runJarvisTool(client, name, rawArgs, projectList, inboxId) {
  let args = {};
  try { args = JSON.parse(rawArgs || "{}"); } catch { /* модель иногда шлёт кривой JSON — просто игнорируем аргументы */ }

  if (name === "create_project") {
    const projectName = String(args.name || "").trim();
    if (!projectName) return "не создал проект — нет названия";
    const stack = Array.isArray(args.stack) ? args.stack.map(String) : [];
    const gitUrl = String(args.git_url || "").trim();
    const inserted = await client.query(
      `INSERT INTO projects(name, status, stack, git_url, access_level, props) VALUES ($1, 'active', $2, $3, 'private', '{}') RETURNING id::text`,
      [projectName, JSON.stringify(stack), gitUrl || null],
    );
    projectList.push({ id: inserted.rows[0].id, name: projectName });
    const extra = [stack.length ? `стек: ${stack.join(", ")}` : "", gitUrl ? `git: ${gitUrl}` : ""].filter(Boolean).join(", ");
    return `создан проект «${projectName}»${extra ? ` (${extra})` : ""} (#${inserted.rows[0].id})`;
  }

  if (name === "delete_project") {
    // Удаление необратимо — специально без нечёткого совпадения, чтобы модель не снесла
    // соседний проект по неточной команде.
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
      const status = TODO_STATUSES.includes(args.status) ? args.status : null;
      if (!status) return `неизвестный статус «${args.status}» — доступны: ${TODO_STATUSES.join(", ")}`;
      await client.query("UPDATE todos SET status = $1, updated_at = now() WHERE id = $2", [status, todo.id]);
      return `задача «${todo.title}» теперь в статусе «${status}» (была «${todo.status}»)`;
    }
    const priority = TODO_PRIORITIES.includes(args.priority) ? args.priority : null;
    if (!priority) return `неизвестный приоритет «${args.priority}» — доступны: ${TODO_PRIORITIES.join(", ")}`;
    await client.query("UPDATE todos SET priority = $1, updated_at = now() WHERE id = $2", [priority, todo.id]);
    return `у задачи «${todo.title}» теперь приоритет «${priority}» (был «${todo.priority}»)`;
  }

  if (name === "delete_todo") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(client, project.id, args.todo_title, { exact: true });
    if (!todo) return `не нашёл задачу с точным заголовком «${args.todo_title}» в проекте «${project.name}»`;
    await client.query("DELETE FROM todos WHERE id = $1", [todo.id]);
    return `удалена задача «${todo.title}» из проекта «${project.name}»`;
  }

  if (name === "merge_todos") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const ids = Array.isArray(args.todo_ids) ? [...new Set(args.todo_ids.map((id) => String(id).trim()).filter((id) => /^\d+$/.test(id)))] : [];
    if (ids.length < 2) return "нужно минимум два числовых ID задачи в todo_ids";
    const mergedTitle = String(args.merged_title || "").trim();
    if (!mergedTitle) return "не объединил — нужен заголовок объединённой задачи";
    const rows = (await client.query("SELECT id::text, title, priority, note FROM todos WHERE id = ANY($1::bigint[]) AND project_id = $2", [ids, project.id])).rows;
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !found.has(id));
      return `не нашёл в проекте «${project.name}» задачи с ID: ${missing.join(", ")} — объединение отменено, ничего не тронуто`;
    }
    const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
    const mergedPriority = rows.reduce((best, r) => (priorityRank[r.priority] ?? 9) < (priorityRank[best] ?? 9) ? r.priority : best, "low");
    const inserted = await client.query(
      `INSERT INTO todos(project_id, title, note, status, priority, props, access_level)
       VALUES ($1, $2, $3, 'open', $4, '{}', 'private') RETURNING id::text`,
      [project.id, mergedTitle, String(args.merged_note || ""), mergedPriority],
    );
    const newId = inserted.rows[0].id;
    await client.query(
      `UPDATE todos SET status = 'archived', note = note || $1, claimed_by = '', claimed_until = NULL, updated_at = now() WHERE id = ANY($2::bigint[])`,
      [`\n\n[Объединено в «${mergedTitle}» #${newId}]`, ids],
    );
    return `объединил ${rows.length} задач (${rows.map((r) => `#${r.id} «${r.title}»`).join(", ")}) в новую «${mergedTitle}» (#${newId}, приоритет ${mergedPriority}); исходные переведены в архив с пометкой`;
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
      "SELECT title, status, priority FROM todos WHERE project_id = $1 ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, updated_at DESC LIMIT 20",
      [project.id],
    )).rows;
    if (!rows.length) return `у проекта «${project.name}» пока нет задач`;
    const lines = rows.map((t) => `[${t.status}/${t.priority}] ${t.title}`);
    return `задачи проекта «${project.name}» (${rows.length}${rows.length === 20 ? "+" : ""}): ${lines.join("; ")}`;
  }

  if (name === "get_project_info") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const row = (await client.query(
      "SELECT git_url, stack, deploy_provider, deploy_target, access_level, props FROM projects WHERE id = $1",
      [project.id],
    )).rows[0];
    const parts = [
      row.git_url ? `git: ${row.git_url}` : "git не указан",
      Array.isArray(row.stack) && row.stack.length ? `стек: ${row.stack.join(", ")}` : "стек не указан",
      row.deploy_target || row.deploy_provider ? `деплой: ${[row.deploy_provider, row.deploy_target].filter(Boolean).join(" / ")}` : "деплой не указан",
      `доступ: ${row.access_level}`,
    ];
    // "Найди в памяти описание проекта" искал по фактам-логам (итоги работы), а не по описанию
    // проекта — оно лежит в props ("роль", "контекст", "тип" и т.п.), а не в memories. Отдаём
    // props как есть, коротко описанные ключи — самый частый вопрос "расскажи про проект".
    const props = row.props && typeof row.props === "object" ? row.props : {};
    const descriptiveKeys = Object.keys(props).filter((key) => !key.startsWith("deploy_"));
    if (descriptiveKeys.length) {
      const propsText = descriptiveKeys.map((key) => `${key}: ${String(props[key]).slice(0, 200)}`).join("; ");
      parts.push(`описание из props — ${propsText}`);
    }
    return `проект «${project.name}»: ${parts.join("; ")}`;
  }

  // Компании — контейнер верхнего уровня для нескольких проектов, отдельная таблица от projects.
  // 20 августа человек спросил Джарвиса про компанию «Вокруг света» (там 25+ заполненных полей:
  // юрлицо, контакты, бренд, тон общения, связанные проекты) — инструментов увидеть её не было
  // вообще, и Джарвис честно ответил "нет записей о такой сущности", хотя запись была.
  if (name === "list_companies") {
    const rows = (await client.query("SELECT name, props FROM companies ORDER BY name")).rows;
    if (!rows.length) return "компаний в MBOX пока нет";
    const lines = rows.map((c) => {
      const hint = c.props?.profile || c.props?.role || "";
      return hint ? `${c.name} — ${String(hint).slice(0, 120)}` : c.name;
    });
    return `компании (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "get_company_info") {
    const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows;
    const company = matchCompanyFuzzy(args.company_name, companyList);
    if (!company) return `не нашёл компанию «${args.company_name}» — есть: ${companyList.map((c) => c.name).join(", ") || "компаний пока нет"}`;
    const row = (await client.query("SELECT props, access_level FROM companies WHERE id = $1", [company.id])).rows[0];
    const props = row.props && typeof row.props === "object" ? row.props : {};
    const keys = Object.keys(props);
    if (!keys.length) return `компания «${company.name}»: свойства не заполнены`;
    // Раньше каждое поле резалось до 180 символов — на карточке с десятками полей (юрлицо, тон
    // общения, правила UX и т.п.) это обрывало содержательные поля на середине фразы, а модель не
    // могла понять, что ответ на самом деле там был. Режем только итоговую строку целиком, не
    // разрывая отдельные поля — так "правило владельца..." дочитывается до конца.
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
    )).rows;
    if (!rows.length) return `по запросу «${q}» в памяти ничего не нашлось`;
    return rows.map((m) => `«${m.title}»${m.project_name ? ` (${m.project_name})` : ""}: ${m.content.slice(0, 160)}`).join(" | ");
  }

  if (name === "get_memory") {
    const id = String(args.memory_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи — возьми его из результатов search_memory";
    const row = (await client.query(
      `SELECT m.title, m.content, m.tags, m.entity_type, p.name AS project_name
       FROM memories m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.id = $1`,
      [id],
    )).rows[0];
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
    )).rows;
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
    )).rows;
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
    )).rows[0];
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
    )).rows;
    if (!rows.length) return `по запросу «${q}» задач не нашлось`;
    // Раньше возвращали только заголовок — если совпадение было в note, а не в title, модель
    // видела заголовок без "1440" и решала, что задача не подходит, хотя SQL нашёл её верно.
    // Сниппет вокруг совпадения делает видимым, ГДЕ именно нашлось совпадение.
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
    // groq_usage хранит расход ОБЕИХ моделей, которыми говорит Джарвис — geminiChat (mbox-archivist.mjs,
    // server/mbox-server.mjs) логирует туда же по столбцу model=GEMINI_MODEL, не только настоящий Groq.
    // Разбивка по модели — иначе "сколько я потратил" отвечало бы цифрой, где Gemini и Groq слиты в одну.
    const rows = (await client.query(
      `SELECT model,
              COALESCE(SUM(total_tokens), 0)::text AS total,
              COALESCE(SUM(total_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::text AS last_24h,
              COALESCE(SUM(total_tokens) FILTER (WHERE created_at > date_trunc('day', now())), 0)::text AS today,
              COUNT(*)::int AS calls_total
       FROM groq_usage GROUP BY model ORDER BY SUM(total_tokens) DESC`,
    )).rows;
    if (!rows.length) return "расхода токенов пока не зафиксировано";
    const lines = rows.map((r) => `${r.model || "?"}: сегодня ${r.today}, за 24ч ${r.last_24h}, всего ${r.total} (${r.calls_total} вызовов)`);
    return `расход токенов по моделям — ${lines.join("; ")}. У Gemini нет известного жёсткого лимита в этом коде (в отличие от Groq — 8К TPM у Прораба), это только счётчик фактического расхода, не "остаток".`;
  }

  if (name === "list_recent_activity") {
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const rows = (await client.query(
      `SELECT actor, action, entity_type, summary, created_at::text
       FROM audit_events
       WHERE ($1::bigint IS NULL OR project_id = $1::bigint)
       ORDER BY created_at DESC LIMIT 10`,
      [project?.id || null],
    )).rows;
    if (!rows.length) return "недавних событий не нашлось";
    const lines = rows.map((e) => `${e.actor} ${e.action} ${e.entity_type}${e.summary ? ` (${e.summary})` : ""}`);
    return `последние события${project ? ` в «${project.name}»` : ""}: ${lines.join("; ")}`;
  }

  if (name === "find_file") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const row = (await client.query("SELECT props FROM projects WHERE id = $1", [project.id])).rows[0];
    const structure = row?.props?.repo_structure;
    if (!structure || !Array.isArray(structure.paths) || !structure.paths.length) {
      return `у проекта «${project.name}» ещё нет опубликованной структуры репозитория`;
    }
    const q = String(args.query || "").trim().toLowerCase();
    const matches = structure.paths.filter((p) => String(p).toLowerCase().includes(q)).slice(0, 20);
    if (!matches.length) return `по запросу «${args.query}» в структуре «${project.name}» ничего не нашлось (всего файлов: ${structure.paths.length})`;
    return `найдено в «${project.name}»: ${matches.join(", ")}`;
  }

  if (name === "list_data_sources") {
    let where = "";
    const params = [];
    if (args.project_name) {
      const project = matchProjectFuzzy(args.project_name, projectList);
      if (project) { where = "WHERE project_id = $1"; params.push(project.id); }
    }
    const rows = (await client.query(`SELECT name, url, schedule_minutes, last_fetched_at::text, last_status FROM data_sources ${where} ORDER BY name`, params)).rows;
    if (!rows.length) return "источников данных пока нет";
    const lines = rows.map((s) => `${s.name} (${s.url}) — ${s.last_status}, последнее обновление: ${s.last_fetched_at || "ещё не было"}`);
    return `источники данных (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "create_data_source") {
    const sourceName = String(args.name || "").trim();
    const sourceUrl = String(args.url || "").trim();
    if (!sourceName || !sourceUrl) return "не создал источник — нужны и название, и адрес";
    let projectId = null;
    let companyId = null;
    if (args.project_name) {
      const project = matchProjectFuzzy(args.project_name, projectList);
      if (!project) return `не нашёл проект «${args.project_name}»`;
      projectId = project.id;
    }
    if (args.company_name) {
      const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows;
      const company = matchCompanyFuzzy(args.company_name, companyList);
      if (!company) return `не нашёл компанию «${args.company_name}»`;
      companyId = company.id;
    }
    if (!projectId && !companyId) return "не создал источник — укажи проект или компанию, к которой привязать";
    const kind = ["tours_xml", "telegram_channel"].includes(args.kind) ? args.kind : "webpage";
    const inserted = await client.query(
      `INSERT INTO data_sources(project_id, company_id, name, url, schedule_minutes, kind)
       VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5, 0), 1440), $6) RETURNING id::text`,
      [projectId, companyId, sourceName, sourceUrl, Number(args.schedule_minutes) || 0, kind],
    );
    return `создан источник «${sourceName}» (#${inserted.rows[0].id}), первое чтение — на ближайшем тике архивариуса`;
  }

  if (name === "refresh_data_source") {
    const q = String(args.name || "").trim().toLowerCase();
    const rows = (await client.query("SELECT id::text, name FROM data_sources")).rows;
    const source = rows.find((s) => s.name.toLowerCase() === q) || rows.find((s) => s.name.toLowerCase().includes(q));
    if (!source) return `не нашёл источник «${args.name}» — есть: ${rows.map((s) => s.name).join(", ") || "источников пока нет"}`;
    const result = await refreshDataSourceById(source.id, { inboxId });
    return result.ok ? `источник «${source.name}» обновлён: ${result.summary.slice(0, 200)}` : `не удалось обновить «${source.name}»: ${result.error}`;
  }

  if (name === "search_tour_dates") {
    const q = String(args.tour_name || "").trim();
    if (!q) return "не искал — не указано название тура";
    const rows = (await query(
      `SELECT tour_name, route_name, date_start::text, date_end::text, free_places, price_from
       FROM tour_sheets
       WHERE tour_name ILIKE '%' || $1 || '%'
         AND (date_end IS NULL OR date_end >= CURRENT_DATE)
         AND ($2 = false OR free_places > 0)
       ORDER BY date_start ASC NULLS LAST
       LIMIT 20`,
      [q, Boolean(args.only_available)],
    )).rows;
    if (!rows.length) return `по запросу «${q}» дат не нашлось — либо тура с таким названием нет в фиде, либо все места и даты прошли`;
    const lines = rows.map((r) => `${r.tour_name}: ${r.date_start || "?"}${r.date_end && r.date_end !== r.date_start ? `–${r.date_end}` : ""}, мест: ${r.free_places}, от ${r.price_from}₽`);
    return `найдено (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "analyze_posts") {
    const posts = await loadPostStats();
    if (!posts.length) return "постов в базе пока нет — папка «Посты» пуста";
    const mode = ["top", "bottom", "by_photo"].includes(args.mode) ? args.mode : "summary";
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);

    if (mode === "top" || mode === "bottom") {
      const sorted = [...posts].sort((a, b) => mode === "top" ? b.rate - a.rate : a.rate - b.rate).slice(0, limit);
      const lines = sorted.map((p) => `«${p.title}» — ${p.reactionsTotal} реакций${p.postedAt ? `, ${p.postedAt.slice(0, 10)}` : ""}, скорость ${p.rate.toFixed(2)}/день${p.hasPhoto ? ", с фото" : ""}`);
      return `${mode === "top" ? "лучшие" : "худшие"} по скорости набора реакций (${sorted.length} из ${posts.length}): ${lines.join("; ")}`;
    }

    if (mode === "by_photo") {
      const withPhoto = posts.filter((p) => p.hasPhoto);
      const withoutPhoto = posts.filter((p) => !p.hasPhoto);
      const avg = (list) => list.length ? list.reduce((sum, p) => sum + p.rate, 0) / list.length : 0;
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
    const existing = (await client.query("SELECT id::text, title, content, tags FROM memories WHERE id = $1", [id])).rows[0];
    if (!existing) return `запись #${id} не нашлась — возможно, удалена или номер неверный`;
    const title = args.title !== undefined ? String(args.title).trim() : existing.title;
    let content = existing.content;
    if (args.content !== undefined) {
      const newContent = String(args.content);
      const mode = args.mode === "append" ? "append" : "replace";
      content = mode === "append" && existing.content ? `${existing.content}\n\n${newContent}` : newContent;
    }
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : existing.tags;
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
    const existing = (await client.query("SELECT id::text, title FROM memories WHERE id = $1", [id])).rows[0];
    if (!existing) return `запись #${id} не нашлась — возможно, уже удалена или номер неверный`;
    await recordMemoryAction({ memoryId: id, actor: JARVIS_NAME, action: "delete", note: "memory deleted via Jarvis tool" });
    await client.query("DELETE FROM memories WHERE id = $1", [id]);
    return `удалена запись памяти «${existing.title}» (#${id})`;
  }

  if (name === "create_company") {
    const companyName = String(args.name || "").trim();
    if (!companyName) return "не создал компанию — нет названия";
    const existing = (await client.query("SELECT id::text, name FROM companies WHERE lower(name) = lower($1)", [companyName])).rows[0];
    if (existing) return `компания «${existing.name}» уже существует — используй update_company_info, чтобы дополнить её`;
    const props = args.props && typeof args.props === "object" ? args.props : {};
    const inserted = await client.query(
      "INSERT INTO companies(name, status, props, access_level) VALUES ($1, 'active', $2, 'private') RETURNING id::text",
      [companyName, JSON.stringify(props)],
    );
    return `создана компания «${companyName}» (#${inserted.rows[0].id})`;
  }

  if (name === "update_company_info") {
    const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows;
    const company = matchCompanyFuzzy(args.company_name, companyList);
    if (!company) return `не нашёл компанию «${args.company_name}» — есть: ${companyList.map((c) => c.name).join(", ") || "компаний пока нет"}`;
    const props = args.props && typeof args.props === "object" ? args.props : null;
    if (!props || !Object.keys(props).length) return "нечего обновлять — не переданы свойства";
    await client.query("UPDATE companies SET props = props || $1::jsonb, updated_at = now() WHERE id = $2", [JSON.stringify(props), company.id]);
    return `у компании «${company.name}» обновлены свойства: ${Object.keys(props).join(", ")}`;
  }

  if (name === "update_project_info") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const sets = [];
    const params = [];
    if (args.stack !== undefined) { params.push(JSON.stringify(Array.isArray(args.stack) ? args.stack.map(String) : [])); sets.push(`stack = $${params.length}`); }
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
    const entityType = entityTypes.includes(args.entity_type) ? args.entity_type : null;
    if (!folderName || !entityType) return "не создал папку — нужны и название, и корректный тип (memory/artifact/project/todo/script/agent_scope)";
    let parentId = null;
    if (args.parent_name) {
      const parent = (await client.query("SELECT id::text, name FROM folders WHERE name = $1", [String(args.parent_name).trim()])).rows[0];
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
    return `создана папка «${folderName}» (тип ${entityType}${args.parent_name ? `, внутри «${args.parent_name}»` : ""}) (#${inserted.rows[0].id})`;
  }

  if (name === "list_folders") {
    const entityTypes = ["memory", "artifact", "project", "todo", "script", "agent_scope"];
    const entityType = entityTypes.includes(args.entity_type) ? args.entity_type : null;
    const rows = (await client.query(
      `SELECT f.name, f.entity_type, pf.name AS parent_name
       FROM folders f LEFT JOIN folders pf ON pf.id = f.parent_id
       WHERE $1::text IS NULL OR f.entity_type = $1
       ORDER BY f.entity_type, f.name`,
      [entityType],
    )).rows;
    if (!rows.length) return entityType ? `папок типа «${entityType}» пока нет` : "папок пока нет";
    const lines = rows.map((f) => `${f.name}${f.parent_name ? ` (в «${f.parent_name}»)` : ""} [${f.entity_type}]`);
    return `папки (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "link_memories") {
    const idA = String(args.memory_a_id || "").trim();
    const idB = String(args.memory_b_id || "").trim();
    if (!idA || !/^\d+$/.test(idA) || !idB || !/^\d+$/.test(idB)) return "нужны числовые ID обеих записей";
    if (idA === idB) return "нельзя связать запись саму с собой";
    const rows = (await client.query("SELECT id::text, title FROM memories WHERE id IN ($1, $2)", [idA, idB])).rows;
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
    )).rows;
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
    return `создан артефакт «${artifactName}» (${category})${project ? ` в проекте «${project.name}»` : ""} (#${inserted.rows[0].id})`;
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
      null,
      "skill-delegate-junior",
      undefined,
      0,
      GROQ_MODEL_JUNIOR,
    );
    return String(delegateMessage.content || "").trim().slice(0, 3000) || "младший агент не вернул ответ";
  }

  return `неизвестное действие: ${name}`;
}

async function replyAsJarvis(item) {
  if (!GROQ_API_KEY) return;
  const controller = new AbortController();
  activeJarvisRequests.set(String(item.id), controller);
  // new Client() и connect() — ВНУТРИ try. Раньше connect() стоял до try: если бы он упал (пул
  // соединений, кратковременная недоступность БД), это был бы необработанный reject у fire-and-forget
  // вызова replyAsJarvis(...) в POST /agent/inbox — а необработанный reject роняет весь процесс
  // Node (unhandled-rejections=throw по умолчанию с Node 15), то есть не только Джарвис перестал бы
  // отвечать, но и весь MBOX. Не воспроизводилось на проде (RestartCount=0 на момент находки), но
  // мина реальная — защищаемся заранее, а не когда она сработает.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query("SELECT set_config('mbox.actor', $1, false)", [JARVIS_NAME]);
    const projectList = (await client.query("SELECT id::text, name FROM projects ORDER BY name")).rows;
    // "Известные проекты" в промпте так и не включали компании — Джарвис не мог даже заподозрить,
    // что вопрос про компанию (а не про проект), потому что не знал, что компании вообще существуют.
    const companyNames = (await client.query("SELECT name FROM companies ORDER BY name")).rows.map((c) => c.name);
    // Раньше не знал даже сколько всего задач в системе — приходилось отвечать "нет функции узнать".
    // Готовая сводка в промпте закрывает большинство "что вообще есть в MBOX"-вопросов без похода
    // в tool calling; list_project_todos/search_memory — для точечных вопросов по конкретному проекту.
    const stats = (await client.query(
      `SELECT (SELECT count(*) FROM todos)::int AS todos_total,
              (SELECT count(*) FROM todos WHERE status NOT IN ('done', 'archived'))::int AS todos_open,
              (SELECT count(*) FROM memories)::int AS memories_total`,
    )).rows[0];
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
      + "list_companies и get_company_info (КОМПАНИЯ — это не проект: контейнер верхнего уровня, "
      + "владеет несколькими проектами; вопросы про юрлицо, контакты, бренд, реквизиты, тон общения, "
      + "бизнес-контекст — это компания, используй эти инструменты, а не get_project_info), "
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
      + "одно из этого — вызови функцию, не пиши текстом, что сделал это. Если в одном "
      + "сообщении просят НЕСКОЛЬКО действий (может быть комбо из разных инструментов, не только повтор "
      + "одного и того же) — вызывай их одно за другим по очереди, пока не выполнишь все, не только первое; "
      + "не останавливайся после первого шага и не переспрашивай подтверждение между шагами, если человек уже "
      + "описал всю последовательность в одном сообщении — уверенно доводи комбо из 3-5 инструментов до конца "
      + "за один ответ, а мелкие текстовые подзадачи внутри такой цепочки отдавай delegate_to_junior вместо "
      + "того, чтобы писать черновик самому. "
      + "Если просят что-то другое, для чего нет функции — "
      + "честно скажи, что не умеешь этого делать, а не притворяйся, что сделал. Кроме тебя в MBOX работает "
      + "Claude — отдельный, куда более мощный агент (через Claude Code), который занимается тяжёлыми задачами: "
      + "разработкой самого MBOX, деплоем на прод, глубоким анализом больших массивов данных (например, "
      + "разбором постов Telegram-канала для скилла контента). Если просят что-то из этого — не делай вид, что "
      + "справишься сам, скажи прямо, что это к Claude, не к тебе. Модели, которые говорят твоим голосом: сам "
      + "ты обычно на Gemini, в резерве — Groq (\"Прораб\", openai/gpt-oss-120b — ведёт диалог и решает, какой "
      + "инструмент вызвать; \"Младший\", openai/gpt-oss-20b — разовые задачи без диалога вроде пересказа "
      + "страницы или классификации памяти). Claude — это отдельный агент на своей модели (Claude Sonnet), не "
      + "ещё одна твоя резервная модель, не путай. Тебе видна история разговора "
      + "(не только последнее сообщение), но действие вызывай ТОЛЬКО когда об этом явно просят прямо сейчас — "
      + "фразы вроде «буду делать проект на стеке X» или «планирую X» это описание планов, а не команда, не "
      + "создавай ничего в ответ на них. Когда человек явно просит создать проект, а раньше в разговоре уже "
      + "называл детали (стек, ссылку и т.п.) — подставь их в create_project сам, не переспрашивай то, что уже "
      + "прозвучало. Если деталей вообще не было — создавай хотя бы с одним названием, не устраивай анкету из "
      + "вопросов, человек всегда может дополнить проект следующим сообщением. Известные проекты: "
      + `${projectList.map((p) => p.name).join(", ") || "нет проектов"}. Известные компании: `
      + `${companyNames.join(", ") || "нет компаний"}. Сводка по MBOX прямо сейчас: всего задач `
      + `${stats.todos_total}, из них незакрытых ${stats.todos_open}, записей в памяти ${stats.memories_total}. `
      + "Если спросят общее число задач/проектов — отвечай из этой сводки, не выдумывай и не говори, что не умеешь."
      + (item.props?.current_project_name
        ? ` Пользователь сейчас открыл в интерфейсе проект «${item.props.current_project_name}» — если он не называет проект явно в вопросе или команде, подразумевай именно этот, не переспрашивай.`
        : "");
    // Раньше каждый ответ видел ТОЛЬКО текущее сообщение — если человек в прошлом сообщении назвал
    // стек или ссылку, а в этом попросил "создай проект", Джарвис не мог их связать. Подтягиваем
    // последние сообщения разговора (включая только что вставленное — оно уже в базе) как реальную
    // историю диалога, а не только последнюю реплику.
    const history = (await client.query(
      `SELECT agent_name, body, title FROM agent_inbox
       WHERE item_type IN ('question', 'answer') AND (agent_name = 'Человек' OR agent_name = $1)
       ORDER BY created_at DESC LIMIT 8`,
      [JARVIS_NAME],
    )).rows.reverse();
    // Однократный запрос с несколькими действиями ("удали Тест и Тест 2") ненадёжен — модель
    // часто возвращает только один tool_call за раз, даже когда попросили вызывать функцию на
    // каждое действие. Вместо надежды на параллельные tool_calls гоняем обычный agentic-цикл:
    // выполняем то, что модель попросила, отдаём результат обратно и спрашиваем снова, пока она
    // не перестанет вызывать функции (или не упрёмся в потолок шагов).
    const toRole = (row) => ({ role: row.agent_name === JARVIS_NAME ? "assistant" : "user", content: row.body || row.title });
    // Сжатие включается только на достаточно длинной истории (иначе короткий обмен репликами
    // сжимать нечего и незачем) и только если Cloudflare реально настроен — иначе поведение не
    // меняется. Сводка идёт ВНУТРЬ системного промпта, не отдельным message с role:"system" в
    // истории — toGeminiContents(messages) явно пропускает (continue) любой message с role:"system",
    // кроме самого первого, который geminiComplete отдельно вынимает под systemInstruction. Сводка
    // как message посреди истории молча терялась бы на основном (Gemini) пути.
    const COMPRESS_FROM = 4;
    let historyMessages = history.map(toRole);
    let finalSystemPrompt = systemPrompt;
    if (history.length >= COMPRESS_FROM && CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN) {
      const older = history.slice(0, -2);
      const recent = history.slice(-2);
      const transcript = older.map((row) => `${row.agent_name === JARVIS_NAME ? JARVIS_NAME : "Человек"}: ${row.body || row.title}`).join("\n");
      setPhase(item.id, "Сжимает историю диалога (Cloudflare)");
      const summary = await cloudflareSummarize(transcript);
      if (summary) {
        jlog(item.id, `история сжата Cloudflare: ${older.length} сообщений -> сводка ${summary.length} символов`);
        finalSystemPrompt = `${systemPrompt} Сводка более раннего разговора: ${summary}`;
        historyMessages = recent.map(toRole);
      }
    }
    const messages = [
      { role: "system", content: finalSystemPrompt },
      ...historyMessages,
    ];
    const actionLog = [];
    const toolsUsed = [];
    // Полный пошаговый трейс — что вызвано, с чем, что вернулось. В props, не в body: props не
    // попадают в historyMessages (там читаются только body/title), так что этот подробный вывод
    // никогда не вернётся Джарвису на следующем шаге — только человеку в консоль.
    const detailedTrace = [];
    let reply = "";
    // Прораб — Gemini; при первой же ошибке (429, недоступность, отсутствие ключа) переключаемся
    // на Groq gpt-oss-120b и остаёмся на нём до конца ЭТОГО ответа — не мечемся между провайдерами
    // внутри одного цикла (у Gemini уже могли накопиться tool_calls с thoughtSignature, которые Groq
    // не поймёт, а начинать заново значит повторно выполнить уже отработавшие инструменты).
    let provider = GEMINI_API_KEY ? "gemini" : "groq";
    async function complete(msgs) {
      if (provider === "gemini") {
        try {
          return await geminiComplete(msgs, JARVIS_TOOLS, "reply", controller.signal);
        } catch (error) {
          jlog(item.id, `Gemini недоступен (${error.message}) — переключаюсь на Groq до конца этого ответа`);
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
        let result;
        setPhase(item.id, `Применяет инструмент/навык: ${call.function?.name || "?"}`);
        try {
          result = await runJarvisTool(client, call.function?.name, call.function?.arguments, projectList, item.id);
          jlog(item.id, `  ${call.function?.name} -> ${result.slice(0, 200)}`);
        } catch (error) {
          result = describeToolFailure(call.function?.name || "инструмент", error);
          jlog(item.id, `  ${call.function?.name} -> ОШИБКА: ${error.stack || error}`);
          await logJarvisError({ source: "reply", toolName: call.function?.name || "", inboxId: item.id, projectId: item.project_id || null, message: error.message || String(error) });
        }
        actionLog.push(result);
        if (call.function?.name && !toolsUsed.includes(call.function.name)) toolsUsed.push(call.function.name);
        detailedTrace.push(`${call.function?.name || "?"}(${call.function?.arguments || ""}) -> ${result}`);
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function?.name, content: result });
      }
    }
    jlog(item.id, `готово: инструменты=[${toolsUsed.join(", ")}]`);
    if (!reply) reply = actionLog.join("; ") || "не смог выполнить действие";

    // "Джарвис использовал инструменты: ..." — видимый след того, что реально было вызвано,
    // а не просто текст. Отдельным полем в props, а не вклеено в текст, чтобы клиент рисовал
    // это отдельной приглушённой строкой в логе.
    await client.query(
      `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
       VALUES ($1, $2, 'answer', $3, $4, 'open', 'normal', false, $5)`,
      [item.project_id || null, JARVIS_NAME, `Ответ: ${String(item.title || "").slice(0, 100)}`, reply, JSON.stringify({ to: "Человек", re: item.id, tools_used: toolsUsed, trace: detailedTrace })],
    );
    await client.query("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.id]);
    broadcastRealtime("entity_changed", { entity: "agent_inbox", action: "create", actor: JARVIS_NAME, detail: reply.slice(0, 120), notification: `Агент ${JARVIS_NAME} ответил` });
  } catch (error) {
    if (error.name === "AbortError") {
      console.error(`Jarvis reply for #${item.id} cancelled by user`);
    } else {
      console.error(`Jarvis inline reply failed for #${item.id}: ${error.stack || error}`);
      await logJarvisError({ source: "reply", inboxId: item.id, projectId: item.project_id || null, message: error.message || String(error) });
      // Раньше отказ ВНЕ цикла инструментов (сеть до Groq, рейт-лимит, обрыв соединения к БД)
      // оставлял вопрос человека висеть открытым НАВСЕГДА без единого слова — молчание неотличимо
      // от "ещё думает". Честное "не получилось" — тоже ответ, и его стоит показать. query() —
      // отдельное свежее соединение, на случай если сломан именно client из этой попытки.
      try {
        await query(
          `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
           VALUES ($1, $2, 'answer', $3, $4, 'open', 'normal', false, $5)`,
          [item.project_id || null, JARVIS_NAME, `Ответ: ${String(item.title || "").slice(0, 100)}`, `Не получилось ответить: ${String(error.message || error).slice(0, 200)}. Попробуй ещё раз.`, JSON.stringify({ to: "Человек", re: item.id, tools_used: [], failed: true })],
        );
        await query("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.id]);
        broadcastRealtime("entity_changed", { entity: "agent_inbox", action: "create", actor: JARVIS_NAME, detail: "не получилось ответить", notification: `Агент ${JARVIS_NAME} споткнулся` });
      } catch (fallbackError) {
        console.error(`Jarvis fallback answer for #${item.id} also failed: ${fallbackError.message}`);
      }
    }
  } finally {
    activeJarvisRequests.delete(String(item.id));
    jarvisPhase.delete(String(item.id));
    try { await client.end(); } catch { /* уже не подключён или подключение сломано — нечего закрывать */ }
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
    res.setHeader("set-cookie", `mbox_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    return sendJson(res, 200, { user: user.rows[0] });
  }

  if (url.pathname === "/api/mbox/auth/logout" && req.method === "POST") {
    const token = getCookie(req, "mbox_session");
    if (token) await query("DELETE FROM auth_sessions WHERE token_hash = $1", [createHash("sha256").update(token).digest("hex")]);
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
    return sendJson(res, 200, { presence: result.rows[0] });
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
    const result = await query(
      `SELECT id::text, source, tool_name, inbox_id::text, project_id::text, message, created_at::text
       FROM jarvis_errors ORDER BY created_at DESC LIMIT 50`,
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
    const result = await query(
      `SELECT id::text, folder_id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
              pg_column_size(memories)::int AS memory_bytes,
              created_at::text, updated_at::text,
              count(*) OVER()::int AS total_count,
              sum(pg_column_size(memories)) OVER()::bigint AS total_bytes
       FROM memories
       WHERE $1 = '' OR search_vector @@ plainto_tsquery('simple', $1) OR title ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%' OR tags::text ILIKE '%' || $1 || '%'
       ORDER BY updated_at DESC
       LIMIT 300`,
      [q],
    );
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
         ORDER BY m.updated_at DESC
         LIMIT $1`,
        [limit, projectId, project, tags, recencyDays],
      );
      const memories = recent.rows.map((memory) => ({ ...memory, score: 0 }));
      return sendJson(res, 200, { query: search, detail, memories: detail === "full" ? memories : memories.map((memory) => compactRecallMemoryRow(memory)) });
    }

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
         AND ($4::int <= 0 OR m.updated_at >= now() - ($4::int * interval '1 day'))`,
      [projectId, project, tags, recencyDays],
    );
    const memories = result.rows
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
       WHERE m.id = $1`,
      [memoryMatch[1]],
    );
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
  }

  if (memoryMatch && req.method === "PATCH") {
    const body = await readBody(req);
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
    await recordMemoryAction({ memoryId: memoryMatch[1], actor: actorFromReq(req), action: "delete", note: "memory deleted via API" });
    await query("DELETE FROM memories WHERE id = $1", [memoryMatch[1]]);
    await refreshMemoryEmbeddings();
    broadcastChange(req, "delete", "memories", `#${memoryMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/folders") {
    if (req.method === "POST") {
      const body = await readBody(req);
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
       WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR entity_type ILIKE '%' || $1 || '%'
       ORDER BY COALESCE(parent_id, 0), name`,
      [q],
    );
    return sendJson(res, 200, { folders: result.rows });
  }

  const folderMatch = url.pathname.match(/^\/api\/mbox\/folders\/(\d+)$/);
  if (folderMatch && req.method === "PATCH") {
    const body = await readBody(req);
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
    await query("DELETE FROM folders WHERE id = $1", [folderMatch[1]]);
    broadcastChange(req, "delete", "folders", `#${folderMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/artifacts") {
    if (req.method === "POST") {
      const body = await readBody(req);
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
       WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR category ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%'
       ORDER BY category, name
       LIMIT 300`,
      [q],
    );
    return sendJson(res, 200, { artifacts: result.rows });
  }

  const artifactMatch = url.pathname.match(/^\/api\/mbox\/artifacts\/(\d+)$/);
  if (artifactMatch && req.method === "PATCH") {
    const body = await readBody(req);
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
    const todos = await query("SELECT id::text, project_id::text, title, note, status, priority, props, claimed_by, claimed_until::text, heartbeat_at::text, pg_column_size(todos)::int AS memory_bytes FROM todos ORDER BY updated_at DESC");
    const relations = await query(
      `SELECT e.id::text, e.from_id::text AS from_project_id, fp.name AS from_project_name,
              e.to_id::text AS to_project_id, tp.name AS to_project_name, e.edge_type,
              e.title, e.description, e.owner, e.group_entity, e.strength, e.valid_until::text
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
       WHERE id = $1`,
      [todoMatch[1]],
    );
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { todo: result.rows[0] } : { error: "not_found" });
  }

  if (todoMatch && req.method === "PATCH") {
    const body = await readBody(req);
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
       WHERE $1 = '' OR actor ILIKE '%' || $1 || '%' OR action ILIKE '%' || $1 || '%'
          OR entity_type ILIKE '%' || $1 || '%' OR summary ILIKE '%' || $1 || '%' OR metadata::text ILIKE '%' || $1 || '%'
       ORDER BY created_at DESC
       LIMIT 200`,
      [q],
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
      const result = await query(
        `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
         VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'notice'), $4, $5, COALESCE(NULLIF($6, ''), 'open'), COALESCE(NULLIF($7, ''), 'normal'), $8, $9)
         RETURNING id::text`,
        [body.project_id || null, String(body.agent_name || actorFromReq(req)), String(body.item_type || ""), String(body.title || "").trim(), String(body.body || ""), String(body.status || ""), String(body.priority || ""), Boolean(body.requires_human), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
      );
      broadcastChange(req, "create", "agent_inbox", String(body.title || "").trim());
      const senderName = String(body.agent_name || actorFromReq(req));
      const addressedTo = body.props && typeof body.props === "object" ? String(body.props.to || "") : "";
      if (senderName === "Человек" && (!addressedTo || addressedTo === JARVIS_NAME) && result.rows[0]) {
        // .catch() обязателен на fire-and-forget вызове: необработанный reject роняет весь процесс.
        // replyAsJarvis теперь сама не должна выбрасывать наружу, но это последний рубеж, не первый.
        replyAsJarvis({ id: result.rows[0].id, project_id: body.project_id || null, title: body.title, body: body.body, props: body.props })
          .catch((error) => console.error(`Jarvis reply totally uncaught: ${error.message}`));
      }
      return sendJson(res, 201, { inbox_item: result.rows[0] });
    }
    const result = await query("SELECT id::text, project_id::text, agent_name, item_type, title, body, status, priority, requires_human, props, pg_column_size(agent_inbox)::int AS memory_bytes, created_at::text, updated_at::text FROM agent_inbox ORDER BY updated_at DESC LIMIT 200");
    return sendJson(res, 200, { inbox: result.rows });
  }

  const inboxMatch = url.pathname.match(/^\/api\/mbox\/agent\/inbox\/(\d+)$/);
  if (inboxMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const result = await query(
      `UPDATE agent_inbox SET status = COALESCE(NULLIF($1, ''), status), priority = COALESCE(NULLIF($2, ''), priority), body = COALESCE($3, body), props = COALESCE($4, props), updated_at = now()
       WHERE id = $5 RETURNING id::text`,
      [String(body.status || ""), String(body.priority || ""), body.body ?? null, body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, inboxMatch[1]],
    );
    if (result.rows[0]) broadcastChange(req, "update", "agent_inbox", `#${inboxMatch[1]}`);
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
    const result = await query("SELECT id::text, project_id::text, todo_id::text, agent_name, status, goal, read_context, commands, touched_files, result, props, pg_column_size(agent_runs)::int AS memory_bytes, started_at::text, heartbeat_at::text, finished_at::text FROM agent_runs ORDER BY started_at DESC LIMIT 100");
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
       WHERE $1 = '' OR actor ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%' OR decision ILIKE '%' || $1 || '%'
          OR rationale ILIKE '%' || $1 || '%' OR impact ILIKE '%' || $1 || '%'
       ORDER BY created_at DESC LIMIT 200`,
      [q],
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

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
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
