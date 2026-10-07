// Планировщик: «Задачи» и «Календарь» (интерфейс перенесён из shar-2, данные — MBOX).
//
// Задачи — это те же todos, что видят агенты и канбан проектов: список задачи = её проект. Личные задачи —
// todos без проекта с props.owner_user_id: их видит и меняет только хозяин (старые без хозяина — владелец MBOX).
// Срок, повтор и исполнители лежат в props (due, repeat, assignees), текст — в note (markdown, как везде в MBOX).
//
// Календарь — личный: calendar_events с owner_user_id. Время локальное, без зоны («2026-10-07T10:00:00»), как в shar.
// Повторы разворачиваются здесь, по диапазону запроса; исключённые повторения — в exdates. Правка одного повторения
// («только это») = исключение в серии + отдельное событие; «это и следующие» = серия обрывается, начинается новая.

const COLORS = new Set(["blue", "green", "orange", "red", "purple", "yellow", "cyan", "gray"]);
const TASK_STATUSES = new Set(["open", "next", "doing", "review", "done"]);
const TASK_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
export const TASK_REPEATS = new Set(["daily", "weekdays", "weekly", "monthly", "yearly"]);
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const PERSONAL = "personal";
/** Выполненные задачи старше этого в список не попадают — их сотни, планированию они не нужны. */
const DONE_DAYS = 60;

// ── Даты: локальное время без зоны ───────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");

export function localDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  return match ? new Date(+match[1], +match[2] - 1, +match[3], +(match[4] || 0), +(match[5] || 0), +(match[6] || 0)) : new Date(NaN);
}

export function isoLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

const isoDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const valid = (date) => !Number.isNaN(date.getTime());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds());
const mondayOf = (date) => addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate()), -((date.getDay() + 6) % 7));

// ── Повтор событий (подмножество RRULE: то, что умеет редактор) ──────────────

export function parseRule(value) {
  return Object.fromEntries(String(value || "").replace(/^RRULE:/i, "").split(";").map((part) => part.split("=")).filter(([key, val]) => key && val).map(([key, val]) => [key.toUpperCase(), val.toUpperCase()]));
}

export function formatRule(rule) {
  return Object.entries(rule).filter(([, val]) => val).map(([key, val]) => `${key}=${val}`).join(";");
}

/** UNTIL из правила: «20261007» или «20261007T235959» → момент включительно. */
function ruleUntil(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!match) return null;
  return match[4] ? new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : new Date(+match[1], +match[2] - 1, +match[3], 23, 59, 59);
}

const untilValue = (date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

/** Начала повторений серии от её начала, пока не вышли за to (или за UNTIL/COUNT). */
export function* occurrences(startValue, ruleValue, toValue) {
  const start = localDate(startValue);
  const to = localDate(toValue);
  if (!valid(start)) return;
  if (!ruleValue) { yield start; return; }
  const rule = parseRule(ruleValue);
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const until = ruleUntil(rule.UNTIL);
  const limit = Number(rule.COUNT) > 0 ? Number(rule.COUNT) : Infinity;
  const end = until && until < to ? until : to;
  let count = 0;
  if (rule.FREQ === "WEEKLY" && rule.BYDAY) {
    const days = new Set(rule.BYDAY.split(","));
    const firstWeek = mondayOf(start);
    for (let cursor = start; cursor <= end && count < limit; cursor = addDays(cursor, 1)) {
      const week = Math.round((mondayOf(cursor) - firstWeek) / 604800000);
      if (week % interval !== 0 || !days.has(WEEKDAYS[cursor.getDay()])) continue;
      count += 1;
      yield cursor;
    }
    return;
  }
  for (let step = 0; count < limit && step < 5000; step += 1) {
    let cursor;
    if (rule.FREQ === "DAILY") cursor = addDays(start, step * interval);
    else if (rule.FREQ === "WEEKLY") cursor = addDays(start, step * 7 * interval);
    else if (rule.FREQ === "MONTHLY" || rule.FREQ === "YEARLY") {
      const months = step * interval * (rule.FREQ === "YEARLY" ? 12 : 1);
      cursor = new Date(start.getFullYear(), start.getMonth() + months, start.getDate(), start.getHours(), start.getMinutes());
      // 31-е в коротком месяце не переносим на 1-е следующего — такого повторения просто нет.
      if (cursor.getDate() !== start.getDate()) continue;
    } else { yield start; return; }
    if (cursor > end) return;
    count += 1;
    yield cursor;
  }
}

/** Повторения события в диапазоне [from, to): каждое — отдельная запись с master_id и recurrence_id. */
export function expandEvent(event, fromValue, toValue) {
  const start = localDate(event.starts_at);
  const duration = Math.max(0, localDate(event.ends_at) - start);
  const from = localDate(fromValue);
  const to = localDate(toValue);
  const skip = new Set((event.exdates || []).map((value) => isoLocal(localDate(value))));
  const output = [];
  for (const cursor of occurrences(event.starts_at, event.recurrence_rule, toValue)) {
    if (cursor >= to) break;
    const finish = new Date(cursor.getTime() + duration);
    const key = isoLocal(cursor);
    // Событие на весь день, кончающееся в начале диапазона, его касается; обычное — нет.
    if (finish < from || (finish.getTime() === from.getTime() && duration > 0) || skip.has(key)) continue;
    const base = { ...event, starts_at: key, ends_at: isoLocal(finish) };
    delete base.exdates;
    output.push(event.recurrence_rule ? { ...base, id: `${event.id}::${key}`, master_id: String(event.id), recurrence_id: key } : base);
    if (output.length > 2000) break;
  }
  return output;
}

// ── Повтор задач: выполнили — срок уезжает на следующий раз ──────────────────

export function nextDue(due, repeat) {
  const date = localDate(due);
  if (!valid(date) || !TASK_REPEATS.has(repeat)) return null;
  if (repeat === "daily") return isoDay(addDays(date, 1));
  if (repeat === "weekly") return isoDay(addDays(date, 7));
  if (repeat === "weekdays") {
    let next = addDays(date, 1);
    while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
    return isoDay(next);
  }
  const months = repeat === "yearly" ? 12 : 1;
  const next = new Date(date.getFullYear(), date.getMonth() + months, 1);
  // 31 января → 28/29 февраля: последний день месяца, а не 3 марта.
  next.setDate(Math.min(date.getDate(), new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
  return isoDay(next);
}

/** props задачи после правки: null у ключа — удалить ключ. Служебный owner_user_id правкой не трогается. */
export function mergeProps(current, patch) {
  const next = { ...(current && typeof current === "object" ? current : {}) };
  for (const [key, value] of Object.entries(patch && typeof patch === "object" ? patch : {})) {
    if (key === "owner_user_id") continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (next.repeat && !TASK_REPEATS.has(next.repeat)) delete next.repeat;
  if (next.due && !/^\d{4}-\d{2}-\d{2}/.test(String(next.due))) delete next.due;
  if (next.assignees && !Array.isArray(next.assignees)) delete next.assignees;
  if (Array.isArray(next.assignees)) next.assignees = [...new Set(next.assignees.map(String).filter(Boolean))].slice(0, 20);
  return next;
}

// ── Схема ────────────────────────────────────────────────────────────────────

let schemaReady = null;
function ensurePlannerSchema(query) {
  schemaReady ||= (async () => {
    await query(`CREATE TABLE IF NOT EXISTS calendar_events (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starts_at TIMESTAMP NOT NULL,
      ends_at TIMESTAMP NOT NULL,
      all_day BOOLEAN NOT NULL DEFAULT false,
      location TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'blue',
      reminder_minutes INTEGER,
      recurrence_rule TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (ends_at >= starts_at)
    )`);
    await query("CREATE INDEX IF NOT EXISTS idx_calendar_events_owner_range ON calendar_events(owner_user_id, starts_at, ends_at)");
    // Исключённые повторения серии («удалить только это», «изменить только это»).
    await query("ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS exdates TEXT[] NOT NULL DEFAULT '{}'");
    await query("CREATE INDEX IF NOT EXISTS idx_todos_personal_owner ON todos ((props->>'owner_user_id')) WHERE project_id IS NULL");
  })().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

// ── Задачи ───────────────────────────────────────────────────────────────────

const TASK_COLUMNS = `t.id::text, COALESCE(t.project_id::text, '${PERSONAL}') AS list_id, t.title, t.note, t.status, t.priority, t.props,
  t.claimed_by, (t.claimed_until > now()) AS claim_active, t.created_at::text, t.updated_at::text`;

function shapeTask(row) {
  const props = row.props && typeof row.props === "object" ? row.props : {};
  const { owner_user_id: _owner, ...rest } = props;
  return { ...row, props: rest, claim_active: Boolean(row.claim_active) };
}

/** Может ли человек менять задачу: личная — только хозяин, проектная — по доступу к проекту. */
function canTouchTask(row, scope, userId) {
  if (!row) return false;
  if (row.project_id == null) {
    const owner = row.props?.owner_user_id;
    return owner ? String(owner) === userId : Boolean(scope.all);
  }
  return Boolean(scope.all) || (scope.projectIds || []).map(String).includes(String(row.project_id));
}

function canUseList(listId, scope) {
  return listId === PERSONAL || Boolean(scope.all) || (scope.projectIds || []).map(String).includes(String(listId));
}

async function readTask(query, id) {
  return (await query("SELECT id::text, project_id::text, props, status FROM todos WHERE id = $1", [id])).rows[0];
}

async function selectTask(query, id) {
  const row = (await query(`SELECT ${TASK_COLUMNS} FROM todos t WHERE t.id = $1`, [id])).rows[0];
  return row ? shapeTask(row) : null;
}

async function listTasks(query, scope, userId) {
  const rows = (await query(
    `SELECT ${TASK_COLUMNS}
       FROM todos t
      WHERE t.status <> 'archived'
        AND (t.status <> 'done' OR t.updated_at > now() - make_interval(days => $4))
        AND (
          (t.project_id IS NOT NULL AND ($1::boolean OR t.project_id = ANY($2::bigint[])))
          OR (t.project_id IS NULL AND (t.props->>'owner_user_id' = $3 OR ($1::boolean AND NOT (t.props ? 'owner_user_id'))))
        )
      ORDER BY t.updated_at DESC
      LIMIT 2000`,
    [Boolean(scope.all), (scope.projectIds || []).map(String), userId, DONE_DAYS],
  )).rows;
  const lists = (await query(
    `SELECT id::text, name, COALESCE(color, '') AS color FROM projects
      WHERE ($1::boolean OR id = ANY($2::bigint[])) AND COALESCE(status, 'active') <> 'archived'
      ORDER BY lower(name)`,
    [Boolean(scope.all), (scope.projectIds || []).map(String)],
  ).catch(() => query(
    "SELECT id::text, name, COALESCE(color, '') AS color FROM projects WHERE ($1::boolean OR id = ANY($2::bigint[])) ORDER BY lower(name)",
    [Boolean(scope.all), (scope.projectIds || []).map(String)],
  ))).rows;
  return { tasks: rows.map(shapeTask), lists: [{ id: PERSONAL, name: "Личные", color: "" }, ...lists] };
}

/** Люди и агенты, которых можно назначить исполнителем: id «user:1» / «agent:Claude». */
async function listPeople(query, userId) {
  const users = (await query("SELECT id::text, username FROM users ORDER BY lower(username)")).rows;
  const agents = (await query(
    `SELECT DISTINCT agent_name FROM agent_presence
      WHERE (owner_user_id::text = $1 OR owner_user_id IS NULL) AND kind IN ('local_watcher', 'cloud_agent', 'cron_archivist')
      ORDER BY agent_name`,
    [userId],
  ).catch(() => ({ rows: [] }))).rows;
  return {
    me: `user:${userId}`,
    people: [
      ...users.map((row) => ({ id: `user:${row.id}`, name: row.username, kind: "user" })),
      ...agents.map((row) => ({ id: `agent:${row.agent_name}`, name: row.agent_name, kind: "agent" })),
    ],
  };
}

// ── События ──────────────────────────────────────────────────────────────────

const EVENT_COLUMNS = `id::text, title, description, to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at,
  to_char(ends_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_at, all_day, location, color, reminder_minutes, recurrence_rule, exdates`;

/** Поля события из тела запроса; отсутствующее поле — undefined (правка его не трогает). */
export function eventFields(body) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title || "").trim().slice(0, 300);
  if (body.description !== undefined) out.description = String(body.description || "").slice(0, 20000);
  if (body.start !== undefined) out.starts_at = valid(localDate(body.start)) ? isoLocal(localDate(body.start)) : null;
  if (body.end !== undefined) out.ends_at = valid(localDate(body.end)) ? isoLocal(localDate(body.end)) : null;
  if (body.all_day !== undefined) out.all_day = Boolean(body.all_day);
  if (body.location !== undefined) out.location = String(body.location || "").slice(0, 300);
  if (body.color !== undefined) out.color = COLORS.has(body.color) ? body.color : "blue";
  if (body.reminder_minutes !== undefined) out.reminder_minutes = body.reminder_minutes == null || body.reminder_minutes === "" ? null : Math.max(0, Math.round(Number(body.reminder_minutes)) || 0);
  if (body.recurrence_rule !== undefined) out.recurrence_rule = body.recurrence_rule ? formatRule(parseRule(body.recurrence_rule)) || null : null;
  return out;
}

async function insertEvent(query, userId, fields) {
  const row = (await query(
    `INSERT INTO calendar_events(owner_user_id, title, description, starts_at, ends_at, all_day, location, color, reminder_minutes, recurrence_rule, exdates)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${EVENT_COLUMNS}`,
    [userId, fields.title || "", fields.description || "", fields.starts_at, fields.ends_at, Boolean(fields.all_day), fields.location || "", fields.color || "blue", fields.reminder_minutes ?? null, fields.recurrence_rule || null, fields.exdates || []],
  )).rows[0];
  return row;
}

async function updateEventRow(query, id, userId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return (await query(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE id = $1 AND owner_user_id = $2`, [id, userId])).rows[0];
  const sets = keys.map((key, index) => `${key} = $${index + 3}`);
  return (await query(
    `UPDATE calendar_events SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND owner_user_id = $2 RETURNING ${EVENT_COLUMNS}`,
    [id, userId, ...keys.map((key) => fields[key])],
  )).rows[0];
}

/** Оборвать серию перед повторением at: UNTIL — за секунду до него. */
function cutRule(rule, at) {
  const parts = parseRule(rule);
  delete parts.COUNT;
  parts.UNTIL = untilValue(new Date(localDate(at).getTime() - 1000));
  return formatRule(parts);
}

// ── Маршруты ─────────────────────────────────────────────────────────────────

/**
 * Вернуть true, если запрос был планировщика и ответ отправлен; false — не наш маршрут, пусть идёт дальше.
 * Внутренние ветки возвращают результат sendJson (undefined), и вызывающий код принимал это за «не обработано»
 * и отвечал вторым разом (404) — на проде это падение процесса.
 */
export async function handlePlannerApi(context) {
  return (await handlePlanner(context)) !== false;
}

async function handlePlanner({ req, res, url, query, readBody, sendJson, scope = {}, broadcast }) {
  const userId = String(scope?.userId || "");
  if (!userId || !url.pathname.startsWith("/api/mbox/planner/")) return false;
  await ensurePlannerSchema(query);
  const changed = (entity, action) => broadcast?.("entity_changed", { entity, action, silent: true });

  if (url.pathname === "/api/mbox/planner/people" && req.method === "GET") {
    return sendJson(res, 200, await listPeople(query, userId));
  }

  const taskMatch = url.pathname.match(/^\/api\/mbox\/planner\/tasks(?:\/(\d+))?$/);
  if (taskMatch) {
    const id = taskMatch[1];
    if (!id && req.method === "GET") return sendJson(res, 200, await listTasks(query, scope, userId));
    if (!id && req.method === "POST") {
      const body = await readBody(req);
      const listId = String(body.list_id || PERSONAL);
      if (!canUseList(listId, scope)) return sendJson(res, 403, { error: "forbidden" });
      const status = TASK_STATUSES.has(body.status) ? body.status : "open";
      const priority = TASK_PRIORITIES.has(body.priority) ? body.priority : "normal";
      const props = mergeProps(listId === PERSONAL ? { owner_user_id: userId } : {}, body.props);
      if (listId === PERSONAL) props.owner_user_id = userId;
      const row = (await query(
        `INSERT INTO todos(project_id, title, note, status, priority, props) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
        [listId === PERSONAL ? null : listId, String(body.title || "").trim().slice(0, 500), String(body.note || ""), status, priority, JSON.stringify(props)],
      )).rows[0];
      changed("todos", "create");
      return sendJson(res, 201, { task: await selectTask(query, row.id) });
    }
    if (!id) return sendJson(res, 405, { error: "method_not_allowed" });
    const current = await readTask(query, id);
    if (!canTouchTask(current, scope, userId)) return sendJson(res, current ? 403 : 404, { error: current ? "forbidden" : "not_found" });
    if (req.method === "GET") return sendJson(res, 200, { task: await selectTask(query, id) });
    if (req.method === "DELETE") {
      await query("DELETE FROM todos WHERE id = $1", [id]);
      changed("todos", "delete");
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== "PATCH") return sendJson(res, 405, { error: "method_not_allowed" });
    const body = await readBody(req);
    let props = mergeProps(current.props, body.props);
    let status = body.status !== undefined && TASK_STATUSES.has(body.status) ? body.status : null;
    let rolled = null;
    // Повторяющаяся задача не закрывается: срок уезжает на следующий раз, задача остаётся открытой.
    if (status === "done" && props.repeat && props.due) {
      const next = nextDue(props.due, props.repeat);
      if (next) {
        rolled = { from: props.due, to: next };
        props = { ...props, due: next, last_done_at: new Date().toISOString() };
        status = current.status === "done" ? "open" : current.status;
      }
    }
    let projectId;
    if (body.list_id !== undefined) {
      const listId = String(body.list_id || PERSONAL);
      if (!canUseList(listId, scope)) return sendJson(res, 403, { error: "forbidden" });
      projectId = listId === PERSONAL ? null : listId;
      // В личные — хозяином становится тот, кто перенёс; в проект — личная метка снимается.
      if (projectId === null) props.owner_user_id = current.project_id == null && current.props?.owner_user_id ? current.props.owner_user_id : userId;
      else delete props.owner_user_id;
    } else if (current.props?.owner_user_id) {
      props.owner_user_id = current.props.owner_user_id;
    }
    const closing = status === "done";
    await query(
      `UPDATE todos SET
         title = COALESCE($2, title),
         note = COALESCE($3, note),
         status = COALESCE($4, status),
         priority = COALESCE($5, priority),
         props = $6,
         project_id = CASE WHEN $7::boolean THEN $8::bigint ELSE project_id END,
         claimed_by = CASE WHEN $9::boolean THEN '' ELSE claimed_by END,
         claimed_until = CASE WHEN $9::boolean THEN NULL ELSE claimed_until END,
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        body.title !== undefined ? String(body.title || "").trim().slice(0, 500) : null,
        body.note !== undefined ? String(body.note || "") : null,
        status,
        body.priority !== undefined && TASK_PRIORITIES.has(body.priority) ? body.priority : null,
        JSON.stringify(props),
        projectId !== undefined,
        projectId ?? null,
        closing,
      ],
    );
    changed("todos", "update");
    return sendJson(res, 200, { task: await selectTask(query, id), rolled });
  }

  const eventMatch = url.pathname.match(/^\/api\/mbox\/planner\/events(?:\/(\d+))?$/);
  if (eventMatch) {
    const id = eventMatch[1];
    if (!id && req.method === "GET") {
      const from = url.searchParams.get("from") || "1970-01-01T00:00:00";
      const to = url.searchParams.get("to") || "2100-01-01T00:00:00";
      // Серии без конца начинаются когда угодно раньше диапазона — берём всё, что началось до его конца.
      const rows = (await query(
        `SELECT ${EVENT_COLUMNS} FROM calendar_events
          WHERE owner_user_id = $1 AND starts_at < $2::timestamp AND (recurrence_rule IS NOT NULL OR ends_at >= $3::timestamp)
          ORDER BY starts_at`,
        [userId, to, from],
      )).rows;
      return sendJson(res, 200, { events: rows.flatMap((row) => expandEvent(row, from, to)) });
    }
    if (!id && req.method === "POST") {
      const fields = eventFields(await readBody(req));
      if (!fields.starts_at || !fields.ends_at) return sendJson(res, 400, { error: "event_time_required" });
      if (localDate(fields.ends_at) < localDate(fields.starts_at)) fields.ends_at = fields.starts_at;
      const row = await insertEvent(query, userId, fields);
      changed("calendar_events", "create");
      return sendJson(res, 201, { event: row });
    }
    if (!id) return sendJson(res, 405, { error: "method_not_allowed" });
    const master = (await query(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE id = $1 AND owner_user_id = $2`, [id, userId])).rows[0];
    if (!master) return sendJson(res, 404, { error: "not_found" });
    if (req.method === "GET") return sendJson(res, 200, { event: master });

    const body = req.method === "PATCH" ? await readBody(req) : {};
    const editScope = String((req.method === "DELETE" ? url.searchParams.get("scope") : body.scope) || "all");
    const at = String((req.method === "DELETE" ? url.searchParams.get("recurrence_id") : body.recurrence_id) || "");
    const occurrence = master.recurrence_rule && at && valid(localDate(at)) ? isoLocal(localDate(at)) : "";
    const exdates = [...new Set([...(master.exdates || []), occurrence].filter(Boolean))];

    if (req.method === "DELETE") {
      if (occurrence && editScope === "this") await updateEventRow(query, id, userId, { exdates });
      else if (occurrence && editScope === "following" && localDate(occurrence) > localDate(master.starts_at)) await updateEventRow(query, id, userId, { recurrence_rule: cutRule(master.recurrence_rule, occurrence) });
      else await query("DELETE FROM calendar_events WHERE id = $1 AND owner_user_id = $2", [id, userId]);
      changed("calendar_events", "delete");
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== "PATCH") return sendJson(res, 405, { error: "method_not_allowed" });

    const fields = eventFields(body);
    if (fields.starts_at === null || fields.ends_at === null) return sendJson(res, 400, { error: "event_time_required" });
    let row;
    if (occurrence && editScope === "this") {
      // Одно повторение: в серии — исключение, рядом — самостоятельное событие с правкой.
      const duration = localDate(master.ends_at) - localDate(master.starts_at);
      const ownStart = isoLocal(localDate(occurrence));
      const ownEnd = isoLocal(new Date(localDate(occurrence).getTime() + duration));
      await updateEventRow(query, id, userId, { exdates });
      row = await insertEvent(query, userId, { ...master, starts_at: ownStart, ends_at: ownEnd, ...fields, recurrence_rule: null, exdates: [] });
    } else if (occurrence && editScope === "following" && localDate(occurrence) > localDate(master.starts_at)) {
      // Это и следующие: прежняя серия кончается перед ним, новая начинается с него.
      const duration = localDate(master.ends_at) - localDate(master.starts_at);
      const ownStart = isoLocal(localDate(occurrence));
      const ownEnd = isoLocal(new Date(localDate(occurrence).getTime() + duration));
      await updateEventRow(query, id, userId, { recurrence_rule: cutRule(master.recurrence_rule, occurrence) });
      const rule = fields.recurrence_rule !== undefined ? fields.recurrence_rule : master.recurrence_rule;
      row = await insertEvent(query, userId, { ...master, starts_at: ownStart, ends_at: ownEnd, ...fields, recurrence_rule: rule, exdates: (master.exdates || []).filter((value) => localDate(value) > localDate(occurrence)) });
    } else {
      if (fields.starts_at && fields.ends_at && localDate(fields.ends_at) < localDate(fields.starts_at)) fields.ends_at = fields.starts_at;
      row = await updateEventRow(query, id, userId, fields);
    }
    changed("calendar_events", "update");
    return sendJson(res, 200, { event: row });
  }

  return false;
}
