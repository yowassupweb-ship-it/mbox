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

/** Автоматизация задачи: в день срока (в `time`, по умолчанию 09:00) агент получает задание. Пустой агент/задание — её нет. */
export function taskAutomationOf(value) {
  if (!value || typeof value !== "object") return null;
  const agent = String(value.agent || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const prompt = String(value.prompt || "").trim().slice(0, 4000);
  if (!agent || !prompt) return null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.time || "")) ? String(value.time) : "09:00";
  const projectId = /^\d+$/.test(String(value.project_id || "")) ? String(value.project_id) : null;
  return { agent, prompt, time, ...(projectId ? { project_id: projectId } : {}) };
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
  if ("automation" in next) {
    const automation = taskAutomationOf(next.automation);
    if (automation) next.automation = automation;
    else delete next.automation;
  }
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
    // Кто поставил событие: пусто — человек, иначе имя агента (Claude, Джарвис…) — видно на событии.
    await query("ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT ''");
    // Автоматизация: в момент каждого повторения агент получает задание — { agent, prompt, project_id }.
    await query("ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS automation JSONB");
    // Запуски автоматизаций: одна строка на повторение — не запустить дважды и показать, чем кончилось.
    await query(`CREATE TABLE IF NOT EXISTS calendar_event_runs (
      event_id BIGINT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      occurrence TEXT NOT NULL,
      fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      inbox_id BIGINT,
      error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (event_id, occurrence)
    )`);
    // Запуски автоматизаций задач: одна строка на срок — не запустить дважды и показать, дошло ли задание до агента.
    await query(`CREATE TABLE IF NOT EXISTS todo_automation_runs (
      todo_id BIGINT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      due TEXT NOT NULL,
      fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      inbox_id BIGINT,
      agent_online BOOLEAN,
      error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (todo_id, due)
    )`);
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

/** Последний запуск автоматизации у задач, где она есть: чем кончилось и был ли агент на связи. */
async function withRuns(query, tasks) {
  const ids = tasks.filter((task) => task.props?.automation).map((task) => task.id);
  if (!ids.length) return tasks;
  const runs = (await query(
    `SELECT DISTINCT ON (todo_id) todo_id::text, due, fired_at::text, inbox_id::text, agent_online, error
       FROM todo_automation_runs WHERE todo_id = ANY($1::bigint[]) ORDER BY todo_id, fired_at DESC`,
    [ids],
  ).catch(() => ({ rows: [] }))).rows;
  const byId = new Map(runs.map((run) => [run.todo_id, run]));
  return tasks.map((task) => {
    const run = byId.get(task.id);
    return run ? { ...task, automation_run: { due: run.due, fired_at: run.fired_at, inbox_id: run.inbox_id, agent_online: run.agent_online, error: run.error } } : task;
  });
}

async function selectTask(query, id) {
  const row = (await query(`SELECT ${TASK_COLUMNS} FROM todos t WHERE t.id = $1`, [id])).rows[0];
  return row ? (await withRuns(query, [shapeTask(row)]))[0] : null;
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
  return { tasks: await withRuns(query, rows.map(shapeTask)), lists: [{ id: PERSONAL, name: "Личные", color: "" }, ...lists] };
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
  to_char(ends_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_at, all_day, location, color, reminder_minutes, recurrence_rule, exdates,
  source, automation`;

/** Автоматизация события: какой агент и что делает в момент каждого повторения. Пустое задание — автоматизации нет. */
export function automationOf(value) {
  if (!value || typeof value !== "object") return null;
  const agent = String(value.agent || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const prompt = String(value.prompt || "").trim().slice(0, 4000);
  if (!agent || !prompt) return null;
  const projectId = /^\d+$/.test(String(value.project_id || "")) ? String(value.project_id) : null;
  return { agent, prompt, ...(projectId ? { project_id: projectId } : {}) };
}

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
  if (body.automation !== undefined) out.automation = automationOf(body.automation);
  return out;
}

const jsonField = (value) => (value == null ? null : JSON.stringify(value));

async function insertEvent(query, userId, fields) {
  return (await query(
    `INSERT INTO calendar_events(owner_user_id, title, description, starts_at, ends_at, all_day, location, color, reminder_minutes, recurrence_rule, exdates, source, automation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) RETURNING ${EVENT_COLUMNS}`,
    [userId, fields.title || "", fields.description || "", fields.starts_at, fields.ends_at, Boolean(fields.all_day), fields.location || "", fields.color || "blue", fields.reminder_minutes ?? null, fields.recurrence_rule || null, fields.exdates || [], fields.source || "", jsonField(fields.automation)],
  )).rows[0];
}

async function updateEventRow(query, id, userId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return (await query(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE id = $1 AND owner_user_id = $2`, [id, userId])).rows[0];
  const sets = keys.map((key, index) => (key === "automation" ? `${key} = $${index + 3}::jsonb` : `${key} = $${index + 3}`));
  return (await query(
    `UPDATE calendar_events SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND owner_user_id = $2 RETURNING ${EVENT_COLUMNS}`,
    [id, userId, ...keys.map((key) => (key === "automation" ? jsonField(fields[key]) : fields[key]))],
  )).rows[0];
}

/** Оборвать серию перед повторением at: UNTIL — за секунду до него. */
function cutRule(rule, at) {
  const parts = parseRule(rule);
  delete parts.COUNT;
  parts.UNTIL = untilValue(new Date(localDate(at).getTime() - 1000));
  return formatRule(parts);
}

/** События человека в диапазоне: повторы развёрнуты, у автоматизаций — чем кончился запуск каждого повторения. */
export async function listEvents(query, userId, from, to) {
  await ensurePlannerSchema(query);
  const rows = (await query(
    `SELECT ${EVENT_COLUMNS} FROM calendar_events
      WHERE owner_user_id = $1 AND starts_at < $2::timestamp AND (recurrence_rule IS NOT NULL OR ends_at >= $3::timestamp)
      ORDER BY starts_at`,
    [userId, to, from],
  )).rows;
  const events = rows.flatMap((row) => expandEvent(row, from, to));
  const automated = rows.filter((row) => row.automation).map((row) => row.id);
  if (!automated.length) return events;
  const runs = (await query(
    "SELECT event_id::text, occurrence, fired_at::text, inbox_id::text, error FROM calendar_event_runs WHERE event_id = ANY($1::bigint[])",
    [automated],
  )).rows;
  const byKey = new Map(runs.map((run) => [`${run.event_id}@${run.occurrence}`, run]));
  return events.map((event) => {
    if (!event.automation) return event;
    const run = byKey.get(`${event.master_id || event.id}@${event.starts_at}`);
    return run ? { ...event, run: { fired_at: run.fired_at, inbox_id: run.inbox_id, error: run.error } } : event;
  });
}

export async function readEvent(query, userId, id) {
  await ensurePlannerSchema(query);
  return (await query(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE id = $1 AND owner_user_id = $2`, [id, userId])).rows[0] || null;
}

/** Новое событие. source — кто поставил: пусто — человек, иначе имя агента. */
export async function createEvent(query, userId, body, source = "") {
  await ensurePlannerSchema(query);
  const fields = eventFields(body || {});
  if (!fields.starts_at || !fields.ends_at) throw Object.assign(new Error("event_time_required"), { status: 400 });
  if (localDate(fields.ends_at) < localDate(fields.starts_at)) fields.ends_at = fields.starts_at;
  return insertEvent(query, userId, { ...fields, source });
}

/**
 * Правка события. У серии scope: all — вся серия; this — одно повторение (в серии исключение, рядом отдельное событие);
 * following — это и следующие (прежняя серия кончается перед ним, новая начинается с него).
 */
export async function changeEvent(query, userId, id, body, source = "") {
  const master = await readEvent(query, userId, id);
  if (!master) return null;
  const editScope = String(body?.scope || "all");
  const at = String(body?.recurrence_id || "");
  const occurrence = master.recurrence_rule && at && valid(localDate(at)) ? isoLocal(localDate(at)) : "";
  const fields = eventFields(body || {});
  if (fields.starts_at === null || fields.ends_at === null) throw Object.assign(new Error("event_time_required"), { status: 400 });
  if (source) fields.source = source;
  const duration = localDate(master.ends_at) - localDate(master.starts_at);
  if (occurrence && editScope === "this") {
    await updateEventRow(query, id, userId, { exdates: [...new Set([...(master.exdates || []), occurrence])] });
    return insertEvent(query, userId, { ...master, starts_at: occurrence, ends_at: isoLocal(new Date(localDate(occurrence).getTime() + duration)), ...fields, recurrence_rule: null, exdates: [] });
  }
  if (occurrence && editScope === "following" && localDate(occurrence) > localDate(master.starts_at)) {
    await updateEventRow(query, id, userId, { recurrence_rule: cutRule(master.recurrence_rule, occurrence) });
    const rule = fields.recurrence_rule !== undefined ? fields.recurrence_rule : master.recurrence_rule;
    return insertEvent(query, userId, {
      ...master,
      starts_at: occurrence,
      ends_at: isoLocal(new Date(localDate(occurrence).getTime() + duration)),
      ...fields,
      recurrence_rule: rule,
      exdates: (master.exdates || []).filter((value) => localDate(value) > localDate(occurrence)),
    });
  }
  if (fields.starts_at && fields.ends_at && localDate(fields.ends_at) < localDate(fields.starts_at)) fields.ends_at = fields.starts_at;
  return updateEventRow(query, id, userId, fields);
}

/** Удаление: this — только повторение, following — это и следующие, all — событие или серия целиком. */
export async function deleteEvent(query, userId, id, editScope = "all", recurrenceId = "") {
  const master = await readEvent(query, userId, id);
  if (!master) return false;
  const occurrence = master.recurrence_rule && recurrenceId && valid(localDate(recurrenceId)) ? isoLocal(localDate(recurrenceId)) : "";
  if (occurrence && editScope === "this") await updateEventRow(query, id, userId, { exdates: [...new Set([...(master.exdates || []), occurrence])] });
  else if (occurrence && editScope === "following" && localDate(occurrence) > localDate(master.starts_at)) await updateEventRow(query, id, userId, { recurrence_rule: cutRule(master.recurrence_rule, occurrence) });
  else await query("DELETE FROM calendar_events WHERE id = $1 AND owner_user_id = $2", [id, userId]);
  return true;
}

// ── Системные автоматизации: слой поверх календаря ───────────────────────────
// То, что MBOX делает сам по расписанию, видно в календаре рядом с делами человека. Сейчас это SEO Wizard:
// дни сценариев (seo-strategy.mjs, scenariosOnDay) и его реальные прогоны со статусом. Новый источник —
// ещё одна функция в AUTOMATION_SOURCES.

const MSK_OFFSET_MS = 3 * 3_600_000;
/** Полдень по Москве этого календарного дня — по нему расписание SEO решает, какие сценарии в этот день. */
const moscowNoon = (date) => new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) - MSK_OFFSET_MS);
/** Момент из базы (timestamptz) → местное время Москвы без зоны, как у событий календаря. */
function moscowLocal(value) {
  const at = Date.parse(String(value || "").replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  if (!Number.isFinite(at)) return "";
  const d = new Date(at + MSK_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

const SEO_TITLES = { daily: "SEO: ежедневный сбор", monday: "SEO: понедельник", thursday: "SEO: четверг", architecture: "SEO: архитектура", authority: "SEO: авторитет", monthly: "SEO: итоги месяца" };

async function seoAutomations(query, from, to, now = new Date()) {
  let seo;
  try { seo = await import("./seo-strategy.mjs"); } catch { return []; }
  const views = await import("./seo-views.mjs").catch(() => ({ SCENARIOS: [] }));
  const scheduler = await import("./seo-scheduler.mjs").catch(() => ({ seoAutorunEnabled: () => false }));
  const autorun = scheduler.seoAutorunEnabled();
  const about = Object.fromEntries((views.SCENARIOS || []).map((item) => [item.id, item.server]));
  const runs = (await query(
    `SELECT id::text, scenario, status, started_at::text, finished_at::text
       FROM seo_runs WHERE started_at >= $1::timestamp - interval '1 day' AND started_at < $2::timestamp + interval '1 day'
      ORDER BY started_at`,
    [from, to],
  ).catch(() => ({ rows: [] }))).rows;
  // Прогоны одного сценария за день — одним пунктом: их бывает по пять подряд (ручные перезапуски),
  // и отдельные блоки в сетке налезали друг на друга. Статус — последнего прогона, число — в подписи.
  const groups = new Map();
  for (const run of runs) {
    const start = moscowLocal(run.started_at);
    if (!start || start < from || start >= to) continue;
    const key = `${run.scenario}@${start.slice(0, 10)}`;
    const group = groups.get(key) || { scenario: run.scenario, first: start, last: start, lastRun: run, count: 0, failed: 0 };
    group.count += 1;
    if (run.status !== "ok" && run.status !== "running") group.failed += 1;
    if (start >= group.last) { group.last = start; group.lastRun = run; }
    if (start < group.first) group.first = start;
    groups.set(key, group);
  }
  const items = [];
  const ranDays = new Set(groups.keys());
  for (const [key, group] of groups) {
    const last = group.lastRun;
    const end = moscowLocal(last.finished_at) || isoLocal(new Date(localDate(group.last).getTime() + 30 * 60_000));
    const n = group.count;
    const word = n % 10 === 1 && n % 100 !== 11 ? "прогон" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "прогона" : "прогонов";
    const times = n > 1 ? `${n} ${word}, последний в ${group.last.slice(11, 16)}` : `прогон в ${group.first.slice(11, 16)}`;
    items.push({
      id: `seo-run:${key}`,
      source: "SEO Wizard",
      title: SEO_TITLES[group.scenario] || `SEO: прогон «${group.scenario}»`,
      starts_at: group.first,
      ends_at: end > group.first ? end : isoLocal(new Date(localDate(group.first).getTime() + 15 * 60_000)),
      status: last.status === "ok" ? "done" : last.status === "running" ? "running" : "failed",
      detail: `${times}${group.failed ? `, с ошибкой ${group.failed}` : ""}. ${about[group.scenario] || ""}`.trim(),
      tab: "seo",
    });
  }
  const today = wallClock(now, "Europe/Moscow").slice(0, 10);
  for (let cursor = localDate(from.slice(0, 10)); isoLocal(cursor) < to; cursor = addDays(cursor, 1)) {
    const day = isoDay(cursor);
    for (const scenario of seo.scenariosOnDay(moscowNoon(cursor))) {
      if (ranDays.has(`${scenario}@${day}`)) continue;
      // Ежедневный сбор при выключенном автозапуске — не событие, а шум на каждом дне календаря.
      if (scenario === "daily" && !autorun) continue;
      // Ежедневный сбор — в 04:00, сценарии недели и месяца — в 05:00 (с этого часа их берёт расписание).
      const hour = scenario === "daily" ? 4 : 5;
      const start = `${day}T${pad(hour)}:00:00`;
      items.push({
        id: `seo-plan:${scenario}:${day}`,
        source: "SEO Wizard",
        title: SEO_TITLES[scenario] || `SEO: ${scenario}`,
        starts_at: start,
        ends_at: `${day}T${pad(hour)}:30:00`,
        // Автозапуск выключен (SEO_AUTORUN) — день по расписанию есть, но сам сбор не стартует.
        status: !autorun ? "off" : day < today ? "missed" : "planned",
        detail: about[scenario] || "",
        tab: "seo",
      });
    }
  }
  return items;
}

const AUTOMATION_SOURCES = [seoAutomations];

/** Системные автоматизации в диапазоне (только чтение): что и когда MBOX запускает сам и чем кончилось. */
export async function listAutomations(query, from, to) {
  const lists = await Promise.all(AUTOMATION_SOURCES.map((source) => source(query, from, to).catch(() => [])));
  return lists.flat().sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

// ── Запуск автоматизаций событий ─────────────────────────────────────────────

/** «Сейчас» по стене часового пояса человека (события хранятся в его местном времени без зоны). */
export function wallClock(now = new Date(), timeZone = process.env.PLANNER_TZ || "Europe/Moscow") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Опоздавший запуск (сервер был выключен) ещё делаем, если с начала прошло не больше этого. */
const AUTOMATION_GRACE_MS = 15 * 60_000;

/**
 * Повторения автоматизаций, которым пора: начало наступило, но не раньше чем GRACE назад, и запуска ещё не было.
 * Возвращает [{ event, occurrence, owner }] — чистая выборка, без записи.
 */
export async function dueAutomations(query, nowWall) {
  await ensurePlannerSchema(query);
  const to = isoLocal(new Date(localDate(nowWall).getTime() + 1000));
  const from = isoLocal(new Date(localDate(nowWall).getTime() - AUTOMATION_GRACE_MS));
  const rows = (await query(
    `SELECT ${EVENT_COLUMNS}, owner_user_id FROM calendar_events
      WHERE automation IS NOT NULL AND starts_at <= $1::timestamp AND (recurrence_rule IS NOT NULL OR starts_at >= $2::timestamp)`,
    [to, from],
  )).rows;
  const due = [];
  for (const row of rows) {
    for (const occurrence of expandEvent(row, from, to)) {
      if (occurrence.starts_at < from || occurrence.starts_at > nowWall) continue;
      due.push({ event: row, occurrence: occurrence.starts_at, owner: String(row.owner_user_id) });
    }
  }
  return due;
}

/**
 * Задачи, у которых наступил срок и есть автоматизация: срок + время ≤ сейчас (но не старше суток) и запуска на этот срок ещё не было.
 * Чистая выборка, без записи. Возвращает [{ todo, due, owner }].
 */
export async function dueTaskAutomations(query, nowWall) {
  await ensurePlannerSchema(query);
  const now = localDate(nowWall).getTime();
  const rows = (await query(
    `SELECT t.id::text, t.project_id::text, t.title, t.note, t.status, t.props
       FROM todos t
      WHERE t.props ? 'automation' AND t.status NOT IN ('done', 'archived') AND t.props->>'due' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        AND NOT EXISTS (SELECT 1 FROM todo_automation_runs r WHERE r.todo_id = t.id AND r.due = substr(t.props->>'due', 1, 10))`,
  )).rows;
  const due = [];
  for (const todo of rows) {
    const automation = taskAutomationOf(todo.props.automation);
    if (!automation) continue;
    const day = String(todo.props.due).slice(0, 10);
    const at = localDate(`${day}T${automation.time}:00`).getTime();
    if (!(at <= now && at >= now - 24 * 3600_000)) continue;
    due.push({ todo: { ...todo, props: { ...todo.props, automation } }, due: day, owner: todo.props.owner_user_id ? String(todo.props.owner_user_id) : "" });
  }
  return due;
}

/** Запустить одну автоматизацию задачи. Повторяющейся задаче срок сразу уезжает на следующий раз. */
async function fireTaskAutomation(query, dispatch, item, log, broadcast) {
  const { todo } = item;
  const automation = todo.props.automation;
  const online = (await query(
    "SELECT 1 FROM agent_presence WHERE lower(agent_name) = lower($1) AND last_seen > now() - interval '3 minutes' LIMIT 1",
    [automation.agent],
  ).catch(() => ({ rows: [] }))).rows.length > 0;
  const claimed = (await query(
    "INSERT INTO todo_automation_runs(todo_id, due, agent_online) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING todo_id",
    [todo.id, item.due, online],
  )).rows[0];
  if (!claimed) return;
  try {
    const inboxId = await dispatch({
      ownerUserId: item.owner,
      agent: automation.agent,
      projectId: automation.project_id || todo.project_id || null,
      title: todo.title,
      prompt: `${automation.prompt}

Задача #${todo.id}: «${todo.title}»${todo.note ? `

${String(todo.note).slice(0, 3000)}` : ""}`,
      todoId: todo.id,
      repeating: Boolean(todo.props.repeat),
      occurrence: item.due,
    });
    await query("UPDATE todo_automation_runs SET inbox_id = $3 WHERE todo_id = $1 AND due = $2", [todo.id, item.due, inboxId || null]);
    const repeat = todo.props.repeat;
    const next = repeat ? nextDue(item.due, repeat) : null;
    if (next) {
      await query("UPDATE todos SET props = props || $2::jsonb, updated_at = now() WHERE id = $1", [todo.id, JSON.stringify({ due: next, last_run_at: new Date().toISOString() })]);
    }
    log(`[planner] автоматизация задачи #${todo.id} «${todo.title}» (${item.due}) → ${automation.agent}${online ? "" : " (агент не на связи)"}`);
  } catch (error) {
    await query("UPDATE todo_automation_runs SET error = $3 WHERE todo_id = $1 AND due = $2", [todo.id, item.due, String(error?.message || error).slice(0, 500)]);
    log(`[planner] автоматизация задачи #${todo.id} не запустилась: ${error?.message || error}`);
  }
  broadcast?.("entity_changed", { entity: "todos", action: "run", silent: true });
}

/**
 * Раз в минуту запускать автоматизации календаря: агенту уходит задание (dispatch — от сервера: вопрос во входящие,
 * у Джарвиса — его ответ). Повторение помечается в calendar_event_runs до отправки — двойного запуска не будет,
 * даже если тиков два (прод и dev на одной базе: dev расписание не запускает).
 */
export function startPlannerAutomations({ query, dispatch, log = console.log, broadcast }) {
  const tick = async () => {
    try {
      const due = await dueAutomations(query, wallClock());
      for (const item of due) {
        const claimed = (await query(
          "INSERT INTO calendar_event_runs(event_id, occurrence) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id",
          [item.event.id, item.occurrence],
        )).rows[0];
        if (!claimed) continue;
        try {
          const inboxId = await dispatch({
            ownerUserId: item.owner,
            agent: item.event.automation.agent,
            projectId: item.event.automation.project_id || null,
            title: item.event.title,
            prompt: item.event.automation.prompt,
            eventId: item.event.id,
            occurrence: item.occurrence,
          });
          await query("UPDATE calendar_event_runs SET inbox_id = $3 WHERE event_id = $1 AND occurrence = $2", [item.event.id, item.occurrence, inboxId || null]);
          log(`[planner] автоматизация «${item.event.title}» (${item.occurrence}) → ${item.event.automation.agent}`);
        } catch (error) {
          await query("UPDATE calendar_event_runs SET error = $3 WHERE event_id = $1 AND occurrence = $2", [item.event.id, item.occurrence, String(error?.message || error).slice(0, 500)]);
          log(`[planner] автоматизация «${item.event.title}» не запустилась: ${error?.message || error}`);
        }
        broadcast?.("entity_changed", { entity: "calendar_events", action: "run", silent: true });
      }
      for (const item of await dueTaskAutomations(query, wallClock())) await fireTaskAutomation(query, dispatch, item, log, broadcast);
    } catch (error) {
      log(`[planner] проверка автоматизаций: ${error?.message || error}`);
    }
  };
  const first = setTimeout(() => void tick(), 20_000);
  const timer = setInterval(() => void tick(), 60_000);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
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

/** Кто правит: агент (заголовок x-mbox-agent) — его имя попадёт на событие; человек — пусто. */
function sourceOf(actor, userName) {
  const name = String(actor || "").trim();
  if (!name || name === "Человек" || name === "Agent" || name === String(userName || "")) return "";
  return name.slice(0, 60);
}

async function handlePlanner({ req, res, url, query, readBody, sendJson, scope = {}, broadcast, actor = "", userName = "" }) {
  const userId = String(scope?.userId || "");
  if (!userId || !url.pathname.startsWith("/api/mbox/planner/")) return false;
  await ensurePlannerSchema(query);
  const changed = (entity, action, detail = {}) => broadcast?.("entity_changed", { entity, action, silent: true, ...detail });
  const source = sourceOf(actor, userName);
  // Задачу поменял агент — интерфейс покажет, кто и что (как с событиями календаря).
  const announceTask = (action, task) => changed("todos", action, source && task ? { actor: source, task_id: String(task.id), title: task.title || "", due: task.props?.due || "" } : {});

  if (url.pathname === "/api/mbox/planner/people" && req.method === "GET") {
    return sendJson(res, 200, await listPeople(query, userId));
  }

  if (url.pathname === "/api/mbox/planner/automations" && req.method === "GET") {
    const from = url.searchParams.get("from") || isoLocal(new Date());
    const to = url.searchParams.get("to") || isoLocal(addDays(new Date(), 7));
    return sendJson(res, 200, { items: await listAutomations(query, from, to) });
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
      const created = await selectTask(query, row.id);
      announceTask("create", created);
      return sendJson(res, 201, { task: created });
    }
    if (!id) return sendJson(res, 405, { error: "method_not_allowed" });
    const current = await readTask(query, id);
    if (!canTouchTask(current, scope, userId)) return sendJson(res, current ? 403 : 404, { error: current ? "forbidden" : "not_found" });
    if (req.method === "GET") return sendJson(res, 200, { task: await selectTask(query, id) });
    if (req.method === "DELETE") {
      const gone = await selectTask(query, id);
      await query("DELETE FROM todos WHERE id = $1", [id]);
      announceTask("delete", gone);
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
    const updated = await selectTask(query, id);
    announceTask("update", updated);
    return sendJson(res, 200, { task: updated, rolled });
  }

  const eventMatch = url.pathname.match(/^\/api\/mbox\/planner\/events(?:\/(\d+))?$/);
  if (eventMatch) {
    const id = eventMatch[1];
    // Агент правит календарь — человек видит это сразу: кто, что и на когда (см. планировщик в интерфейсе).
    const announce = (action, row) => changed("calendar_events", action, source && row ? { actor: source, event_id: String(row.id || id), title: row.title || "", starts_at: row.starts_at || "" } : {});
    try {
      if (!id && req.method === "GET") {
        const from = url.searchParams.get("from") || "1970-01-01T00:00:00";
        const to = url.searchParams.get("to") || "2100-01-01T00:00:00";
        return sendJson(res, 200, { events: await listEvents(query, userId, from, to) });
      }
      if (!id && req.method === "POST") {
        const row = await createEvent(query, userId, await readBody(req), source);
        announce("create", row);
        return sendJson(res, 201, { event: row });
      }
      if (!id) return sendJson(res, 405, { error: "method_not_allowed" });
      if (req.method === "GET") {
        const row = await readEvent(query, userId, id);
        return sendJson(res, row ? 200 : 404, row ? { event: row } : { error: "not_found" });
      }
      if (req.method === "PATCH") {
        const row = await changeEvent(query, userId, id, await readBody(req), source);
        if (!row) return sendJson(res, 404, { error: "not_found" });
        announce("update", row);
        return sendJson(res, 200, { event: row });
      }
      if (req.method === "DELETE") {
        const before = await readEvent(query, userId, id);
        const ok = await deleteEvent(query, userId, id, url.searchParams.get("scope") || "all", url.searchParams.get("recurrence_id") || "");
        if (!ok) return sendJson(res, 404, { error: "not_found" });
        announce("delete", before);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      if (error?.status === 400) return sendJson(res, 400, { error: error.message });
      throw error;
    }
  }

  return false;
}
