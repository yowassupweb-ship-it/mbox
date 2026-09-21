import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

// Заметки — свои короткие записи человека (не память агентов): быстро записать, найти, закрепить.
// Общий модуль для прод-сервера и dev-API в vite.config.ts, таблица создаётся при старте.

export const NOTES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  tabs JSONB NOT NULL DEFAULT '[]'::jsonb,
  pinned BOOLEAN NOT NULL DEFAULT false,
  color TEXT NOT NULL DEFAULT 'default',
  theme TEXT NOT NULL DEFAULT 'graphite',
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  author TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE notes ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'default';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'graphite';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS tabs JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(pinned DESC, updated_at DESC);
-- Ссылки на заметку для людей без входа в MBOX: одна на режим (просмотр / правка), отзыв — удалением строки.
CREATE TABLE IF NOT EXISTS note_shares (
  token TEXT PRIMARY KEY,
  note_id BIGINT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('view', 'edit')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_note_shares_mode ON note_shares(note_id, mode);
`;

// Заметка по ссылке может быть большой, но не бесконечной: защита публичной правки от мусора.
const MAX_SHARED_CONTENT = 2 * 1024 * 1024;
const MAX_SHARED_IMAGE = 25 * 1024 * 1024;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{24,64}$/;
const INTERNAL_FILE = "/api/mbox/storage/file?key=";
const NOTE_COLORS = new Set(["default", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "gray"]);
const NOTE_THEMES = new Set(["light", "graphite", "black"]);
const MAX_NOTE_TABS = 50;

function noteColor(value) {
  const color = String(value || "default");
  return NOTE_COLORS.has(color) ? color : "default";
}

function noteTheme(value) {
  const theme = String(value || "graphite");
  return NOTE_THEMES.has(theme) ? theme : "graphite";
}

function noteTabs(value, fallbackContent = "") {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const tabs = source.slice(0, MAX_NOTE_TABS).map((item, index) => {
    const proposed = String(item?.id || `tab-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || `tab-${index + 1}`;
    let id = proposed;
    let suffix = 2;
    while (seen.has(id)) id = `${proposed.slice(0, 58)}-${suffix++}`;
    seen.add(id);
    return {
      id,
      title: String(item?.title || `Вкладка ${index + 1}`).trim().slice(0, 120) || `Вкладка ${index + 1}`,
      content: String(item?.content ?? ""),
    };
  });
  return tabs.length ? tabs : [{ id: "main", title: "Основная", content: String(fallbackContent || "") }];
}

function tabsWithContent(tabs, transform) {
  return tabs.map((tab) => ({ ...tab, content: transform(tab.content) }));
}

/** Картинки в тексте хранятся ссылкой, требующей входа в MBOX; на публичной странице — ссылкой по токену. */
function toSharedUrls(content, token) {
  return String(content || "").split(INTERNAL_FILE).join(`/api/share/notes/${token}/file?key=`);
}

function toInternalUrls(content) {
  return String(content || "").replace(/\/api\/share\/notes\/[A-Za-z0-9_-]+\/file\?key=/g, INTERNAL_FILE);
}

const NOTE_COLUMNS = `id::text, title, content, tabs, pinned, color, theme, project_id::text, tags, author, created_at::text, updated_at::text,
  octet_length(content) + pg_column_size(tabs) AS size_bytes`;

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
    `SELECT id::text, title, left(content, 400) AS snippet, pinned, color, theme, project_id::text, tags, author, created_at::text, updated_at::text,
            octet_length(content) + pg_column_size(tabs) AS size_bytes
     FROM notes
     WHERE $1 = '' OR title ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%' OR tabs::text ILIKE '%' || $1 || '%' OR array_to_string(tags, ' ') ILIKE '%' || $1 || '%'
     ORDER BY pinned DESC, updated_at DESC
     LIMIT $2`,
    [q, Math.min(Math.max(Number(limit) || 200, 1), 500)],
  )).rows;
}

export async function createNote(query, { title, content, tabs, color, theme, project_id: projectId, tags, author }) {
  const noteTabList = noteTabs(tabs, content);
  const text = noteTabList[0].content;
  return (await query(
    `INSERT INTO notes(title, content, tabs, color, theme, project_id, tags, author) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8) RETURNING ${NOTE_COLUMNS}`,
    [String(title || "").trim() || titleFrom(text), text, JSON.stringify(noteTabList), noteColor(color), noteTheme(theme), projectId || null, Array.isArray(tags) ? tags.map(String) : [], String(author || "")],
  )).rows[0];
}

export async function handleNotesApi({ req, res, url, query, readBody, sendJson, actor, allowed }) {
  if (!url.pathname.startsWith("/api/mbox/notes")) return false;
  if (!allowed) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }
  try {
    // Ссылки на заметку: список, создать (или выдать существующую; regenerate — новый токен), отозвать.
    const shareMatch = url.pathname.match(/^\/api\/mbox\/notes\/(\d+)\/shares(?:\/(view|edit))?$/);
    if (shareMatch) {
      const [, noteId, modeInPath] = shareMatch;
      if (req.method === "GET") {
        sendJson(res, 200, { shares: (await query("SELECT token, mode, created_by, created_at::text, last_used_at::text FROM note_shares WHERE note_id = $1 ORDER BY mode", [noteId])).rows });
        return true;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const mode = body.mode === "edit" ? "edit" : "view";
        if (body.regenerate) await query("DELETE FROM note_shares WHERE note_id = $1 AND mode = $2", [noteId, mode]);
        const existing = (await query("SELECT token, mode, created_by, created_at::text FROM note_shares WHERE note_id = $1 AND mode = $2", [noteId, mode])).rows[0];
        if (existing) { sendJson(res, 200, { share: existing }); return true; }
        const token = randomBytes(24).toString("base64url");
        const row = (await query(
          "INSERT INTO note_shares(token, note_id, mode, created_by) VALUES ($1, $2, $3, $4) RETURNING token, mode, created_by, created_at::text",
          [token, noteId, mode, String(actor || "")],
        )).rows[0];
        sendJson(res, 201, { share: row });
        return true;
      }
      if (req.method === "DELETE" && modeInPath) {
        await query("DELETE FROM note_shares WHERE note_id = $1 AND mode = $2", [noteId, modeInPath]);
        sendJson(res, 200, { ok: true });
        return true;
      }
    }
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
      let tabs = has("tabs") ? noteTabs(body.tabs, content) : null;
      // base_updated_at — версия, от которой редактировал клиент. Заметку могли поправить по ссылке:
      // тогда 409 со свежей версией, и клиент сливает правки, а не затирает чужие.
      const changesDocument = content !== null || tabs !== null;
      const base = changesDocument && body.base_updated_at ? String(body.base_updated_at) : "";
      if (changesDocument) {
        const current = (await query(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = $1`, [match[1]])).rows[0];
        if (base && current && current.updated_at !== base) { sendJson(res, 409, { error: "conflict", note: current }); return true; }
        if (!tabs && content !== null) {
          tabs = noteTabs(current?.tabs, current?.content);
          tabs[0] = { ...tabs[0], content };
        }
      }
      const primaryContent = tabs ? tabs[0].content : content;
      const row = (await query(
        `UPDATE notes SET
           content = COALESCE($1, content),
           title = CASE WHEN $2::boolean THEN $3 WHEN $1 IS NOT NULL THEN $4 ELSE title END,
           pinned = COALESCE($5, pinned),
           project_id = CASE WHEN $6::boolean THEN $7::bigint ELSE project_id END,
           tags = COALESCE($8, tags),
           color = CASE WHEN $9::boolean THEN $10 ELSE color END,
           theme = CASE WHEN $11::boolean THEN $12 ELSE theme END,
           tabs = CASE WHEN $13::boolean THEN $14::jsonb ELSE tabs END,
           updated_at = CASE WHEN $1 IS NOT NULL OR $2::boolean OR $6::boolean OR $8 IS NOT NULL OR $9::boolean OR $11::boolean OR $13::boolean THEN now() ELSE updated_at END
         WHERE id = $15
         RETURNING ${NOTE_COLUMNS}`,
        [
          primaryContent,
          has("title") && String(body.title || "").trim() !== "",
          String(body.title || "").trim(),
          titleFrom(primaryContent),
          typeof body.pinned === "boolean" ? body.pinned : null,
          has("project_id"),
          body.project_id || null,
          Array.isArray(body.tags) ? body.tags.map(String) : null,
          has("color"),
          noteColor(body.color),
          has("theme"),
          noteTheme(body.theme),
          tabs !== null,
          JSON.stringify(tabs || []),
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


/**
 * Публичные ручки заметки по ссылке — вызываются ДО проверки входа в MBOX. Доступ определяет только токен:
 * view — читать, edit — читать, править и вставлять картинки. Картинки — только в папке этой заметки в S3.
 */
export async function handleSharedNoteApi({ req, res, url, query, readBody, sendJson, storage, broadcast }) {
  const match = url.pathname.match(/^\/api\/share\/notes\/([^/]+)(\/file|\/images)?$/);
  if (!match) return false;
  const [, token, sub] = match;
  try {
    if (!SHARE_TOKEN.test(token)) { sendJson(res, 404, { error: "Ссылка недействительна" }); return true; }
    const share = (await query(
      "SELECT s.mode, n.id::text AS note_id FROM note_shares s JOIN notes n ON n.id = s.note_id WHERE s.token = $1",
      [token],
    )).rows[0];
    if (!share) { sendJson(res, 404, { error: "Ссылка отозвана или заметка удалена" }); return true; }
    const prefix = `notes/${share.note_id}/`;

    if (sub === "/file" && req.method === "GET") {
      const key = String(url.searchParams.get("key") || "");
      if (!key.startsWith(prefix) || key.includes("..")) { sendJson(res, 403, { error: "forbidden" }); return true; }
      const location = await storage.signedGet(key);
      if (!location) { sendJson(res, 404, { error: "Хранилище не настроено" }); return true; }
      res.writeHead(302, { location, "cache-control": "private, max-age=3000" });
      res.end();
      return true;
    }

    if (sub === "/images" && req.method === "POST") {
      if (share.mode !== "edit") { sendJson(res, 403, { error: "Ссылка только для просмотра" }); return true; }
      const type = String(req.headers["content-type"] || "");
      const length = Number(req.headers["content-length"] || 0);
      if (!type.startsWith("image/")) { sendJson(res, 415, { error: "Можно вставлять только картинки" }); return true; }
      if (!length) { sendJson(res, 411, { error: "Нужен размер файла" }); return true; }
      if (length > MAX_SHARED_IMAGE) { sendJson(res, 413, { error: "Картинка больше 25 МБ" }); return true; }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = String(url.searchParams.get("name") || "картинка").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 80) || "картинка";
      const key = `${prefix}${stamp}-${name}`;
      const result = await storage.putStream(key, Readable.toWeb(req), length, type);
      sendJson(res, result.ok ? 200 : 502, result.ok ? { key, url: `/api/share/notes/${token}/file?key=${encodeURIComponent(key)}` } : { error: result.error });
      return true;
    }

    if (sub) return false;
    const note = (await query(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = $1`, [share.note_id])).rows[0];
    const shaped = (row) => {
      const tabs = tabsWithContent(noteTabs(row.tabs, row.content), (content) => toSharedUrls(content, token));
      return { title: row.title, content: tabs[0].content, tabs, theme: noteTheme(row.theme), updated_at: row.updated_at };
    };

    if (req.method === "GET") {
      await query("UPDATE note_shares SET last_used_at = now() WHERE token = $1", [token]).catch(() => {});
      sendJson(res, 200, { mode: share.mode, note: shaped(note) });
      return true;
    }

    if (req.method === "PATCH") {
      if (share.mode !== "edit") { sendJson(res, 403, { error: "Ссылка только для просмотра" }); return true; }
      const body = await readBody(req);
      let tabs;
      if (Array.isArray(body.tabs)) tabs = noteTabs(body.tabs, note.content);
      else {
        tabs = noteTabs(note.tabs, note.content);
        tabs[0] = { ...tabs[0], content: String(body.content ?? "") };
      }
      tabs = tabsWithContent(tabs, toInternalUrls);
      if (Buffer.byteLength(JSON.stringify(tabs)) > MAX_SHARED_CONTENT) { sendJson(res, 413, { error: "Заметка больше 2 МБ" }); return true; }
      const base = String(body.base_updated_at || "");
      if (base && note.updated_at !== base) { sendJson(res, 409, { error: "conflict", note: shaped(note) }); return true; }
      const content = tabs[0].content;
      const row = (await query(
        `UPDATE notes SET content = $1, tabs = $2::jsonb, title = $3, updated_at = now() WHERE id = $4 RETURNING ${NOTE_COLUMNS}`,
        [content, JSON.stringify(tabs), titleFrom(content), share.note_id],
      )).rows[0];
      broadcast?.({ entity: "notes", action: "update", detail: `#${share.note_id}` });
      sendJson(res, 200, { note: shaped(row) });
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}
