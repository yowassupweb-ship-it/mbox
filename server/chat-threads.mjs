// Чаты консоли агентов (props.thread у сообщений agent_inbox, кнопка «Новый чат» в AgentChat.tsx).
// Сообщения помечаются id чата, а сам список чатов — с названием, собеседником и архивом — хранится
// в chat_threads: чат виден в списке сразу после создания, до первого сообщения, и переживает
// очистку браузера. Чаты, у которых записи нет (заведённые до таблицы), собираются группировкой
// сообщений. Общий модуль прод/dev, как notes.mjs: иначе две реализации API опять разойдутся.

export const THREAD_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const CHAT_THREADS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  peer TEXT NOT NULL DEFAULT '',
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id, updated_at DESC);
`;

export async function ensureChatThreadsSchema(query) {
  await query(CHAT_THREADS_SCHEMA_SQL);
}

function autoTitle(text) {
  return String(text || "").replace(/^@\S+\s*/, "").replace(/\s+/g, " ").trim().slice(0, 90);
}

/** Чаты пользователя: записи chat_threads + чаты, известные только по сообщениям. Новые сверху. */
export async function listChatThreads(query, { userId, owner, scopeAll = true, projectIds = [], limit = 60, archived = false }) {
  const max = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const derived = (await query(
    `SELECT props->>'thread' AS id,
            min(created_at)::text AS started_at,
            max(created_at)::text AS last_at,
            count(*)::int AS messages,
            (array_agg(COALESCE(NULLIF(body, ''), title) ORDER BY created_at) FILTER (WHERE agent_name = 'Человек'))[1] AS first_message,
            (array_agg(props->>'to' ORDER BY created_at) FILTER (WHERE agent_name = 'Человек' AND COALESCE(props->>'to', '') <> ''))[1] AS peer,
            (array_agg(agent_name ORDER BY created_at DESC) FILTER (WHERE agent_name <> 'Человек'))[1] AS last_agent,
            (array_agg(props->'work' ORDER BY created_at DESC) FILTER (WHERE props ? 'work'))[1] AS last_work
     FROM agent_inbox
     WHERE COALESCE(props->>'thread', '') <> ''
       AND ($1::boolean OR project_id = ANY($2::bigint[]))
       AND (props->>'mbox_user_id' = $3 OR ($4::boolean AND NOT (props ? 'mbox_user_id')))
     GROUP BY props->>'thread'
     ORDER BY max(created_at) DESC
     LIMIT $5`,
    [scopeAll, projectIds, String(userId), Boolean(owner), max * 2],
  )).rows;
  const stored = (await query(
    `SELECT id, title, peer, archived, created_at::text, updated_at::text FROM chat_threads
     WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [String(userId), max * 2],
  )).rows;
  const byId = new Map(derived.map((row) => [row.id, row]));
  const rows = [];
  for (const row of stored) {
    const messages = byId.get(row.id);
    byId.delete(row.id);
    rows.push({
      id: row.id,
      title: row.title || autoTitle(messages?.first_message) || "Новый чат",
      custom_title: Boolean(row.title),
      peer: row.peer || messages?.peer || null,
      last_agent: messages?.last_agent || null,
      messages: messages?.messages || 0,
      started_at: messages?.started_at || row.created_at,
      last_at: messages?.last_at && messages.last_at > row.updated_at ? messages.last_at : row.updated_at,
      last_work: messages?.last_work || null,
      archived: row.archived,
    });
  }
  for (const row of byId.values()) {
    rows.push({ ...row, title: autoTitle(row.first_message) || "Без названия", custom_title: false, archived: false });
  }
  return rows
    .filter((row) => Boolean(row.archived) === Boolean(archived))
    .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)))
    .slice(0, max)
    .map(({ first_message: _first, ...row }) => row);
}

/** /api/mbox/agent/threads[/:id] — список, создание, переименование, архив. */
export async function handleChatThreadsApi({ req, res, url, query, readBody, sendJson, user, owner, scopeAll = true, projectIds = [] }) {
  if (!url.pathname.startsWith("/api/mbox/agent/threads")) return false;
  const userId = String(user?.id || "");
  if (url.pathname === "/api/mbox/agent/threads" && req.method === "GET") {
    sendJson(res, 200, {
      threads: await listChatThreads(query, { userId, owner, scopeAll, projectIds, limit: url.searchParams.get("limit"), archived: url.searchParams.get("archived") === "1" }),
    });
    return true;
  }
  if (url.pathname === "/api/mbox/agent/threads" && req.method === "POST") {
    const body = await readBody(req);
    const id = String(body.id || "");
    if (!THREAD_ID.test(id)) { sendJson(res, 400, { error: "bad_thread_id" }); return true; }
    const row = (await query(
      `INSERT INTO chat_threads(id, user_id, title, peer) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET updated_at = now() WHERE chat_threads.user_id = EXCLUDED.user_id
       RETURNING id, title, peer, archived, created_at::text, updated_at::text`,
      [id, userId, String(body.title || "").trim().slice(0, 120), String(body.peer || "").slice(0, 60)],
    )).rows[0];
    sendJson(res, row ? 201 : 403, row ? { thread: row } : { error: "forbidden" });
    return true;
  }
  const match = url.pathname.match(/^\/api\/mbox\/agent\/threads\/([A-Za-z0-9_-]{1,80})$/);
  if (match && req.method === "PATCH") {
    const body = await readBody(req);
    const has = (field) => Object.prototype.hasOwnProperty.call(body, field);
    // Чат, известный только по сообщениям, получает запись при первом переименовании.
    const row = (await query(
      `INSERT INTO chat_threads(id, user_id, title, archived) VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, false))
       ON CONFLICT (id) DO UPDATE SET
         title = COALESCE($3, chat_threads.title),
         archived = COALESCE($4, chat_threads.archived),
         updated_at = now()
       WHERE chat_threads.user_id = EXCLUDED.user_id
       RETURNING id, title, peer, archived, created_at::text, updated_at::text`,
      [match[1], userId, has("title") ? String(body.title || "").trim().slice(0, 120) : null, has("archived") ? Boolean(body.archived) : null],
    )).rows[0];
    sendJson(res, row ? 200 : 404, row ? { thread: row } : { error: "not_found" });
    return true;
  }
  return false;
}
