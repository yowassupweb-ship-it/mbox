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

function broadcastRealtime(clients: Set<WebSocket>, type: string, payload: Record<string, unknown> = {}) {
  const message = JSON.stringify({ type, ...payload, at: new Date().toISOString() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
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
    memories: "database-backed knowledge records available for search and graph context.",
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
    after_work: ["set task status", "add a short done todo or audit memory when work was not started from an existing todo"],
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
                `INSERT INTO memories(title, content, entity_type, access_level, tags)
                 VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'memory'), COALESCE(NULLIF($4, ''), 'private'), $5)
                 RETURNING id::text`,
                [String(body.title ?? "").trim(), String(body.content ?? ""), String(body.entity_type ?? ""), String(body.access_level ?? ""), Array.isArray(body.tags) ? body.tags : []],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
              return sendJson(res, 201, { memory: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, title, content, entity_type, access_level, tags, metadata,
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
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
          }

          if (memoryMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM memories WHERE id = $1", [memoryMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "memories" });
            return sendJson(res, 200, { ok: true });
          }

          if (url.pathname === "/api/mbox/folders") {
            if (req.method === "POST") {
              const body = await readBody<Record<string, unknown>>(req);
              const result = await queryPostgres(
                `INSERT INTO folders(parent_id, name, entity_type, access_level, color)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id::text`,
                [body.parent_id || null, String(body.name ?? "").trim(), String(body.entity_type ?? "artifact"), String(body.access_level ?? "private"), String(body.color ?? "#2c2c2e")],
              );
              broadcastRealtime(realtimeClients, "entity_changed", { entity: "folders" });
              return sendJson(res, 201, { folder: result.rows[0] });
            }
            const result = await queryPostgres(
              `SELECT id::text, parent_id::text, name, entity_type, access_level, color, pg_column_size(folders)::int AS memory_bytes
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
               RETURNING id::text`,
              [String(body.title ?? "").trim(), body.note ?? null, String(body.status ?? ""), String(body.priority ?? ""), todoMatch[1], body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null],
            );
            if (result.rows[0]) broadcastRealtime(realtimeClients, "entity_changed", { entity: "todos" });
            return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { todo: result.rows[0] } : { error: "not_found" });
          }

          if (todoMatch && req.method === "DELETE") {
            await queryPostgres("DELETE FROM todos WHERE id = $1", [todoMatch[1]]);
            broadcastRealtime(realtimeClients, "entity_changed", { entity: "todos" });
            return sendJson(res, 200, { ok: true });
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
            return sendJson(res, 200, { task: result.rows[0] ?? null });
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
