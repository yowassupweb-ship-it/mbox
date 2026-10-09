// История действий SEO Wizard и «сторож»: что сервер делал сам и что должен был сделать, но не сделал.
// Человек не должен узнавать о сломавшемся механизме через месяц по отсутствию результата, поэтому всё, что работает по расписанию,
// пишет сюда итог, а сторож сравнивает ожидаемое с фактом и поднимает тревогу.

import { indexTrend as indexTrendOf } from "./seo-yandex.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MSK_OFFSET = 3 * HOUR;

const parseAt = (value) => {
  const at = Date.parse(String(value || "").replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isFinite(at) ? at : null;
};
const ageHours = (value, now) => { const at = parseAt(value); return at === null ? null : (now.getTime() - at) / HOUR; };
const mskHour = (now) => new Date(now.getTime() + MSK_OFFSET).getUTCHours();
const plural = (n, one, few, many) => { const m = n % 100; const k = n % 10; return m > 10 && m < 20 ? many : k === 1 ? one : k >= 2 && k <= 4 ? few : many; };
const days = (hours) => { const n = Math.floor(hours / 24); return `${n} ${plural(n, "день", "дня", "дней")}`; };

/** Записать действие в историю. Ошибка записи не должна ломать само действие. */
export async function logActivity(query, { kind, title, status = "ok", detail = "", source = "scheduler", props = {} }) {
  try {
    await query(
      "INSERT INTO seo_activity(kind, title, status, detail, source, props) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
      [String(kind).slice(0, 40), String(title).slice(0, 300), String(status).slice(0, 20), String(detail || "").slice(0, 2000), String(source).slice(0, 20), JSON.stringify(props || {})],
    );
  } catch {
    // история — вспомогательная: потеря строки хуже не станет, чем потеря самого действия
  }
}

const SOURCE_NAMES = { topvisor_audit: "Topvisor", webmaster: "Вебмастер", metrica: "Метрика", wordstat: "Wordstat", webmaster_pages: "Вебмастер по страницам", sitemap: "sitemap" };

/**
 * Что должно было произойти и не произошло. Чистая функция: на вход факты, на выход список тревог { id, level, title, text, action }.
 * autorun — включено ли расписание на сервере; без него сервер сам ничего не собирает, и это само по себе тревога.
 */
export function watchdog({ now = new Date(), autorun = false, tickAt = "", runs = [], lastCheck = null, jobs = {}, ranksAt = "", demand = null, indexDrop = null }) {
  const alerts = [];
  const add = (id, level, title, text, action = null) => alerts.push({ id, level, title, text, action });
  const lastRun = runs[0] || null;
  const lastOk = runs.find((run) => run.status === "ok") || null;

  if (!autorun) {
    add("autorun_off", "high", "Автозапуск выключен", "Сервер не собирает данные сам: ни ежедневный сбор, ни недельную проверку позиций. Всё делается только кнопкой.", { label: "Расписание", tab: "server", view: "scenarios" });
  } else {
    const tick = ageHours(tickAt, now);
    if (tick !== null && tick > 0.5) add("scheduler_stalled", "high", "Расписание не работает", `Планировщик не просыпался ${tick < 24 ? `${Math.round(tick * 60)} мин` : days(tick)}: должен каждые 10 минут. Возможно, сервер перезапускается или завис.`);
    const sinceOk = lastOk ? ageHours(lastOk.started_at, now) : null;
    if (mskHour(now) >= 8 && (sinceOk === null || sinceOk > 26)) {
      add("daily_missed", "high", "Ежедневный сбор не сработал", sinceOk === null ? "Ни одного успешного сбора ещё не было." : `Последний успешный сбор был ${days(sinceOk)} назад, а должен быть каждый день.`, { label: "Прогоны", tab: "server", view: "runs" });
    }
  }
  if (lastRun && lastRun.status === "error") {
    add("last_run_failed", "high", "Последний сбор закончился ошибкой", `Сбор от ${String(lastRun.started_at).slice(0, 16)} не завершился. Данные могут быть неполными.`, { label: "Прогоны", tab: "server", view: "runs" });
  }
  const broken = Object.entries(lastRun?.sources || {}).filter(([, source]) => source?.status === "error");
  if (broken.length) {
    add("source_errors", "medium", "Источники отвечают ошибкой", broken.map(([key, source]) => `${SOURCE_NAMES[key] || key}: ${String(source.error || "ошибка").slice(0, 120)}`).join("; "), { label: "Прогоны", tab: "server", view: "runs" });
  }

  const check = lastCheck;
  if (check) {
    const hours = ageHours(check.requested_at, now);
    if (check.status === "error") add("positions_check_error", "high", "Проверка позиций не заказана", "Topvisor не принял заказ проверки (например, нет лимита или неверный проект): позиции обновляться не будут.", { label: "Позиции", tab: "clicks", view: "positions" });
    else if (check.status === "requested" && hours !== null && hours > 8) add("positions_check_stuck", "high", "Проверка позиций не завершилась", `Заказана ${days(hours)} назад и до сих пор без результата.`, { label: "Позиции", tab: "clicks", view: "positions" });
    else if (autorun && hours !== null && hours > 8 * 24) add("positions_check_overdue", "high", "Позиции не обновлялись больше недели", `Последняя проверка заказана ${days(hours)} назад, а должна раз в неделю.`, { label: "Позиции", tab: "clicks", view: "positions" });
  }
  const ranks = ageHours(ranksAt, now);
  if (ranks !== null && ranks > 8 * 24) add("positions_stale", "medium", "Позиции устарели", `Свежие позиции Topvisor — ${days(ranks)} назад: решения по ним принимать нельзя.`, { label: "Позиции", tab: "clicks", view: "positions" });

  const pageJob = ageHours(jobs.webmaster_page_queries?.last_at, now);
  if (autorun && jobs.webmaster_page_queries && pageJob !== null && pageJob > 9 * 24) add("page_queries_stale", "medium", "Запросы страниц не собираются", `Недельный сбор запросов страниц из Вебмастера не запускался ${days(pageJob)}: карточки страниц и каннибализация устаревают.`);

  if (demand && demand.todo > 0) {
    const idle = ageHours(demand.last_at, now);
    if (idle === null || idle > 4) add("demand_incomplete", "medium", "Спрос Wordstat собран не весь", `Не хватает ${demand.todo} из ${demand.all} запросов${idle === null ? "" : `, последний сбор ${idle < 24 ? `${Math.round(idle)} ч` : days(idle)} назад`}. Потенциал и видимость по ним не посчитаны.`);
  }
  const yandexJob = ageHours(jobs.webmaster_yandex_view?.last_at, now);
  if (autorun && jobs.webmaster_yandex_view && yandexJob !== null && yandexJob > 9 * 24) add("yandex_stale", "medium", "Данные Яндекса не обновляются", `Недельный сбор «Яндекс видит» не запускался ${days(yandexJob)}: индекс и ошибки обхода устаревают.`, { label: "Яндекс видит", tab: "yandex" });
  if (indexDrop && indexDrop.drop_from_peak_pct >= 15) {
    add("index_shrinking", "high", "Индекс Яндекса сокращается", `Страниц в поиске ${indexDrop.last.value.toLocaleString("ru-RU")} против ${indexDrop.peak.value.toLocaleString("ru-RU")} на ${indexDrop.peak.date.split("-").reverse().join(".")} (минус ${indexDrop.drop_from_peak_pct}%). Это может быть и чисткой дублей, и потерей нужных страниц: посмотрите, какие именно уходят.`, { label: "Яндекс видит", tab: "yandex" });
  }
  const order = { high: 0, medium: 1, info: 2 };
  return alerts.sort((a, b) => order[a.level] - order[b.level]);
}

/** Лента: действия сервера (seo_activity) вместе с прогонами, пакетами и проверками позиций, свежие сверху. */
export async function activityFeed(query, { limit = 200 } = {}) {
  const safe = async (sql, params) => (await query(sql, params).catch(() => ({ rows: [] }))).rows;
  const [acts, runs, packages, checks] = await Promise.all([
    safe("SELECT created_at::text AS at, kind, title, status, detail, source FROM seo_activity ORDER BY created_at DESC LIMIT $1", [limit]),
    safe("SELECT started_at::text AS at, scenario, status, finished_at::text AS finished_at, stats, sources FROM seo_runs ORDER BY started_at DESC LIMIT $1", [limit]),
    safe("SELECT created_at::text AS at, scenario, jsonb_array_length(COALESCE(payload->'candidates', '[]'::jsonb))::int AS candidates FROM seo_packages ORDER BY created_at DESC LIMIT $1", [limit]),
    safe("SELECT requested_at::text AS at, status, error, result FROM seo_rank_checks ORDER BY requested_at DESC LIMIT $1", [limit]),
  ]);
  const out = acts.map((item) => ({ at: item.at, kind: item.kind, title: item.title, status: item.status, detail: item.detail, source: item.source }));
  for (const run of runs) {
    const failed = Object.entries(run.sources || {}).filter(([, source]) => source?.status === "error").map(([key]) => SOURCE_NAMES[key] || key);
    out.push({
      at: run.at, kind: "run", title: `Сбор данных «${run.scenario}»`,
      status: run.status === "ok" ? (failed.length ? "partial" : "ok") : run.status === "running" ? "running" : "failed",
      detail: run.status === "ok" ? `Проверено ${run.stats?.crawled_urls ?? "?"} страниц, находок ${run.stats?.issues_detected ?? "?"}${failed.length ? `. Не ответили: ${failed.join(", ")}` : ""}` : run.status === "running" ? "Идёт" : "Не завершился",
      source: "run",
    });
  }
  for (const item of packages) out.push({ at: item.at, kind: "package", title: `Пакет «${item.scenario}» собран`, status: "ok", detail: `Кандидатов: ${item.candidates}`, source: "package" });
  for (const item of checks) {
    out.push({
      at: item.at, kind: "positions", title: "Проверка позиций в Topvisor",
      status: item.status === "done" ? "ok" : item.status === "requested" ? "running" : "failed",
      detail: item.status === "done" ? "Проверка прошла, позиции обновлены" : item.status === "requested" ? "Заказана, ждём результат" : item.error || "Не завершилась",
      source: "scheduler",
    });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

/** Факты для сторожа из базы + решение. ctx.tickAt и ctx.autorun знает вызывающий (планировщик живёт в памяти процесса). */
export async function healthAlerts(query, { now = new Date(), autorun = false, tickAt = "", demandTargets = null } = {}) {
  const safe = async (sql, params) => (await query(sql, params).catch(() => ({ rows: [] }))).rows;
  const [runs, checks, jobRows, ranks, demandLast] = await Promise.all([
    safe("SELECT started_at::text AS started_at, status, scenario, sources FROM seo_runs ORDER BY started_at DESC LIMIT 6"),
    safe("SELECT status, requested_at::text AS requested_at FROM seo_rank_checks ORDER BY requested_at DESC LIMIT 1"),
    safe("SELECT name, last_at::text AS last_at FROM seo_jobs"),
    safe("SELECT max(captured_at)::text AS at FROM seo_rank_snapshots WHERE source = 'topvisor'"),
    safe("SELECT max(captured_at)::text AS at FROM seo_demand_snapshots WHERE source = 'wordstat_api'"),
  ]);
  const demand = demandTargets ? { all: demandTargets.all, todo: demandTargets.todo.length, last_at: demandLast[0]?.at || "" } : null;
  const snapshot = (await safe("SELECT data->'indexed_history' AS history FROM seo_yandex_snapshots ORDER BY captured_on DESC LIMIT 1"))[0];
  const trend = snapshot?.history ? indexTrendOf(snapshot.history) : null;
  return watchdog({
    now, autorun, tickAt, runs, lastCheck: checks[0] || null,
    jobs: Object.fromEntries(jobRows.map((row) => [row.name, { last_at: row.last_at }])), ranksAt: ranks[0]?.at || "", demand, indexDrop: trend,
  });
}
