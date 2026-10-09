// Связь коммитов с todo. Правило: в сообщении коммита пишем номер задачи (#123). Агенты и люди забывают
// закрывать сделанное — по коммиту видно, что работа была, и незакрытая задача всплывает в контексте агента.
//   «Closes #12», «Fixes #12, #13», «Закрывает #12» — закрывают задачу сразу;
//   просто «#12» или «Refs #12» — привязывают коммит, статус не трогают.

const CLOSE_WORD = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|done|finish(?:e[sd])?|закрыва\\p{L}+|закры\\p{L}+|исправ\\p{L}+|готов\\p{L}*)";
const REF_LIST = "#\\d+(?:\\s*(?:,|и|and|&)\\s*#\\d+)*";
const CLOSE_RE = new RegExp(`${CLOSE_WORD}\\s*:?\\s+(${REF_LIST})`, "giu");
const REF_RE = /(?<![\w&/])#(\d{1,9})(?!\w)/g;

/** Номера задач из сообщения коммита: { refs: все упомянутые, closes: те, что коммит закрывает }. */
export function parseTodoRefs(message) {
  const text = String(message || "");
  const closes = new Set();
  for (const match of text.matchAll(CLOSE_RE)) {
    for (const ref of match[1].matchAll(/#(\d+)/g)) closes.add(ref[1]);
  }
  const refs = new Set(closes);
  for (const match of text.matchAll(REF_RE)) refs.add(match[1]);
  return { refs: [...refs], closes: [...closes] };
}

export async function ensureTodoCommitsSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS todo_commits (
    todo_id BIGINT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    sha TEXT NOT NULL,
    repo TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    closes BOOLEAN NOT NULL DEFAULT false,
    author TEXT NOT NULL DEFAULT '',
    committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (todo_id, sha)
  )`);
  await query("CREATE INDEX IF NOT EXISTS idx_todo_commits_sha ON todo_commits(sha)");
}

/**
 * Записать коммит: привязать к существующим задачам, закрыть те, что коммит закрывает.
 * canTouch(projectId) — проверка доступа вызывающего к проекту задачи. Возвращает, что с какой задачей стало.
 */
export async function recordCommit(query, { sha, message, repo = "", branch = "", author = "", committedAt = null }, { canTouch = () => true } = {}) {
  const cleanSha = String(sha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(cleanSha)) throw Object.assign(new Error("invalid_sha"), { status: 400 });
  const { refs, closes } = parseTodoRefs(message);
  const result = { sha: cleanSha, linked: [], closed: [], already_closed: [], unknown: [], forbidden: [] };
  if (!refs.length) return result;
  await ensureTodoCommitsSchema(query);
  const subject = String(message || "").split("\n")[0].trim().slice(0, 300);
  const todos = (await query("SELECT id::text, project_id::text, status FROM todos WHERE id = ANY($1::bigint[])", [refs])).rows;
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  for (const ref of refs) {
    const todo = byId.get(ref);
    if (!todo) { result.unknown.push(ref); continue; }
    if (!canTouch(todo.project_id)) { result.forbidden.push(ref); continue; }
    const closing = closes.includes(ref);
    await query(
      `INSERT INTO todo_commits(todo_id, sha, repo, branch, subject, closes, author, committed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
       ON CONFLICT (todo_id, sha) DO UPDATE SET subject = EXCLUDED.subject, closes = todo_commits.closes OR EXCLUDED.closes`,
      [ref, cleanSha, String(repo).slice(0, 200), String(branch).slice(0, 200), subject, closing, String(author).slice(0, 120), committedAt || null],
    );
    result.linked.push(ref);
    if (["done", "archived"].includes(todo.status)) { result.already_closed.push(ref); continue; }
    if (closing) {
      await query(
        "UPDATE todos SET status = 'done', claimed_by = '', claimed_until = NULL, heartbeat_at = NULL, updated_at = now() WHERE id = $1",
        [ref],
      );
      result.closed.push({ id: ref, project_id: todo.project_id });
    }
  }
  return result;
}

/** Коммиты по задачам: Map(todoId → [{sha, subject, closes, committed_at}]), свежие первыми. */
export async function commitsForTodos(query, todoIds) {
  const map = new Map();
  if (!todoIds.length) return map;
  try {
    await ensureTodoCommitsSchema(query);
    const rows = (await query(
      "SELECT todo_id::text, sha, subject, closes, committed_at::text FROM todo_commits WHERE todo_id = ANY($1::bigint[]) ORDER BY committed_at DESC",
      [todoIds],
    )).rows;
    for (const row of rows) {
      const list = map.get(row.todo_id) || [];
      list.push({ sha: row.sha.slice(0, 8), subject: row.subject, closes: row.closes, committed_at: row.committed_at });
      map.set(row.todo_id, list);
    }
  } catch {
    // нет таблицы/доступа — контекст агента важнее подсказки
  }
  return map;
}
