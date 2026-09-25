import { createHash } from "node:crypto";
import { documentToDocx } from "./docx.mjs";

// Локальные рабочие папки: файлы лежат на компьютере с MBOX Desktop, сервер их не видит.
// Здесь три вещи, общие для прод-сервера и dev-API (vite.config.ts):
// 1) реестр папок, которые подключило приложение (с git-сводкой, чтобы агенты видели состояние репо);
// 2) очередь операций — Джарвис на сервере и MCP-агенты кладут «прочитать/записать файл», приложение
//    на компьютере выполняет и возвращает результат;
// 3) история версий файлов: правки из MBOX, агентов и замеченные на диске.

export const WORKSPACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  root_key TEXT NOT NULL,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL DEFAULT '',
  agent_write BOOLEAN NOT NULL DEFAULT true,
  git JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, root_key)
);
CREATE TABLE IF NOT EXISTS workspace_file_versions (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  sha TEXT NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'mbox',
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_file_versions_path ON workspace_file_versions(workspace_id, path, created_at DESC);
CREATE TABLE IF NOT EXISTS workspace_ops (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  content TEXT,
  message TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_workspace_ops_pending ON workspace_ops(workspace_id, status, created_at);
`;

// read_table / write_cells / read_doc выполняет страница MBOX Desktop (src/app/workbench/officeOps.ts),
// write_data — запись готового двоичного файла (base64). write_docx сюда приходит markdown-ом и
// превращается в write_data на сервере: конвертер Word живёт в server/docx.mjs.
export const WORKSPACE_OPS = ["list", "read", "write", "find", "git_log", "read_table", "write_cells", "read_doc", "write_data", "write_docx"];
const WRITE_OPS = new Set(["write", "write_cells", "write_data", "write_docx"]);
const VERSIONS_PER_FILE = 100;
const MAX_VERSION_BYTES = 1024 * 1024;
const ONLINE_MS = 3 * 60 * 1000;
const OP_WAIT_MS = 25_000;

export async function ensureWorkspaceSchema(query) {
  await query(WORKSPACE_SCHEMA_SQL);
}

export function normalizeWorkspacePath(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("path_outside_workspace");
  return parts.join("/");
}

function sha(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const WORKSPACE_COLUMNS = `id::text, device_id, device_name, root_key, name, root_path, agent_write, git,
  last_seen::text, created_at::text, (last_seen > now() - interval '${ONLINE_MS / 1000} seconds') AS online`;

export async function listWorkspaces(query) {
  return (await query(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces ORDER BY last_seen DESC`)).rows;
}

export async function findWorkspace(query, idOrName) {
  const key = String(idOrName || "").trim();
  if (!key) {
    const rows = await listWorkspaces(query);
    return rows.length === 1 ? rows[0] : null;
  }
  const rows = (await query(
    `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id::text = $1 OR lower(name) = lower($1) ORDER BY last_seen DESC LIMIT 1`,
    [key],
  )).rows;
  return rows[0] ?? null;
}

/** Запись версии: одинаковое содержимое подряд не дублируется, первую правку файла предваряет
 * исходная версия (previous_content), чтобы было к чему откатиться. */
export async function recordVersion(query, { workspaceId, path, content, previousContent, author, source = "mbox", message = "" }) {
  const clean = normalizeWorkspacePath(path);
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_VERSION_BYTES) return { skipped: "too_large" };
  const hash = sha(text);
  const latest = (await query(
    "SELECT sha FROM workspace_file_versions WHERE workspace_id = $1 AND path = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
    [workspaceId, clean],
  )).rows[0];
  if (latest?.sha === hash) return { skipped: "unchanged" };
  if (!latest && typeof previousContent === "string" && previousContent !== text && Buffer.byteLength(previousContent, "utf8") <= MAX_VERSION_BYTES) {
    await query(
      `INSERT INTO workspace_file_versions(workspace_id, path, content, sha, size_bytes, author, source, message, created_at)
       VALUES ($1, $2, $3, $4, $5, 'исходная', 'baseline', 'до первой правки', now() - interval '1 millisecond')`,
      [workspaceId, clean, previousContent, sha(previousContent), Buffer.byteLength(previousContent, "utf8")],
    );
  }
  const inserted = (await query(
    `INSERT INTO workspace_file_versions(workspace_id, path, content, sha, size_bytes, author, source, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text, created_at::text`,
    [workspaceId, clean, text, hash, Buffer.byteLength(text, "utf8"), String(author || ""), String(source || "mbox"), String(message || "")],
  )).rows[0];
  await query(
    `DELETE FROM workspace_file_versions
     WHERE workspace_id = $1 AND path = $2 AND id NOT IN (
       SELECT id FROM workspace_file_versions WHERE workspace_id = $1 AND path = $2 ORDER BY created_at DESC, id DESC LIMIT $3
     )`,
    [workspaceId, clean, VERSIONS_PER_FILE],
  );
  return { version: inserted };
}

export async function listVersions(query, workspaceId, path, limit = 50) {
  return (await query(
    `SELECT id::text, path, sha, size_bytes, author, source, message, created_at::text
     FROM workspace_file_versions
     WHERE workspace_id = $1 AND ($2 = '' OR path = $2)
     ORDER BY created_at DESC, id DESC LIMIT $3`,
    [workspaceId, path ? normalizeWorkspacePath(path) : "", Math.min(Math.max(Number(limit) || 50, 1), 200)],
  )).rows;
}

/** Поставить операцию и дождаться, пока приложение на компьютере её выполнит. */
export async function requestWorkspaceOp(query, { workspace, op, path = "", content = null, message = "", requestedBy = "", waitMs = OP_WAIT_MS }) {
  if (!WORKSPACE_OPS.includes(op)) throw new Error(`unknown_op:${op}`);
  if (WRITE_OPS.has(op) && !workspace.agent_write) throw new Error("agent_write_disabled");
  if (op === "write_docx") {
    if (!/\.docx$/i.test(String(path || ""))) throw new Error("docx_path_required");
    const buffer = documentToDocx({ content: String(content ?? ""), name: String(path).split("/").pop() || "" });
    op = "write_data";
    content = Buffer.from(buffer).toString("base64");
  }
  if (!workspace.online) throw new Error("workspace_offline");
  const clean = op === "find" ? String(path || "") : normalizeWorkspacePath(path);
  const created = (await query(
    `INSERT INTO workspace_ops(workspace_id, op, path, content, message, requested_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
    [workspace.id, op, clean, content, String(message || ""), String(requestedBy || "")],
  )).rows[0];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const row = (await query("SELECT id::text, status, result, error FROM workspace_ops WHERE id = $1", [created.id])).rows[0];
    if (row && (row.status === "done" || row.status === "failed")) return row;
  }
  await query("UPDATE workspace_ops SET status = 'failed', error = 'timeout', finished_at = now() WHERE id = $1 AND status IN ('pending', 'running')", [created.id]);
  return { id: created.id, status: "failed", result: null, error: "timeout" };
}

export function describeWorkspaceError(error, workspace) {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "workspace_offline") return `папка «${workspace?.name ?? "?"}» сейчас недоступна: MBOX Desktop на ${workspace?.device_name || "компьютере"} не в сети`;
  if (code === "agent_write_disabled") return `в папке «${workspace?.name ?? "?"}» агентам запрещено записывать файлы (переключатель в MBOX Desktop)`;
  if (code === "timeout") return "приложение не ответило за 25 секунд";
  if (code === "path_outside_workspace") return "путь выходит за пределы папки";
  if (code === "docx_path_required") return "для Word нужен путь с расширением .docx";
  return code;
}

/** Маршруты /api/mbox/workspaces*. Возвращает true, если запрос обработан. */
export async function handleWorkspaceApi({ req, res, url, query, readBody, sendJson, actor, allowed, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/workspaces")) return false;
  if (!allowed) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }
  const { pathname } = url;

  try {
    if (pathname === "/api/mbox/workspaces" && req.method === "GET") {
      sendJson(res, 200, { workspaces: await listWorkspaces(query) });
      return true;
    }

    if (pathname === "/api/mbox/workspaces/register" && req.method === "POST") {
      const body = await readBody(req);
      const deviceId = String(body.device_id || "").trim();
      if (!deviceId) { sendJson(res, 400, { error: "device_id_required" }); return true; }
      const rows = [];
      for (const root of Array.isArray(body.roots) ? body.roots : []) {
        const rootKey = String(root.key || "").trim();
        if (!rootKey) continue;
        const row = (await query(
          `INSERT INTO workspaces(device_id, device_name, root_key, name, root_path, git, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (device_id, root_key) DO UPDATE SET
             device_name = EXCLUDED.device_name, name = EXCLUDED.name, root_path = EXCLUDED.root_path,
             git = EXCLUDED.git, last_seen = now()
           RETURNING ${WORKSPACE_COLUMNS}`,
          [deviceId, String(body.device_name || ""), rootKey, String(root.name || rootKey), String(root.path || ""), JSON.stringify(root.git && typeof root.git === "object" ? root.git : {})],
        )).rows[0];
        rows.push(row);
      }
      sendJson(res, 200, { workspaces: rows });
      return true;
    }

    const opsPending = pathname === "/api/mbox/workspaces/ops/pending" && req.method === "GET";
    if (opsPending) {
      const deviceId = url.searchParams.get("device_id") || "";
      // Забираем атомарно: две вкладки одного приложения не выполнят операцию дважды.
      const rows = (await query(
        `UPDATE workspace_ops SET status = 'running'
         WHERE id IN (
           SELECT o.id FROM workspace_ops o JOIN workspaces w ON w.id = o.workspace_id
           WHERE w.device_id = $1 AND o.status = 'pending' AND o.created_at > now() - interval '2 minutes'
           ORDER BY o.created_at LIMIT 10 FOR UPDATE SKIP LOCKED
         )
         RETURNING id::text, workspace_id::text, op, path, content, message, requested_by`,
        [deviceId],
      )).rows;
      sendJson(res, 200, { ops: rows });
      return true;
    }

    const opMatch = pathname.match(/^\/api\/mbox\/workspaces\/ops\/(\d+)$/);
    if (opMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const status = body.status === "done" ? "done" : "failed";
      await query(
        "UPDATE workspace_ops SET status = $1, result = $2, error = $3, finished_at = now() WHERE id = $4",
        [status, JSON.stringify(body.result ?? null), String(body.error || ""), opMatch[1]],
      );
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (opMatch && req.method === "GET") {
      const row = (await query("SELECT id::text, workspace_id::text, op, path, status, result, error, requested_by, created_at::text, finished_at::text FROM workspace_ops WHERE id = $1", [opMatch[1]])).rows[0];
      sendJson(res, row ? 200 : 404, row ? { op: row } : { error: "not_found" });
      return true;
    }

    const versionMatch = pathname.match(/^\/api\/mbox\/workspaces\/versions\/(\d+)$/);
    if (versionMatch && req.method === "GET") {
      const row = (await query(
        "SELECT id::text, workspace_id::text, path, content, sha, size_bytes, author, source, message, created_at::text FROM workspace_file_versions WHERE id = $1",
        [versionMatch[1]],
      )).rows[0];
      sendJson(res, row ? 200 : 404, row ? { version: row } : { error: "not_found" });
      return true;
    }

    const itemMatch = pathname.match(/^\/api\/mbox\/workspaces\/(\d+)(\/versions|\/ops|\/tracked)?$/);
    if (!itemMatch) return false;
    const workspace = await findWorkspace(query, itemMatch[1]);
    if (!workspace) { sendJson(res, 404, { error: "not_found" }); return true; }
    const sub = itemMatch[2] || "";

    if (!sub && req.method === "PATCH") {
      const body = await readBody(req);
      const row = (await query(
        `UPDATE workspaces SET agent_write = COALESCE($1, agent_write), name = COALESCE(NULLIF($2, ''), name) WHERE id = $3 RETURNING ${WORKSPACE_COLUMNS}`,
        [typeof body.agent_write === "boolean" ? body.agent_write : null, String(body.name || ""), workspace.id],
      )).rows[0];
      sendJson(res, 200, { workspace: row });
      return true;
    }
    if (!sub && req.method === "DELETE") {
      await query("DELETE FROM workspaces WHERE id = $1", [workspace.id]);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (!sub && req.method === "GET") {
      sendJson(res, 200, { workspace });
      return true;
    }

    if (sub === "/tracked" && req.method === "GET") {
      const rows = (await query("SELECT DISTINCT path FROM workspace_file_versions WHERE workspace_id = $1", [workspace.id])).rows;
      sendJson(res, 200, { paths: rows.map((row) => row.path) });
      return true;
    }

    if (sub === "/versions" && req.method === "GET") {
      sendJson(res, 200, { versions: await listVersions(query, workspace.id, url.searchParams.get("path") || "", url.searchParams.get("limit")) });
      return true;
    }
    if (sub === "/versions" && req.method === "POST") {
      const body = await readBody(req);
      const result = await recordVersion(query, {
        workspaceId: workspace.id,
        path: body.path,
        content: body.content,
        previousContent: body.previous_content,
        author: body.author || actor,
        source: body.source,
        message: body.message,
      });
      if (result.version) broadcast?.("workspace_version", { workspace_id: workspace.id, path: normalizeWorkspacePath(body.path) });
      sendJson(res, 200, result);
      return true;
    }

    if (sub === "/ops" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const op = await requestWorkspaceOp(query, {
          workspace,
          op: String(body.op || ""),
          path: body.path,
          content: typeof body.content === "string" ? body.content : null,
          message: body.message,
          requestedBy: actor,
        });
        sendJson(res, op.status === "done" ? 200 : 502, { op });
      } catch (error) {
        sendJson(res, 409, { error: describeWorkspaceError(error, workspace) });
      }
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}
