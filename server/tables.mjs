import { randomBytes } from "node:crypto";
import { appendRows, loadWorkbook, readTable, workbookFromRows, workbookToBase64, writeCells } from "./table-ops.mjs";

export const TABLES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tables (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT false,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  author TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT,
  access_level TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tables ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'private';
UPDATE tables SET owner_user_id = users.id::text FROM users
 WHERE tables.owner_user_id IS NULL AND lower(users.username) = lower(tables.author);
UPDATE tables SET owner_user_id = (SELECT id::text FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
 WHERE owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tables_updated ON tables(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tables_owner ON tables(owner_user_id);
CREATE TABLE IF NOT EXISTS table_shares (
  token TEXT PRIMARY KEY,
  table_id BIGINT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('view', 'edit')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_table_shares_mode ON table_shares(table_id, mode);
`;

const TABLE_COLUMNS = `id::text, title, content, pinned, project_id::text, author, owner_user_id, access_level, created_at::text, updated_at::text,
  octet_length(content) AS size_bytes`;
const ACCESS_LEVELS = ["private", "project", "all"];
const MAX_TABLE_BYTES = 25 * 1024 * 1024;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{24,64}$/;

export async function ensureTablesSchema(query) {
  await query(TABLES_SCHEMA_SQL);
}

function accessLevel(value) {
  return ACCESS_LEVELS.includes(String(value)) ? String(value) : "private";
}

function tableScopeWhere(scope, alias = "tables") {
  const projectIds = Array.isArray(scope?.projectIds) ? scope.projectIds : [];
  if (scope?.userId) {
    return {
      sql: `(${alias}.owner_user_id = $1 OR ${alias}.access_level = 'all' OR (${alias}.access_level = 'project' AND ($2::boolean OR ${alias}.project_id = ANY($3::bigint[]))))`,
      values: [String(scope.userId), Boolean(scope.all), projectIds],
    };
  }
  if (!scope || scope.all) return { sql: "TRUE", values: [] };
  return { sql: `${alias}.project_id = ANY($1::bigint[])`, values: [projectIds] };
}

function hasProjectAccess(scope, projectId) {
  if (!scope || scope.all) return true;
  return projectId != null && scope.projectIds.includes(String(projectId));
}

async function ownsTable(query, tableId, scope) {
  if (!scope?.userId) return Boolean(scope?.all);
  const row = (await query("SELECT owner_user_id FROM tables WHERE id = $1", [tableId])).rows[0];
  return Boolean(row) && row.owner_user_id === String(scope.userId);
}

function cleanContent(value) {
  const content = String(value || "");
  if (Buffer.byteLength(content, "utf8") > MAX_TABLE_BYTES) throw new Error("table_too_large");
  return content;
}

export async function handleTablesApi({ req, res, url, query, readBody, sendJson, actor, scope = { all: true, projectIds: [] }, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/tables")) return false;
  const notify = (action, detail) => broadcast?.("entity_changed", { entity: "tables", action, actor: String(actor || ""), detail });

  try {
    const shareMatch = url.pathname.match(/^\/api\/mbox\/tables\/(\d+)\/shares(?:\/(view|edit))?$/);
    if (shareMatch) {
      const [, tableId, modeInPath] = shareMatch;
      const scoped = tableScopeWhere(scope, "tables");
      const existing = (await query(`SELECT id FROM tables WHERE id = $${scoped.values.length + 1} AND (${scoped.sql})`, [...scoped.values, tableId])).rows[0];
      if (!existing) { sendJson(res, 404, { error: "not_found" }); return true; }
      if (req.method === "GET") {
        sendJson(res, 200, { shares: (await query("SELECT token, mode, created_by, created_at::text, last_used_at::text FROM table_shares WHERE table_id = $1 ORDER BY mode", [tableId])).rows });
        return true;
      }
      if (!(await ownsTable(query, tableId, scope))) { sendJson(res, 403, { error: "only_owner_shares" }); return true; }
      if (req.method === "POST") {
        const body = await readBody(req);
        const mode = body.mode === "edit" ? "edit" : "view";
        if (body.regenerate) await query("DELETE FROM table_shares WHERE table_id = $1 AND mode = $2", [tableId, mode]);
        const present = (await query("SELECT token, mode, created_by, created_at::text, last_used_at::text FROM table_shares WHERE table_id = $1 AND mode = $2", [tableId, mode])).rows[0];
        if (present) { sendJson(res, 200, { share: present }); return true; }
        const share = (await query(
          "INSERT INTO table_shares(token, table_id, mode, created_by) VALUES ($1, $2, $3, $4) RETURNING token, mode, created_by, created_at::text, last_used_at::text",
          [randomBytes(24).toString("base64url"), tableId, mode, String(actor || "")],
        )).rows[0];
        sendJson(res, 201, { share });
        return true;
      }
      if (req.method === "DELETE" && modeInPath) {
        await query("DELETE FROM table_shares WHERE table_id = $1 AND mode = $2", [tableId, modeInPath]);
        sendJson(res, 200, { ok: true });
        return true;
      }
    }
    if (url.pathname === "/api/mbox/tables" && req.method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim();
      const scoped = tableScopeWhere(scope, "tables");
      const result = await query(
        `SELECT ${TABLE_COLUMNS}
         FROM tables
         WHERE (${scoped.sql}) AND ($${scoped.values.length + 1} = '' OR title ILIKE '%' || $${scoped.values.length + 1} || '%')
         ORDER BY pinned DESC, updated_at DESC
         LIMIT 200`,
        [...scoped.values, q],
      );
      sendJson(res, 200, { tables: result.rows });
      return true;
    }

    if (url.pathname === "/api/mbox/tables" && req.method === "POST") {
      const body = await readBody(req);
      if (!hasProjectAccess(scope, body.project_id)) { sendJson(res, 403, { error: "project_access_denied" }); return true; }
      // rows — таблица из двумерного массива (агенты): первая строка заголовки, если headers не false.
      const content = !body.content && Array.isArray(body.rows) ? await workbookFromRows(body.rows, { sheet: body.sheet, headers: body.headers !== false }) : body.content;
      const result = await query(
        `INSERT INTO tables(title, content, project_id, author, owner_user_id, access_level)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${TABLE_COLUMNS}`,
        [
          String(body.title || "Новая таблица").trim().slice(0, 200) || "Новая таблица",
          cleanContent(content),
          body.project_id || null,
          String(actor || ""),
          scope?.userId || null,
          accessLevel(body.access_level),
        ],
      );
      notify("create", `«${result.rows[0].title}»`);
      sendJson(res, 201, { table: result.rows[0] });
      return true;
    }

    // Операции агентов: читать диапазон, писать ячейки и оформление, дописывать строки. Работают с xlsx в базе.
    const opsMatch = url.pathname.match(/^\/api\/mbox\/tables\/(\d+)\/(cells|rows)$/);
    if (opsMatch) {
      const [, tableId, operation] = opsMatch;
      const scopedOps = tableScopeWhere(scope, "tables");
      const row = (await query(`SELECT id::text, title, content FROM tables WHERE id = $${scopedOps.values.length + 1} AND (${scopedOps.sql})`, [...scopedOps.values, tableId])).rows[0];
      if (!row) { sendJson(res, 404, { error: "not_found" }); return true; }
      if (operation === "cells" && req.method === "GET") {
        const book = await loadWorkbook(row.content);
        sendJson(res, 200, { table: { id: row.id, title: row.title }, ...readTable(book, { sheet: url.searchParams.get("sheet") || undefined, range: url.searchParams.get("range") || undefined, styles: url.searchParams.get("styles") === "1" }) });
        return true;
      }
      if ((operation === "cells" && req.method === "PATCH") || (operation === "rows" && req.method === "POST")) {
        const body = await readBody(req);
        const book = await loadWorkbook(row.content);
        const result = operation === "cells" ? writeCells(book, body) : appendRows(book, body);
        const saved = (await query(`UPDATE tables SET content = $1, updated_at = now() WHERE id = $2 RETURNING ${TABLE_COLUMNS}`, [cleanContent(await workbookToBase64(book)), tableId])).rows[0];
        notify("update", `«${saved.title}»`);
        sendJson(res, 200, { ...result, table: { id: saved.id, title: saved.title, updated_at: saved.updated_at } });
        return true;
      }
      return false;
    }

    const match = url.pathname.match(/^\/api\/mbox\/tables\/(\d+)$/);
    if (!match) return false;
    const scoped = tableScopeWhere(scope, "tables");
    const existing = (await query(`SELECT ${TABLE_COLUMNS} FROM tables WHERE id = $${scoped.values.length + 1} AND (${scoped.sql})`, [...scoped.values, match[1]])).rows[0];
    if (!existing) { sendJson(res, 404, { error: "not_found" }); return true; }

    if (req.method === "GET") {
      sendJson(res, 200, { table: existing });
      return true;
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (Object.prototype.hasOwnProperty.call(body, "project_id") && !hasProjectAccess(scope, body.project_id)) { sendJson(res, 403, { error: "project_access_denied" }); return true; }
      if ((Object.prototype.hasOwnProperty.call(body, "access_level") || Object.prototype.hasOwnProperty.call(body, "project_id")) && !(await ownsTable(query, match[1], scope))) {
        sendJson(res, 403, { error: "only_owner_changes_access" });
        return true;
      }
      // Правка поверх версии, которую человек не видел (агент или коллега успели записать раньше), — не молча затираем.
      if (Object.prototype.hasOwnProperty.call(body, "content") && body.base_updated_at && String(body.base_updated_at) !== existing.updated_at) {
        sendJson(res, 409, { error: "conflict", updated_at: existing.updated_at });
        return true;
      }
      const hasProject = Object.prototype.hasOwnProperty.call(body, "project_id");
      const result = await query(
        `UPDATE tables SET
          title = COALESCE($1, title),
          content = COALESCE($2, content),
          pinned = COALESCE($3, pinned),
          project_id = CASE WHEN $7::boolean THEN $4 ELSE project_id END,
          access_level = COALESCE($5, access_level),
          updated_at = now()
         WHERE id = $6
         RETURNING ${TABLE_COLUMNS}`,
        [
          Object.prototype.hasOwnProperty.call(body, "title") ? String(body.title || "").trim().slice(0, 200) : null,
          Object.prototype.hasOwnProperty.call(body, "content") ? cleanContent(body.content) : null,
          Object.prototype.hasOwnProperty.call(body, "pinned") ? Boolean(body.pinned) : null,
          hasProject ? body.project_id || null : null,
          Object.prototype.hasOwnProperty.call(body, "access_level") ? accessLevel(body.access_level) : null,
          match[1],
          hasProject,
        ],
      );
      notify("update", `«${result.rows[0].title}»`);
      sendJson(res, 200, { table: result.rows[0] });
      return true;
    }

    if (req.method === "DELETE") {
      if (!(await ownsTable(query, match[1], scope))) { sendJson(res, 403, { error: "only_owner_deletes" }); return true; }
      await query("DELETE FROM tables WHERE id = $1", [match[1]]);
      notify("delete", `#${match[1]}`);
      sendJson(res, 200, { ok: true });
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }

  return false;
}

/** Публичная ссылка на таблицу: токен определяет просмотр либо правку без входа в MBOX. */
export async function handleSharedTableApi({ req, res, url, query, readBody, sendJson, broadcast }) {
  const match = url.pathname.match(/^\/api\/share\/tables\/([^/]+)$/);
  if (!match) return false;
  const token = match[1];
  try {
    if (!SHARE_TOKEN.test(token)) { sendJson(res, 404, { error: "Ссылка недействительна" }); return true; }
    const share = (await query(
      "SELECT s.mode, t.id::text AS table_id FROM table_shares s JOIN tables t ON t.id = s.table_id WHERE s.token = $1",
      [token],
    )).rows[0];
    if (!share) { sendJson(res, 404, { error: "Ссылка отозвана или таблица удалена" }); return true; }
    const table = (await query(`SELECT ${TABLE_COLUMNS} FROM tables WHERE id = $1`, [share.table_id])).rows[0];
    if (!table) { sendJson(res, 404, { error: "Таблица не найдена" }); return true; }
    if (req.method === "GET") {
      await query("UPDATE table_shares SET last_used_at = now() WHERE token = $1", [token]).catch(() => {});
      sendJson(res, 200, { mode: share.mode, table });
      return true;
    }
    if (req.method === "PATCH") {
      if (share.mode !== "edit") { sendJson(res, 403, { error: "Ссылка только для просмотра" }); return true; }
      const body = await readBody(req);
      const base = String(body.base_updated_at || "");
      if (base && table.updated_at !== base) { sendJson(res, 409, { error: "conflict", table }); return true; }
      const content = Object.prototype.hasOwnProperty.call(body, "content") ? cleanContent(body.content) : table.content;
      const title = Object.prototype.hasOwnProperty.call(body, "title") ? String(body.title || "").trim().slice(0, 200) || "Таблица" : table.title;
      const updated = (await query(
        `UPDATE tables SET title = $1, content = $2, updated_at = now() WHERE id = $3 RETURNING ${TABLE_COLUMNS}`,
        [title, content, share.table_id],
      )).rows[0];
      broadcast?.("entity_changed", { entity: "tables", action: "update", detail: `#${share.table_id}` });
      sendJson(res, 200, { table: updated });
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}
