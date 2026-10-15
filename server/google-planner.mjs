// Синхронизация планировщика MBOX с Google Календарём и Google Задачами (двусторонняя, у каждого человека своя).
//
// Вход — отдельное подключение `google_planner` в oauth_connections: у человека только свой постоянный токен и только права на календарь и
// задачи (почта и Диск не просятся). Приложение OAuth (Client ID и секрет) общее на экземпляр: его владелец уже внёс при подключении Gmail
// («Настройки → Интеграции → Gmail»), а в Google Cloud у этого же проекта нужно включить Calendar API и Tasks API. Адрес возврата тот же,
// /api/mbox/oauth/google/callback; кому он принадлежит — решает одноразовый state (provider = google_planner).
//
// Что с чем связано.
//   События: calendar_events ↔ выбранные календари Google (основной всегда; новые события MBOX уходят в основной). Повторы (RRULE, исключённые
//   даты) переезжают как есть. Отдельные повторения, изменённые в Google (recurringEventId), становятся в MBOX отдельным событием, а в серии
//   их исходная дата исключается; отменённое повторение — просто исключённая дата. Календари только для чтения (праздники, чужие) приходят
//   в MBOX, но правки из MBOX туда не отправляются. Время MBOX — местное без зоны, зона из PLANNER_TZ (по умолчанию Europe/Moscow).
//   Задачи: личные задачи (todos без проекта с props.owner_user_id) ↔ выбранные списки Google Tasks (новые задачи MBOX — в список по умолчанию):
//   название, заметка, срок (дата), выполнено. Приоритет, повтор, исполнители и автоматизации остаются только в MBOX; проектные задачи в Google
//   не уходят. Снятый с выбора календарь или список убирает из MBOX то, что пришло из него (в Google всё остаётся).
//
// Как сверяется. Таблица google_links хранит пару «локальная запись — запись Google», календарь или список Google, etag/метку Google и время
// правки MBOX на момент последней сверки. Сначала забираем изменения Google (события — по syncToken каждого календаря, задачи — по updatedMin
// каждого списка), потом отправляем локальные правки и удаления. Если запись изменили с обеих сторон, побеждает та, что новее. Своё же эхо
// (запись, которую мы только что отправили) не пишется обратно.
//
// Когда сверяется. Правка в MBOX (через интерфейс, агента, дерево задач — любым путём) замечается проверкой раз в 30 секунд и уходит в Google
// сразу. Правки в Google Календаре приходят мгновенно, если MBOX открыт по https: Google присылает уведомление на
// /api/mbox/google-planner/push (канал на неделю, продлевается сам). Без уведомлений и для задач (у Tasks API их нет) — опрос раз в 2 минуты.
//
//   GET  /api/mbox/google-planner/status
//   GET  /api/mbox/google-planner/sources        календари и списки задач аккаунта Google
//   POST /api/mbox/google-planner/connect        → { url } страница согласия Google
//   POST /api/mbox/google-planner/disconnect
//   PATCH /api/mbox/google-planner/settings      { enabled?, calendar?, tasks?, calendars?, task_lists? }
//   POST /api/mbox/google-planner/sync           сверить сейчас
//   POST /api/mbox/google-planner/push           уведомление Google (без сессии: подлинность — id и токен канала)

import { randomBytes, randomUUID } from "node:crypto";
import { gmailRedirectUri, secretKey, tokenRequest } from "./gmail.mjs";
import { formatRule, parseRule } from "./planner.mjs";

const PROVIDER = "google_planner";
export const PLANNER_SCOPES = ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/tasks"];
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const CAL = "https://www.googleapis.com/calendar/v3";
const TASKS = "https://tasks.googleapis.com/tasks/v1";
const STATE_TTL_MIN = 10;
const HISTORY_DAYS = 90;
const DONE_DAYS = 60;
const PUSH_LIMIT = 100;
const POLL_MS = 2 * 60_000;
const DIRTY_CHECK_MS = 30_000;
const DEBOUNCE_MS = 10_000;
const PUSH_DEBOUNCE_MS = 3_000;
const WATCH_TTL_S = 7 * 86_400;
const WATCH_RENEW_MS = 86_400_000;
const WATCH_RETRY_MS = 3_600_000;
export const PUSH_PATH = "/api/mbox/google-planner/push";
export const DEFAULT_CALENDAR = "primary";
export const DEFAULT_LIST = "@default";

export const plannerTimeZone = () => process.env.PLANNER_TZ || "Europe/Moscow";

// ── Время: местное без зоны ↔ момент ─────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");

function wallParts(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return parts;
}

/** Момент → местное время зоны без смещения: «2026-10-15T12:30:00». */
export function utcToWall(instant, timeZone = plannerTimeZone()) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const p = wallParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Местное время зоны без смещения → момент. Дважды уточняем смещение, чтобы переход на летнее время не сдвигал результат. */
export function wallToUtc(naive, timeZone = plannerTimeZone()) {
  const match = String(naive).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return new Date(NaN);
  const asUtc = Date.UTC(+match[1], +match[2] - 1, +match[3], +(match[4] || 0), +(match[5] || 0), +(match[6] || 0));
  let guess = asUtc;
  for (let step = 0; step < 2; step += 1) {
    const p = wallParts(new Date(guess), timeZone);
    guess += asUtc - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(guess);
}

const dayOf = (naive) => String(naive).slice(0, 10);
const addDay = (day, delta) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + delta); return date.toISOString().slice(0, 10); };
const compact = (naive) => String(naive).replace(/[-:]/g, "").slice(0, 15);
const expand = (value) => { const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}` : ""; };

// ── События: Google ↔ MBOX ───────────────────────────────────────────────────

/** UNTIL правила: у MBOX местное «20261031T235959», у Google для событий со временем — UTC с буквой Z. */
function untilToGoogle(rule, allDay, timeZone) {
  const parts = parseRule(rule);
  if (parts.UNTIL) {
    const naive = expand(parts.UNTIL);
    if (naive) parts.UNTIL = allDay ? compact(naive).slice(0, 8) : `${compact(wallToUtc(naive, timeZone).toISOString().slice(0, 19))}Z`;
  }
  return formatRule(parts);
}

function untilFromGoogle(rule, timeZone) {
  const parts = parseRule(rule);
  if (parts.UNTIL?.endsWith("Z")) parts.UNTIL = compact(utcToWall(new Date(expand(parts.UNTIL.slice(0, -1)) + "Z"), timeZone));
  return formatRule(parts);
}

/** Событие Google → поля calendar_events; null — такое событие не переносим (день рождения, исключение повторения, пустое). */
export function fromGoogleEvent(event, timeZone = plannerTimeZone(), { instance = false } = {}) {
  if (!event || event.status === "cancelled") return null;
  // Дни рождения, «Не в офисе», «Время для работы», «Место работы» — служебные записи Google; брони из писем (fromGmail) — обычные события.
  if (event.eventType && !["default", "fromGmail"].includes(event.eventType)) return null;
  if (event.recurringEventId && !instance) return null;
  if (!event.start || !event.end) return null;
  let starts;
  let ends;
  const allDay = Boolean(event.start.date && !event.start.dateTime);
  if (allDay) {
    starts = `${event.start.date}T00:00:00`;
    const last = addDay(event.end.date || event.start.date, -1);
    ends = `${last < event.start.date ? event.start.date : last}T00:00:00`;
  } else {
    starts = utcToWall(event.start.dateTime, timeZone);
    ends = utcToWall(event.end.dateTime || event.start.dateTime, timeZone);
    if (ends < starts) ends = starts;
  }
  const lines = Array.isArray(event.recurrence) ? event.recurrence : [];
  const rrule = lines.find((line) => /^RRULE:/i.test(line));
  const exdates = [];
  for (const line of lines.filter((item) => /^EXDATE/i.test(item))) {
    for (const value of line.slice(line.indexOf(":") + 1).split(",")) {
      const naive = /Z$/.test(value) ? utcToWall(new Date(`${expand(value.slice(0, -1))}Z`), timeZone) : expand(value);
      if (naive) exdates.push(naive);
    }
  }
  const popup = event.reminders?.overrides?.find((item) => item.method === "popup");
  return {
    title: String(event.summary || "").trim().slice(0, 300) || "Без названия",
    description: String(event.description || "").slice(0, 20000),
    starts_at: starts,
    ends_at: ends,
    all_day: allDay,
    location: String(event.location || "").slice(0, 300),
    reminder_minutes: popup ? Math.max(0, Number(popup.minutes) || 0) : null,
    recurrence_rule: rrule ? untilFromGoogle(rrule.replace(/^RRULE:/i, ""), timeZone) || null : null,
    exdates: [...new Set(exdates)].sort(),
  };
}

/**
 * Строка calendar_events → тело события Google. reminders не трогаем, пока у события MBOX нет напоминания: пусть остаются обычные у Google.
 * instance — запись связана с отдельным повторением серии Google: у повторения нет своего правила. keepExdates — исходные даты повторений,
 * изменённых в Google: в MBOX они исключены из серии (их заменяет отдельное событие), а в Google EXDATE отменил бы само изменённое повторение.
 */
export function toGoogleEvent(row, timeZone = plannerTimeZone(), { instance = false, keepExdates = [] } = {}) {
  const allDay = Boolean(row.all_day);
  const body = {
    summary: row.title || "Без названия",
    description: row.description || "",
    location: row.location || "",
    start: allDay ? { date: dayOf(row.starts_at), dateTime: null, timeZone: null } : { dateTime: row.starts_at, timeZone, date: null },
    end: allDay ? { date: addDay(dayOf(row.ends_at), 1), dateTime: null, timeZone: null } : { dateTime: row.ends_at, timeZone, date: null },
    ...(instance ? {} : { recurrence: [] }),
  };
  if (row.recurrence_rule && !instance) {
    body.recurrence.push(`RRULE:${untilToGoogle(row.recurrence_rule, allDay, timeZone)}`);
    const exdates = (row.exdates || []).filter((value) => !keepExdates.includes(value)).map((value) => (allDay ? compact(value).slice(0, 8) : compact(value)));
    if (exdates.length) body.recurrence.push(allDay ? `EXDATE;VALUE=DATE:${exdates.join(",")}` : `EXDATE;TZID=${timeZone}:${exdates.join(",")}`);
  }
  if (row.reminder_minutes != null) body.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: Number(row.reminder_minutes) }] };
  return body;
}

const INSTANCE_ID = /^(.+)_(\d{8})(?:T(\d{6})Z)?$/;

/** Повторение серии Google: id «<серия>_20261027T080000Z» (у событий на весь день — «_20261027») → серия и местное время исходного повторения. */
export function instanceOrigin(googleId, timeZone = plannerTimeZone()) {
  const match = String(googleId).match(INSTANCE_ID);
  if (!match) return null;
  const wall = match[3] ? utcToWall(new Date(`${expand(`${match[2]}T${match[3]}`)}Z`), timeZone) : expand(match[2]);
  return { series: match[1], wall };
}

/** Исходное время повторения из самого события Google (originalStartTime) — местное, как exdates в MBOX. */
function originalWall(event, timeZone) {
  const origin = event.originalStartTime;
  if (origin?.date) return `${origin.date}T00:00:00`;
  if (origin?.dateTime) return utcToWall(origin.dateTime, timeZone);
  return instanceOrigin(event.id, timeZone)?.wall || "";
}

const sameEvent = (a, b) => ["title", "description", "starts_at", "ends_at", "all_day", "location"].every((key) => a[key] === b[key])
  && (a.recurrence_rule || null) === (b.recurrence_rule || null)
  && JSON.stringify([...(a.exdates || [])].sort()) === JSON.stringify([...(b.exdates || [])].sort())
  // Напоминание Google без своего (useDefault) читается как null и не должно стирать напоминание, поставленное в MBOX.
  && (b.reminder_minutes == null || (a.reminder_minutes ?? null) === b.reminder_minutes);

// ── Задачи: Google ↔ MBOX ────────────────────────────────────────────────────

export function fromGoogleTask(task) {
  if (!task) return null;
  return {
    title: String(task.title || "").trim().slice(0, 500) || "Без названия",
    note: String(task.notes || ""),
    due: task.due ? String(task.due).slice(0, 10) : null,
    done: task.status === "completed",
  };
}

export function toGoogleTask(row) {
  const due = row.props?.due && /^\d{4}-\d{2}-\d{2}/.test(String(row.props.due)) ? `${String(row.props.due).slice(0, 10)}T00:00:00.000Z` : null;
  return { title: row.title || "Без названия", notes: row.note || "", status: row.status === "done" ? "completed" : "needsAction", due, ...(row.status === "done" ? {} : { completed: null }) };
}

// ── Схема ────────────────────────────────────────────────────────────────────

let schemaReady = null;
export function ensureGooglePlannerSchema(query) {
  schemaReady ||= (async () => {
    await query(`CREATE TABLE IF NOT EXISTS google_sync_state (
      owner_user_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      calendar BOOLEAN NOT NULL DEFAULT true,
      tasks BOOLEAN NOT NULL DEFAULT true,
      email TEXT NOT NULL DEFAULT '',
      calendar_sync_token TEXT NOT NULL DEFAULT '',
      tasks_updated_min TEXT NOT NULL DEFAULT '',
      last_sync_at TIMESTAMPTZ,
      last_error TEXT NOT NULL DEFAULT '',
      last_result JSONB
    )`);
    // Какие календари и списки задач сверяются, метки сверки каждого, права на календари и каналы мгновенных уведомлений Google.
    await query(`ALTER TABLE google_sync_state
      ADD COLUMN IF NOT EXISTS calendars JSONB NOT NULL DEFAULT '["primary"]',
      ADD COLUMN IF NOT EXISTS task_lists JSONB NOT NULL DEFAULT '["@default"]',
      ADD COLUMN IF NOT EXISTS calendar_tokens JSONB NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS list_marks JSONB NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS readonly_calendars JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS watches JSONB NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS push_origin TEXT NOT NULL DEFAULT ''`);
    await query(`CREATE TABLE IF NOT EXISTS google_links (
      owner_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      local_id BIGINT NOT NULL,
      google_id TEXT NOT NULL,
      etag TEXT NOT NULL DEFAULT '',
      google_stamp TEXT NOT NULL DEFAULT '',
      local_stamp TIMESTAMPTZ,
      PRIMARY KEY (owner_user_id, kind, google_id),
      UNIQUE (owner_user_id, kind, local_id)
    )`);
    // container — календарь или список задач Google, где живёт запись; пусто — основной («primary» / «@default»).
    await query("ALTER TABLE google_links ADD COLUMN IF NOT EXISTS container TEXT NOT NULL DEFAULT ''");
  })().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

// ── Подключение и токены ─────────────────────────────────────────────────────

const tokenCache = new Map();

/** Приложение OAuth экземпляра: то, что владелец внёс для Gmail. */
async function instanceClient(query) {
  const row = (await query(
    `SELECT c.client_id, pgp_sym_decrypt(c.client_secret_ciphertext, $1) AS client_secret
       FROM oauth_connections c JOIN users u ON u.id::text = c.owner_user_id
      WHERE c.provider = 'google' AND c.client_id <> '' AND c.client_secret_ciphertext IS NOT NULL
      ORDER BY (u.role = 'owner') DESC, c.updated_at DESC LIMIT 1`,
    [secretKey()],
  ).catch(() => ({ rows: [] }))).rows[0];
  return row?.client_id && row?.client_secret ? { clientId: row.client_id, clientSecret: row.client_secret } : null;
}

async function ownRow(query, userId) {
  return (await query(
    `SELECT email, scopes, connected_at::text,
            CASE WHEN refresh_ciphertext IS NULL THEN '' ELSE pgp_sym_decrypt(refresh_ciphertext, $2) END AS refresh_token
       FROM oauth_connections WHERE provider = $3 AND owner_user_id = $1`,
    [String(userId), secretKey(), PROVIDER],
  )).rows[0] || null;
}

async function accessToken(query, userId) {
  const key = String(userId);
  const cached = tokenCache.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  const [client, row] = await Promise.all([instanceClient(query), ownRow(query, key)]);
  if (!client) throw Object.assign(new Error("Владелец не внёс OAuth-клиент Google (Настройки → Интеграции → Gmail)."), { code: "not_configured" });
  if (!row?.refresh_token) throw Object.assign(new Error("Google Календарь не подключён."), { code: "not_connected" });
  try {
    const data = await tokenRequest({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: row.refresh_token, grant_type: "refresh_token" });
    tokenCache.set(key, { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 });
    return data.access_token;
  } catch (error) {
    if (error.code === "invalid_grant") {
      await query("UPDATE oauth_connections SET refresh_ciphertext = NULL, connected_at = NULL WHERE provider = $2 AND owner_user_id = $1", [key, PROVIDER]);
      throw Object.assign(new Error("Доступ к Google истёк или отозван. Подключите заново."), { code: "not_connected" });
    }
    throw error;
  }
}

export async function googlePlannerStatus(query, userId, origin) {
  await ensureGooglePlannerSchema(query);
  const [client, row, state] = await Promise.all([
    instanceClient(query),
    ownRow(query, userId),
    query("SELECT enabled, calendar, tasks, email, last_sync_at::text, last_error, last_result, calendars, task_lists, readonly_calendars, watches FROM google_sync_state WHERE owner_user_id = $1", [String(userId)]).then((result) => result.rows[0]),
  ]);
  const granted = String(row?.scopes || "").split(/\s+/);
  const watches = Object.values(state?.watches || {});
  return {
    calendars: selection(state?.calendars, DEFAULT_CALENDAR),
    task_lists: selection(state?.task_lists, DEFAULT_LIST),
    readonly_calendars: Array.isArray(state?.readonly_calendars) ? state.readonly_calendars : [],
    // Мгновенные уведомления Google: работают, если хотя бы один канал жив; иначе — опрос раз в 2 минуты.
    instant: watches.some((watch) => watch.id && Number(watch.expires) > Date.now()),
    instant_error: watches.find((watch) => watch.error)?.error || "",
    poll_minutes: POLL_MS / 60_000,
    configured: Boolean(client),
    connected: Boolean(row?.refresh_token),
    scopes_ok: PLANNER_SCOPES.every((scope) => granted.includes(scope)),
    email: row?.email || "",
    enabled: Boolean(state?.enabled),
    calendar: state ? Boolean(state.calendar) : true,
    tasks: state ? Boolean(state.tasks) : true,
    last_sync_at: state?.last_sync_at || null,
    last_error: state?.last_error || "",
    last_result: state?.last_result || null,
    time_zone: plannerTimeZone(),
    redirect_uri: gmailRedirectUri(origin),
  };
}

export async function beginGooglePlannerConnect(query, userId, origin) {
  await ensureGooglePlannerSchema(query);
  const client = await instanceClient(query);
  if (!client) throw Object.assign(new Error("Владелец ещё не внёс OAuth-клиент Google. Это делается один раз в «Настройки → Интеграции → Gmail»."), { code: "not_configured" });
  await query("INSERT INTO oauth_connections(provider, owner_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [PROVIDER, String(userId)]);
  await query("DELETE FROM oauth_states WHERE created_at < now() - interval '1 day'");
  const state = randomBytes(24).toString("base64url");
  await query("INSERT INTO oauth_states(state, provider, owner_user_id, origin) VALUES ($1, $2, $3, $4)", [state, PROVIDER, String(userId), origin]);
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: gmailRedirectUri(origin),
    response_type: "code",
    scope: ["openid", "email", ...PLANNER_SCOPES].join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

const page = (title, text, ok) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:520px;margin:12vh auto;padding:0 20px;color:#202124"><h2 style="color:${ok ? "#188038" : "#d93025"}">${title}</h2><p>${text}</p></body>`;

/** Возвращение из Google для подключения планировщика. false — state не наш, пусть разбирает Gmail. */
export async function handleGooglePlannerCallback({ res, url, query, onConnected }) {
  await ensureGooglePlannerSchema(query);
  const state = String(url.searchParams.get("state") || "");
  const found = (await query("DELETE FROM oauth_states WHERE state = $1 AND provider = $2 AND created_at > now() - make_interval(mins => $3) RETURNING owner_user_id, origin", [state, PROVIDER, STATE_TTL_MIN])).rows[0];
  if (!found) {
    const stale = (await query("SELECT 1 FROM oauth_states WHERE state = $1 AND provider = $2", [state, PROVIDER])).rows[0];
    if (!stale) return false;
  }
  const send = (status, html) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); };
  if (!found) { send(400, page("Ссылка устарела", "Нажмите «Подключить» в MBOX ещё раз.", false)); return true; }
  const denied = url.searchParams.get("error");
  if (denied) { send(200, page("Доступ не дан", `Google вернул: ${String(denied).replace(/[<>&]/g, "")}. Подключение отменено.`, false)); return true; }
  try {
    const client = await instanceClient(query);
    if (!client) throw new Error("Не задан OAuth-клиент Google");
    const tokens = await tokenRequest({ code: String(url.searchParams.get("code") || ""), client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: gmailRedirectUri(found.origin), grant_type: "authorization_code" });
    if (!tokens.refresh_token) throw new Error("Google не выдал постоянный токен. Откройте myaccount.google.com/permissions, уберите доступ MBOX и подключите снова.");
    let email = "";
    try { email = String(JSON.parse(Buffer.from(String(tokens.id_token).split(".")[1], "base64url").toString("utf8")).email || ""); } catch { /* адрес покажем позже */ }
    const granted = String(tokens.scope || "").split(/\s+/);
    if (!PLANNER_SCOPES.every((scope) => granted.includes(scope))) throw new Error("Google выдал не все права: нужны и Календарь, и Задачи. Подключите снова и отметьте оба пункта.");
    await query(
      `UPDATE oauth_connections SET refresh_ciphertext = pgp_sym_encrypt($2, $3), email = $4, scopes = $5, connected_at = now(), updated_at = now()
        WHERE provider = $6 AND owner_user_id = $1`,
      [found.owner_user_id, tokens.refresh_token, secretKey(), email, String(tokens.scope || ""), PROVIDER],
    );
    tokenCache.set(found.owner_user_id, { token: tokens.access_token, until: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 - 60_000 });
    // Другой аккаунт Google — старые пары записей не годятся: начинаем сверку с чистого листа.
    const previous = (await query("SELECT email FROM google_sync_state WHERE owner_user_id = $1", [found.owner_user_id])).rows[0];
    if (previous?.email && previous.email !== email) {
      await query("DELETE FROM google_links WHERE owner_user_id = $1", [found.owner_user_id]);
      await query(
        `UPDATE google_sync_state SET calendar_tokens = '{}', list_marks = '{}', calendars = '["primary"]', task_lists = '["@default"]', readonly_calendars = '[]'
          WHERE owner_user_id = $1`,
        [found.owner_user_id],
      );
      await stopAllWatches(query, found.owner_user_id);
    }
    await query(
      `INSERT INTO google_sync_state(owner_user_id, enabled, email, last_error, push_origin) VALUES ($1, true, $2, '', $3)
       ON CONFLICT (owner_user_id) DO UPDATE SET enabled = true, email = $2, last_error = '', push_origin = $3`,
      [found.owner_user_id, email, pushable(found.origin) ? found.origin : ""],
    );
    onConnected?.(found.owner_user_id);
    send(200, page("Google подключён", `${email ? `Аккаунт ${email.replace(/[<>&]/g, "")} подключён.` : "Аккаунт подключён."} Календарь и задачи сверяются с MBOX. Это окно можно закрыть.`, true));
  } catch (error) {
    send(200, page("Не удалось подключить Google", String(error.message || error).replace(/[<>&]/g, ""), false));
  }
  return true;
}

export async function disconnectGooglePlanner(query, userId) {
  await ensureGooglePlannerSchema(query);
  const row = await ownRow(query, userId);
  await stopAllWatches(query, String(userId));
  if (row?.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.refresh_token)}`, { method: "POST" }).catch(() => {});
  await query("UPDATE oauth_connections SET refresh_ciphertext = NULL, email = '', scopes = '', connected_at = NULL WHERE provider = $2 AND owner_user_id = $1", [String(userId), PROVIDER]);
  // Пары записей и метки оставляем: при повторном подключении того же аккаунта дубликатов не будет.
  await query("UPDATE google_sync_state SET enabled = false WHERE owner_user_id = $1", [String(userId)]);
  tokenCache.delete(String(userId));
}

/** Выбранные календари или списки: строки, без повторов, основной всегда первым (туда уходят новые записи MBOX). */
function selection(value, main) {
  const items = Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().slice(0, 300)) : [];
  return [main, ...new Set(items.filter((item) => item !== main))].slice(0, 30);
}

export async function saveGooglePlannerSettings(query, userId, body) {
  await ensureGooglePlannerSchema(query);
  const owner = String(userId);
  const before = (await query("SELECT calendars, task_lists FROM google_sync_state WHERE owner_user_id = $1", [owner])).rows[0];
  const calendars = Array.isArray(body.calendars) ? selection(body.calendars, DEFAULT_CALENDAR) : null;
  const lists = Array.isArray(body.task_lists) ? selection(body.task_lists, DEFAULT_LIST) : null;
  await query(
    `INSERT INTO google_sync_state(owner_user_id, enabled, calendar, tasks, calendars, task_lists)
     VALUES ($1, COALESCE($2, false), COALESCE($3, true), COALESCE($4, true), COALESCE($5::jsonb, '["primary"]'), COALESCE($6::jsonb, '["@default"]'))
     ON CONFLICT (owner_user_id) DO UPDATE SET enabled = COALESCE($2, google_sync_state.enabled), calendar = COALESCE($3, google_sync_state.calendar),
       tasks = COALESCE($4, google_sync_state.tasks), calendars = COALESCE($5::jsonb, google_sync_state.calendars), task_lists = COALESCE($6::jsonb, google_sync_state.task_lists)`,
    [owner, typeof body.enabled === "boolean" ? body.enabled : null, typeof body.calendar === "boolean" ? body.calendar : null, typeof body.tasks === "boolean" ? body.tasks : null,
      calendars ? JSON.stringify(calendars) : null, lists ? JSON.stringify(lists) : null],
  );
  // Снятый с выбора календарь или список: то, что пришло из него, из MBOX убираем (в Google остаётся), метку сверки забываем.
  if (calendars && before) {
    for (const removed of selection(before.calendars, DEFAULT_CALENDAR).filter((id) => !calendars.includes(id))) {
      await query(
        `DELETE FROM calendar_events e USING google_links l
          WHERE l.owner_user_id = $1 AND l.kind = 'event' AND l.container = $2 AND e.id = l.local_id AND e.owner_user_id = $1`,
        [owner, removed],
      );
      await query("DELETE FROM google_links WHERE owner_user_id = $1 AND kind = 'event' AND container = $2", [owner, removed]);
      await query("UPDATE google_sync_state SET calendar_tokens = calendar_tokens - $2::text WHERE owner_user_id = $1", [owner, removed]);
    }
  }
  if (lists && before) {
    for (const removed of selection(before.task_lists, DEFAULT_LIST).filter((id) => !lists.includes(id))) {
      await query(
        `DELETE FROM todos t USING google_links l
          WHERE l.owner_user_id = $1 AND l.kind = 'task' AND l.container = $2 AND t.id = l.local_id AND t.project_id IS NULL AND t.props->>'owner_user_id' = $1`,
        [owner, removed],
      );
      await query("DELETE FROM google_links WHERE owner_user_id = $1 AND kind = 'task' AND container = $2", [owner, removed]);
      await query("UPDATE google_sync_state SET list_marks = list_marks - $2::text WHERE owner_user_id = $1", [owner, removed]);
    }
  }
}

/** Календари и списки задач аккаунта Google — для выбора в настройках. Заодно запоминаем календари только для чтения. */
export async function googlePlannerSources(query, userId) {
  await ensureGooglePlannerSchema(query);
  const owner = String(userId);
  const [calendarList, taskLists, defaultList] = await Promise.all([
    google(query, owner, { base: CAL, path: "users/me/calendarList", params: { maxResults: 250 } }),
    google(query, owner, { base: TASKS, path: "users/@me/lists", params: { maxResults: 100 } }),
    google(query, owner, { base: TASKS, path: "users/@me/lists/@default" }).catch(() => null),
  ]);
  const calendars = (calendarList.items || []).filter((item) => !item.deleted).map((item) => ({
    id: item.primary ? DEFAULT_CALENDAR : item.id,
    title: item.summaryOverride || item.summary || item.id,
    color: item.backgroundColor || "",
    writable: ["owner", "writer"].includes(item.accessRole),
    primary: Boolean(item.primary),
  })).sort((a, b) => Number(b.primary) - Number(a.primary) || a.title.localeCompare(b.title, "ru"));
  const lists = (taskLists.items || []).map((item) => ({
    id: item.id === defaultList?.id ? DEFAULT_LIST : item.id,
    title: item.title || "Без названия",
    default: item.id === defaultList?.id,
  })).sort((a, b) => Number(b.default) - Number(a.default));
  await query("UPDATE google_sync_state SET readonly_calendars = $2::jsonb WHERE owner_user_id = $1", [owner, JSON.stringify(calendars.filter((item) => !item.writable).map((item) => item.id))]);
  return { calendars, lists };
}

// ── Вызовы Google ────────────────────────────────────────────────────────────

async function google(query, userId, { base, method = "GET", path, params, body, ignore = [] }) {
  const token = await accessToken(query, userId);
  const url = new URL(`${base}/${path}`);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 401) tokenCache.delete(String(userId));
  if (ignore.includes(response.status)) return null;
  const raw = await response.text();
  if (!response.ok) {
    let message = `Google ответил ${response.status}`;
    try { message = JSON.parse(raw)?.error?.message || message; } catch { /* оставляем статус */ }
    throw Object.assign(new Error(`Google: ${message}`), { status: response.status });
  }
  return raw ? JSON.parse(raw) : {};
}

// ── Пары записей ─────────────────────────────────────────────────────────────

const calendarOf = (container) => container || DEFAULT_CALENDAR;
const listOf = (container) => container || DEFAULT_LIST;
const enc = encodeURIComponent;

async function linkOf(query, owner, kind, googleId) {
  return (await query(
    "SELECT local_id::text AS local_id, etag, google_stamp, local_stamp::text AS local_stamp, container FROM google_links WHERE owner_user_id = $1 AND kind = $2 AND google_id = $3",
    [owner, kind, googleId],
  )).rows[0] || null;
}

async function saveLink(query, owner, kind, { localId, googleId, container, etag = "", googleStamp = "", localStamp }) {
  await query(
    `INSERT INTO google_links(owner_user_id, kind, local_id, google_id, container, etag, google_stamp, local_stamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
     ON CONFLICT (owner_user_id, kind, google_id) DO UPDATE SET local_id = $3, container = $5, etag = $6, google_stamp = $7, local_stamp = $8::timestamptz`,
    [owner, kind, localId, googleId, container, etag, googleStamp, localStamp],
  );
}

// ── Сверка событий ───────────────────────────────────────────────────────────

const EVENT_SELECT = `e.id, e.title, e.description, to_char(e.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at, to_char(e.ends_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_at,
  e.all_day, e.location, e.reminder_minutes, e.recurrence_rule, e.exdates, e.updated_at::text AS stamp, e.updated_at AS updated`;

async function pullEvents(query, owner, stats, timeZone, calendarId) {
  const tokens = (await query("SELECT calendar_tokens FROM google_sync_state WHERE owner_user_id = $1", [owner])).rows[0]?.calendar_tokens || {};
  let syncToken = tokens[calendarId] || "";
  let pageToken = "";
  let restarted = false;
  let next = "";
  for (;;) {
    let data;
    try {
      data = await google(query, owner, {
        base: CAL, path: `calendars/${enc(calendarId)}/events`,
        params: { showDeleted: "true", singleEvents: "false", maxResults: 250, pageToken, ...(syncToken ? { syncToken } : { timeMin: new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString() }) },
      });
    } catch (error) {
      // syncToken устарел (Google хранит их ограниченное время) — полная пересверка; пары записей не дают появиться дублям.
      if (error.status === 410 && syncToken && !restarted) { restarted = true; syncToken = ""; pageToken = ""; continue; }
      throw error;
    }
    const items = data.items || [];
    // Сначала события и серии, потом отдельные повторения: повторению нужна уже известная серия.
    for (const event of items.filter((item) => !item.recurringEventId)) await applyGoogleEvent(query, owner, event, stats, timeZone, calendarId);
    for (const event of items.filter((item) => item.recurringEventId)) await applyGoogleInstance(query, owner, event, stats, timeZone, calendarId);
    pageToken = data.nextPageToken || "";
    if (data.nextSyncToken) next = data.nextSyncToken;
    if (!pageToken) break;
  }
  if (next) await query("UPDATE google_sync_state SET calendar_tokens = calendar_tokens || jsonb_build_object($2::text, $3::text) WHERE owner_user_id = $1", [owner, calendarId, next]);
}

async function applyGoogleEvent(query, owner, event, stats, timeZone, calendarId) {
  const link = await linkOf(query, owner, "event", event.id);
  // То же событие видно в двух выбранных календарях (приглашение в общий календарь) — оно уже связано через первый.
  if (link && calendarOf(link.container) !== calendarId) return;
  if (event.status === "cancelled") {
    if (link) {
      await query("DELETE FROM calendar_events WHERE id = $1 AND owner_user_id = $2", [link.local_id, owner]);
      await query("DELETE FROM google_links WHERE owner_user_id = $1 AND kind = 'event' AND google_id = $2", [owner, event.id]);
      stats.events.deleted_local += 1;
    }
    return;
  }
  const fields = fromGoogleEvent(event, timeZone, { instance: Boolean(event.recurringEventId) });
  if (!fields) return;
  if (!link) {
    const row = (await query(
      `INSERT INTO calendar_events(owner_user_id, title, description, starts_at, ends_at, all_day, location, reminder_minutes, recurrence_rule, exdates, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Google') RETURNING id::text, updated_at::text AS stamp`,
      [owner, fields.title, fields.description, fields.starts_at, fields.ends_at, fields.all_day, fields.location, fields.reminder_minutes, fields.recurrence_rule, fields.exdates],
    )).rows[0];
    await saveLink(query, owner, "event", { localId: row.id, googleId: event.id, container: calendarId, etag: event.etag || "", googleStamp: event.updated || "", localStamp: row.stamp });
    stats.events.pulled += 1;
    return;
  }
  if ((event.etag || "") === link.etag) return;
  const local = (await query(`SELECT ${EVENT_SELECT} FROM calendar_events e WHERE e.id = $1 AND e.owner_user_id = $2`, [link.local_id, owner])).rows[0];
  if (!local) return; // удалено в MBOX — ниже уйдёт удалением в Google
  const localChanged = local.stamp !== link.local_stamp;
  if (localChanged && Date.parse(local.updated) > Date.parse(event.updated || 0)) return; // правка MBOX новее — уйдёт в Google
  // Отменённые и изменённые повторения Google присылает отдельными записями, в правиле серии их нет: исключённые даты MBOX не теряем.
  if (fields.recurrence_rule) fields.exdates = [...new Set([...fields.exdates, ...(local.exdates || [])])].sort();
  if (sameEvent(local, fields)) {
    await query("UPDATE google_links SET etag = $3, google_stamp = $4 WHERE owner_user_id = $1 AND kind = 'event' AND google_id = $2", [owner, event.id, event.etag || "", event.updated || ""]);
    return;
  }
  const row = (await query(
    `UPDATE calendar_events SET title = $3, description = $4, starts_at = $5, ends_at = $6, all_day = $7, location = $8,
            reminder_minutes = COALESCE($9, reminder_minutes), recurrence_rule = $10, exdates = $11, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 RETURNING updated_at::text AS stamp`,
    [link.local_id, owner, fields.title, fields.description, fields.starts_at, fields.ends_at, fields.all_day, fields.location, fields.reminder_minutes, fields.recurrence_rule, fields.exdates],
  )).rows[0];
  await query("UPDATE google_links SET etag = $3, google_stamp = $4, local_stamp = $5::timestamptz WHERE owner_user_id = $1 AND kind = 'event' AND google_id = $2", [owner, event.id, event.etag || "", event.updated || "", row.stamp]);
  stats.events.pulled += 1;
}

/**
 * Отдельное повторение серии, изменённое или отменённое в Google. В серии MBOX его исходная дата исключается; изменённое повторение
 * становится отдельным событием, связанным с повторением Google (правки и удаление в MBOX уходят именно в это повторение).
 */
async function applyGoogleInstance(query, owner, event, stats, timeZone, calendarId) {
  const series = await linkOf(query, owner, "event", event.recurringEventId);
  const wall = originalWall(event, timeZone);
  if (series && calendarOf(series.container) === calendarId && wall) {
    const row = (await query(
      `WITH before AS (SELECT updated_at::text AS stamp FROM calendar_events WHERE id = $1 AND owner_user_id = $2)
       UPDATE calendar_events SET exdates = ARRAY(SELECT value FROM unnest(array_append(exdates, $3)) AS value ORDER BY value), updated_at = now()
        WHERE id = $1 AND owner_user_id = $2 AND recurrence_rule IS NOT NULL AND NOT ($3 = ANY(exdates))
       RETURNING updated_at::text AS stamp, (SELECT stamp FROM before) AS was`,
      [series.local_id, owner, wall],
    )).rows[0];
    if (row) {
      // Google уже знает об этом повторении: если других правок серии в MBOX не было, отправлять её обратно незачем.
      if (row.was === series.local_stamp) await query("UPDATE google_links SET local_stamp = $3::timestamptz WHERE owner_user_id = $1 AND kind = 'event' AND google_id = $2", [owner, event.recurringEventId, row.stamp]);
      stats.events.pulled += 1;
    }
  }
  await applyGoogleEvent(query, owner, event, stats, timeZone, calendarId);
}

/** Исходные даты повторений серии, которые связаны с изменёнными повторениями Google: их нельзя отправлять в EXDATE. */
async function linkedInstanceDates(query, owner, seriesId, timeZone) {
  const rows = (await query(
    "SELECT google_id FROM google_links WHERE owner_user_id = $1 AND kind = 'event' AND google_id LIKE $2",
    [owner, `${seriesId.replace(/[\\%_]/g, (char) => `\\${char}`)}\\_%`],
  )).rows;
  return rows.map((row) => instanceOrigin(row.google_id, timeZone)).filter((origin) => origin?.series === seriesId).map((origin) => origin.wall);
}

async function pushEvents(query, owner, stats, timeZone, readonly) {
  const pending = (await query(
    `SELECT ${EVENT_SELECT}, l.google_id, l.container
       FROM calendar_events e LEFT JOIN google_links l ON l.owner_user_id = e.owner_user_id AND l.kind = 'event' AND l.local_id = e.id
      WHERE e.owner_user_id = $1 AND (l.local_id IS NULL OR e.updated_at > l.local_stamp)
        AND (e.recurrence_rule IS NOT NULL OR e.ends_at > now() - make_interval(days => $2))
      ORDER BY e.updated_at LIMIT $3`,
    [owner, HISTORY_DAYS, PUSH_LIMIT],
  )).rows;
  for (const row of pending) {
    const calendarId = row.google_id ? calendarOf(row.container) : DEFAULT_CALENDAR;
    if (row.google_id && readonly.has(calendarId)) {
      // Календарь только для чтения: правка остаётся в MBOX, в Google её не отправить.
      await query("UPDATE google_links SET local_stamp = $3::timestamptz WHERE owner_user_id = $1 AND kind = 'event' AND local_id = $2", [owner, row.id, row.stamp]);
      continue;
    }
    const instance = Boolean(row.google_id && instanceOrigin(row.google_id));
    const keepExdates = row.google_id && row.recurrence_rule ? await linkedInstanceDates(query, owner, row.google_id, timeZone) : [];
    const body = toGoogleEvent(row, timeZone, { instance, keepExdates });
    const path = `calendars/${enc(calendarId)}/events`;
    let saved = null;
    if (row.google_id) saved = await google(query, owner, { base: CAL, method: "PATCH", path: `${path}/${enc(row.google_id)}`, body, ignore: [404, 410] });
    if (!saved) {
      saved = await google(query, owner, { base: CAL, method: "POST", path, body: toGoogleEvent(row, timeZone) });
      await query("DELETE FROM google_links WHERE owner_user_id = $1 AND kind = 'event' AND local_id = $2", [owner, row.id]);
    }
    await saveLink(query, owner, "event", { localId: row.id, googleId: saved.id, container: calendarId, etag: saved.etag || "", googleStamp: saved.updated || "", localStamp: row.stamp });
    stats.events.pushed += 1;
  }
  const gone = (await query(
    `SELECT l.google_id, l.container FROM google_links l LEFT JOIN calendar_events e ON e.id = l.local_id
      WHERE l.owner_user_id = $1 AND l.kind = 'event' AND e.id IS NULL LIMIT $2`,
    [owner, PUSH_LIMIT],
  )).rows;
  for (const link of gone) {
    const calendarId = calendarOf(link.container);
    // Удалённое повторение серии Google отменяет это повторение; удаление в календаре только для чтения просто забывает пару.
    if (!readonly.has(calendarId)) await google(query, owner, { base: CAL, method: "DELETE", path: `calendars/${enc(calendarId)}/events/${enc(link.google_id)}`, ignore: [404, 410] });
    await query("DELETE FROM google_links WHERE owner_user_id = $1 AND kind = 'event' AND google_id = $2", [owner, link.google_id]);
    stats.events.deleted_remote += 1;
  }
}

/** Календари, куда писать нельзя (праздники, чужие календари с правом просмотра), — по списку календарей Google. */
async function refreshReadonly(query, owner, fallback) {
  try {
    const data = await google(query, owner, { base: CAL, path: "users/me/calendarList", params: { maxResults: 250 } });
    const ids = (data.items || []).filter((item) => !["owner", "writer"].includes(item.accessRole)).map((item) => (item.primary ? DEFAULT_CALENDAR : item.id));
    await query("UPDATE google_sync_state SET readonly_calendars = $2::jsonb WHERE owner_user_id = $1", [owner, JSON.stringify(ids)]);
    return ids;
  } catch {
    return Array.isArray(fallback) ? fallback : [];
  }
}

// ── Сверка задач ─────────────────────────────────────────────────────────────

const TASK_SELECT = "t.id, t.title, t.note, t.status, t.props, t.updated_at::text AS stamp, t.updated_at AS updated";
const PERSONAL_OF = "t.project_id IS NULL AND t.props->>'owner_user_id' = $1";

async function pullTasks(query, owner, stats, listId) {
  const marks = (await query("SELECT list_marks FROM google_sync_state WHERE owner_user_id = $1", [owner])).rows[0]?.list_marks || {};
  const since = marks[listId] || "";
  let pageToken = "";
  let newest = since;
  do {
    const data = await google(query, owner, {
      base: TASKS, path: `lists/${enc(listId)}/tasks`,
      params: { showCompleted: "true", showHidden: "true", showDeleted: "true", maxResults: 100, pageToken, updatedMin: since },
    });
    for (const task of data.items || []) {
      if (task.updated && task.updated > newest) newest = task.updated;
      await applyGoogleTask(query, owner, task, stats, listId);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  if (newest && newest !== since) await query("UPDATE google_sync_state SET list_marks = list_marks || jsonb_build_object($2::text, $3::text) WHERE owner_user_id = $1", [owner, listId, newest]);
}

async function applyGoogleTask(query, owner, task, stats, listId) {
  const link = await linkOf(query, owner, "task", task.id);
  if (link && listOf(link.container) !== listId) return;
  if (task.deleted) {
    if (link) {
      await query("DELETE FROM todos WHERE id = $1 AND project_id IS NULL AND props->>'owner_user_id' = $2", [link.local_id, owner]);
      await query("DELETE FROM google_links WHERE owner_user_id = $1 AND kind = 'task' AND google_id = $2", [owner, task.id]);
      stats.tasks.deleted_local += 1;
    }
    return;
  }
  const fields = fromGoogleTask(task);
  if (!link) {
    const props = { owner_user_id: owner, ...(fields.due ? { due: fields.due } : {}) };
    const row = (await query(
      "INSERT INTO todos(project_id, title, note, status, priority, props) VALUES (NULL, $1, $2, $3, 'normal', $4) RETURNING id::text, updated_at::text AS stamp",
      [fields.title, fields.note, fields.done ? "done" : "open", JSON.stringify(props)],
    )).rows[0];
    await saveLink(query, owner, "task", { localId: row.id, googleId: task.id, container: listId, etag: task.etag || "", googleStamp: task.updated || "", localStamp: row.stamp });
    stats.tasks.pulled += 1;
    return;
  }
  if ((task.updated || "") === link.google_stamp) return;
  const local = (await query(`SELECT ${TASK_SELECT} FROM todos t WHERE t.id = $2 AND ${PERSONAL_OF}`, [owner, link.local_id])).rows[0];
  if (!local) return;
  if (local.stamp !== link.local_stamp && Date.parse(local.updated) > Date.parse(task.updated || 0)) return;
  const localDone = local.status === "done";
  const same = local.title === fields.title && (local.note || "") === fields.note && (local.props?.due || null) === fields.due && localDone === fields.done;
  if (same) {
    await query("UPDATE google_links SET etag = $3, google_stamp = $4 WHERE owner_user_id = $1 AND kind = 'task' AND google_id = $2", [owner, task.id, task.etag || "", task.updated || ""]);
    return;
  }
  const props = { ...(local.props || {}) };
  if (fields.due) props.due = fields.due; else delete props.due;
  // Статус MBOX (в работе, на проверке…) Google не знает: меняем его только когда «выполнено» разошлось.
  const status = fields.done ? "done" : localDone ? "open" : local.status;
  const row = (await query("UPDATE todos SET title = $2, note = $3, status = $4, props = $5, updated_at = now() WHERE id = $1 RETURNING updated_at::text AS stamp", [link.local_id, fields.title, fields.note, status, JSON.stringify(props)])).rows[0];
  await query("UPDATE google_links SET etag = $3, google_stamp = $4, local_stamp = $5::timestamptz WHERE owner_user_id = $1 AND kind = 'task' AND google_id = $2", [owner, task.id, task.etag || "", task.updated || "", row.stamp]);
  stats.tasks.pulled += 1;
}

async function pushTasks(query, owner, stats) {
  const pending = (await query(
    `SELECT ${TASK_SELECT}, l.google_id, l.container
       FROM todos t LEFT JOIN google_links l ON l.owner_user_id = $1 AND l.kind = 'task' AND l.local_id = t.id
      WHERE ${PERSONAL_OF} AND t.status <> 'archived' AND (t.status <> 'done' OR t.updated_at > now() - make_interval(days => $2))
        AND (l.local_id IS NULL OR t.updated_at > l.local_stamp)
      ORDER BY t.updated_at LIMIT $3`,
    [owner, DONE_DAYS, PUSH_LIMIT],
  )).rows;
  for (const row of pending) {
    const listId = row.google_id ? listOf(row.container) : DEFAULT_LIST;
    const path = `lists/${enc(listId)}/tasks`;
    const body = toGoogleTask(row);
    let saved = null;
    if (row.google_id) saved = await google(query, owner, { base: TASKS, method: "PATCH", path: `${path}/${enc(row.google_id)}`, body, ignore: [404, 410] });
    if (!saved) {
      saved = await google(query, owner, { base: TASKS, method: "POST", path, body });
      await query("DELETE FROM google_links WHERE owner_user_id = $1 AND kind = 'task' AND local_id = $2", [owner, row.id]);
    }
    await saveLink(query, owner, "task", { localId: row.id, googleId: saved.id, container: listId, etag: saved.etag || "", googleStamp: saved.updated || "", localStamp: row.stamp });
    stats.tasks.pushed += 1;
  }
  const gone = (await query(
    `SELECT l.google_id, l.container FROM google_links l LEFT JOIN todos t ON t.id = l.local_id
      WHERE l.owner_user_id = $1 AND l.kind = 'task' AND t.id IS NULL LIMIT $2`,
    [owner, PUSH_LIMIT],
  )).rows;
  for (const link of gone) {
    await google(query, owner, { base: TASKS, method: "DELETE", path: `lists/${enc(listOf(link.container))}/tasks/${enc(link.google_id)}`, ignore: [404, 410] });
    await query("DELETE FROM google_links WHERE owner_user_id = $1 AND kind = 'task' AND google_id = $2", [owner, link.google_id]);
    stats.tasks.deleted_remote += 1;
  }
}

// ── Мгновенные уведомления Google Календаря ──────────────────────────────────

/** Google шлёт уведомления только на публичный https-адрес; локальный dev и адреса в сети их не получат. */
export const pushable = (origin) => /^https:\/\//i.test(String(origin || "")) && !/^https:\/\/(localhost|127\.|10\.|192\.168\.|\[)/i.test(String(origin));

async function stopWatch(query, owner, watch) {
  if (!watch?.id || !watch.resource) return;
  await google(query, owner, { base: CAL, method: "POST", path: "channels/stop", body: { id: watch.id, resourceId: watch.resource }, ignore: [400, 404] }).catch(() => {});
}

async function stopAllWatches(query, owner) {
  const watches = (await query("SELECT watches FROM google_sync_state WHERE owner_user_id = $1", [owner]).catch(() => ({ rows: [] }))).rows[0]?.watches || {};
  for (const watch of Object.values(watches)) await stopWatch(query, owner, watch);
  await query("UPDATE google_sync_state SET watches = '{}' WHERE owner_user_id = $1", [owner]).catch(() => {});
}

/** Каналы уведомлений на каждый выбранный календарь: открыть недостающие, продлить истекающие, закрыть лишние. */
async function ensureWatches(query, owner) {
  const state = (await query("SELECT enabled, calendar, calendars, watches, push_origin FROM google_sync_state WHERE owner_user_id = $1", [owner])).rows[0];
  if (!state) return;
  const address = pushable(state.push_origin) ? `${state.push_origin}${PUSH_PATH}` : "";
  const wanted = state.enabled && state.calendar && address ? selection(state.calendars, DEFAULT_CALENDAR) : [];
  const watches = { ...(state.watches || {}) };
  let changed = false;
  for (const [calendarId, watch] of Object.entries(watches)) {
    if (wanted.includes(calendarId) && (!watch.address || watch.address === address)) continue;
    await stopWatch(query, owner, watch);
    delete watches[calendarId];
    changed = true;
  }
  for (const calendarId of wanted) {
    const watch = watches[calendarId];
    if (watch?.id && Number(watch.expires) - Date.now() > WATCH_RENEW_MS) continue;
    if (watch?.error && Number(watch.retry_at) > Date.now()) continue;
    const id = randomUUID();
    const token = randomBytes(18).toString("base64url");
    try {
      const data = await google(query, owner, {
        base: CAL, method: "POST", path: `calendars/${enc(calendarId)}/events/watch`,
        body: { id, type: "web_hook", address, token, params: { ttl: String(WATCH_TTL_S) } },
      });
      if (watch?.id) await stopWatch(query, owner, watch);
      watches[calendarId] = { id, token, resource: data.resourceId || "", expires: Number(data.expiration) || Date.now() + WATCH_TTL_S * 1000, address };
    } catch (error) {
      watches[calendarId] = { ...(watch?.id ? watch : {}), error: error instanceof Error ? error.message : String(error), retry_at: Date.now() + WATCH_RETRY_MS };
    }
    changed = true;
  }
  if (changed) await query("UPDATE google_sync_state SET watches = $2::jsonb WHERE owner_user_id = $1", [owner, JSON.stringify(watches)]);
}

/** Уведомление Google «в календаре что-то изменилось». Без сессии: подлинность — id канала и его токен из нашей же таблицы. */
export async function handleGooglePlannerPush({ req, res, url, query, broadcast }) {
  if (url.pathname !== PUSH_PATH || req.method !== "POST") return false;
  req.resume?.();
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
  const channel = String(req.headers["x-goog-channel-id"] || "");
  const token = String(req.headers["x-goog-channel-token"] || "");
  if (!channel || !token || req.headers["x-goog-resource-state"] === "sync") return true;
  const row = (await query(
    `SELECT s.owner_user_id FROM google_sync_state s, jsonb_each(s.watches) w
      WHERE s.enabled AND w.value->>'id' = $1 AND w.value->>'token' = $2 LIMIT 1`,
    [channel, token],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (row) scheduleGoogleSync(query, row.owner_user_id, broadcast, PUSH_DEBOUNCE_MS);
  return true;
}

// ── Запуск ───────────────────────────────────────────────────────────────────

const running = new Set();
const emptyStats = () => ({ events: { pulled: 0, pushed: 0, deleted_local: 0, deleted_remote: 0 }, tasks: { pulled: 0, pushed: 0, deleted_local: 0, deleted_remote: 0 } });

/** Одна сверка человека. Возвращает счётчики; ошибка Google попадает в last_error, не роняя процесс. */
export async function syncGooglePlanner(query, userId, { force = false, broadcast } = {}) {
  await ensureGooglePlannerSchema(query);
  const owner = String(userId);
  const state = (await query("SELECT * FROM google_sync_state WHERE owner_user_id = $1", [owner])).rows[0];
  if (!state || (!state.enabled && !force)) return { skipped: "disabled" };
  if (running.has(owner)) return { skipped: "running" };
  running.add(owner);
  // Время начала, а не конца: правка, сделанная в MBOX во время сверки, останется «новее сверки» и уйдёт следующей.
  const started = new Date().toISOString();
  const stats = emptyStats();
  let error = "";
  try {
    const timeZone = plannerTimeZone();
    if (state.calendar) {
      const calendars = selection(state.calendars, DEFAULT_CALENDAR);
      const readonly = new Set(calendars.length > 1 ? await refreshReadonly(query, owner, state.readonly_calendars) : []);
      for (const calendarId of calendars) await pullEvents(query, owner, stats, timeZone, calendarId);
      await pushEvents(query, owner, stats, timeZone, readonly);
    }
    if (state.tasks) {
      for (const listId of selection(state.task_lists, DEFAULT_LIST)) await pullTasks(query, owner, stats, listId);
      await pushTasks(query, owner, stats);
    }
    await ensureWatches(query, owner);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    running.delete(owner);
  }
  await query("UPDATE google_sync_state SET last_sync_at = $4::timestamptz, last_error = $2, last_result = $3::jsonb WHERE owner_user_id = $1", [owner, error, JSON.stringify(stats), started]);
  if (stats.events.pulled || stats.events.deleted_local) broadcast?.("entity_changed", { entity: "calendar_events", action: "update", actor: "Google", silent: true });
  if (stats.tasks.pulled || stats.tasks.deleted_local) broadcast?.("entity_changed", { entity: "todos", action: "update", actor: "Google", silent: true });
  return { stats, error };
}

const timers = new Map();
/** Сверка через несколько секунд: серия правок или уведомлений склеивается в одну. */
export function scheduleGoogleSync(query, userId, broadcast, delay = DEBOUNCE_MS) {
  const key = String(userId);
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => { timers.delete(key); syncGooglePlanner(query, key, { broadcast }).catch(() => {}); }, delay);
  timer.unref?.();
  timers.set(key, timer);
}

/**
 * У кого в MBOX есть правки, ещё не ушедшие в Google: новые или изменённые после последней сверки события и личные задачи, удалённые записи
 * с парой в Google. Так в Google уходит любая правка — из интерфейса, от агента по MCP, из дерева задач, от автоматизации.
 */
export async function usersWithLocalChanges(query) {
  return (await query(
    `SELECT s.owner_user_id FROM google_sync_state s
       JOIN oauth_connections c ON c.provider = $1 AND c.owner_user_id = s.owner_user_id AND c.refresh_ciphertext IS NOT NULL
      WHERE s.enabled AND (
        (s.calendar AND EXISTS (
          SELECT 1 FROM calendar_events e LEFT JOIN google_links l ON l.owner_user_id = e.owner_user_id AND l.kind = 'event' AND l.local_id = e.id
           WHERE e.owner_user_id = s.owner_user_id AND e.updated_at > COALESCE(s.last_sync_at, 'epoch') AND (l.local_stamp IS NULL OR e.updated_at > l.local_stamp)))
        OR (s.tasks AND EXISTS (
          SELECT 1 FROM todos t LEFT JOIN google_links l ON l.owner_user_id = s.owner_user_id AND l.kind = 'task' AND l.local_id = t.id
           WHERE t.project_id IS NULL AND t.props->>'owner_user_id' = s.owner_user_id AND t.updated_at > COALESCE(s.last_sync_at, 'epoch')
             AND (l.local_stamp IS NULL OR t.updated_at > l.local_stamp)))
        OR EXISTS (
          SELECT 1 FROM google_links l WHERE l.owner_user_id = s.owner_user_id
             AND ((l.kind = 'event' AND NOT EXISTS (SELECT 1 FROM calendar_events e WHERE e.id = l.local_id))
               OR (l.kind = 'task' AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.id = l.local_id)))))`,
    [PROVIDER],
  )).rows.map((row) => row.owner_user_id);
}

/** Фон: правки MBOX — проверка раз в 30 секунд; правки Google — опрос раз в 2 минуты (календарь ещё и уведомлениями, см. выше). */
export function startGooglePlannerSync({ query, broadcast, log = console.log }) {
  const poll = async () => {
    try {
      await ensureGooglePlannerSchema(query);
      const users = (await query(
        `SELECT s.owner_user_id FROM google_sync_state s JOIN oauth_connections c ON c.provider = $1 AND c.owner_user_id = s.owner_user_id
          WHERE s.enabled AND c.refresh_ciphertext IS NOT NULL`,
        [PROVIDER],
      )).rows;
      for (const user of users) {
        const result = await syncGooglePlanner(query, user.owner_user_id, { broadcast });
        if (result.error) log(`google planner ${user.owner_user_id}: ${result.error}`);
      }
    } catch (error) {
      log(`google planner: ${error instanceof Error ? error.message : error}`);
    }
  };
  const dirty = async () => {
    try {
      await ensureGooglePlannerSchema(query);
      for (const userId of await usersWithLocalChanges(query)) scheduleGoogleSync(query, userId, broadcast, 1_000);
    } catch (error) {
      log(`google planner local check: ${error instanceof Error ? error.message : error}`);
    }
  };
  const timers = [setInterval(poll, POLL_MS), setInterval(dirty, DIRTY_CHECK_MS)];
  for (const timer of timers) timer.unref?.();
  setTimeout(poll, 20_000).unref?.();
  return () => timers.forEach(clearInterval);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export async function handleGooglePlannerApi({ req, res, url, query, readBody, sendJson, userId, origin, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/google-planner/")) return false;
  try {
    const route = url.pathname.slice("/api/mbox/google-planner/".length);
    // Адрес, по которому человек открыл MBOX: на него Google будет слать уведомления календаря (только публичный https).
    if (pushable(origin)) await query("UPDATE google_sync_state SET push_origin = $2 WHERE owner_user_id = $1 AND push_origin <> $2", [String(userId), origin]).catch(() => {});
    if (route === "status" && req.method === "GET") { sendJson(res, 200, await googlePlannerStatus(query, userId, origin)); return true; }
    if (route === "sources" && req.method === "GET") { sendJson(res, 200, await googlePlannerSources(query, userId)); return true; }
    if (route === "connect" && req.method === "POST") { sendJson(res, 200, { url: await beginGooglePlannerConnect(query, userId, origin) }); return true; }
    if (route === "disconnect" && req.method === "POST") { await disconnectGooglePlanner(query, userId); sendJson(res, 200, await googlePlannerStatus(query, userId, origin)); return true; }
    if (route === "settings" && req.method === "PATCH") {
      const body = await readBody(req);
      await saveGooglePlannerSettings(query, userId, body || {});
      // Новый календарь или список — сразу забираем его; выключение — закрываем каналы уведомлений.
      if (body && (body.calendars || body.task_lists || body.enabled === true)) scheduleGoogleSync(query, userId, broadcast, 500);
      else await ensureWatches(query, String(userId)).catch(() => {});
      if (body && (body.calendars || body.task_lists)) broadcast?.("entity_changed", { entity: "calendar_events", action: "update", actor: "Google", silent: true });
      sendJson(res, 200, await googlePlannerStatus(query, userId, origin));
      return true;
    }
    if (route === "sync" && req.method === "POST") {
      const result = await syncGooglePlanner(query, userId, { force: true, broadcast });
      sendJson(res, 200, { ...(await googlePlannerStatus(query, userId, origin)), result });
      return true;
    }
  } catch (error) {
    sendJson(res, error?.code === "not_connected" ? 409 : 400, { error: error instanceof Error ? error.message : String(error), code: error?.code || "" });
    return true;
  }
  return false;
}
