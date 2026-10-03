import { randomBytes } from "node:crypto";
import { documentToDocx } from "./docx.mjs";

export const DOCUMENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pinned BOOLEAN NOT NULL DEFAULT false,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  author TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT,
  access_level TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_user_id);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'private';
UPDATE documents SET owner_user_id = users.id::text FROM users
 WHERE documents.owner_user_id IS NULL AND lower(users.username) = lower(documents.author);
UPDATE documents SET owner_user_id = (SELECT id::text FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
 WHERE owner_user_id IS NULL;
CREATE TABLE IF NOT EXISTS document_shares (
  token TEXT PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('view', 'edit')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_shares_mode ON document_shares(document_id, mode);
`;

const COLUMNS = `id::text, title, content, mime_type, pinned, project_id::text, author, owner_user_id, access_level, created_at::text, updated_at::text, octet_length(content) AS size_bytes`;
const MAX_BYTES = 25 * 1024 * 1024;
const ACCESS_LEVELS = ["private", "project", "all"];
const SHARE_TOKEN = /^[A-Za-z0-9_-]{24,64}$/;

export async function ensureDocumentsSchema(query) {
  await query(DOCUMENTS_SCHEMA_SQL);
}

function scopeWhere(scope, alias = "documents") {
  const projects = Array.isArray(scope?.projectIds) ? scope.projectIds : [];
  if (scope?.userId) return { sql: `(${alias}.owner_user_id = $1 OR ${alias}.access_level = 'all' OR (${alias}.access_level = 'project' AND ($2::boolean OR ${alias}.project_id = ANY($3::bigint[]))))`, values: [String(scope.userId), Boolean(scope.all), projects] };
  if (!scope || scope.all) return { sql: "TRUE", values: [] };
  return { sql: `${alias}.project_id = ANY($1::bigint[])`, values: [projects] };
}

function canUseProject(scope, projectId) {
  return !projectId || scope?.all || scope?.projectIds?.includes(String(projectId));
}

function accessLevel(value) { return ACCESS_LEVELS.includes(String(value)) ? String(value) : "private"; }

async function ownsDocument(query, documentId, scope) {
  if (!scope?.userId) return Boolean(scope?.all);
  const row = (await query("SELECT owner_user_id FROM documents WHERE id = $1", [documentId])).rows[0];
  return Boolean(row) && row.owner_user_id === String(scope.userId);
}

function cleanContent(value) {
  const content = String(value || "");
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new Error("document_too_large");
  return content;
}

export async function handleDocumentsApi({ req, res, url, query, readBody, sendJson, actor, scope = { all: true, projectIds: [] }, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/documents")) return false;
  const notify = (action, detail) => broadcast?.("entity_changed", { entity: "documents", action, actor: String(actor || ""), detail });
  try {
    const shareMatch = url.pathname.match(/^\/api\/mbox\/documents\/(\d+)\/shares(?:\/(view|edit))?$/);
    if (shareMatch) {
      const [, documentId, modeInPath] = shareMatch;
      const scoped = scopeWhere(scope);
      const existing = (await query(`SELECT id FROM documents WHERE id = $${scoped.values.length + 1} AND (${scoped.sql})`, [...scoped.values, documentId])).rows[0];
      if (!existing) { sendJson(res, 404, { error: "not_found" }); return true; }
      if (req.method === "GET") { sendJson(res, 200, { shares: (await query("SELECT token, mode, created_at::text, last_used_at::text FROM document_shares WHERE document_id = $1 ORDER BY mode", [documentId])).rows }); return true; }
      if (!(await ownsDocument(query, documentId, scope))) { sendJson(res, 403, { error: "only_owner_shares" }); return true; }
      if (req.method === "POST") {
        const body = await readBody(req);
        const mode = body.mode === "edit" ? "edit" : "view";
        if (body.regenerate) await query("DELETE FROM document_shares WHERE document_id = $1 AND mode = $2", [documentId, mode]);
        const present = (await query("SELECT token, mode, created_at::text, last_used_at::text FROM document_shares WHERE document_id = $1 AND mode = $2", [documentId, mode])).rows[0];
        if (present) { sendJson(res, 200, { share: present }); return true; }
        const share = (await query("INSERT INTO document_shares(token, document_id, mode, created_by) VALUES ($1, $2, $3, $4) RETURNING token, mode, created_at::text, last_used_at::text", [randomBytes(24).toString("base64url"), documentId, mode, String(actor || "")])).rows[0];
        sendJson(res, 201, { share }); return true;
      }
      if (req.method === "DELETE" && modeInPath) { await query("DELETE FROM document_shares WHERE document_id = $1 AND mode = $2", [documentId, modeInPath]); sendJson(res, 200, { ok: true }); return true; }
    }
    if (url.pathname === "/api/mbox/documents" && req.method === "GET") {
      const text = String(url.searchParams.get("q") || "").trim();
      const scoped = scopeWhere(scope);
      const result = await query(`SELECT ${COLUMNS} FROM documents WHERE (${scoped.sql}) AND ($${scoped.values.length + 1} = '' OR title ILIKE '%' || $${scoped.values.length + 1} || '%') ORDER BY pinned DESC, updated_at DESC LIMIT 200`, [...scoped.values, text]);
      sendJson(res, 200, { documents: result.rows });
      return true;
    }
    if (url.pathname === "/api/mbox/documents" && req.method === "POST") {
      const body = await readBody(req);
      if (!canUseProject(scope, body.project_id)) { sendJson(res, 403, { error: "project_access_denied" }); return true; }
      const title = String(body.title || "Новый документ").trim().slice(0, 200) || "Новый документ";
      const content = Object.prototype.hasOwnProperty.call(body, "content")
        ? cleanContent(body.content)
        : documentToDocx({ content: "", title }).toString("base64");
      const result = await query(
        `INSERT INTO documents(title, content, mime_type, project_id, author, owner_user_id, access_level) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [title, content, String(body.mime_type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document").slice(0, 160), body.project_id || null, String(actor || ""), scope?.userId || null, accessLevel(body.access_level)],
      );
      notify("create", `«${result.rows[0].title}»`);
      sendJson(res, 201, { document: result.rows[0] });
      return true;
    }
    const match = url.pathname.match(/^\/api\/mbox\/documents\/(\d+)$/);
    if (!match) return false;
    const scoped = scopeWhere(scope);
    const current = (await query(`SELECT ${COLUMNS} FROM documents WHERE id = $${scoped.values.length + 1} AND (${scoped.sql})`, [...scoped.values, match[1]])).rows[0];
    if (!current) { sendJson(res, 404, { error: "not_found" }); return true; }
    if (req.method === "GET") { sendJson(res, 200, { document: current }); return true; }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (Object.prototype.hasOwnProperty.call(body, "project_id") && !canUseProject(scope, body.project_id)) { sendJson(res, 403, { error: "project_access_denied" }); return true; }
      if ((Object.prototype.hasOwnProperty.call(body, "project_id") || Object.prototype.hasOwnProperty.call(body, "access_level")) && !(await ownsDocument(query, match[1], scope))) { sendJson(res, 403, { error: "only_owner_changes_access" }); return true; }
      const hasProject = Object.prototype.hasOwnProperty.call(body, "project_id");
      const updated = (await query(
        `UPDATE documents SET title = COALESCE($1, title), content = COALESCE($2, content), mime_type = COALESCE($3, mime_type), pinned = COALESCE($4, pinned), project_id = CASE WHEN $7::boolean THEN $5 ELSE project_id END, access_level = COALESCE($6, access_level), updated_at = now() WHERE id = $8 RETURNING ${COLUMNS}`,
        [Object.prototype.hasOwnProperty.call(body, "title") ? String(body.title || "").trim().slice(0, 200) : null, Object.prototype.hasOwnProperty.call(body, "content") ? cleanContent(body.content) : null, Object.prototype.hasOwnProperty.call(body, "mime_type") ? String(body.mime_type || "").slice(0, 160) : null, Object.prototype.hasOwnProperty.call(body, "pinned") ? Boolean(body.pinned) : null, hasProject ? body.project_id || null : null, Object.prototype.hasOwnProperty.call(body, "access_level") ? accessLevel(body.access_level) : null, hasProject, match[1]],
      )).rows[0];
      notify("update", `«${updated.title}»`);
      sendJson(res, 200, { document: updated });
      return true;
    }
    if (req.method === "DELETE") {
      if (!scope.all && current.owner_user_id !== String(scope.userId)) { sendJson(res, 403, { error: "only_owner_deletes" }); return true; }
      await query("DELETE FROM documents WHERE id = $1", [match[1]]);
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

/** Публичная ссылка документа: токен определяет просмотр либо правку без входа в MBOX. */
export async function handleSharedDocumentApi({ req, res, url, query, readBody, sendJson, broadcast }) {
  const match = url.pathname.match(/^\/api\/share\/documents\/([^/]+)$/);
  if (!match) return false;
  const token = match[1];
  try {
    if (!SHARE_TOKEN.test(token)) { sendJson(res, 404, { error: "Ссылка недействительна" }); return true; }
    const share = (await query("SELECT s.mode, d.id::text AS document_id FROM document_shares s JOIN documents d ON d.id = s.document_id WHERE s.token = $1", [token])).rows[0];
    if (!share) { sendJson(res, 404, { error: "Ссылка отозвана или документ удалён" }); return true; }
    const document = (await query(`SELECT ${COLUMNS} FROM documents WHERE id = $1`, [share.document_id])).rows[0];
    if (!document) { sendJson(res, 404, { error: "Документ не найден" }); return true; }
    if (req.method === "GET") { await query("UPDATE document_shares SET last_used_at = now() WHERE token = $1", [token]).catch(() => {}); sendJson(res, 200, { mode: share.mode, document }); return true; }
    if (req.method === "PATCH") {
      if (share.mode !== "edit") { sendJson(res, 403, { error: "Ссылка только для просмотра" }); return true; }
      const body = await readBody(req);
      const updated = (await query(`UPDATE documents SET title = $1, content = $2, mime_type = $3, updated_at = now() WHERE id = $4 RETURNING ${COLUMNS}`, [String(body.title || document.title).trim().slice(0, 200) || "Документ", Object.prototype.hasOwnProperty.call(body, "content") ? cleanContent(body.content) : document.content, Object.prototype.hasOwnProperty.call(body, "mime_type") ? String(body.mime_type || document.mime_type).slice(0, 160) : document.mime_type, share.document_id])).rows[0];
      broadcast?.("entity_changed", { entity: "documents", action: "update", detail: `#${share.document_id}` });
      sendJson(res, 200, { document: updated }); return true;
    }
  } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); return true; }
  return false;
}
