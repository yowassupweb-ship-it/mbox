// Единый поиск MBOX («Spotlight»): заметки (включая вкладки и теги), документы, таблицы (с содержимым ячеек),
// проекты, задачи, память и артефакты — одним запросом, с правами пользователя. Каждый источник ищет слова запроса
// по отдельности и с отрезанными окончаниями (searchTerms), поэтому «пересборке» находит «пересборка». Результаты
// ранжируются здесь: название весит больше текста, точное совпадение больше частичного, свежее и закреплённое — выше.

import { noteScopeWhere } from "./notes.mjs";
import { scopeWhere as documentScopeWhere } from "./documents.mjs";
import { tableScopeWhere } from "./tables.mjs";

const PER_SOURCE = 12;
const TOTAL = 40;
const EXCERPT = 700;
const SNIPPET = 170;

/** Условие «каждое слово встречается в одном из столбцов» с параметрами $from, $from+1, … (по слову на параметр). */
function termsWhere(terms, columns, from) {
  if (!terms.length) return { sql: "TRUE", values: [] };
  const clauses = terms.map((_, index) => `(${columns.map((column) => `${column} ILIKE $${from + index} ESCAPE '\\'`).join(" OR ")})`);
  return { sql: clauses.join(" AND "), values: terms.map((term) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`) };
}

const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** Кусок текста вокруг первого совпадения слов запроса: size знаков, с многоточиями по краям. */
function around(text, terms, size) {
  const clean = flat(text);
  if (clean.length <= size) return clean;
  const lower = clean.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return `${clean.slice(0, size).trimEnd()}…`;
  const start = Math.max(0, at - Math.round(size / 3));
  const end = Math.min(clean.length, start + size);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}

function score({ title, text, updated_at: updatedAt, pinned }, terms, phrase) {
  const lowerTitle = flat(title).toLowerCase();
  const lowerText = String(text ?? "").toLowerCase();
  let value = 0;
  if (phrase && lowerTitle === phrase) value += 12;
  else if (phrase && lowerTitle.startsWith(phrase)) value += 8;
  else if (phrase && lowerTitle.includes(phrase)) value += 5;
  for (const term of terms) {
    if (lowerTitle.includes(term)) value += 3;
    let hits = 0;
    for (let from = lowerText.indexOf(term); from >= 0 && hits < 3; from = lowerText.indexOf(term, from + term.length)) hits += 1;
    value += hits;
  }
  if (pinned) value += 1;
  const days = (Date.now() - new Date(updatedAt).getTime()) / 86_400_000;
  if (days < 2) value += 2;
  else if (days < 14) value += 1;
  return value;
}

export async function handleSpotlightApi({ req, res, url, query, sendJson, scope = { all: true, projectIds: [] }, searchTerms }) {
  if (url.pathname !== "/api/mbox/spotlight" || req.method !== "GET") return false;
  const started = Date.now();
  const raw = String(url.searchParams.get("q") || "").trim().slice(0, 200);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || TOTAL, 1), 100);
  const terms = raw ? (searchTerms(raw).length ? searchTerms(raw) : [raw.toLowerCase()]) : [];
  const phrase = raw.toLowerCase();
  const recent = !raw;
  const projectIds = Array.isArray(scope.projectIds) ? scope.projectIds : [];
  const all = Boolean(scope.all);

  const sources = [];

  // Заметки: заголовок, основной текст, ВСЕ вкладки и теги.
  {
    const scoped = noteScopeWhere(scope, "notes");
    const match = termsWhere(terms, ["notes.title", "notes.content", "notes.tabs::text", "array_to_string(notes.tags, ' ')"], scoped.values.length + 1);
    sources.push(query(
      `SELECT notes.id::text, notes.title, notes.content, notes.tabs, notes.pinned, notes.project_id::text, p.name AS project, notes.updated_at::text
       FROM notes LEFT JOIN projects p ON p.id = notes.project_id
       WHERE (${scoped.sql}) AND ${match.sql}
       ORDER BY notes.pinned DESC, notes.updated_at DESC LIMIT ${recent ? 6 : PER_SOURCE * 3}`,
      [...scoped.values, ...match.values],
    ).then(({ rows }) => rows.map((row) => {
      // Основной текст обычно и есть первая вкладка: дописываем content только если его нет среди вкладок.
      const tabs = Array.isArray(row.tabs) ? row.tabs : [];
      const tabText = tabs.map((tab, index) => `${index ? `${tab?.title ?? ""}\n` : ""}${tab?.content ?? ""}`).join("\n");
      const text = tabs.some((tab) => tab?.content === row.content) ? tabText : `${row.content}\n${tabText}`;
      return { kind: "note", id: row.id, key: `note:${row.id}`, title: row.title || "Без названия", project: row.project, updated_at: row.updated_at, pinned: row.pinned, text };
    })));
  }

  // Документы.
  {
    const scoped = documentScopeWhere(scope, "documents");
    const match = termsWhere(terms, ["documents.title", "documents.text_content"], scoped.values.length + 1);
    sources.push(query(
      `SELECT documents.id::text, documents.title, documents.text_content, documents.pinned, p.name AS project, documents.updated_at::text
       FROM documents LEFT JOIN projects p ON p.id = documents.project_id
       WHERE (${scoped.sql}) AND ${match.sql}
       ORDER BY documents.pinned DESC, documents.updated_at DESC LIMIT ${recent ? 6 : PER_SOURCE * 3}`,
      [...scoped.values, ...match.values],
    ).then(({ rows }) => rows.map((row) => ({ kind: "doc", id: row.id, key: `doc:${row.id}`, title: row.title || "Документ", project: row.project, updated_at: row.updated_at, pinned: row.pinned, text: row.text_content }))));
  }

  // Таблицы: название и текст ячеек (индекс строится в фоне после записи).
  {
    const scoped = tableScopeWhere(scope, "tables");
    const match = termsWhere(terms, ["tables.title", "tables.text_content"], scoped.values.length + 1);
    sources.push(query(
      `SELECT tables.id::text, tables.title, tables.text_content, tables.pinned, p.name AS project, tables.updated_at::text
       FROM tables LEFT JOIN projects p ON p.id = tables.project_id
       WHERE (${scoped.sql}) AND ${match.sql}
       ORDER BY tables.pinned DESC, tables.updated_at DESC LIMIT ${recent ? 6 : PER_SOURCE * 3}`,
      [...scoped.values, ...match.values],
    ).then(({ rows }) => rows.map((row) => ({ kind: "table", id: row.id, key: `table:${row.id}`, title: row.title || "Таблица", project: row.project, updated_at: row.updated_at, pinned: row.pinned, text: row.text_content }))));
  }

  if (!recent) {
    // Проекты, задачи, память и артефакты — только при поиске: в «недавнем» они шумят.
    {
      const match = termsWhere(terms, ["projects.name", "projects.props::text"], 3);
      sources.push(query(
        `SELECT projects.id::text, projects.name, projects.props::text AS props, projects.updated_at::text
         FROM projects WHERE ($1::boolean OR projects.id = ANY($2::bigint[])) AND ${match.sql}
         ORDER BY projects.updated_at DESC LIMIT ${PER_SOURCE}`,
        [all, projectIds, ...match.values],
      ).then(({ rows }) => rows.map((row) => ({ kind: "project", id: row.id, key: `project:${row.id}`, title: row.name, project: "", updated_at: row.updated_at, text: row.props }))));
    }
    {
      const match = termsWhere(terms, ["todos.title", "todos.note"], 3);
      sources.push(query(
        `SELECT todos.id::text, todos.title, todos.note, todos.status, p.name AS project, todos.updated_at::text
         FROM todos JOIN projects p ON p.id = todos.project_id
         WHERE ($1::boolean OR todos.project_id = ANY($2::bigint[])) AND ${match.sql}
         ORDER BY todos.updated_at DESC LIMIT ${PER_SOURCE}`,
        [all, projectIds, ...match.values],
      ).then(({ rows }) => rows.map((row) => ({ kind: "todo", id: row.id, key: `todo:${row.id}`, title: row.title, project: row.project, updated_at: row.updated_at, text: row.note, status: row.status }))));
    }
    {
      const match = termsWhere(terms, ["memories.title", "memories.content", "array_to_string(memories.tags, ' ')"], 3);
      sources.push(query(
        `SELECT memories.id::text, memories.title, memories.content, p.name AS project, memories.updated_at::text
         FROM memories LEFT JOIN projects p ON p.id = memories.project_id
         WHERE ($1::boolean OR memories.project_id = ANY($2::bigint[])) AND ${match.sql}
         ORDER BY memories.updated_at DESC LIMIT ${PER_SOURCE}`,
        [all, projectIds, ...match.values],
      ).then(({ rows }) => rows.map((row) => ({ kind: "memory", id: row.id, key: `memory:${row.id}`, title: row.title || `Запись #${row.id}`, project: row.project, updated_at: row.updated_at, text: row.content }))));
    }
    {
      const match = termsWhere(terms, ["artifacts.name", "artifacts.content"], 3);
      sources.push(query(
        `SELECT artifacts.id::text, artifacts.name, artifacts.content, p.name AS project, artifacts.updated_at::text
         FROM artifacts LEFT JOIN projects p ON p.id = artifacts.project_id
         WHERE ($1::boolean OR artifacts.project_id = ANY($2::bigint[])) AND ${match.sql}
         ORDER BY artifacts.updated_at DESC LIMIT ${PER_SOURCE}`,
        [all, projectIds, ...match.values],
      ).then(({ rows }) => rows.map((row) => ({ kind: "artifact", id: row.id, key: `file:${row.id}`, title: row.name, project: row.project, updated_at: row.updated_at, text: row.content }))));
    }
  }

  try {
    const settled = await Promise.allSettled(sources);
    const rows = settled.flatMap((item) => (item.status === "fulfilled" ? item.value : []));
    const ranked = rows
      .map((row) => ({ ...row, score: recent ? new Date(row.updated_at).getTime() : score(row, terms, phrase) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ text, score: rank, ...row }) => ({
        ...row,
        score: recent ? 0 : Number(rank.toFixed(2)),
        snippet: recent ? around(text, [], SNIPPET) : around(text, terms, SNIPPET),
        excerpt: recent ? around(text, [], EXCERPT) : around(text, terms, EXCERPT),
      }));
    sendJson(res, 200, { query: raw, terms, recent, results: ranked, took_ms: Date.now() - started, failed: settled.filter((item) => item.status === "rejected").length });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
