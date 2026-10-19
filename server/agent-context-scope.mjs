// Параметры и постраничность /api/mbox/agent/context. Чистые функции без доступа к БД.
//
// Зачем: detail=full отдавал всё без границ (все задачи с полными заметками, все связи) — 1,34 млн знаков
// на боевых данных. Теперь full режется по секциям и страницам, а контекст можно собрать под одну задачу.

const CLOSED_STATUSES = new Set(["done", "archived"]);

export const FULL_SECTIONS = ["todos", "relations", "decisions", "inbox", "runs", "history", "memories", "approved_secrets"];
export const FULL_DEFAULT_LIMIT = 50;
export const FULL_MAX_LIMIT = 200;
export const FULL_NOTE_LIMIT = 2000;

export function parseContextParams(url) {
  const params = url.searchParams;
  const requested = String(params.get("sections") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sections = requested.length ? FULL_SECTIONS.filter((name) => requested.includes(name)) : FULL_SECTIONS;
  const limit = Math.min(Math.max(Math.floor(Number(params.get("limit"))) || FULL_DEFAULT_LIMIT, 1), FULL_MAX_LIMIT);
  const offset = Math.max(Math.floor(Number(params.get("offset"))) || 0, 0);
  const taskId = String(params.get("task_id") || "").replace(/\D/g, "");
  const includeClosed = ["1", "true", "yes"].includes(String(params.get("include_closed") || "").toLowerCase());
  return { sections, limit, offset, taskId, includeClosed };
}

function clip(text, limit) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `${value.slice(0, limit - 3).trimEnd()}...`;
}

function fullTodo(todo) {
  const note = String(todo.note || "");
  if (note.length <= FULL_NOTE_LIMIT) return todo;
  return { ...todo, note: clip(note, FULL_NOTE_LIMIT), note_bytes: Buffer.byteLength(note, "utf8"), note_truncated: true };
}

// Запрос для recall: заголовок и начало заметки задачи, а не весь props проекта.
export function taskRecallQuery(task, project) {
  if (!task) return "";
  return `${task.title} ${clip(task.note, 600)} ${project?.name || ""}`.trim();
}

export function buildFullAgentContext({ project, todos = [], relations = [], decisions = [], inbox = [], runs = [], history = [], memories = [], secrets = [], task = null }, { sections, limit, offset, includeClosed }) {
  const lists = {
    todos: includeClosed ? todos : todos.filter((todo) => !CLOSED_STATUSES.has(todo.status)),
    relations,
    decisions,
    inbox,
    runs,
    history,
    memories,
    approved_secrets: secrets,
  };
  const page = {};
  const result = { project, detail: "full" };
  if (task) result.task = task;
  for (const name of sections) {
    const rows = lists[name];
    const slice = rows.slice(offset, offset + limit);
    result[name] = name === "todos" ? slice.map(fullTodo) : slice;
    page[name] = { total: rows.length, offset, returned: slice.length, next_offset: offset + slice.length < rows.length ? offset + slice.length : null };
  }
  result.page = page;
  result.note = "full: секции и страницы — ?sections=todos,runs&limit=50&offset=0; закрытые задачи — include_closed=1; под одну задачу — task_id=<id>. Заметки задач длиннее 2000 знаков обрезаны (note_truncated), целиком — get_task.";
  return result;
}
