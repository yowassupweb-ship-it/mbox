const COLORS = new Set(["blue", "green", "orange", "red", "purple", "yellow", "cyan", "gray"]);
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function parseRule(value) {
  return Object.fromEntries(String(value || "").replace(/^RRULE:/i, "").split(";").map((part) => part.split("=")).filter(([key, val]) => key && val));
}

export function localDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  return match ? new Date(+match[1], +match[2] - 1, +match[3], +(match[4] || 0), +(match[5] || 0), +(match[6] || 0)) : new Date(value);
}

export function isoLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

export function expandRecurringEvent(event, rangeStart, rangeEnd) {
  const start = localDate(event.starts_at);
  const end = localDate(event.ends_at);
  const from = localDate(rangeStart);
  const to = localDate(rangeEnd);
  if (!event.recurrence_rule) return end >= from && start <= to ? [{ ...event, starts_at: isoLocal(start), ends_at: isoLocal(end) }] : [];
  const rule = parseRule(event.recurrence_rule);
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const until = rule.UNTIL ? localDate(rule.UNTIL.replace(/^(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")) : to;
  const duration = end.getTime() - start.getTime();
  const output = [];
  const cursor = new Date(start);
  let count = 0;
  while (cursor <= to && cursor <= until && count < 1000) {
    const weeks = Math.floor((cursor - start) / 604800000);
    const validWeekday = !rule.BYDAY || rule.BYDAY.split(",").includes(WEEKDAYS[cursor.getDay()]);
    const valid = rule.FREQ === "WEEKLY" && rule.BYDAY ? weeks % interval === 0 && validWeekday : true;
    if (valid && new Date(cursor.getTime() + duration) >= from) output.push({ ...event, id: `${event.id}::${isoLocal(cursor)}`, master_id: String(event.id), recurrence_id: isoLocal(cursor), starts_at: isoLocal(cursor), ends_at: isoLocal(new Date(cursor.getTime() + duration)) });
    if (rule.FREQ === "DAILY" || (rule.FREQ === "WEEKLY" && rule.BYDAY)) cursor.setDate(cursor.getDate() + (rule.FREQ === "DAILY" ? interval : 1));
    else if (rule.FREQ === "WEEKLY") cursor.setDate(cursor.getDate() + 7 * interval);
    else if (rule.FREQ === "MONTHLY") cursor.setMonth(cursor.getMonth() + interval);
    else if (rule.FREQ === "YEARLY") cursor.setFullYear(cursor.getFullYear() + interval);
    else break;
    count += 1;
  }
  return output;
}

function taskInput(body) {
  return [String(body.title || "").trim(), String(body.description || ""), body.due_at || null, body.recurrence_rule || null, body.completed ? new Date().toISOString() : null];
}

function eventInput(body) {
  return [String(body.title || "").trim(), String(body.description || ""), body.starts_at, body.ends_at, Boolean(body.all_day), String(body.location || ""), COLORS.has(body.color) ? body.color : "blue", body.reminder_minutes == null ? null : Number(body.reminder_minutes), body.recurrence_rule || null];
}

/**
 * Вернуть true, если запрос был планировщика и ответ отправлен; false — не наш маршрут, пусть идёт дальше.
 * Внутренние ветки возвращают результат sendJson (undefined), и вызывающий код принимал это за «не обработано»
 * и отвечал вторым разом (404) — на проде это падение процесса.
 */
export async function handlePlannerApi(context) {
  return (await handlePlanner(context)) !== false;
}

async function handlePlanner({ req, res, url, query, readBody, sendJson, scope, broadcast }) {
  const userId = String(scope?.userId || "");
  if (!userId) return false;
  const task = url.pathname.match(/^\/api\/mbox\/personal-tasks(?:\/(\d+))?$/);
  const event = url.pathname.match(/^\/api\/mbox\/calendar-events(?:\/(\d+))?$/);
  if (!task && !event) return false;
  if (task) {
    const id = task[1];
    if (req.method === "GET" && !id) return sendJson(res, 200, { tasks: (await query("SELECT id::text, title, description, due_at::text, recurrence_rule, completed_at::text, created_at::text, updated_at::text FROM personal_tasks WHERE owner_user_id=$1 ORDER BY completed_at NULLS FIRST, due_at NULLS LAST, created_at DESC", [userId])).rows });
    if (req.method === "POST" && !id) { const values = taskInput(await readBody(req)); if (!values[0]) return sendJson(res, 400, { error: "title_required" }); const row = (await query("INSERT INTO personal_tasks(owner_user_id,title,description,due_at,recurrence_rule,completed_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text,*", [userId, ...values])).rows[0]; broadcast?.("entity_changed", { entity: "personal_tasks", silent: true }); return sendJson(res, 201, { task: row }); }
    if (req.method === "PATCH" && id) { const body = await readBody(req); const row = (await query("UPDATE personal_tasks SET title=COALESCE(NULLIF($1,''),title),description=$2,due_at=$3,recurrence_rule=$4,completed_at=$5,updated_at=now() WHERE id=$6 AND owner_user_id=$7 RETURNING id::text,*", [...taskInput(body), id, userId])).rows[0]; broadcast?.("entity_changed", { entity: "personal_tasks", silent: true }); return sendJson(res, row ? 200 : 404, row ? { task: row } : { error: "not_found" }); }
    if (req.method === "DELETE" && id) { await query("DELETE FROM personal_tasks WHERE id=$1 AND owner_user_id=$2", [id, userId]); broadcast?.("entity_changed", { entity: "personal_tasks", silent: true }); return sendJson(res, 200, { ok: true }); }
  }
  if (event) {
    const id = event[1];
    if (req.method === "GET" && !id) { const from = url.searchParams.get("from") || "1970-01-01"; const to = url.searchParams.get("to") || "2100-01-01"; const rows = (await query("SELECT id::text, title, description, starts_at::text, ends_at::text, all_day, location, color, reminder_minutes, recurrence_rule FROM calendar_events WHERE owner_user_id=$1 AND starts_at <= $2::timestamp ORDER BY starts_at", [userId, to])).rows; return sendJson(res, 200, { events: rows.flatMap((row) => expandRecurringEvent(row, from, to)) }); }
    if (req.method === "POST" && !id) { const values = eventInput(await readBody(req)); if (!values[0] || !values[2] || !values[3]) return sendJson(res, 400, { error: "event_fields_required" }); const row = (await query("INSERT INTO calendar_events(owner_user_id,title,description,starts_at,ends_at,all_day,location,color,reminder_minutes,recurrence_rule) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text,*", [userId, ...values])).rows[0]; broadcast?.("entity_changed", { entity: "calendar_events", silent: true }); return sendJson(res, 201, { event: row }); }
    if (req.method === "PATCH" && id) { const row = (await query("UPDATE calendar_events SET title=$1,description=$2,starts_at=$3,ends_at=$4,all_day=$5,location=$6,color=$7,reminder_minutes=$8,recurrence_rule=$9,updated_at=now() WHERE id=$10 AND owner_user_id=$11 RETURNING id::text,*", [...eventInput(await readBody(req)), id, userId])).rows[0]; broadcast?.("entity_changed", { entity: "calendar_events", silent: true }); return sendJson(res, row ? 200 : 404, row ? { event: row } : { error: "not_found" }); }
    if (req.method === "DELETE" && id) { await query("DELETE FROM calendar_events WHERE id=$1 AND owner_user_id=$2", [id, userId]); broadcast?.("entity_changed", { entity: "calendar_events", silent: true }); return sendJson(res, 200, { ok: true }); }
  }
  return sendJson(res, 405, { error: "method_not_allowed" });
}
