import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    agent_inbox: "agent-visible inbox for notices, proposals and human decisions.",
    agent_runs: "agent work sessions with goal, read context, commands, touched files, heartbeat and result.",
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
    "Call /api/mbox/agent/next-task?project=MBOX&agent=Codex to pick and claim work.",
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
    after_work: ["set task status", "add a short done todo or audit memory when work was not started from an existing todo"],
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

function actorFromReq(req) {
  return req.headers["x-mbox-agent"] || req.headers["x-agent-name"] || "Agent";
}

function broadcastChange(req, action, entity, detail = "") {
  const actor = String(actorFromReq(req));
  const verb = actionLabels[action] || action;
  broadcastRealtime("entity_changed", {
    entity,
    action,
    actor,
    detail,
    notification: `Агент ${actor} ${verb} ${detail || entity}`,
  });
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
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
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

  if (url.pathname === "/api/mbox/agents") {
    const sessions = await query(
      `SELECT count(*)::int AS active_sessions, max(s.created_at)::text AS last_seen
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > now()`,
    );
    return sendJson(res, 200, {
      agents: [
        {
          id: "mbox-prod-mcp",
          name: "MBOX MCP",
          kind: "trusted_mcp",
          status: realtimeClients.size > 0 || Number(sessions.rows[0]?.active_sessions || 0) > 0 ? "active" : "idle",
          scope: "projects,todos,history,approved_secrets",
          active_sessions: sessions.rows[0]?.active_sessions || 0,
          live_connections: realtimeClients.size,
          last_seen: sessions.rows[0]?.last_seen || new Date().toISOString(),
        },
        {
          id: "codex-chatgpt",
          name: "Codex / ChatGPT",
          kind: "ai_agent",
          status: Number(sessions.rows[0]?.active_sessions || 0) > 0 ? "active" : "idle",
          scope: "uses mbox-prod MCP after session reload",
          active_sessions: sessions.rows[0]?.active_sessions || 0,
          live_connections: realtimeClients.size,
          last_seen: sessions.rows[0]?.last_seen || new Date().toISOString(),
        },
      ],
    });
  }

  if (url.pathname === "/api/mbox/memories") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
        `INSERT INTO memories(title, content, entity_type, access_level, tags)
         VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'memory'), COALESCE(NULLIF($4, ''), 'private'), $5)
         RETURNING id::text`,
        [String(body.title || "").trim(), String(body.content || ""), String(body.entity_type || ""), String(body.access_level || ""), Array.isArray(body.tags) ? body.tags : []],
      );
      broadcastChange(req, "create", "memories", String(body.title || "").trim());
      return sendJson(res, 201, { memory: result.rows[0] });
    }
    const result = await query(
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
    const body = await readBody(req);
    const result = await query(
      `UPDATE memories SET
         title = COALESCE(NULLIF($1, ''), title),
         content = COALESCE($2, content),
         access_level = COALESCE(NULLIF($3, ''), access_level),
         tags = COALESCE($4, tags),
         updated_at = now()
       WHERE id = $5
       RETURNING id::text`,
      [String(body.title || "").trim(), body.content ?? null, String(body.access_level || ""), Array.isArray(body.tags) ? body.tags : null, memoryMatch[1]],
    );
    if (result.rows[0]) broadcastChange(req, "update", "memories", String(body.title || "").trim() || `#${memoryMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { memory: result.rows[0] } : { error: "not_found" });
  }

  if (memoryMatch && req.method === "DELETE") {
    await query("DELETE FROM memories WHERE id = $1", [memoryMatch[1]]);
    broadcastChange(req, "delete", "memories", `#${memoryMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/folders") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
        `INSERT INTO folders(parent_id, name, entity_type, access_level, color)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id::text`,
        [body.parent_id || null, String(body.name || "").trim(), String(body.entity_type || "artifact"), String(body.access_level || "private"), String(body.color || "#2c2c2e")],
      );
      broadcastChange(req, "create", "folders", String(body.name || "").trim());
      return sendJson(res, 201, { folder: result.rows[0] });
    }
    const result = await query(
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
        `INSERT INTO artifacts(folder_id, name, category, version, status, content, access_level)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE(NULLIF($7, ''), 'agents'))
         RETURNING id::text`,
        [body.folder_id || null, String(body.name || "").trim(), String(body.category || "Code"), String(body.version || "v1"), String(body.status || "created"), String(body.content || ""), String(body.access_level || "")],
      );
      broadcastChange(req, "create", "artifacts", String(body.name || "").trim());
      return sendJson(res, 201, { artifact: result.rows[0] });
    }
    const result = await query(
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
    const body = await readBody(req);
    const result = await query(
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
      [body.folder_id || null, String(body.name || "").trim(), String(body.category || ""), String(body.version || ""), String(body.status || ""), body.content ?? null, artifactMatch[1]],
    );
    if (result.rows[0]) broadcastChange(req, "update", "artifacts", String(body.name || "").trim() || `#${artifactMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { artifact: result.rows[0] } : { error: "not_found" });
  }

  if (artifactMatch && req.method === "DELETE") {
    await query("DELETE FROM artifacts WHERE id = $1", [artifactMatch[1]]);
    broadcastChange(req, "delete", "artifacts", `#${artifactMatch[1]}`);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/mbox/projects") {
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
      `SELECT id::text, name, status, stack, git_url, deploy_target, deploy_provider, props, color, access_level,
              pg_column_size(projects)::int AS memory_bytes
       FROM projects
       WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR git_url ILIKE '%' || $1 || '%' OR deploy_target ILIKE '%' || $1 || '%' OR stack::text ILIKE '%' || $1 || '%'
       ORDER BY updated_at DESC
       LIMIT 200`,
      [q],
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
      projects: projects.rows.map((project) => ({
        ...project,
        todos: todos.rows.filter((todo) => todo.project_id === project.id),
        relations: relations.rows.filter((edge) => edge.from_project_id === project.id || edge.to_project_id === project.id),
      })),
    });
  }

  if (url.pathname === "/api/mbox/graph/edges") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const fromId = String(body.from_id || "");
      const toId = String(body.to_id || "");
      if (!fromId || !toId || fromId === toId) return sendJson(res, 400, { error: "invalid_edge" });
      const result = await query(
        `INSERT INTO graph_edges(from_entity, from_id, to_entity, to_id, edge_type, title, description, owner, group_entity, strength, valid_until, score)
         VALUES ('project', $1, 'project', $2, COALESCE(NULLIF($3, ''), 'related'), $4, $5, $6, $7, COALESCE($8, 1), $9, 1)
         ON CONFLICT DO NOTHING
         RETURNING id::text`,
        [fromId, toId, String(body.edge_type || ""), String(body.title || ""), String(body.description || ""), String(body.owner || ""), String(body.group_entity || ""), Number(body.strength || 1), body.valid_until || null],
      );
      broadcastChange(req, "create", "graph_edges", String(body.edge_type || "related"));
      return sendJson(res, 201, { edge: result.rows[0] || null });
    }
    const result = await query(
      `SELECT e.id::text, e.from_entity, e.from_id::text, COALESCE(fp.name, e.from_entity || ' #' || e.from_id::text) AS from_label,
              e.to_entity, e.to_id::text, COALESCE(tp.name, e.to_entity || ' #' || e.to_id::text) AS to_label,
              e.edge_type, e.title, e.description, e.owner, e.group_entity, e.strength, e.valid_until::text
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
    await query("DELETE FROM graph_edges WHERE id = $1", [edgeMatch[1]]);
    broadcastChange(req, "delete", "graph_edges", `#${edgeMatch[1]}`);
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
       RETURNING id::text`,
      [body.project_id, String(body.title || "").trim(), String(body.note || ""), String(body.status || ""), String(body.priority || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {}), String(body.access_level || "")],
    );
    broadcastChange(req, "create", "todos", String(body.title || "").trim());
    return sendJson(res, 201, { todo: result.rows[0] });
  }

  const todoMatch = url.pathname.match(/^\/api\/mbox\/todos\/(\d+)$/);
  if (todoMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const result = await query(
      `UPDATE todos SET
         title = COALESCE(NULLIF($1, ''), title),
         note = COALESCE($2, note),
         status = COALESCE(NULLIF($3, ''), status),
         priority = COALESCE(NULLIF($4, ''), priority),
         props = COALESCE($6, props),
         claimed_by = COALESCE($7, claimed_by),
         claimed_until = COALESCE($8, claimed_until),
         heartbeat_at = CASE WHEN $9 THEN now() ELSE heartbeat_at END,
         updated_at = now()
       WHERE id = $5
       RETURNING id::text`,
      [String(body.title || "").trim(), body.note ?? null, String(body.status || ""), String(body.priority || ""), todoMatch[1], body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, typeof body.claimed_by === "string" ? body.claimed_by : null, body.claimed_until || null, Boolean(body.heartbeat)],
    );
    if (result.rows[0]) broadcastChange(req, "update", "todos", String(body.title || "").trim() || `#${todoMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { todo: result.rows[0] } : { error: "not_found" });
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
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    return sendJson(res, 200, { events: result.rows });
  }

  if (url.pathname === "/api/mbox/agent/context") {
    const projectName = url.searchParams.get("project") || "MBOX";
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
      `SELECT e.id::text, e.from_entity, e.from_id::text, COALESCE(fp.name, e.from_entity || ' #' || e.from_id::text) AS from_label,
              e.to_entity, e.to_id::text, COALESCE(tp.name, e.to_entity || ' #' || e.to_id::text) AS to_label,
              e.edge_type, e.title, e.description, e.owner, e.group_entity, e.strength, e.valid_until::text
       FROM graph_edges e
       LEFT JOIN projects fp ON e.from_entity = 'project' AND fp.id = e.from_id
       LEFT JOIN projects tp ON e.to_entity = 'project' AND tp.id = e.to_id
       WHERE (e.from_entity = 'project' AND e.from_id = $1) OR (e.to_entity = 'project' AND e.to_id = $1)
       ORDER BY e.created_at DESC`,
      [project.id],
    );
    const decisions = await query("SELECT id::text, actor, title, decision, rationale, impact, props, created_at::text FROM decision_log WHERE project_id = $1 ORDER BY created_at DESC LIMIT 25", [project.id]);
    const inbox = await query("SELECT id::text, agent_name, item_type, title, body, status, priority, requires_human, props, created_at::text, updated_at::text FROM agent_inbox WHERE project_id = $1 AND status <> 'done' ORDER BY created_at DESC LIMIT 50", [project.id]);
    const runs = await query("SELECT id::text, todo_id::text, agent_name, status, goal, read_context, commands, touched_files, result, props, started_at::text, heartbeat_at::text, finished_at::text FROM agent_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 20", [project.id]);
    const history = await query("SELECT id::text, actor, action, entity_type, entity_id::text, summary, metadata, created_at::text FROM audit_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50", [project.id]);
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
    return sendJson(res, 200, { project, todos: todos.rows, relations: relations.rows, decisions: decisions.rows, inbox: inbox.rows, runs: runs.rows, history: history.rows, approved_secrets: secrets.rows });
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

  if (url.pathname === "/api/mbox/agent/runs") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
        `INSERT INTO agent_runs(project_id, todo_id, agent_name, status, goal, read_context, commands, touched_files, result, props)
         VALUES ($1, $2, $3, COALESCE(NULLIF($4, ''), 'running'), $5, $6, $7, $8, $9, $10)
         RETURNING id::text`,
        [body.project_id || null, body.todo_id || null, String(body.agent_name || actorFromReq(req)), String(body.status || ""), String(body.goal || ""), JSON.stringify(Array.isArray(body.read_context) ? body.read_context : []), JSON.stringify(Array.isArray(body.commands) ? body.commands : []), JSON.stringify(Array.isArray(body.touched_files) ? body.touched_files : []), String(body.result || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
      );
      broadcastChange(req, "create", "agent_runs", String(body.goal || "run"));
      return sendJson(res, 201, { run: result.rows[0] });
    }
    const result = await query("SELECT id::text, project_id::text, todo_id::text, agent_name, status, goal, read_context, commands, touched_files, result, props, pg_column_size(agent_runs)::int AS memory_bytes, started_at::text, heartbeat_at::text, finished_at::text FROM agent_runs ORDER BY started_at DESC LIMIT 100");
    return sendJson(res, 200, { runs: result.rows });
  }

  const runMatch = url.pathname.match(/^\/api\/mbox\/agent\/runs\/(\d+)$/);
  if (runMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const result = await query(
      `UPDATE agent_runs SET status = COALESCE(NULLIF($1, ''), status), result = COALESCE($2, result), commands = COALESCE($3, commands), touched_files = COALESCE($4, touched_files), props = COALESCE($5, props), heartbeat_at = now(), finished_at = CASE WHEN $6 THEN now() ELSE finished_at END
       WHERE id = $7 RETURNING id::text`,
      [String(body.status || ""), body.result ?? null, Array.isArray(body.commands) ? JSON.stringify(body.commands) : null, Array.isArray(body.touched_files) ? JSON.stringify(body.touched_files) : null, body.props && typeof body.props === "object" ? JSON.stringify(body.props) : null, ["done", "failed", "blocked"].includes(String(body.status || "")), runMatch[1]],
    );
    if (result.rows[0]) broadcastChange(req, ["done", "failed", "blocked"].includes(String(body.status || "")) ? "finish" : "heartbeat", "agent_runs", `#${runMatch[1]}`);
    return sendJson(res, result.rows[0] ? 200 : 404, result.rows[0] ? { run: result.rows[0] } : { error: "not_found" });
  }

  if (url.pathname === "/api/mbox/decisions") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const result = await query(
        `INSERT INTO decision_log(project_id, agent_run_id, actor, title, decision, rationale, impact, props)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id::text`,
        [body.project_id || null, body.agent_run_id || null, String(body.actor || actorFromReq(req)), String(body.title || "").trim(), String(body.decision || ""), String(body.rationale || ""), String(body.impact || ""), JSON.stringify(body.props && typeof body.props === "object" ? body.props : {})],
      );
      broadcastChange(req, "create", "decision_log", String(body.title || "").trim());
      return sendJson(res, 201, { decision: result.rows[0] });
    }
    const result = await query("SELECT id::text, project_id::text, agent_run_id::text, actor, title, decision, rationale, impact, props, pg_column_size(decision_log)::int AS memory_bytes, created_at::text FROM decision_log ORDER BY created_at DESC LIMIT 200");
    return sendJson(res, 200, { decisions: result.rows });
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
    const result = await query("SELECT id::text, project_id::text, title, login, url, access_level, agent_share_state, pg_column_size(protected_secrets)::int AS memory_bytes, approved_until::text, updated_at::text FROM protected_secrets ORDER BY updated_at DESC LIMIT 100");
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
  const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, { "content-type": type });
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
