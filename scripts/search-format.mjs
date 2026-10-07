// Единый поиск для агентов: вывод /api/mbox/spotlight в виде коротких строк с подсказкой, чем читать найденное.

export const SEARCH_KINDS = ["note", "doc", "table", "todo", "memory", "project", "artifact"];

const READ_WITH = {
  note: "note_read",
  doc: "doc_read",
  table: "table_read",
  todo: "get_task",
  memory: "get_memory",
  project: "get_agent_context project=<название>",
  artifact: "storage_read / artifact",
};

const clip = (text, limit) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
};

/**
 * @param results строки из spotlight (kind, id, title, project, status, snippet, updated_at)
 * @param opts.kinds ограничение по видам, пустое — все
 * @param opts.fallback true, если по всем словам сразу ничего не нашлось и поиск шёл по любому из слов
 */
export function formatSearch(results, { query = "", kinds = [], fallback = false, limit = 15 } = {}) {
  const filtered = (kinds.length ? results.filter((row) => kinds.includes(row.kind)) : results).slice(0, limit);
  if (!filtered.length) {
    return `Ничего не найдено по «${query}»${kinds.length ? ` среди: ${kinds.join(", ")}` : ""}. Поиск уже учитывает окончания слов; попробуйте одно ключевое слово.`;
  }
  const lines = filtered.map((row) => {
    const where = [row.project, row.status].filter(Boolean).join(", ");
    return `${row.kind} #${row.id} «${clip(row.title, 80)}»${where ? ` [${where}]` : ""} — ${clip(row.snippet, 160)}\n   читать: ${READ_WITH[row.kind] || "get_memory"} ${row.id}`;
  });
  const head = fallback
    ? `По всем словам «${query}» сразу пусто — показано, где встречается ЛЮБОЕ из слов (выше те, где слов больше):`
    : `Найдено по «${query}» (${filtered.length}):`;
  return [head, ...lines].join("\n");
}
