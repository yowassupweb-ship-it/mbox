// Компактный ответ /api/mbox/agent/context (detail=short). Чистая функция без доступа к БД:
// её используют и server/mbox-server.mjs, и dev-слой в vite.config.ts, чтобы сжатие не расходилось.
//
// Зачем: на боевых данных прежний short весил ~266 тыс. символов (221 задача с закрытыми,
// 50 inbox, 50 history, project.props целиком) и не помещался в контекст клиента.

const CLOSED_STATUSES = new Set(["done", "archived"]);

export const SHORT_LIMITS = {
  todoNote: 140,
  propText: 200,
  decisions: 5,
  inbox: 8,
  runs: 5,
  history: 8,
  memoryText: 200,
};

function textPreview(value, limit) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

// project.props у MBOX несёт целые документы (философия проекта и т.п.) — в short оставляем превью.
function compactProps(props) {
  if (!props || typeof props !== "object") return props;
  const result = {};
  for (const [key, value] of Object.entries(props)) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    result[key] = text.length > SHORT_LIMITS.propText ? textPreview(value, SHORT_LIMITS.propText) : value;
  }
  return result;
}

function compactTodo(todo) {
  const note = String(todo.note || "");
  const preview = textPreview(note, SHORT_LIMITS.todoNote);
  const row = {
    id: todo.id,
    title: todo.title,
    status: todo.status,
    priority: todo.priority,
    note_preview: preview,
    note_bytes: Buffer.byteLength(note, "utf8"),
    note_truncated: note.length > preview.length,
    memory_bytes: todo.memory_bytes,
  };
  const propsKeys = Object.keys(todo.props || {});
  if (propsKeys.length) row.props_keys = propsKeys;
  if (todo.claimed_by) {
    row.claimed_by = todo.claimed_by;
    row.claimed_until = todo.claimed_until;
    row.heartbeat_at = todo.heartbeat_at;
  }
  // Коммит на задачу есть, а она не закрыта: работа сделана, статус забыли (правило «#N в коммите»).
  if (Array.isArray(todo.commits) && todo.commits.length) {
    row.commits = todo.commits.slice(0, 3).map((commit) => `${commit.sha} ${commit.subject}`.trim());
    row.commit_count = todo.commits.length;
  }
  return row;
}

export function buildShortAgentContext({
  project,
  todos = [],
  relations = [],
  decisions = [],
  inbox = [],
  runs = [],
  history = [],
  memories = [],
  secrets = [],
}) {
  const openTodos = todos.filter((todo) => !CLOSED_STATUSES.has(todo.status));
  const byStatus = {};
  for (const todo of todos) byStatus[todo.status] = (byStatus[todo.status] || 0) + 1;

  const shownDecisions = decisions.slice(0, SHORT_LIMITS.decisions);
  const shownInbox = inbox.slice(0, SHORT_LIMITS.inbox);
  const shownRuns = runs.slice(0, SHORT_LIMITS.runs);
  const shownHistory = history.slice(0, SHORT_LIMITS.history);

  return {
    project: { ...project, props: compactProps(project.props) },
    detail: "short",
    counts: {
      todos: todos.length,
      todos_open: openTodos.length,
      todos_by_status: byStatus,
      relations: relations.length,
      decisions: decisions.length,
      inbox: inbox.length,
      runs: runs.length,
      history: history.length,
      approved_secrets: secrets.length,
      memories: memories.length,
    },
    ...(openTodos.some((todo) => todo.commits?.length)
      ? { needs_closing: openTodos.filter((todo) => todo.commits?.length).map((todo) => todo.id) }
      : {}),
    note: "short: только незакрытые задачи и последние записи. Закрытые задачи, полные тексты и все props — через get_task / get_memory / detail=full.",
    todos: openTodos.map(compactTodo),
    relations: relations.map((relation) => ({
      id: relation.id,
      from_entity: relation.from_entity,
      from_id: relation.from_id,
      from_label: relation.from_label,
      to_entity: relation.to_entity,
      to_id: relation.to_id,
      to_label: relation.to_label,
      edge_type: relation.edge_type,
      title: relation.title,
      description_preview: textPreview(relation.description, 160),
      owner: relation.owner,
      group_entity: relation.group_entity,
      strength: relation.strength,
      valid_until: relation.valid_until,
    })),
    decisions: shownDecisions.map((decision) => ({
      id: decision.id,
      todo_id: decision.todo_id,
      actor: decision.actor,
      title: decision.title,
      decision_preview: textPreview(decision.decision, 160),
      created_at: decision.created_at,
    })),
    inbox: shownInbox.map((item) => ({
      id: item.id,
      agent_name: item.agent_name,
      item_type: item.item_type,
      title: item.title,
      body_preview: textPreview(item.body, 140),
      status: item.status,
      priority: item.priority,
      requires_human: item.requires_human,
      created_at: item.created_at,
    })),
    runs: shownRuns.map((run) => ({
      id: run.id,
      todo_id: run.todo_id,
      agent_name: run.agent_name,
      status: run.status,
      goal: textPreview(run.goal, 140),
      touched_files: Array.isArray(run.touched_files) ? run.touched_files.slice(0, 8) : run.touched_files,
      result_preview: textPreview(run.result, 140),
      started_at: run.started_at,
      finished_at: run.finished_at,
    })),
    history: shownHistory.map((event) => ({
      id: event.id,
      actor: event.actor,
      action: event.action,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      summary: textPreview(event.summary, 140),
      created_at: event.created_at,
    })),
    memories: memories.map((memory) => ({
      id: memory.id,
      todo_id: memory.todo_id,
      title: memory.title,
      content_preview: textPreview(memory.content_preview ?? memory.content, SHORT_LIMITS.memoryText),
      score: memory.score,
    })),
    approved_secrets: secrets.map((secret) => ({
      id: secret.id,
      title: secret.title,
      login: secret.login,
      url: secret.url,
      approved_until: secret.approved_until,
    })),
  };
}
