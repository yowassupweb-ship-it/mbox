// Уведомления по проектам, как в мессенджере: лента чужих действий в моих проектах, счётчик непрочитанного,
// «прочитать всё» и отключение отдельных проектов. Источник — audit_events: триггер пишет в них user_id автора,
// поэтому свои действия и действия своих агентов в ленту не попадают, а чужие личные чаты и агенты — тоже (берутся
// только общие сущности проекта: задачи и решения).

export const NOTIFICATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  muted BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, project_id)
);
CREATE TABLE IF NOT EXISTS notification_reads (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const WINDOW_DAYS = 30;
const MAX_ITEMS = 100;
const SHOWN_STATUSES = new Set(["done", "review", "blocked"]);
const STATUS_TEXT = { done: "закрыл(а) задачу", review: "отправил(а) на проверку", blocked: "заблокировал(а) задачу" };

export async function ensureNotificationsSchema(query) {
  await query(NOTIFICATIONS_SCHEMA_SQL);
}

function describe(row) {
  if (row.entity_type === "decision_log") return "записал(а) решение";
  if (row.action === "insert") return "создал(а) задачу";
  return STATUS_TEXT[row.status] || "обновил(а) задачу";
}

/** Один и тот же шаг по одной задаче (например, три правки подряд в статусе «закрыта») показываем одной строкой. */
function collapse(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.entity_type}:${row.entity_id}:${row.action}:${row.status || ""}:${row.who}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function readMark(query, userId) {
  // Первое открытие: «прочитано» начинается с этой минуты, иначе вся история месяца показалась бы новой.
  const row = (await query(
    `INSERT INTO notification_reads(user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING read_at::text AS read_at`,
    [userId],
  )).rows[0];
  return row.read_at;
}

export async function listNotifications(query, { user, scope, username }) {
  const userId = String(user.id);
  const readAt = await readMark(query, userId);
  const rows = (await query(
    `SELECT e.id::text, e.project_id::text, p.name AS project_name, e.entity_type, e.entity_id::text, e.action, e.summary,
            e.metadata->>'status' AS status, COALESCE(NULLIF(u.username, ''), e.actor) AS who, e.created_at::text,
            (e.created_at > $5::timestamptz) AS unread
       FROM audit_events e
       JOIN projects p ON p.id = e.project_id
       LEFT JOIN users u ON u.id = e.user_id
      WHERE ($1::boolean OR e.project_id = ANY($2::bigint[]))
        AND e.user_id IS NOT NULL AND e.user_id <> $3::bigint
        AND e.created_at > now() - make_interval(days => $4::int)
        AND ((e.entity_type = 'decision_log' AND e.action = 'insert')
          OR (e.entity_type = 'todos' AND (e.action = 'insert' OR (e.action = 'update' AND e.metadata->>'status' = ANY($6::text[])))))
        AND NOT EXISTS (SELECT 1 FROM notification_prefs n WHERE n.user_id = $3::bigint AND n.project_id = e.project_id AND n.muted)
      ORDER BY e.created_at DESC
      LIMIT $7`,
    [scope.all, scope.projectIds, userId, WINDOW_DAYS, readAt, [...SHOWN_STATUSES], MAX_ITEMS],
  )).rows;
  const items = collapse(rows).map((row) => ({
    id: row.id, project_id: row.project_id, project: row.project_name, entity: row.entity_type, entity_id: row.entity_id,
    who: row.who, text: describe(row), title: row.summary, at: row.created_at, unread: row.unread,
  }));
  const projects = (await query(
    `SELECT p.id::text, p.name, COALESCE(n.muted, false) AS muted
       FROM projects p LEFT JOIN notification_prefs n ON n.project_id = p.id AND n.user_id = $1::bigint
      WHERE $2::boolean OR p.id = ANY($3::bigint[])
      ORDER BY p.name`,
    [userId, scope.all, scope.projectIds],
  )).rows.map((project) => ({
    ...project,
    unread: project.muted ? 0 : items.filter((item) => item.project_id === project.id && item.unread).length,
  }));
  return { items, projects, unread: items.filter((item) => item.unread).length, username };
}

/**
 * GET /notifications — лента и счётчики; POST /notifications/read — прочитать всё;
 * PUT /notifications/prefs {project_id, muted} — выключить или включить проект.
 */
export async function handleNotificationsApi({ req, res, url, query, readBody, sendJson, user, scope, hasProjectAccess }) {
  if (!url.pathname.startsWith("/api/mbox/notifications")) return false;
  const sub = url.pathname.slice("/api/mbox/notifications".length);
  if (sub === "" && req.method === "GET") {
    sendJson(res, 200, await listNotifications(query, { user, scope, username: user.username }));
    return true;
  }
  if (sub === "/read" && req.method === "POST") {
    await query(
      `INSERT INTO notification_reads(user_id, read_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET read_at = now()`,
      [String(user.id)],
    );
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (sub === "/prefs" && req.method === "PUT") {
    const body = await readBody(req);
    const projectId = String(body.project_id || "");
    if (!/^\d+$/.test(projectId)) { sendJson(res, 400, { error: "project_id_required" }); return true; }
    if (!hasProjectAccess(scope, projectId)) { sendJson(res, 403, { error: "project_access_denied" }); return true; }
    await query(
      `INSERT INTO notification_prefs(user_id, project_id, muted) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, project_id) DO UPDATE SET muted = EXCLUDED.muted`,
      [String(user.id), projectId, Boolean(body.muted)],
    );
    sendJson(res, 200, { ok: true });
    return true;
  }
  sendJson(res, 404, { error: "not_found" });
  return true;
}
