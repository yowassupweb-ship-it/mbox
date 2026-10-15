// Дизайн-системы проектов: страница бренда или интерфейса целиком в одном HTML-файле (палитра, шрифты, компоненты, правила).
// Хранится как есть и показывается во вкладке в изолированной рамке (iframe sandbox), поэтому свои стили и разметка
// дизайн-системы не задевают интерфейс MBOX. Доступ как у документов и презентаций: владелец, участники проекта, все.
// Агенты читают и пишут её через MCP (design_system_list/read/write): HTML — тот же файл, который видит человек.
//
//   GET    /api/mbox/design-systems?q=&project_id=   — список (без HTML)
//   POST   /api/mbox/design-systems                   — создать { title, html?, description?, project_id?, access_level? }
//   GET    /api/mbox/design-systems/:id               — целиком
//   PATCH  /api/mbox/design-systems/:id               — { title?, html?, description?, base_updated_at?, pinned?, project_id?, access_level? }
//   DELETE /api/mbox/design-systems/:id               — только владелец записи

import { announceAgentEdit } from "./presence.mjs";

export const DESIGN_SYSTEMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS design_systems (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  text_content TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT false,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  author TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT,
  access_level TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_design_systems_updated ON design_systems(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_design_systems_project ON design_systems(project_id);
CREATE INDEX IF NOT EXISTS idx_design_systems_owner ON design_systems(owner_user_id);
`;

const LIST_COLUMNS = `id::text, title, description, pinned, project_id::text, author, owner_user_id, access_level, created_at::text, updated_at::text,
  octet_length(html) AS size_bytes, left(text_content, 160) AS snippet`;
const FULL_COLUMNS = `${LIST_COLUMNS}, html`;
const ACCESS_LEVELS = ["private", "project", "all"];
const MAX_BYTES = 8 * 1024 * 1024;

export async function ensureDesignSystemsSchema(query) {
  await query(DESIGN_SYSTEMS_SCHEMA_SQL);
}

const accessLevel = (value) => (ACCESS_LEVELS.includes(String(value)) ? String(value) : "private");
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

/** Текст страницы без разметки, стилей и скриптов: для поиска и подсказки в списке. */
export function htmlText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000);
}

/** Название по умолчанию: <title>, иначе первый заголовок страницы. */
export function htmlTitle(html) {
  const source = String(html || "");
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "";
  return htmlText(title).slice(0, 200);
}

/** Стартовая страница: каркас с токенами, который можно сразу править руками или отдать агенту. */
export function starterHtml(title) {
  const name = String(title || "Дизайн-система").replace(/[<>&]/g, "");
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  :root {
    --bg: #ffffff; --surface: #f5f5f7; --text: #1d1d1f; --muted: #6e6e73; --accent: #0a84ff; --line: #d2d2d7;
    --radius: 10px; --font: Inter, "Segoe UI", Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1c1c1e; --surface: #2c2c2e; --text: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 32px 80px; background: var(--bg); color: var(--text); font: 15px/1.5 var(--font); }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 32px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 40px 0 12px; }
  p { color: var(--muted); margin: 0 0 16px; }
  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
  .swatch { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--surface); }
  .swatch i { display: block; height: 64px; }
  .swatch span { display: block; padding: 8px 10px; font-size: 12px; color: var(--muted); }
  .btn { display: inline-block; padding: 8px 16px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p>Описание: для кого система, где применяется, какие принципы в основе.</p>
  <h2>Цвета</h2>
  <div class="swatches">
    <div class="swatch"><i style="background:var(--bg)"></i><span>--bg</span></div>
    <div class="swatch"><i style="background:var(--surface)"></i><span>--surface</span></div>
    <div class="swatch"><i style="background:var(--text)"></i><span>--text</span></div>
    <div class="swatch"><i style="background:var(--accent)"></i><span>--accent</span></div>
  </div>
  <h2>Типографика</h2>
  <p>Шрифт, размеры, веса, межстрочный интервал.</p>
  <h2>Компоненты</h2>
  <span class="btn">Основная кнопка</span>
</main>
</body>
</html>
`;
}

function scopeWhere(scope, alias = "design_systems") {
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

function checkSize(html) {
  if (Buffer.byteLength(String(html), "utf8") > MAX_BYTES) throw new Error("design_system_too_large");
}

async function visibleRow(query, id, scope, columns = FULL_COLUMNS) {
  const scoped = scopeWhere(scope);
  return (await query(`SELECT ${columns} FROM design_systems WHERE id = $${scoped.values.length + 1} AND (${scoped.sql})`, [...scoped.values, id])).rows[0] || null;
}

const light = (row, extra = {}) => { const { html: _html, ...rest } = row; return { ...rest, ...extra }; };

export async function handleDesignSystemsApi({ req, res, url, query, readBody, sendJson, actor, scope = { all: true, projectIds: [] }, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/design-systems")) return false;
  const notify = (action, detail, id) => broadcast?.("entity_changed", { entity: "design_systems", action, actor: String(actor || ""), detail, id, silent: action === "update" });

  try {
    if (url.pathname === "/api/mbox/design-systems" && req.method === "GET") {
      await ensureDesignSystemsSchema(query);
      const scoped = scopeWhere(scope);
      const q = String(url.searchParams.get("q") || "").trim();
      const projectId = String(url.searchParams.get("project_id") || "");
      const n = scoped.values.length;
      const rows = (await query(
        `SELECT ${LIST_COLUMNS} FROM design_systems
          WHERE (${scoped.sql}) AND ($${n + 1} = '' OR title ILIKE '%' || $${n + 1} || '%' OR text_content ILIKE '%' || $${n + 1} || '%')
            AND ($${n + 2} = '' OR project_id::text = $${n + 2})
          ORDER BY pinned DESC, updated_at DESC LIMIT 300`,
        [...scoped.values, q, projectId],
      )).rows;
      sendJson(res, 200, { design_systems: rows });
      return true;
    }

    if (url.pathname === "/api/mbox/design-systems" && req.method === "POST") {
      await ensureDesignSystemsSchema(query);
      const body = await readBody(req);
      const title = String(body.title || "").trim().slice(0, 200);
      const html = typeof body.html === "string" && body.html.trim() ? body.html : starterHtml(title);
      checkSize(html);
      const projectId = body.project_id || null;
      if (projectId && scope && !scope.all && !scope.projectIds.includes(String(projectId))) { sendJson(res, 403, { error: "forbidden" }); return true; }
      const row = (await query(
        `INSERT INTO design_systems(title, description, html, text_content, project_id, author, owner_user_id, access_level)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, (SELECT id::text FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)), $8)
         RETURNING ${FULL_COLUMNS}`,
        [title || htmlTitle(html) || "Дизайн-система", String(body.description || "").slice(0, 2000), html, htmlText(html), projectId, String(actor || ""), scope?.userId ? String(scope.userId) : null, accessLevel(body.access_level)],
      )).rows[0];
      notify("create", row.title, row.id);
      sendJson(res, 201, { design_system: light(row) });
      return true;
    }

    const match = url.pathname.match(/^\/api\/mbox\/design-systems\/(\d+)$/);
    if (!match) return false;
    const id = match[1];
    const current = await visibleRow(query, id, scope);
    if (!current) { sendJson(res, 404, { error: "not_found" }); return true; }
    const isOwner = !scope?.userId || current.owner_user_id === String(scope.userId);

    if (req.method === "GET") {
      if (url.searchParams.get("meta") === "1") { sendJson(res, 200, { design_system: light(current, { is_owner: isOwner }) }); return true; }
      sendJson(res, 200, { design_system: { ...current, is_owner: isOwner } });
      return true;
    }

    if (req.method === "DELETE") {
      if (!isOwner) { sendJson(res, 403, { error: "owner_required" }); return true; }
      await query("DELETE FROM design_systems WHERE id = $1", [id]);
      notify("delete", current.title, id);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      // base_updated_at — версия, от которой правил клиент: если агент успел поменять страницу, отдаём 409 со свежей.
      if (has(body, "html") && body.base_updated_at && String(body.base_updated_at) !== current.updated_at) {
        sendJson(res, 409, { error: "conflict", design_system: current });
        return true;
      }
      if ((has(body, "access_level") || has(body, "project_id")) && !isOwner) { sendJson(res, 403, { error: "owner_required" }); return true; }
      const html = has(body, "html") ? String(body.html ?? "") : null;
      if (html !== null) checkSize(html);
      const row = (await query(
        `UPDATE design_systems SET
           html = COALESCE($1, html),
           text_content = COALESCE($2, text_content),
           title = CASE WHEN $3 <> '' THEN $3 ELSE title END,
           description = COALESCE($4, description),
           pinned = COALESCE($5, pinned),
           project_id = CASE WHEN $6::boolean THEN $7::bigint ELSE project_id END,
           access_level = COALESCE($8, access_level),
           updated_at = now()
         WHERE id = $9 RETURNING ${FULL_COLUMNS}`,
        [
          html,
          html !== null ? htmlText(html) : null,
          String(body.title || "").trim().slice(0, 200),
          has(body, "description") ? String(body.description || "").slice(0, 2000) : null,
          typeof body.pinned === "boolean" ? body.pinned : null,
          has(body, "project_id"),
          body.project_id || null,
          has(body, "access_level") ? accessLevel(body.access_level) : null,
          id,
        ],
      )).rows[0];
      if (html !== null) announceAgentEdit(broadcast, { doc: `design:${id}`, name: actor });
      notify("update", row.title, id);
      sendJson(res, 200, { design_system: light(row, { is_owner: isOwner }) });
      return true;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "design_system_too_large") { sendJson(res, 413, { error: "design_system_too_large" }); return true; }
    throw error;
  }
  return false;
}
