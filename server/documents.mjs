// Документы (docs): постраничные тексты формата A4 в редакторе Univer Docs. Живут рядом с таблицами и заметками,
// доступ тот же: владелец, участники проекта, все. Содержимое — снимок Univer (JSON); text_content — тот же
// текст чистым Markdown-подобным видом для поиска и для агентов, которым снимок читать незачем.

import { randomBytes } from "node:crypto";
import mammoth from "mammoth";
import { announceAgentEdit } from "./presence.mjs";
import { appendMarkdown, markdownToSnapshot, snapshotToMarkdown, snapshotToText } from "./doc-snapshot.mjs";
import { documentToDocx, docxFileName, htmlToBlocks } from "./docx.mjs";

export const DOCUMENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  text_content TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT false,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  author TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT,
  access_level TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS text_content TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'private';
UPDATE documents SET owner_user_id = (SELECT id::text FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
 WHERE owner_user_id IS NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'edit';
CREATE TABLE IF NOT EXISTS document_shares (
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_document_shares_user ON document_shares(user_id);
-- Ссылки «по ссылке» (открываются без входа): по одной на режим view/edit у документа, как note_shares у заметок.
CREATE TABLE IF NOT EXISTS document_link_shares (
  token TEXT PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('view', 'edit')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_link_shares_mode ON document_link_shares(document_id, mode);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_user_id);
`;

// В списке содержимого нет: снимок документа весит сотни килобайт, а списку нужны название, дата и фрагмент.
const LIST_COLUMNS = `id::text, title, pinned, project_id::text, author, owner_user_id, access_level, access_mode, created_at::text, updated_at::text,
  octet_length(content) AS size_bytes, left(regexp_replace(text_content, '\\s+', ' ', 'g'), 160) AS snippet`;
const FULL_COLUMNS = `${LIST_COLUMNS}, content`;
const ACCESS_LEVELS = ["private", "project", "all"];
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_DOCX_IMPORT_BYTES = 25 * 1024 * 1024;

export async function ensureDocumentsSchema(query) {
  await query(DOCUMENTS_SCHEMA_SQL);
}

const accessLevel = (value) => (ACCESS_LEVELS.includes(String(value)) ? String(value) : "private");
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

export function scopeWhere(scope, alias = "documents") {
  const projectIds = Array.isArray(scope?.projectIds) ? scope.projectIds : [];
  if (scope?.userId) {
    return {
      sql: `(${alias}.owner_user_id = $1 OR ${alias}.access_level = 'all' OR (${alias}.access_level = 'project' AND ($2::boolean OR ${alias}.project_id = ANY($3::bigint[])))
        OR EXISTS (SELECT 1 FROM document_shares ds WHERE ds.document_id = ${alias}.id AND ds.user_id = $1))`,
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

async function owns(query, documentId, scope) {
  if (!scope?.userId) return Boolean(scope?.all);
  const row = (await query("SELECT owner_user_id FROM documents WHERE id = $1", [documentId])).rows[0];
  return Boolean(row) && row.owner_user_id === String(scope.userId);
}

/**
 * Права на правку: владелец; человек, которому документ выдан поимённо (его роль решает); остальные, кто видит
 * документ по уровню доступа, — по режиму документа (edit | view). Внутренние вызовы без пользователя правят всё.
 */
async function permissionsFor(query, row, scope) {
  if (!scope?.userId) return { is_owner: Boolean(scope?.all), can_edit: true, role: "owner" };
  const uid = String(scope.userId);
  if (row.owner_user_id === uid) return { is_owner: true, can_edit: true, role: "owner" };
  const share = (await query("SELECT role FROM document_shares WHERE document_id = $1 AND user_id = $2", [row.id, uid])).rows[0];
  if (share) return { is_owner: false, can_edit: share.role === "edit", role: share.role };
  return { is_owner: false, can_edit: row.access_mode !== "view", role: row.access_mode === "view" ? "view" : "edit" };
}

/** content приходит снимком-объектом или JSON-строкой; на выходе строка, из которой выведен и текст для поиска. */
function prepareContent(value) {
  const snapshot = typeof value === "string" ? JSON.parse(value) : value;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.body || typeof snapshot.body.dataStream !== "string") throw new Error("invalid_document");
  const content = JSON.stringify(snapshot);
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");
  return { content, snapshot, text: snapshotToMarkdown(snapshot) };
}

/** Блоки Word (заголовки, списки, жирный, курсив) → Markdown, из которого строится снимок документа. */
function blocksToMarkdown(blocks) {
  const inline = (runs) => runs.map((item) => {
    const text = item.text;
    if (!text.trim()) return text;
    if (item.bold && item.italic) return `***${text}***`;
    if (item.bold) return `**${text}**`;
    if (item.italic) return `*${text}*`;
    return text;
  }).join("");
  let number = 0;
  const lines = blocks.map((block) => {
    const text = inline(block.runs).trim();
    if (block.type !== "li" || block.list !== "number") number = 0;
    if (/^h[1-3]$/.test(block.type)) return `${"#".repeat(Number(block.type[1]))} ${block.runs.map((item) => item.text).join("").trim()}`;
    if (block.type === "li") return block.list === "number" ? `${++number}. ${text}` : `- ${text}`;
    return text;
  });
  // Пункты списка идут подряд, остальные блоки разделены пустой строкой.
  return lines.reduce((out, line, index) => out + (index ? (blocks[index].type === "li" && blocks[index - 1].type === "li" ? "\n" : "\n\n") : "") + line, "");
}

async function docxToMarkdown(body) {
  const name = String(body?.name || "Документ.docx");
  if (!/\.docx$/i.test(name)) throw new Error("docx_required");
  const buffer = Buffer.from(String(body?.data || "").replace(/^data:[^,]+,/, ""), "base64");
  if (!buffer.length) throw new Error("empty_docx");
  if (buffer.length > MAX_DOCX_IMPORT_BYTES) throw new Error("docx_too_large");
  const { value } = await mammoth.convertToHtml({ buffer });
  const markdown = blocksToMarkdown(htmlToBlocks(value));
  if (!markdown.trim()) throw new Error("docx_empty_text");
  return { name, title: String(body?.title || name.replace(/\.docx$/i, "")).trim().slice(0, 200), markdown };
}

export async function handleDocumentsApi({ req, res, url, query, readBody, sendJson, actor, scope = { all: true, projectIds: [] }, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/documents")) return false;
  // Правки человека (автосохранение) рассылаем тихо: окна обновятся, а «Агент изменил…» писать не надо.
  const silent = !req.headers["x-mbox-agent"];
  const notify = (action, detail, id) => broadcast?.("entity_changed", { entity: "documents", action, actor: String(actor || ""), detail, id, silent });

  try {
    if (url.pathname === "/api/mbox/documents" && req.method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim();
      const scoped = scopeWhere(scope);
      const n = scoped.values.length + 1;
      const result = await query(
        `SELECT ${LIST_COLUMNS}
         FROM documents
         WHERE (${scoped.sql}) AND ($${n} = '' OR title ILIKE '%' || $${n} || '%' OR text_content ILIKE '%' || $${n} || '%')
         ORDER BY pinned DESC, updated_at DESC
         LIMIT 200`,
        [...scoped.values, q],
      );
      sendJson(res, 200, { documents: result.rows });
      return true;
    }

    if (url.pathname === "/api/mbox/documents/import-docx" && req.method === "POST") {
      const body = await readBody(req);
      if (!hasProjectAccess(scope, body.project_id)) { sendJson(res, 403, { error: "project_access_denied" }); return true; }
      const input = await docxToMarkdown(body);
      const snapshot = markdownToSnapshot(`mbox-doc-${Date.now().toString(36)}`, input.title, input.markdown);
      const result = await query(
        `INSERT INTO documents(title, content, text_content, project_id, author, owner_user_id, access_level)
         VALUES ($1, $2, $3, $4, $5, $6, 'private') RETURNING ${FULL_COLUMNS}`,
        [input.title, JSON.stringify(snapshot), snapshotToMarkdown(snapshot), body.project_id || null, String(actor || ""), scope?.userId || null],
      );
      notify("create", `«${result.rows[0].title}»`, result.rows[0].id);
      sendJson(res, 201, { document: result.rows[0] });
      return true;
    }

    if (url.pathname === "/api/mbox/documents" && req.method === "POST") {
      const body = await readBody(req);
      if (!hasProjectAccess(scope, body.project_id)) { sendJson(res, 403, { error: "project_access_denied" }); return true; }
      const title = String(body.title || "Новый документ").trim().slice(0, 200) || "Новый документ";
      const prepared = body.content
        ? prepareContent(body.content)
        : (() => { const snapshot = markdownToSnapshot(`mbox-doc-${Date.now().toString(36)}`, title, String(body.markdown || "")); return { content: JSON.stringify(snapshot), snapshot, text: snapshotToMarkdown(snapshot) }; })();
      const result = await query(
        `INSERT INTO documents(title, content, text_content, project_id, author, owner_user_id, access_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${FULL_COLUMNS}`,
        [title, prepared.content, prepared.text, body.project_id || null, String(actor || ""), scope?.userId || null, accessLevel(body.access_level)],
      );
      notify("create", `«${result.rows[0].title}»`, result.rows[0].id);
      sendJson(res, 201, { document: result.rows[0] });
      return true;
    }

    // Ссылки на документ: список, создать (или выдать существующую; regenerate — новый токен), отозвать. Только владелец:
    // ссылка открывает документ людям без входа.
    const linksMatch = url.pathname.match(/^\/api\/mbox\/documents\/(\d+)\/links(?:\/(view|edit))?$/);
    if (linksMatch) {
      const [, documentId, modeInPath] = linksMatch;
      if (!(await owns(query, documentId, scope))) { sendJson(res, 403, { error: "only_owner_shares" }); return true; }
      if (req.method === "GET") {
        sendJson(res, 200, { links: (await query("SELECT token, mode, created_by, created_at::text, last_used_at::text FROM document_link_shares WHERE document_id = $1 ORDER BY mode", [documentId])).rows });
        return true;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const mode = body.mode === "edit" ? "edit" : "view";
        if (body.regenerate) await query("DELETE FROM document_link_shares WHERE document_id = $1 AND mode = $2", [documentId, mode]);
        const existing = (await query("SELECT token, mode, created_by, created_at::text, last_used_at::text FROM document_link_shares WHERE document_id = $1 AND mode = $2", [documentId, mode])).rows[0];
        if (existing) { sendJson(res, 200, { link: existing }); return true; }
        const row = (await query(
          "INSERT INTO document_link_shares(token, document_id, mode, created_by) VALUES ($1, $2, $3, $4) RETURNING token, mode, created_by, created_at::text, last_used_at::text",
          [randomBytes(24).toString("base64url"), documentId, mode, String(actor || "")],
        )).rows[0];
        sendJson(res, 201, { link: row });
        return true;
      }
      if (req.method === "DELETE" && modeInPath) {
        await query("DELETE FROM document_link_shares WHERE document_id = $1 AND mode = $2", [documentId, modeInPath]);
        sendJson(res, 200, { ok: true });
        return true;
      }
      return false;
    }

    const sharesMatch = url.pathname.match(/^\/api\/mbox\/documents\/(\d+)\/shares$/);
    if (sharesMatch) {
      if (!(await owns(query, sharesMatch[1], scope))) { sendJson(res, 403, { error: "only_owner_shares" }); return true; }
      if (req.method === "GET") {
        const rows = (await query(
          `SELECT ds.user_id, ds.role, u.username FROM document_shares ds LEFT JOIN users u ON u.id::text = ds.user_id WHERE ds.document_id = $1 ORDER BY lower(u.username)`,
          [sharesMatch[1]],
        )).rows;
        sendJson(res, 200, { shares: rows });
        return true;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        const userId = String(body.user_id || "");
        if (!/^\d+$/.test(userId)) { sendJson(res, 400, { error: "user_required" }); return true; }
        if (body.role === null || body.role === "none") {
          await query("DELETE FROM document_shares WHERE document_id = $1 AND user_id = $2", [sharesMatch[1], userId]);
        } else {
          const role = body.role === "edit" ? "edit" : "view";
          if (!(await query("SELECT 1 FROM users WHERE id = $1", [userId])).rows[0]) { sendJson(res, 404, { error: "user_not_found" }); return true; }
          await query(
            `INSERT INTO document_shares(document_id, user_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [sharesMatch[1], userId, role],
          );
        }
        broadcast?.("entity_changed", { entity: "documents", action: "share", actor: String(actor || ""), id: sharesMatch[1], silent: true });
        sendJson(res, 200, { ok: true });
        return true;
      }
      return false;
    }

    const match = url.pathname.match(/^\/api\/mbox\/documents\/(\d+)(\/docx)?$/);
    if (!match) return false;
    const scoped = scopeWhere(scope);
    const existing = (await query(`SELECT ${FULL_COLUMNS}, text_content FROM documents WHERE id = $${scoped.values.length + 1} AND (${scoped.sql})`, [...scoped.values, match[1]])).rows[0];
    if (!existing) { sendJson(res, 404, { error: "not_found" }); return true; }

    if (match[2]) {
      if (req.method !== "GET") return false;
      const file = documentToDocx({ content: existing.text_content, name: `${existing.title || `document-${match[1]}`}.md`, title: existing.title || "Документ" });
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-length": file.length,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(docxFileName(existing.title || `document-${match[1]}`))}`,
      });
      res.end(file);
      return true;
    }

    const permissions = await permissionsFor(query, existing, scope);

    if (req.method === "GET") {
      const { text_content: markdown, ...rawDocument } = existing;
      const document = { ...rawDocument, ...permissions };
      // format=markdown — для агентов: Markdown вместо снимка, который им читать незачем.
      if (url.searchParams.get("format") === "markdown") {
        const { content: _content, ...light } = document;
        sendJson(res, 200, { document: light, markdown });
        return true;
      }
      sendJson(res, 200, { document });
      return true;
    }

    if ((req.method === "PATCH" || req.method === "DELETE") && !permissions.can_edit) { sendJson(res, 403, { error: "read_only" }); return true; }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (has(body, "project_id") && !hasProjectAccess(scope, body.project_id)) { sendJson(res, 403, { error: "project_access_denied" }); return true; }
      if ((has(body, "access_level") || has(body, "project_id") || has(body, "access_mode")) && !(await owns(query, match[1], scope))) { sendJson(res, 403, { error: "only_owner_changes_access" }); return true; }
      if (has(body, "content") && body.base_updated_at && String(body.base_updated_at) !== existing.updated_at) {
        sendJson(res, 409, { error: "conflict", updated_at: existing.updated_at });
        return true;
      }
      let prepared = null;
      if (has(body, "content")) prepared = prepareContent(body.content);
      else if (has(body, "markdown")) {
        const markdown = String(body.markdown || "");
        const base = JSON.parse(existing.content || "null");
        const append = body.mode === "append" && base?.body;
        const snapshot = append ? appendMarkdown(base, markdown) : markdownToSnapshot(base?.id || `mbox-doc-${match[1]}`, existing.title, markdown);
        // Заменяя текст, оставляем поля страницы прежними: человек мог поменять поля и ориентацию.
        if (!append && base?.documentStyle) snapshot.documentStyle = base.documentStyle;
        prepared = { content: JSON.stringify(snapshot), snapshot, text: snapshotToMarkdown(snapshot) };
      }
      const hasProject = has(body, "project_id");
      const result = await query(
        `UPDATE documents SET
          title = COALESCE($1, title),
          content = COALESCE($2, content),
          text_content = COALESCE($3, text_content),
          pinned = COALESCE($4, pinned),
          project_id = CASE WHEN $8::boolean THEN $5 ELSE project_id END,
          access_level = COALESCE($6, access_level),
          access_mode = COALESCE($9, access_mode),
          updated_at = now()
         WHERE id = $7
         RETURNING ${FULL_COLUMNS}`,
        [
          has(body, "title") ? String(body.title || "").trim().slice(0, 200) || "Документ" : null,
          prepared?.content ?? null,
          prepared?.text ?? null,
          has(body, "pinned") ? Boolean(body.pinned) : null,
          hasProject ? body.project_id || null : null,
          has(body, "access_level") ? accessLevel(body.access_level) : null,
          match[1],
          hasProject,
          has(body, "access_mode") ? (body.access_mode === "view" ? "view" : "edit") : null,
        ],
      );
      notify("update", `«${result.rows[0].title}»`, result.rows[0].id);
      // Текст через Markdown пишет агент (человек правит снимком из редактора): показываем его присутствие.
      if (has(body, "markdown")) announceAgentEdit(broadcast, { doc: `doc:${result.rows[0].id}`, name: actor });
      sendJson(res, 200, { document: result.rows[0] });
      return true;
    }

    if (req.method === "DELETE") {
      if (!(await owns(query, match[1], scope))) { sendJson(res, 403, { error: "only_owner_deletes" }); return true; }
      await query("DELETE FROM documents WHERE id = $1", [match[1]]);
      notify("delete", `#${match[1]}`, match[1]);
      sendJson(res, 200, { ok: true });
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}

const SHARE_TOKEN = /^[A-Za-z0-9_-]{24,64}$/;
const UNIVER_DOCUMENT_MIME = "application/vnd.mbox.univer-doc+json";

/**
 * Документ по ссылке (/d/<токен>, страница SharedDocumentPage): без входа в MBOX. GET отдаёт снимок документа и режим,
 * PATCH (только у ссылки на правку) сохраняет снимок из редактора. Токен — единственное, что даёт доступ.
 */
export async function handleSharedDocumentApi({ req, res, url, query, readBody, sendJson, broadcast }) {
  const match = url.pathname.match(/^\/api\/share\/documents\/([^/]+)$/);
  if (!match) return false;
  const token = match[1];
  try {
    if (!SHARE_TOKEN.test(token)) { sendJson(res, 404, { error: "Ссылка недействительна" }); return true; }
    const link = (await query("SELECT document_id::text AS document_id, mode FROM document_link_shares WHERE token = $1", [token])).rows[0];
    if (!link) { sendJson(res, 404, { error: "Ссылка отозвана или документ удалён" }); return true; }
    const shaped = (row) => ({ id: row.id, title: row.title, content: row.content, mime_type: UNIVER_DOCUMENT_MIME, updated_at: row.updated_at });
    const columns = "id::text, title, content, updated_at::text";

    if (req.method === "GET") {
      await query("UPDATE document_link_shares SET last_used_at = now() WHERE token = $1", [token]).catch(() => {});
      const row = (await query(`SELECT ${columns} FROM documents WHERE id = $1`, [link.document_id])).rows[0];
      if (!row) { sendJson(res, 404, { error: "Документ удалён" }); return true; }
      sendJson(res, 200, { mode: link.mode, document: shaped(row) });
      return true;
    }

    if (req.method === "PATCH") {
      if (link.mode !== "edit") { sendJson(res, 403, { error: "Ссылка только для просмотра" }); return true; }
      const body = await readBody(req);
      if (!has(body, "content")) { sendJson(res, 400, { error: "content_required" }); return true; }
      const prepared = prepareContent(body.content);
      const row = (await query(
        `UPDATE documents SET content = $1, text_content = $2, title = COALESCE($3, title), updated_at = now() WHERE id = $4 RETURNING ${columns}`,
        [prepared.content, prepared.text, has(body, "title") ? String(body.title || "").trim().slice(0, 200) || "Документ" : null, link.document_id],
      )).rows[0];
      if (!row) { sendJson(res, 404, { error: "Документ удалён" }); return true; }
      broadcast?.("entity_changed", { entity: "documents", action: "update", actor: "ссылка", id: row.id, silent: true });
      sendJson(res, 200, { document: shaped(row) });
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}

export { snapshotToText };
