import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client, type QueryResult, type QueryResultRow } from "pg";
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

function actorFromReq(req: IncomingMessage) {
  return req.headers["x-mbox-agent"] || req.headers["x-agent-name"] || "Agent";
}

function textPreview(value: unknown, limit = 240) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
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
};

type TfidfVector = {
  id?: string;
  terms: Record<string, number>;
  norm: number;
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

const agentStructure = {
  entity_model: {
    projects: "root work folders. Each project owns todos, git, deploy, stack and access scopes.",
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
    "Call /api/mbox/agent/next-task?project=MBOX to pick work.",
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
      "set task status",
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

async function queryPostgres<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await client.query<T>(sql, values);
  } finally {
    await client.end();
  }
}

async function refreshMemoryEmbeddings() {
  const memories = await queryPostgres<MemoryEmbeddingRow>(
    `SELECT id::text, title, content, tags, metadata, updated_at::text
     FROM memories
     ORDER BY id`,
  );
  const documents = memories.rows.map((memory) => ({ id: memory.id, text: memoryEmbeddingText(memory), updated_at: memory.updated_at }));
  const vectors = buildTfIdfIndex(documents);
  for (const vector of vectors) {
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
  return { skipped: false, id: result.rows[0]?.id || null };
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

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/mbox/")) return next();
        const url = new URL(req.url, "http://localhost");
        const q = url.searchParams.get("q")?.trim() ?? "";

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
                id: row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agent",
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

          if (url.pathname === "/api/mbox/agent/ping" && req.method === "POST") {
            const body = await readBody<{ agent?: string; kind?: string; client?: string; scope?: string; event?: string }>(req);
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
            return sendJson(res, 200, { presence: result.rows[0] });
          }

          if (url.pathname === "/api/mbox/status") {
            const result = await queryPostgres<{ now: string; database: string; server_addr: string | null }>(
              "SELECT now()::text, current_database() AS database, inet_server_addr()::text AS server_addr",
            );
            return sendJson(res, 200, { ok: true, postgres: result.rows[0] });
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
              await refreshMemoryEmbeddings();
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
              return sendJson(res, 201, { memory: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, entity_type, access_level, tags, metadata,
                      pg_column_size(memories)::int AS memory_bytes,
                      created_at::text, updated_at::text
               FROM memories
               WHERE $1 = '' OR search_vector @@ plainto_tsquery('simple', $1) OR title ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%'
               ORDER BY updated_at DESC
               LIMIT 300`,
              [q],
            );
            return sendJson(res, 200, { memories: result.rows });
          }

          if (url.pathname === "/api/mbox/memories/search") {
            const search = url.searchParams.get("q")?.trim() ?? "";
            const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
            if (!search) {
              const recent = await queryPostgres(
                `SELECT m.id::text, m.project_id::text, m.todo_id::text, m.agent_run_id::text, m.title, m.content, m.entity_type, m.access_level, m.tags, m.metadata,
                        pg_column_size(m)::int AS memory_bytes,
                        m.created_at::text, m.updated_at::text,
                        e.dimension, e.encoding_source, e.updated_at::text AS embedding_updated_at
                 FROM memories m
                 LEFT JOIN memory_embeddings e ON e.memory_id = m.id
                 ORDER BY m.updated_at DESC
                 LIMIT $1`,
                [limit],
              );
              return sendJson(res, 200, { query: search, memories: recent.rows.map((memory) => ({ ...memory, score: 0 })) });
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
              `SELECT m.id::text, m.project_id::text, m.todo_id::text, m.agent_run_id::text, m.title, m.content, m.entity_type, m.access_level, m.tags, m.metadata,
                      pg_column_size(m)::int AS memory_bytes,
                      m.created_at::text, m.updated_at::text,
                      e.representation, e.dimension, e.encoding_source, e.updated_at::text AS embedding_updated_at
               FROM memories m
               JOIN memory_embeddings e ON e.memory_id = m.id`,
            );
            const memories = result.rows
              .map((memory) => ({
                ...memory,
                score: cosineSimilarity(queryVector, memory.representation || { terms: {}, norm: 0 }),
              }))
              .filter((memory) => memory.score > 0)
              .sort((a, b) => b.score - a.score || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
              .slice(0, limit)
              .map(({ representation, ...memory }) => ({ ...memory, score: Number(memory.score.toFixed(6)) }));
            return sendJson(res, 200, { query: search, memories });
          }

          const memoryMatch = url.pathname.match(/^\/api\/mbox\/memories\/(\d+)$/);
          if (memoryMatch && req.method === "PATCH") {
            const body = await readBody<Record<string, unknown>>(req);
            const result = await queryPostgres(
              `UPDATE memories SET
                 title = COALESCE(NULLIF($1, ''), title),
                 content = COALESCE($2, content),
                 access_level = COALESCE(NULLIF($3, ''), access_level),
                 tags = COALESCE($4, tags),
                 updated_at = now()
               WHERE id = $5
               RETURNING id::text`,
              [String(body.title ?? "").trim(), body.content ?? null, String(body.access_level ?? ""), Array.isArray(body.tags) ? body.tags : null, memoryMatch[1]],
            );
            if (result.rows[0]) await refreshMemoryEmbeddings();
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
          }

          if (memoryMatch && req.method === "DELETE") {
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
                `INSERT INTO artifacts(folder_id, name, category, version, status, content, access_level)
                 VALUES ($1, $2, $3, $4, $5, $6, COALESCE(NULLIF($7, ''), 'agents'))
                 RETURNING id::text`,
                [body.folder_id || null, String(body.name ?? "").trim(), String(body.category ?? "Code"), String(body.version ?? "v1"), String(body.status ?? "created"), String(body.content ?? ""), String(body.access_level ?? "")],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "artifacts" });
              return sendJson(res, 201, { artifact: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, folder_id::text, name, category, version, status, content, access_level, pg_column_size(artifacts)::int AS memory_bytes
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
                 name = COALESCE(NULLIF($2, ''), name),
                 category = COALESCE(NULLIF($3, ''), category),
                 version = COALESCE(NULLIF($4, ''), version),
                 status = COALESCE(NULLIF($5, ''), status),
                 content = COALESCE($6, content),
                 updated_at = now()
               WHERE id = $7
               RETURNING id::text`,
              [body.folder_id || null, String(body.name ?? "").trim(), String(body.category ?? ""), String(body.version ?? ""), String(body.status ?? ""), body.content ?? null, artifactMatch[1]],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "artifacts" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { artifact: result.rows[0] } : { error: "not_found" });
          }

          if (artifactMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM artifacts WHERE id = $1", [artifactMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "artifacts" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/projects") {
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
              `SELECT id::text, name, status, stack, git_url, deploy_target, deploy_provider, props, color, access_level,
                      pg_column_size(projects)::int AS memory_bytes
               FROM projects
               WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR git_url ILIKE '%' || $1 || '%' OR deploy_target ILIKE '%' || $1 || '%' OR stack::text ILIKE '%' || $1 || '%'
               ORDER BY updated_at DESC
               LIMIT 200`,
              [q],
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
              if (!fromId || !toId || fromId === toId) return sendJson(res, 400, { error: "invalid_edge" });
              const result = await queryPostgres(
                `INSERT INTO graph_edges(from_entity, from_id, to_entity, to_id, edge_type, score)
                 VALUES ('project', $1, 'project', $2, COALESCE(NULLIF($3, ''), 'related'), 1)
                 ON CONFLICT DO NOTHING
                 RETURNING id::text`,
                [fromId, toId, String(body.edge_type ?? "")],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "graph_edges" });
              return sendJson(res, 201, { edge: result.rows[0] ?? null });
            }
            const result = await queryPostgres(
              `SELECT e.id::text, e.from_entity, e.from_id::text, COALESCE(fp.name, e.from_entity || ' #' || e.from_id::text) AS from_label,
                      e.to_entity, e.to_id::text, COALESCE(tp.name, e.to_entity || ' #' || e.to_id::text) AS to_label,
                      e.edge_type
               FROM graph_edges e
               LEFT JOIN projects fp ON e.from_entity = 'project' AND fp.id = e.from_id
               LEFT JOIN projects tp ON e.to_entity = 'project' AND tp.id = e.to_id
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
               RETURNING id::text`,
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
               ORDER BY created_at DESC
               LIMIT 200`,
            );
            return sendJson(res, 200, { events: result.rows });
          }

          // Расстановка узлов карты. Держать в паре с server/mbox-server.mjs.
          if (url.pathname === "/api/mbox/agent/context") {
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

          if (url.pathname === "/api/mbox/graph/positions") {
            if (req.method === "POST") {
              const body = await readBody<{ positions?: Array<{ entity_type?: string; entity_id?: string; x?: number; y?: number }> }>(req);
              const items = Array.isArray(body.positions) ? body.positions : [];
              const rows = items
                .filter((item) => item && item.entity_type && item.entity_id)
                .map((item) => [String(item.entity_type), String(item.entity_id), Number(item.x) || 0, Number(item.y) || 0]);
              if (!rows.length) return sendJson(res, 400, { error: "positions_required" });
              const values = rows.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, now())`).join(", ");
              await queryPostgres(
                `INSERT INTO graph_positions(entity_type, entity_id, x, y, updated_at)
                 VALUES ${values}
                 ON CONFLICT (entity_type, entity_id)
                 DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = now()`,
                rows.flat(),
              );
              return sendJson(res, 200, { ok: true, saved: rows.length });
            }
            if (req.method === "DELETE") {
              await queryPostgres("DELETE FROM graph_positions");
              return sendJson(res, 200, { ok: true });
            }
            const result = await queryPostgres("SELECT entity_type, entity_id, x, y FROM graph_positions");
            return sendJson(res, 200, { positions: result.rows });
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
               ORDER BY created_at DESC
               LIMIT 200`,
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
              "SELECT id::text, project_id::text, title, login, url, access_level, agent_share_state, pg_column_size(protected_secrets)::int AS memory_bytes, approved_until::text, updated_at::text FROM protected_secrets ORDER BY updated_at DESC LIMIT 100",
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
    },
  };
}

export default defineConfig({
  plugins: [react(), mboxDevApi()],
  publicDir: false,
  server: { port: 5173 },
});
