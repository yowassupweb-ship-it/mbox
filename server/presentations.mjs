// Презентации в духе Google Презентаций рядом с таблицами и документами. Доступ как у документов: владелец,
// участники проекта, все. Содержимое — JSON: тема и слайды 960×540 со свободно расположенными блоками (текст, фигура,
// картинка). Агент правит слайды через MCP (presentation_slide), открытая вкладка перечитывает презентацию по сигналу
// entity_changed и подсвечивает изменённые слайды — человек видит работу агента сразу.
//
// Шаблоны: любая презентация может стать шаблоном (is_template). Новая презентация из шаблона берёт его шапку
// (тема, стили, размер) и слайды-образцы; агент начинает работу со списка шаблонов и уже сделанных презентаций.
//
//   GET    /api/mbox/presentations?q=&templates=1   — список (без текста)
//   POST   /api/mbox/presentations                  — создать { title, content?, template_id?, project_id? }
//   GET    /api/mbox/presentations/:id              — целиком
//   PATCH  /api/mbox/presentations/:id              — { title?, content?, base_updated_at?, is_template?, pinned?, project_id?, access_level? }
//   POST   /api/mbox/presentations/:id/slides       — правка слайда агентом { op: add|update|delete|move|theme, index?, slide?, to?, theme? }
//   DELETE /api/mbox/presentations/:id              — только владелец

import { createHash } from "node:crypto";
import { announceAgentEdit } from "./presence.mjs";

export const PRESENTATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS presentations (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  is_template BOOLEAN NOT NULL DEFAULT false,
  pinned BOOLEAN NOT NULL DEFAULT false,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  author TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT,
  access_level TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE presentations ADD COLUMN IF NOT EXISTS slide_count INT NOT NULL DEFAULT 1;
ALTER TABLE presentations ADD COLUMN IF NOT EXISTS text_content TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_presentations_updated ON presentations(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_presentations_owner ON presentations(owner_user_id);
-- Картинки слайдов отдельно от текста презентации: в JSON остаётся короткая ссылка /api/mbox/presentations/:id/assets/:asset.
CREATE TABLE IF NOT EXISTS presentation_assets (
  id BIGSERIAL PRIMARY KEY,
  presentation_id BIGINT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  sha TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (presentation_id, sha)
);
`;

const LIST_COLUMNS = `id::text, title, is_template, pinned, project_id::text, author, owner_user_id, access_level, created_at::text, updated_at::text,
  octet_length(content) AS size_bytes, slide_count, left(text_content, 160) AS snippet`;
const FULL_COLUMNS = `${LIST_COLUMNS}, content`;
const ACCESS_LEVELS = ["private", "project", "all"];
const MAX_BYTES = 45 * 1024 * 1024;

const newId = () => Math.random().toString(36).slice(2, 10);
const THEME = { name: "Светлая", fontFamily: "Inter, 'Segoe UI', Arial, sans-serif", background: "#ffffff", text: "#1d1d1f", accent: "#0a84ff", titleSize: 44, bodySize: 22 };

/** Стартовая презентация: титульный слайд и слайд «заголовок и текст» (та же модель, что в src/app/workbench/slides/deck.ts). */
export function defaultDeck() {
  return {
    version: 1,
    theme: THEME,
    slides: [
      { id: newId(), notes: "", elements: [
        { id: newId(), type: "text", role: "title", x: 80, y: 170, w: 800, h: 120, html: "Название презентации", style: { fontSize: 52, bold: true, align: "center", valign: "middle" } },
        { id: newId(), type: "text", role: "subtitle", x: 80, y: 300, w: 800, h: 60, html: "Подзаголовок или автор", style: { fontSize: 22, align: "center", valign: "top", color: THEME.accent } },
      ] },
      { id: newId(), notes: "", elements: [
        { id: newId(), type: "text", role: "title", x: 60, y: 40, w: 840, h: 90, html: "Заголовок", style: { fontSize: 44, bold: true, align: "left", valign: "middle" } },
        { id: newId(), type: "text", role: "body", x: 60, y: 150, w: 840, h: 330, html: "<ul><li>Первая мысль</li><li>Вторая мысль</li><li>Третья мысль</li></ul>", style: { fontSize: 22, align: "left", valign: "top" } },
      ] },
    ],
  };
}

const stripHtml = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Разбор содержимого: JSON-презентация или ошибка invalid_presentation (старый Markdown пропускаем как есть). */
export function parseDeck(content) {
  const text = String(content || "").trim();
  if (!text.startsWith("{")) return null;
  let deck;
  try { deck = JSON.parse(text); } catch { throw new Error("invalid_presentation"); }
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.slides)) throw new Error("invalid_presentation");
  return deck;
}

/** Число слайдов и весь текст презентации — для списка, поиска и для агентов, которым JSON читать незачем. */
function deckStats(content) {
  const deck = parseDeck(content);
  if (!deck) return { slideCount: Math.max(1, String(content).replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "").split(/\n---\s*\n/).length), text: String(content).slice(0, 20000) };
  const text = deck.slides.map((slide) => (slide.elements || []).map((element) => stripHtml(element.html)).filter(Boolean).join(" · ")).join(" | ");
  return { slideCount: Math.max(1, deck.slides.length), text: text.slice(0, 20000) };
}

export async function ensurePresentationsSchema(query) {
  await query(PRESENTATIONS_SCHEMA_SQL);
}

const accessLevel = (value) => (ACCESS_LEVELS.includes(String(value)) ? String(value) : "private");
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

function scopeWhere(scope, alias = "presentations") {
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

/** Заголовок — первая строка текста после шапки Marp и служебных комментариев. */
export function deckTitle(content) {
  try {
    const deck = parseDeck(content);
    if (deck) {
      const first = deck.slides[0]?.elements || [];
      const title = first.find((element) => element.role === "title") || first.find((element) => element.type === "text");
      return stripHtml(title?.html).slice(0, 200);
    }
  } catch { /* ниже — как текст */ }
  const text = String(content || "").replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "").replace(/<!--[\s\S]*?-->/g, "");
  return (text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) || "").slice(0, 200);
}

/** Шапка Marp (--- … ---) и стили шаблона: с них начинается новая презентация «в стиле» шаблона. */
export function deckHead(content) {
  const match = String(content || "").match(/^\s*---\n[\s\S]*?\n---\s*\n/);
  const head = match ? match[0].trim() : "---\nmarp: true\n---";
  const styles = [...String(content || "").matchAll(/<style[\s\S]*?<\/style>/g)].map((item) => item[0]);
  return [head, ...styles].join("\n\n");
}

function checkSize(content) {
  if (Buffer.byteLength(String(content), "utf8") > MAX_BYTES) throw new Error("presentation_too_large");
}

async function visibleRow(query, id, scope, columns = FULL_COLUMNS) {
  const scoped = scopeWhere(scope);
  return (await query(`SELECT ${columns} FROM presentations WHERE id = $${scoped.values.length + 1} AND (${scoped.sql})`, [...scoped.values, id])).rows[0] || null;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/;

/**
 * Картинки data:-ссылками (вставка, импорт PDF) уезжают в presentation_assets, в презентации остаётся ссылка.
 * Одинаковые картинки хранятся один раз (по sha). Возвращает новый текст или null, если менять нечего.
 */
async function extractAssets(query, presentationId, content) {
  if (!String(content).includes("data:image/")) return null;
  const deck = parseDeck(content);
  if (!deck) return null;
  let changed = false;
  for (const slide of deck.slides) {
    for (const element of slide.elements || []) {
      const match = element?.type === "image" && typeof element.src === "string" ? element.src.match(DATA_URL) : null;
      if (!match) continue;
      const data = Buffer.from(match[2], "base64");
      const sha = createHash("sha1").update(data).digest("hex");
      const row = (await query(
        `INSERT INTO presentation_assets(presentation_id, mime, sha, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (presentation_id, sha) DO UPDATE SET sha = EXCLUDED.sha RETURNING id::text`,
        [presentationId, match[1], sha, data],
      )).rows[0];
      element.src = `/api/mbox/presentations/${presentationId}/assets/${row.id}`;
      changed = true;
    }
  }
  return changed ? JSON.stringify(deck) : null;
}

/** Ответ без текста презентации: после сохранения клиенту он не нужен, а весить может мегабайты. */
const light = (row, extra = {}) => { const { content: _content, ...rest } = row; return { ...rest, ...extra }; };

export async function handlePresentationsApi({ req, res, url, query, readBody, sendJson, actor, scope = { all: true, projectIds: [] }, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/presentations")) return false;
  const notify = (action, detail, id) => broadcast?.("entity_changed", { entity: "presentations", action, actor: String(actor || ""), detail, id, silent: action === "update" });

  try {
    if (url.pathname === "/api/mbox/presentations" && req.method === "GET") {
      const scoped = scopeWhere(scope);
      const q = String(url.searchParams.get("q") || "").trim();
      const onlyTemplates = url.searchParams.get("templates") === "1";
      const n = scoped.values.length;
      const rows = (await query(
        `SELECT ${LIST_COLUMNS} FROM presentations
          WHERE (${scoped.sql}) AND ($${n + 1} = '' OR title ILIKE '%' || $${n + 1} || '%' OR content ILIKE '%' || $${n + 1} || '%') AND (NOT $${n + 2}::boolean OR is_template)
          ORDER BY pinned DESC, updated_at DESC LIMIT 300`,
        [...scoped.values, q, onlyTemplates],
      )).rows;
      sendJson(res, 200, { presentations: rows });
      return true;
    }

    if (url.pathname === "/api/mbox/presentations" && req.method === "POST") {
      const body = await readBody(req);
      let content = typeof body.content === "string" && body.content.trim() ? body.content : "";
      if (!content && body.template_id) {
        const template = await visibleRow(query, String(body.template_id), scope);
        if (!template) { sendJson(res, 404, { error: "template_not_found" }); return true; }
        content = template.content;
      }
      if (!content) content = JSON.stringify(defaultDeck());
      checkSize(content);
      parseDeck(content);
      const stats = deckStats(content);
      const projectId = body.project_id || null;
      if (projectId && scope && !scope.all && !scope.projectIds.includes(String(projectId))) { sendJson(res, 403, { error: "forbidden" }); return true; }
      const row = (await query(
        `INSERT INTO presentations(title, content, project_id, author, owner_user_id, access_level, slide_count, text_content)
         VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT id::text FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)), $6, $7, $8)
         RETURNING ${FULL_COLUMNS}`,
        [String(body.title || "").trim().slice(0, 200) || deckTitle(content) || "Презентация", content, projectId, String(actor || ""), scope?.userId ? String(scope.userId) : null, accessLevel(body.access_level), stats.slideCount, stats.text],
      )).rows[0];
      const rewritten = await extractAssets(query, row.id, content);
      if (rewritten) await query("UPDATE presentations SET content = $1 WHERE id = $2", [rewritten, row.id]);
      notify("create", row.title, row.id);
      sendJson(res, 201, { presentation: light(row) });
      return true;
    }

    // Картинка слайда: отдаётся тем, кто видит презентацию; адрес по содержимому, поэтому кэшируется надолго.
    const assetMatch = url.pathname.match(/^\/api\/mbox\/presentations\/(\d+)\/assets\/(\d+)$/);
    if (assetMatch && req.method === "GET") {
      const visible = await visibleRow(query, assetMatch[1], scope, "id::text");
      if (!visible) { sendJson(res, 404, { error: "not_found" }); return true; }
      const asset = (await query("SELECT mime, data FROM presentation_assets WHERE id = $1 AND presentation_id = $2", [assetMatch[2], assetMatch[1]])).rows[0];
      if (!asset) { sendJson(res, 404, { error: "not_found" }); return true; }
      res.writeHead(200, { "content-type": asset.mime, "content-length": asset.data.length, "cache-control": "private, max-age=31536000, immutable" });
      res.end(asset.data);
      return true;
    }

    // Загрузка картинки слайда: { data_url } → { url }. Импорт PDF шлёт страницы по одной, пока читает файл.
    const uploadMatch = url.pathname.match(/^\/api\/mbox\/presentations\/(\d+)\/assets$/);
    if (uploadMatch && req.method === "POST") {
      const visible = await visibleRow(query, uploadMatch[1], scope, "id::text");
      if (!visible) { sendJson(res, 404, { error: "not_found" }); return true; }
      const body = await readBody(req);
      const match = String(body.data_url || "").match(DATA_URL);
      if (!match) { sendJson(res, 400, { error: "bad_image", hint: "Нужна data:-ссылка PNG, JPEG, WebP или GIF" }); return true; }
      const data = Buffer.from(match[2], "base64");
      if (data.length > 15 * 1024 * 1024) { sendJson(res, 413, { error: "image_too_large" }); return true; }
      const sha = createHash("sha1").update(data).digest("hex");
      const row = (await query(
        `INSERT INTO presentation_assets(presentation_id, mime, sha, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (presentation_id, sha) DO UPDATE SET sha = EXCLUDED.sha RETURNING id::text`,
        [uploadMatch[1], match[1], sha, data],
      )).rows[0];
      sendJson(res, 201, { url: `/api/mbox/presentations/${uploadMatch[1]}/assets/${row.id}` });
      return true;
    }

    const match = url.pathname.match(/^\/api\/mbox\/presentations\/(\d+)(\/slides)?$/);
    if (!match) return false;
    const [, id, edit] = match;
    const current = await visibleRow(query, id, scope);
    if (!current) { sendJson(res, 404, { error: "not_found" }); return true; }
    const isOwner = !scope?.userId || current.owner_user_id === String(scope.userId);

    if (!edit && req.method === "GET") {
      // meta=1 — только версия и сведения, без текста: открытая вкладка так проверяет, не поменял ли презентацию агент.
      if (url.searchParams.get("meta") === "1") { sendJson(res, 200, { presentation: light(current, { is_owner: isOwner }) }); return true; }
      sendJson(res, 200, { presentation: { ...current, is_owner: isOwner } });
      return true;
    }

    if (!edit && req.method === "DELETE") {
      if (!isOwner) { sendJson(res, 403, { error: "owner_required" }); return true; }
      await query("DELETE FROM presentations WHERE id = $1", [id]);
      notify("delete", current.title, id);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (!edit && req.method === "PATCH") {
      const body = await readBody(req);
      // base_updated_at — версия, от которой правил клиент: если агент успел поменять текст, отдаём 409 со свежей версией.
      if (has(body, "content") && body.base_updated_at && String(body.base_updated_at) !== current.updated_at) {
        sendJson(res, 409, { error: "conflict", presentation: current });
        return true;
      }
      if ((has(body, "access_level") || has(body, "project_id")) && !isOwner) { sendJson(res, 403, { error: "owner_required" }); return true; }
      let content = has(body, "content") ? String(body.content ?? "") : null;
      if (content !== null) { checkSize(content); parseDeck(content); }
      const rewritten = content !== null ? await extractAssets(query, id, content) : null;
      if (rewritten) content = rewritten;
      const stats = content !== null ? deckStats(content) : null;
      const row = (await query(
        `UPDATE presentations SET
           content = COALESCE($1, content),
           title = CASE WHEN $2 <> '' THEN $2 WHEN $1 IS NOT NULL AND $3 <> '' THEN $3 ELSE title END,
           is_template = COALESCE($4, is_template),
           pinned = COALESCE($5, pinned),
           project_id = CASE WHEN $6::boolean THEN $7::bigint ELSE project_id END,
           access_level = COALESCE($8, access_level),
           slide_count = COALESCE($10, slide_count),
           text_content = COALESCE($11, text_content),
           updated_at = now()
         WHERE id = $9 RETURNING ${FULL_COLUMNS}`,
        [
          content,
          String(body.title || "").trim().slice(0, 200),
          content !== null && !has(body, "title") ? deckTitle(content) : "",
          typeof body.is_template === "boolean" ? body.is_template : null,
          typeof body.pinned === "boolean" ? body.pinned : null,
          has(body, "project_id"),
          body.project_id || null,
          has(body, "access_level") ? accessLevel(body.access_level) : null,
          id,
          stats?.slideCount ?? null,
          stats?.text ?? null,
        ],
      )).rows[0];
      if (content !== null) announceAgentEdit(broadcast, { doc: `slides:${id}`, name: actor });
      notify("update", row.title, id);
      // Если картинки уехали в хранилище, текст поменялся — отдаём его, чтобы вкладка не слала data:-ссылки снова.
      sendJson(res, 200, { presentation: light(row, { is_owner: isOwner, ...(rewritten ? { content: row.content } : {}) }) });
      return true;
    }

    // Правка одного слайда агентом: человек видит, как слайды появляются и меняются по одному.
    if (edit && req.method === "POST") {
      const body = await readBody(req);
      const deck = parseDeck(current.content) || defaultDeck();
      const slides = deck.slides;
      const index = Number.isInteger(body.index) ? body.index : slides.length;
      const op = String(body.op || "");
      const cleanSlide = (slide) => {
        if (!slide || typeof slide !== "object" || !Array.isArray(slide.elements)) throw new Error("invalid_presentation");
        return { id: String(slide.id || newId()), background: slide.background, notes: String(slide.notes || ""), elements: slide.elements.map((element) => ({ ...element, id: String(element.id || newId()) })) };
      };
      if (op === "add") slides.splice(Math.max(0, Math.min(index, slides.length)), 0, cleanSlide(body.slide));
      else if (op === "update") { if (!slides[index]) { sendJson(res, 404, { error: "slide_not_found", slides: slides.length }); return true; } slides[index] = { ...cleanSlide(body.slide), id: slides[index].id }; }
      else if (op === "delete") { if (!slides[index] || slides.length <= 1) { sendJson(res, 400, { error: "cannot_delete" }); return true; } slides.splice(index, 1); }
      else if (op === "move") { const to = Number(body.to); if (!slides[index] || !Number.isInteger(to) || to < 0 || to >= slides.length) { sendJson(res, 400, { error: "bad_move" }); return true; } const [moved] = slides.splice(index, 1); slides.splice(to, 0, moved); }
      else if (op === "theme") { if (!body.theme || typeof body.theme !== "object") { sendJson(res, 400, { error: "theme_required" }); return true; } deck.theme = { ...deck.theme, ...body.theme }; }
      else { sendJson(res, 400, { error: "bad_op", hint: "op: add | update | delete | move | theme" }); return true; }
      const content = (await extractAssets(query, id, JSON.stringify(deck))) || JSON.stringify(deck);
      checkSize(content);
      const stats = deckStats(content);
      const row = (await query(
        `UPDATE presentations SET content = $1, title = CASE WHEN $2 <> '' THEN $2 ELSE title END, slide_count = $3, text_content = $4, updated_at = now() WHERE id = $5 RETURNING ${FULL_COLUMNS}`,
        [content, deckTitle(content), stats.slideCount, stats.text, id],
      )).rows[0];
      announceAgentEdit(broadcast, { doc: `slides:${id}`, name: actor });
      notify("update", row.title, id);
      sendJson(res, 200, { presentation: { ...row, content: undefined }, slides: deck.slides.length });
      return true;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "presentation_too_large") { sendJson(res, 413, { error: "presentation_too_large" }); return true; }
    if (error instanceof Error && error.message === "invalid_presentation") { sendJson(res, 400, { error: "invalid_presentation", hint: "Нужен JSON { version: 1, theme, slides: [{ elements: [...] }] }" }); return true; }
    throw error;
  }
  return false;
}
