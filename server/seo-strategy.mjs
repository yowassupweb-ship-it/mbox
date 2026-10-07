// SEO Wizard: «сценарий» (цикл улучшения и ритм недели/месяца) и «стратегия» (что имеем, что можем, что могли бы,
// чего не можем). Всё считается по живым данным — источникам, прогонам, находкам, задачам; текст стратегии —
// честная опись возможностей, а не обещания: у каждого пункта есть доказательство или условие, что его откроет.
import { seoSources, SCENARIOS } from "./seo-views.mjs";
import { liveSeoRun } from "./seo-wizard.mjs";

const DAY = 86_400_000;
const MSK_OFFSET = 3 * 3_600_000;
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/** Дата и время по Москве как UTC-поля: расписание сайта привязано к московскому дню, а не к часовому поясу сервера. */
function msk(now) {
  return new Date(now.getTime() + MSK_OFFSET);
}

const isoDay = (date) => date.toISOString().slice(0, 10);
const parseAt = (value) => {
  const text = String(value || "");
  if (!text) return null;
  const at = Date.parse(text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isFinite(at) ? at : null;
};
const daysAgo = (value, now) => {
  const at = parseAt(value);
  return at === null ? null : Math.floor((now.getTime() - at) / DAY);
};

/** Какие сценарии на этот день: по расписанию из стратегии (заметка #27). Чистая функция — проверяется тестом. */
export function scenariosOnDay(date) {
  const day = msk(date);
  const list = ["daily"];
  const weekday = day.getUTCDay();
  if (weekday === 1) list.push("monday");
  if (weekday === 4) list.push("thursday");
  const dom = day.getUTCDate();
  if (dom === 10) list.push("architecture");
  if (dom === 20) list.push("authority");
  if (dom === 25) list.push("monthly");
  return list;
}

/** Ближайшая дата (по Москве, YYYY-MM-DD) указанного сценария начиная с `now` включительно. */
export function nextRunDay(scenario, now = new Date()) {
  for (let step = 0; step < 62; step += 1) {
    const date = new Date(now.getTime() + step * DAY);
    if (scenariosOnDay(date).includes(scenario)) return isoDay(msk(date));
  }
  return "";
}

/** Календарь месяца с отметками сценариев: по нему рисуется «ритм». */
export function monthRhythm(now = new Date()) {
  const today = msk(now);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const days = [];
  for (let day = 1; day <= count; day += 1) {
    const date = new Date(Date.UTC(year, month, day) - MSK_OFFSET + 12 * 3_600_000);
    days.push({ day, weekday: WEEKDAYS[new Date(Date.UTC(year, month, day)).getUTCDay()], markers: scenariosOnDay(date).filter((id) => id !== "daily") });
  }
  return { year, month: month + 1, title: `${MONTHS[month]} ${year}`, today: today.getUTCDate(), days };
}

/**
 * Кого и что запускать по расписанию: сценарий «должен» быть, если его дата наступила (или прошла в этом
 * периоде) и свежего пакета за период нет. Пропущенная сессия не теряется — следующий тик её догоняет.
 * `lastAt` — когда последний раз был пакет/прогон сценария (ISO или Postgres-текст), `lastRunAt` — последний удачный сбор.
 */
export function dueScenarios({ now = new Date(), lastAt = {}, lastRunAt = null }) {
  const today = msk(now);
  const hour = today.getUTCHours();
  const startOfDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - MSK_OFFSET;
  const since = (id, from) => { const at = parseAt(lastAt[id]); return at !== null && at >= from; };
  const dom = today.getUTCDate();
  const monthStart = (day) => Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day) - MSK_OFFSET;
  const due = [];
  if (dom >= 25 && !since("monthly", monthStart(25))) due.push("monthly");
  if (dom >= 20 && !since("authority", monthStart(20))) due.push("authority");
  if (dom >= 10 && !since("architecture", monthStart(10))) due.push("architecture");
  if (today.getUTCDay() === 1 && hour >= 5 && !since("monday", startOfDay)) due.push("monday");
  if (today.getUTCDay() === 4 && hour >= 5 && !since("thursday", startOfDay)) due.push("thursday");
  const lastRun = parseAt(lastRunAt);
  if (hour >= 4 && (lastRun === null || lastRun < startOfDay) && !due.length) due.push("daily");
  return due;
}

async function count(query, sql, values = []) {
  try { return Number((await query(sql, values)).rows[0]?.n ?? 0); } catch { return 0; }
}

const SOURCE_FRESH_DAYS = { sitemap: 3, crawl: 3, webmaster: 7, metrica: 7, topvisor_ranks: 14, topvisor_serp: 14, topvisor_audit: 14, wordstat: 35 };

/** Источник в понятном виде: подключён, свежий ли, сколько данных. */
function sourceView(item, now) {
  const age = daysAgo(item.updated_at, now);
  const limit = SOURCE_FRESH_DAYS[item.key] ?? 7;
  const stale = item.status === "ok" && age !== null && age > limit;
  return { key: item.key, label: item.label, status: stale ? "stale" : item.status, age_days: age, rows: item.rows, note: item.note || "" };
}

const TODO_SEO = "props->>'seo_wizard' = 'true'";

export async function seoScenarioState(query, settings, { now = new Date(), autorun = { enabled: false } } = {}) {
  const sources = await seoSources(query);
  const views = sources.sources.map((item) => sourceView(item, now));
  const connected = views.filter((item) => item.status === "ok").length;
  const run = sources.run;
  const runAge = daysAgo(run?.finished_at || run?.started_at, now);
  const live = liveSeoRun();

  const [open, high, queue, working, blocked, reviewing, doneMonth, plannedChanges, measured] = await Promise.all([
    count(query, "SELECT count(*)::int AS n FROM seo_issues WHERE status IN ('open', 'review')"),
    count(query, "SELECT count(*)::int AS n FROM seo_issues WHERE severity = 'high' AND status IN ('open', 'review')"),
    count(query, `SELECT count(*)::int AS n FROM todos WHERE ${TODO_SEO} AND status IN ('open', 'next')`),
    count(query, `SELECT count(*)::int AS n FROM todos WHERE ${TODO_SEO} AND status = 'doing'`),
    count(query, `SELECT count(*)::int AS n FROM todos WHERE ${TODO_SEO} AND status = 'blocked'`),
    count(query, `SELECT count(*)::int AS n FROM todos WHERE ${TODO_SEO} AND status = 'review'`),
    count(query, `SELECT count(*)::int AS n FROM todos WHERE ${TODO_SEO} AND status = 'done' AND updated_at > now() - interval '28 days'`),
    count(query, "SELECT count(*)::int AS n FROM seo_changes WHERE status IN ('planned', 'applied') AND (measure_after IS NULL OR measure_after > current_date)"),
    count(query, "SELECT count(*)::int AS n FROM seo_changes WHERE result <> '{}'::jsonb AND updated_at > now() - interval '28 days'"),
  ]);
  const packages = (await query("SELECT DISTINCT ON (scenario) scenario, created_at::text AS at, jsonb_array_length(COALESCE(payload->'candidates', '[]'::jsonb))::int AS candidates FROM seo_packages ORDER BY scenario, created_at DESC").catch(() => ({ rows: [] }))).rows;
  const byScenario = Object.fromEntries(packages.map((item) => [item.scenario, item]));
  const sessionNote = (await query("SELECT updated_at::text AS at FROM notes WHERE title = 'SEO · журнал сессий' ORDER BY updated_at DESC LIMIT 1").catch(() => ({ rows: [] }))).rows[0];
  const sessionAge = daysAgo(sessionNote?.at, now);

  const collectStatus = live ? "working" : !run ? "idle" : run.status === "error" ? "blocked" : runAge !== null && runAge > 1 ? "stale" : "ok";
  const flow = [
    {
      id: "collect", title: "Сбор", who: "сервер", status: collectStatus,
      value: `${connected} из ${views.length}`, label: "источников с данными",
      detail: live ? `Идёт сбор: ${live.stage}${live.total ? ` ${live.done}/${live.total}` : ""}` : run ? `Последний сбор ${runAge === 0 ? "сегодня" : `${runAge} дн. назад`}: ${run.stats?.crawled_urls ?? 0} страниц, ${run.stats?.sitemap_urls ?? 0} URL в sitemap` : "Сбор ещё не запускали",
      tab: "server", view: "runs",
    },
    {
      id: "detect", title: "Находки", who: "детекторы", status: !run ? "idle" : open ? "ok" : "ok",
      value: String(open), label: `открытых находок, важных ${high}`,
      detail: open ? "Каждая — с цифрой и адресами; шум помечается и больше не считается" : "Открытых находок нет",
      tab: "server", view: "issues",
    },
    {
      id: "choose", title: "Выбор недели", who: "агент", status: queue + working + reviewing >= 3 ? "ok" : sessionAge === null || sessionAge > 8 ? "stale" : "ok",
      value: String(queue + working), label: "задач в очереди недели (цель 3–5)",
      detail: sessionAge === null ? "Сессий разбора ещё не было" : `Последний разбор ${sessionAge === 0 ? "сегодня" : `${sessionAge} дн. назад`}`,
      tab: "week", view: "queue",
    },
    {
      id: "implement", title: "Внедрение", who: "человек", status: blocked ? "blocked" : working || reviewing ? "working" : queue ? "idle" : "idle",
      value: String(working + reviewing + blocked), label: `в работе / на проверке / заблокировано`,
      detail: `в работе ${working}, на проверке ${reviewing}, заблокировано ${blocked}; сделано за 28 дней ${doneMonth}`,
      tab: "week", view: "decisions",
    },
    {
      id: "verify", title: "Проверка", who: "сервер + агент", status: plannedChanges ? "working" : "idle",
      value: String(plannedChanges), label: "изменений ждут замера",
      detail: "Четверг: повторный обход страниц из задач, снимок «до» против «после»",
      tab: "week", view: "changes",
    },
    {
      id: "learn", title: "Итоги", who: "агент", status: measured ? "ok" : "idle",
      value: String(measured), label: "изменений с результатом за 28 дней",
      detail: byScenario.monthly ? `Итоги месяца: ${byScenario.monthly.at.slice(0, 10)}` : "25 числа — что сработало, что поменять, уроки в память",
      tab: "reports", view: "report25",
    },
  ];

  const rhythm = SCENARIOS.map((item) => {
    const last = byScenario[item.id]?.at || "";
    const next = nextRunDay(item.id, now);
    return { id: item.id, when: item.when, title: item.session === "не запускается" ? "Сторожевые проверки" : item.session.split("—")[0].replace(/[«»]/g, "").trim(), next_day: next, last_package_at: last, candidates: byScenario[item.id]?.candidates ?? null, today: scenariosOnDay(now).includes(item.id) };
  });

  return { today: isoDay(msk(now)), autorun, live, sources: views, flow, rhythm, month: monthRhythm(now), counts: { open_issues: open, high_issues: high, queue, working, blocked, reviewing } };
}

/** Опись возможностей: что имеем, можем, могли бы, не можем. Подключённое определяется по источникам, остальное — условия. */
export async function seoStrategy(query, settings, { now = new Date() } = {}) {
  const sources = await seoSources(query);
  const views = sources.sources.map((item) => sourceView(item, now));
  const by = Object.fromEntries(views.map((item) => [item.key, item]));
  const config = settings?.config || {};
  const [urls, links, tracked, queries, issues, templates] = await Promise.all([
    count(query, "SELECT count(*)::int AS n FROM seo_urls WHERE in_sitemap"),
    count(query, "SELECT count(*)::int AS n FROM seo_links"),
    count(query, "SELECT count(DISTINCT query)::int AS n FROM seo_rank_snapshots"),
    count(query, "SELECT count(DISTINCT query)::int AS n FROM seo_search_snapshots WHERE captured_at > now() - interval '28 days'"),
    count(query, "SELECT count(*)::int AS n FROM seo_issues WHERE status IN ('open', 'review')"),
    count(query, "SELECT count(DISTINCT url_type)::int AS n FROM seo_urls WHERE status_code IS NOT NULL"),
  ]);
  const age = (key) => (by[key]?.age_days === null || by[key]?.age_days === undefined ? "" : by[key].age_days === 0 ? "сегодня" : `${by[key].age_days} дн. назад`);
  const fresh = (key) => by[key]?.status === "ok";

  const have = [];
  const can = [];
  const could = [];
  const cannot = [];

  // Имеем: только то, что реально приходит и свежее. Устаревшее честно названо устаревшим.
  if (by.sitemap?.status === "ok" || by.crawl?.status === "ok") have.push({ id: "site", title: "Карта сайта и обход страниц", detail: `${urls} URL в sitemap, обход HTTP — ${by.crawl?.rows ?? 0} снимков, ${links} внутренних ссылок`, evidence: `обновлено ${age("crawl") || age("sitemap")}` });
  if (fresh("webmaster")) have.push({ id: "webmaster", title: "Показы и клики из Вебмастера", detail: `${queries} запросов за 28 дней: показы, клики, CTR, позиция по страницам`, evidence: `обновлено ${age("webmaster")}` });
  if (fresh("metrica")) have.push({ id: "metrica", title: "Трафик и поведение из Метрики", detail: "визиты, отказы, глубина, время и цели по страницам за 28 дней", evidence: `обновлено ${age("metrica")}` });
  if (fresh("topvisor_ranks")) have.push({ id: "ranks", title: "Позиции запросов (Topvisor)", detail: `${tracked} отслеживаемых запросов, динамика по неделям`, evidence: `обновлено ${age("topvisor_ranks")}` });
  if (by.topvisor_ranks?.status === "stale") have.push({ id: "ranks_stale", title: "Позиции запросов — устарели", detail: `${tracked} запросов, но снимок ${age("topvisor_ranks")}: для решений не годится, пока не обновится`, evidence: "сбор позиций не запускался", tone: "warn" });
  have.push({ id: "memory", title: "Задачи, решения и память в MBOX", detail: "находки превращаются в задачи с цифрами, решения человека и итоги сессий остаются в журнале", evidence: `открытых находок: ${issues}` });

  // Можем: что умеет система поверх уже подключённых данных.
  if (by.webmaster?.status === "ok" || by.webmaster?.status === "stale") can.push({ id: "ctr", title: "Найти упущенные клики", detail: "сравнить CTR страницы с нашей же кривой «позиция → CTR» и посчитать, сколько кликов недобираем", action: { label: "Открыть CTR", tab: "clicks", view: "ctr" } });
  if (urls) can.push({ id: "architecture", title: "Проверить архитектуру адресов", detail: "дубли окончаний в разных разделах, технические адреса в sitemap, внутренние ссылки на параметры фильтров", action: { label: "Открыть архитектуру", tab: "architecture", view: "registry" } });
  if (templates) can.push({ id: "templates", title: "Качество по шаблонам", detail: "заголовки, H1 и описания по типам страниц: одна задача на шаблон, а не двести на страницы", action: { label: "Открыть качество", tab: "pages", view: "quality" } });
  can.push({ id: "queue", title: "Собрать очередь недели", detail: "3–5 задач из находок с цифрой, адресом и способом проверки; остальное отклонить как шум", action: { label: "Открыть очередь", tab: "week", view: "queue" } });
  can.push({ id: "before_after", title: "Измерить результат", detail: "зафиксировать «до» и сравнить через 28 дней по Вебмастеру и Метрике", action: { label: "Журнал изменений", tab: "week", view: "changes" } });

  // Могли бы: чего не хватает и что оно даст — с условием включения.
  if (!fresh("topvisor_serp")) could.push({ id: "serp", title: "Выдача и конкуренты", detail: "кто стабильно в топ-10 и чем их сниппеты лучше: цена, даты, длительность", needs: "включить модуль выдачи в Topvisor", action: { label: "Настройки", tab: "settings" } });
  if (!fresh("wordstat")) could.push({ id: "demand", title: "Спрос и охват", detail: "сколько ищут по ядру и какую долю спроса забираем: видно страницы, которые недорабатывают", needs: "подключить Wordstat", action: { label: "Настройки", tab: "settings" } });
  if (by.topvisor_ranks?.status === "stale" || !fresh("topvisor_ranks")) could.push({ id: "fresh_ranks", title: "Свежие позиции каждую неделю", detail: "динамика Top-3/10/20 и эффект от внедрённых правок", needs: "ежедневный сбор позиций (расписание)", action: { label: "Сценарии", tab: "server", view: "scenarios" } });
  could.push({ id: "obscura", title: "Проверка карточек туров глазами пользователя", detail: "цена, даты, FAQ, отзывы, карта и фото подгружаются скриптом — их видит только настоящий браузер", needs: "локальная сессия с Obscura на компьютере" });
  if (!(config.metrica_counters || []).some((counter) => (counter.goals || []).some((goal) => goal.role === "lead" || goal.role === "booking")) && !config.metrica_goals?.lead) could.push({ id: "goals", title: "Заявки по страницам", detail: "видеть, какие страницы приводят заявки, а не только визиты", needs: "указать цели «заявка» и «бронь» Метрики в настройках", action: { label: "Настройки", tab: "settings" } });
  could.push({ id: "outreach", title: "Ссылочный профиль", detail: "площадки, которые уже упоминают «Вокруг света» без ссылки — самый быстрый источник ссылок", needs: "сессия «20 число» и список площадок", action: { label: "Link Outreach", tab: "authority", view: "outreach" } });

  // Не можем: границы, которые не зависят от настроек.
  cannot.push({ id: "deploy", title: "Менять сайт самим", detail: "SEO Wizard готовит задачи и проверяет результат; правки на сайте вносит команда сайта" });
  cannot.push({ id: "decisions", title: "Решать за человека", detail: "301, canonical, noindex, объединение страниц, новые страницы и правила фильтров — только решением владельца" });
  cannot.push({ id: "predict", title: "Обещать рост", detail: "есть измерение «до/после» за 28 дней, а прогноза позиций и трафика нет: поиск меняется сам" });
  cannot.push({ id: "google", title: "Видеть Google", detail: "данные только из Яндекса (Вебмастер, Метрика, Wordstat); по Google нет ни показов, ни позиций" });
  cannot.push({ id: "clicks_topvisor", title: "Брать клики из Topvisor", detail: "Topvisor даёт позиции и выдачу, клики и CTR — только из Вебмастера" });
  cannot.push({ id: "server_browser", title: "Запускать браузер на сервере", detail: "Obscura работает только в локальной сессии: серверу достаются обычные запросы страниц" });

  return { sources: views, columns: { have, can, could, cannot }, summary: { connected: views.filter((item) => item.status === "ok").length, total: views.length, stale: views.filter((item) => item.status === "stale").length } };
}
