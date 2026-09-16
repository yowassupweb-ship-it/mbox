// Заметки — свои короткие записи человека (не память агентов): быстро записать, найти, закрепить.
// Общий модуль для прод-сервера и dev-API в vite.config.ts, таблица создаётся при старте.

export const NOTES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT false,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  author TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(pinned DESC, updated_at DESC);
`;

const NOTE_COLUMNS = `id::text, title, content, pinned, project_id::text, tags, author, created_at::text, updated_at::text,
  octet_length(content) AS size_bytes`;

export async function ensureNotesSchema(query) {
  await query(NOTES_SCHEMA_SQL);
}

function titleFrom(content) {
  const line = String(content || "").split("\n").map((item) => item.replace(/^#+\s*/, "").trim()).find(Boolean) || "";
  return line.slice(0, 200);
}

export async function listNotes(query, search = "", limit = 200) {
  const q = String(search || "").trim();
  return (await query(
    `SELECT id::text, title, left(content, 400) AS snippet, pinned, project_id::text, tags, author, created_at::text, updated_at::text,
            octet_length(content) AS size_bytes
     FROM notes
     WHERE $1 = '' OR title ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%' OR array_to_string(tags, ' ') ILIKE '%' || $1 || '%'
     ORDER BY pinned DESC, updated_at DESC
     LIMIT $2`,
    [q, Math.min(Math.max(Number(limit) || 200, 1), 500)],
  )).rows;
}

export async function createNote(query, { title, content, project_id: projectId, tags, author }) {
  const text = String(content ?? "");
  return (await query(
    `INSERT INTO notes(title, content, project_id, tags, author) VALUES ($1, $2, $3, $4, $5) RETURNING ${NOTE_COLUMNS}`,
    [String(title || "").trim() || titleFrom(text), text, projectId || null, Array.isArray(tags) ? tags.map(String) : [], String(author || "")],
  )).rows[0];
}

export async function handleNotesApi({ req, res, url, query, readBody, sendJson, actor, allowed }) {
  if (!url.pathname.startsWith("/api/mbox/notes")) return false;
  if (!allowed) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }
  try {
    if (url.pathname === "/api/mbox/notes" && req.method === "GET") {
      sendJson(res, 200, { notes: await listNotes(query, url.searchParams.get("q") || "", url.searchParams.get("limit")) });
      return true;
    }
    if (url.pathname === "/api/mbox/notes" && req.method === "POST") {
      const body = await readBody(req);
      sendJson(res, 201, { note: await createNote(query, { ...body, author: actor }) });
      return true;
    }
    const match = url.pathname.match(/^\/api\/mbox\/notes\/(\d+)$/);
    if (!match) return false;
    if (req.method === "GET") {
      const row = (await query(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = $1`, [match[1]])).rows[0];
      sendJson(res, row ? 200 : 404, row ? { note: row } : { error: "not_found" });
      return true;
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const has = (field) => Object.prototype.hasOwnProperty.call(body, field);
      const content = has("content") ? String(body.content ?? "") : null;
      const row = (await query(
        `UPDATE notes SET
           content = COALESCE($1, content),
           title = CASE WHEN $2::boolean THEN $3 WHEN $1 IS NOT NULL THEN $4 ELSE title END,
           pinned = COALESCE($5, pinned),
           project_id = CASE WHEN $6::boolean THEN $7::bigint ELSE project_id END,
           tags = COALESCE($8, tags),
           updated_at = CASE WHEN $1 IS NOT NULL OR $2::boolean OR $6::boolean OR $8 IS NOT NULL THEN now() ELSE updated_at END
         WHERE id = $9
         RETURNING ${NOTE_COLUMNS}`,
        [
          content,
          has("title") && String(body.title || "").trim() !== "",
          String(body.title || "").trim(),
          titleFrom(content),
          typeof body.pinned === "boolean" ? body.pinned : null,
          has("project_id"),
          body.project_id || null,
          Array.isArray(body.tags) ? body.tags.map(String) : null,
          match[1],
        ],
      )).rows[0];
      sendJson(res, row ? 200 : 404, row ? { note: row } : { error: "not_found" });
      return true;
    }
    if (req.method === "DELETE") {
      await query("DELETE FROM notes WHERE id = $1", [match[1]]);
      sendJson(res, 200, { ok: true });
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}
