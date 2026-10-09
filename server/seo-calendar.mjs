// Календарь SEO Wizard: что должно происходить в каждый день месяца и что реально произошло.
// Расписание — scenariosOnDay (seo-strategy.mjs, заметка #27), факты — прогоны (seo_runs), пакеты (seo_packages),
// проверки позиций Topvisor (seo_rank_checks) и замеры правок (seo_changes). Здесь чистая сборка дней: проверяется тестом.

const DAY = 86_400_000;
const MSK_OFFSET = 3 * 3_600_000;

/** Человеческие названия: в клетках календаря нельзя оставлять «Арх» и «Авт». */
export const CALENDAR_TITLES = {
  daily: "Сбор данных",
  monday: "Очередь недели",
  thursday: "Проверка внедрения",
  architecture: "Архитектура сайта",
  authority: "Авторитет и ссылки",
  monthly: "Итоги месяца",
  positions: "Позиции Topvisor",
  measure: "Замер эффекта правки",
};

const WEEKLY = new Set(["monday", "thursday"]);

const pad = (value) => String(value).padStart(2, "0");
const mskDay = (value) => new Date(new Date(value).getTime() + MSK_OFFSET).toISOString().slice(0, 10);
const parseAt = (value) => {
  const at = Date.parse(String(value || "").replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isFinite(at) ? at : null;
};

/** «2026-10» → { year, month }; пусто или мусор — текущий месяц по Москве. */
export function parseMonth(text, now = new Date()) {
  const match = String(text || "").match(/^(\d{4})-(\d{2})$/);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return { year: Number(match[1]), month: Number(match[2]) };
  const today = new Date(now.getTime() + MSK_OFFSET);
  return { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 };
}

/**
 * Дни месяца с событиями.
 *  scenariosOnDay — функция расписания (date → [id]);
 *  runs      — [{ day, status }] прогоны сбора по дням (по Москве);
 *  packages  — [{ scenario, at }] собранные пакеты;
 *  checks    — [{ day, status }] заказанные проверки позиций;
 *  measures  — [{ day, count }] правки, у которых в этот день срок замера;
 *  info      — { [id]: { server, session, notify } } описание сценариев для панели дня.
 */
export function buildCalendar({ year, month, today, scenariosOnDay, runs = [], packages = [], checks = [], measures = [], info = {}, autorun = false, nextPositionsDay = "" }) {
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${pad(month)}-${pad(count)}`;
  const runsByDay = new Map();
  for (const run of runs) runsByDay.set(run.day, [...(runsByDay.get(run.day) || []), run.status]);
  const checkByDay = new Map(checks.map((item) => [item.day, item.status]));
  const measureByDay = new Map(measures.map((item) => [item.day, item.count]));
  const packageDays = packages.map((item) => ({ scenario: item.scenario, day: mskDay(item.at), at: item.at })).sort((a, b) => a.day.localeCompare(b.day));

  const days = [];
  for (let day = 1; day <= count; day += 1) {
    const date = `${year}-${pad(month)}-${pad(day)}`;
    const noon = new Date(Date.UTC(year, month - 1, day) - MSK_OFFSET + 12 * 3_600_000);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const isPast = date < today;
    const isToday = date === today;
    const items = [];

    // Сбор данных каждый день: факт по прогонам, а не по расписанию (до включения автозапуска прогонов не было).
    const dayRuns = runsByDay.get(date) || [];
    const ok = dayRuns.filter((status) => status === "ok").length;
    const failed = dayRuns.filter((status) => status === "error").length;
    items.push({
      id: "daily", kind: "daily", title: CALENDAR_TITLES.daily,
      state: ok ? "done" : failed ? "failed" : isToday ? "today" : isPast ? "none" : "planned",
      detail: dayRuns.length ? `Прогонов: ${dayRuns.length}${failed ? `, с ошибкой: ${failed}` : ""}` : isPast ? "Прогонов в этот день не было" : "",
      info: info.daily || null,
    });

    for (const id of scenariosOnDay(noon).filter((item) => item !== "daily")) {
      // Пакет сценария считается этим днём, если он собран в этот день или позже, но до следующего такого же срока.
      const horizon = WEEKLY.has(id) ? new Date(Date.UTC(year, month - 1, day) + 6 * DAY).toISOString().slice(0, 10) : monthEnd;
      const built = packageDays.find((item) => item.scenario === id && item.day >= date && item.day <= horizon);
      items.push({
        id, kind: "scenario", title: CALENDAR_TITLES[id] || id,
        state: built ? "done" : isToday ? "today" : isPast ? "missed" : "planned",
        detail: built ? `Пакет собран ${built.day.split("-").reverse().join(".")}` : isPast ? "Пакет не собран: сессия не запускалась" : isToday ? "Пакет сегодня: сервер соберёт по расписанию или нажмите «Собрать»" : "",
        info: info[id] || null,
      });
    }

    const check = checkByDay.get(date);
    const planned = !check && date === nextPositionsDay;
    if (check || planned) {
      items.push({
        id: "positions", kind: "positions", title: CALENDAR_TITLES.positions,
        state: check === "done" ? "done" : check === "error" || check === "timeout" ? "failed" : check === "requested" ? "today" : "planned",
        detail: check === "done" ? "Проверка прошла, позиции обновлены" : check === "error" ? "Topvisor не принял заказ проверки" : check === "timeout" ? "Проверка не завершилась за 8 часов" : check === "requested" ? "Проверка заказана, ждём результат" : autorun ? "Сервер закажет проверку по расписанию (раз в неделю)" : "Автозапуск выключен: проверку придётся заказывать вручную",
        info: { server: "Раз в неделю сервер просит Topvisor перепроверить позиции (без платных снимков выдачи), через 20 минут забирает результат и спрос Wordstat.", session: "", notify: "" },
      });
    }

    const measure = measureByDay.get(date);
    if (measure) {
      items.push({
        id: "measure", kind: "measure", title: CALENDAR_TITLES.measure,
        state: isPast ? "none" : "planned", detail: `Правок к замеру: ${measure}. Результат «до/после» войдёт в итоги месяца.`,
        info: null,
      });
    }

    days.push({ day, date, weekday, is_today: isToday, is_past: isPast, items });
  }
  return days;
}

/** Данные для календаря месяца из базы. query — функция SQL; scenariosOnDay и info приходят снаружи, чтобы модуль не зависел от остального SEO Wizard. */
export async function seoCalendarData(query, { monthText = "", now = new Date(), scenariosOnDay, info = {}, autorun = false } = {}) {
  const { year, month } = parseMonth(monthText, now);
  const from = `${year}-${pad(month)}-01`;
  const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const safe = async (sql, params) => (await query(sql, params).catch(() => ({ rows: [] }))).rows;
  const [runs, packages, checks, measures, lastCheck] = await Promise.all([
    safe("SELECT (started_at AT TIME ZONE 'Europe/Moscow')::date::text AS day, status FROM seo_runs WHERE (started_at AT TIME ZONE 'Europe/Moscow')::date >= $1::date AND (started_at AT TIME ZONE 'Europe/Moscow')::date < $2::date", [from, next]),
    safe("SELECT scenario, created_at::text AS at FROM seo_packages WHERE created_at >= $1::date - interval '1 day' AND created_at < $2::date + interval '7 days'", [from, next]),
    safe("SELECT (requested_at AT TIME ZONE 'Europe/Moscow')::date::text AS day, status FROM seo_rank_checks WHERE (requested_at AT TIME ZONE 'Europe/Moscow')::date >= $1::date AND (requested_at AT TIME ZONE 'Europe/Moscow')::date < $2::date", [from, next]),
    safe("SELECT measure_after::text AS day, count(*)::int AS count FROM seo_changes WHERE measure_after >= $1::date AND measure_after < $2::date AND status IN ('planned', 'applied') GROUP BY 1", [from, next]),
    safe("SELECT requested_at::text AS at FROM seo_rank_checks WHERE status <> 'error' ORDER BY requested_at DESC LIMIT 1"),
  ]);
  const today = mskDay(now);
  const lastAt = parseAt(lastCheck[0]?.at);
  const nextPositionsDay = autorun ? mskDay(lastAt === null ? now : Math.max(lastAt + 7 * DAY, now.getTime())) : "";
  return {
    year, month, today,
    title: `${new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)))} ${year}`,
    prev: `${month === 1 ? year - 1 : year}-${pad(month === 1 ? 12 : month - 1)}`,
    next: `${month === 12 ? year + 1 : year}-${pad(month === 12 ? 1 : month + 1)}`,
    autorun,
    days: buildCalendar({ year, month, today, scenariosOnDay, runs, packages, checks, measures, info, autorun, nextPositionsDay }),
  };
}
