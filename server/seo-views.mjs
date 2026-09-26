// Представления SEO Wizard: рабочие таблицы презентации «SEO VS-Travel» (URL Registry, Index Composition,
// Query/Filter Policy, Internal Links Audit, Cannibalization Monitor, Page Quality, CTR Opportunities,
// SEO Opportunities, SERP Competitor Gap, Link Outreach, Weekly Queue, Change Log), дашборд и отчёты
// 10/20/25 числа. Всё считается поверх 14 таблиц seo_* (server/seo-wizard.mjs) — отдельного хранилища нет.
// Цифр не выдумываем: пока источник не подключён, раздел отвечает empty с именем источника.
import { pageKind } from "./seo-wizard.mjs";

const OUR_DOMAIN = /(^|\.)vs-travel\.ru$/i;
const WINDOW = "28 days";

export const SOURCE_LABELS = {
  sitemap: "sitemap.xml",
  crawl: "обход HTTP",
  webmaster: "Вебмастер",
  topvisor_ranks: "Topvisor · позиции",
  topvisor_serp: "Topvisor · выдача",
  topvisor_audit: "Topvisor · аудит",
  wordstat: "Wordstat",
  metrica: "Метрика",
  obscura: "Obscura (сессия)",
  mbox: "MBOX",
};

const TYPE_LABELS = {
  home: "главная",
  home_duplicate: "дубль главной",
  tour: "тур",
  geo: "гео",
  section: "раздел",
  selection: "подбор",
  theme: "тематика",
  article: "статья",
  service: "служебная",
  technical: "техническая",
  legacy: "легаси",
  other: "прочее",
  unknown: "прочее",
};

export const URL_DECISIONS = {
  keep: "оставить",
  "301": "301",
  canonical: "canonical",
  noindex: "noindex",
  remove_sitemap: "убрать из sitemap",
};

// Контракт параметров из презентации (слайд «Query / Filter Policy»). Владелец правит его в интерфейсе;
// отсюда — только стартовое заполнение, пока в настройках пусто.
export const DEFAULT_FILTER_PARAMS = [
  { param: "city", example: "?city=tula", own_url: "да", index: "нет для query", canonical: "/odnodnevnye/tula", link: "ЧПУ" },
  { param: "topic", example: "?topic=gastronomy", own_url: "зависит", index: "зависит", canonical: "определить", link: "определить" },
  { param: "month", example: "?month=october", own_url: "обычно нет", index: "нет", canonical: "основная", link: "query" },
  { param: "holiday", example: "?holiday=ny", own_url: "при спросе", index: "зависит", canonical: "определить", link: "определить" },
  { param: "days", example: "?days=2", own_url: "при спросе", index: "зависит", canonical: "определить", link: "определить" },
  { param: "price", example: "?price=5000", own_url: "нет", index: "нет", canonical: "основная", link: "query" },
];

const INDEX_BUCKETS = [
  ["tour", "Туры (офферы)"],
  ["odnodnevnye", "Однодневные гео"],
  ["tury-po-rossii", "Россия гео + тематики"],
  ["podbor-tura", "Подбор тура"],
  ["tury-zarubezh", "Зарубежье"],
  ["article", "Статьи"],
  ["query", "Query (параметры)"],
  ["legacy", "Legacy (/toursg/)"],
  ["technical", "Технические (/lk/ /ajax/ /payment/)"],
  ["other", "Прочее"],
];

const QUALITY_FEATURES = [
  ["price", "Цена"],
  ["dates", "Даты"],
  ["departure", "Отправление"],
  ["travel_time", "Время в пути"],
  ["faq", "FAQ"],
  ["reviews", "Отзывы"],
  ["map", "Карта"],
  ["photos", "Фото"],
];

function col(key, label, type = "text", extra = {}) {
  return { key, label, type, ...extra };
}

function section(id, title, columns, rows, options = {}) {
  return { id, title, columns, rows, total: options.total ?? rows.length, empty: rows.length ? "" : options.empty || "Нет строк", note: options.note || "", source: options.source || "" };
}

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url || "");
  }
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const k = 10 ** digits;
  return Math.round(Number(value) * k) / k;
}

async function rows(query, sql, values = []) {
  return (await query(sql, values)).rows;
}

async function scalar(query, sql, values = []) {
  const row = (await query(sql, values)).rows[0];
  return row ? Object.values(row)[0] : null;
}

function bucketOf(url) {
  const path = String(url.path || "");
  const kind = pageKind(path);
  if (kind.type === "tour") return "tour";
  if (path.includes("?")) return "query";
  if (kind.type === "legacy") return "legacy";
  if (kind.type === "technical") return "technical";
  if (kind.type === "article") return "article";
  if (["odnodnevnye", "tury-po-rossii", "podbor-tura", "tury-zarubezh"].includes(kind.section)) return kind.section;
  return "other";
}

/** Свежесть источников: когда что последний раз писалось и что говорит последний прогон. */
export async function seoSources(query) {
  const run = (await rows(query, "SELECT id::text, status, started_at::text, finished_at::text, sources, stats FROM seo_runs ORDER BY started_at DESC LIMIT 1"))[0] || null;
  const latest = await rows(query, `
    SELECT 'crawl' AS key, max(captured_at)::text AS at, count(*)::int AS n FROM seo_page_snapshots
    UNION ALL SELECT 'webmaster', max(captured_at)::text, count(*)::int FROM seo_search_snapshots
    UNION ALL SELECT 'topvisor_ranks', max(captured_at)::text, count(*)::int FROM seo_rank_snapshots
    UNION ALL SELECT 'topvisor_serp', max(captured_at)::text, count(*)::int FROM seo_serp_snapshots
    UNION ALL SELECT 'wordstat', max(captured_at)::text, count(*)::int FROM seo_demand_snapshots
    UNION ALL SELECT 'metrica', max(captured_on)::text, count(*)::int FROM seo_traffic_snapshots`);
  const byKey = Object.fromEntries(latest.map((item) => [item.key, item]));
  const runSources = run?.sources || {};
  const status = (key, runKey) => {
    const fromRun = runKey ? runSources[runKey] : null;
    const data = byKey[key];
    if (data?.n) return { status: "ok", updated_at: data.at, rows: data.n, note: "" };
    if (fromRun?.status === "error") return { status: "error", updated_at: fromRun.updated_at || "", rows: 0, note: fromRun.error || "" };
    if (fromRun?.status === "not_configured") return { status: "not_configured", updated_at: fromRun.updated_at || "", rows: 0, note: fromRun.reason || "" };
    return { status: "empty", updated_at: "", rows: 0, note: "" };
  };
  const sitemap = runSources.sitemap || {};
  const list = [
    { key: "sitemap", ...(sitemap.status ? { status: sitemap.status, updated_at: sitemap.updated_at || "", rows: sitemap.urls || 0, note: sitemap.error || sitemap.url || "" } : { status: "empty", updated_at: "", rows: 0, note: "" }) },
    { key: "crawl", ...status("crawl") },
    { key: "topvisor_audit", ...status("topvisor_audit", "topvisor_audit") },
    { key: "webmaster", ...status("webmaster", "webmaster") },
    { key: "topvisor_ranks", ...status("topvisor_ranks", "topvisor_audit") },
    { key: "topvisor_serp", ...status("topvisor_serp", "topvisor_audit") },
    { key: "wordstat", ...status("wordstat", "wordstat") },
    { key: "metrica", ...status("metrica", "metrica") },
  ].map((item) => ({ ...item, label: SOURCE_LABELS[item.key] || item.key }));
  return { run, sources: list, has: Object.fromEntries(list.map((item) => [item.key, item.status === "ok"])) };
}

function emptyFor(sources, key) {
  const source = sources.sources.find((item) => item.key === key);
  const label = SOURCE_LABELS[key] || key;
  if (!source || source.status === "empty") return `Нет данных: источник «${label}» ещё не присылал снимков`;
  if (source.status === "not_configured") return `Нет данных: не подключён источник «${label}»`;
  if (source.status === "error") return `Нет данных: источник «${label}» упал при последнем прогоне`;
  return "Нет строк";
}

async function searchByUrl(query) {
  const list = await rows(query, `
    SELECT url, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks, count(DISTINCT query)::int AS queries,
           CASE WHEN sum(impressions) > 0 THEN sum(COALESCE(position, 0) * impressions) / sum(impressions) END AS position
    FROM seo_search_snapshots WHERE captured_at > now() - interval '${WINDOW}' GROUP BY url`);
  return new Map(list.map((item) => [item.url, item]));
}

async function inlinksByUrl(query) {
  const list = await rows(query, "SELECT to_url, count(DISTINCT from_url)::int AS n FROM seo_links GROUP BY to_url");
  return new Map(list.map((item) => [item.to_url, item.n]));
}

async function allUrls(query) {
  return rows(query, `
    SELECT id::text, url, path, url_type, section, status_code, canonical, in_sitemap, in_search, lastmod::text,
           title, h1, quality, decision, decision_note, updated_at::text
    FROM seo_urls ORDER BY path`);
}

/** Кривая «позиция → CTR» по нашим же данным за 28 дней (как в презентации: ожидаемый CTR — наш, не отраслевой). */
async function ctrCurve(query) {
  const list = await rows(query, `
    SELECT GREATEST(1, LEAST(50, round(position)))::int AS pos, sum(clicks)::float AS clicks, sum(impressions)::float AS imp
    FROM seo_search_snapshots WHERE captured_at > now() - interval '${WINDOW}' AND position IS NOT NULL
    GROUP BY 1`);
  const curve = new Map(list.filter((item) => item.imp > 0).map((item) => [item.pos, item.clicks / item.imp]));
  return (position) => {
    const pos = Math.max(1, Math.min(50, Math.round(Number(position) || 50)));
    if (curve.has(pos)) return curve.get(pos);
    let best = null;
    for (const [key, value] of curve) if (best === null || Math.abs(key - pos) < Math.abs(best[0] - pos)) best = [key, value];
    return best ? best[1] : 0;
  };
}

async function queryPairs(query) {
  return rows(query, `
    SELECT query, url, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks,
           CASE WHEN sum(impressions) > 0 THEN sum(COALESCE(position, 0) * impressions) / sum(impressions) END AS position
    FROM seo_search_snapshots WHERE captured_at > now() - interval '${WINDOW}'
    GROUP BY query, url`);
}

// ─── Архитектура ──────────────────────────────────────────────────────────────

async function viewRegistry(query, sources) {
  const [urls, search, inlinks] = await Promise.all([allUrls(query), searchByUrl(query), inlinksByUrl(query)]);
  const list = urls.map((url) => {
    const s = search.get(url.url);
    const noindex = Boolean(url.quality?.noindex);
    const selfCanonical = url.canonical ? url.canonical === url.url : null;
    return {
      id: url.id,
      url: url.url,
      path: url.path,
      type: TYPE_LABELS[url.url_type] || url.url_type,
      section: url.section,
      status: url.status_code,
      indexable: url.status_code ? url.status_code === 200 && !noindex && selfCanonical !== false : null,
      in_sitemap: url.in_sitemap,
      canonical: url.canonical ? pathOf(url.canonical) : "",
      self_canonical: selfCanonical,
      impressions: s ? s.impressions : null,
      clicks: s ? s.clicks : null,
      queries: s ? s.queries : null,
      inlinks: inlinks.get(url.url) ?? null,
      lastmod: url.lastmod,
      decision: url.decision || "",
    };
  });
  const checked = list.filter((item) => item.status !== null).length;
  return {
    sections: [section("registry", "SEO URL Registry — реестр всех URL", [
      col("path", "URL", "url"),
      col("type", "Тип", "badge"),
      col("section", "Раздел"),
      col("status", "HTTP", "status"),
      col("indexable", "Indexable", "bool"),
      col("in_sitemap", "В sitemap", "bool"),
      col("canonical", "Canonical"),
      col("self_canonical", "Self-canonical", "bool"),
      col("impressions", "Показы 28д", "int"),
      col("clicks", "Клики 28д", "int"),
      col("queries", "Запросов", "int"),
      col("inlinks", "Вход. ссылок", "int"),
      col("lastmod", "lastmod", "date"),
      col("decision", "Решение", "decision"),
    ], list, {
      note: `Проверено HTTP: ${checked} из ${list.length}. Показы и клики — из Вебмастера${sources.has.webmaster ? "" : " (не подключён)"}.`,
      source: "sitemap · обход · Вебмастер",
    })],
    options: { decisions: URL_DECISIONS },
  };
}

async function compositionRows(query, sources, settings) {
  const [urls, search] = await Promise.all([allUrls(query), searchByUrl(query)]);
  const hasSearch = sources.has.webmaster;
  const stats = new Map(INDEX_BUCKETS.map(([key, label]) => [key, { key, label, in_search: 0, in_sitemap: 0, checked: 0, clicks: 0, no_clicks: 0 }]));
  const dead = { key: "dead", label: "Мёртвые (404/401/5xx)", in_search: 0, in_sitemap: 0, checked: 0, clicks: 0, no_clicks: 0 };
  const empty = { key: "empty", label: "Пустые (200, нет текста)", in_search: 0, in_sitemap: 0, checked: 0, clicks: 0, no_clicks: 0 };
  for (const url of urls) {
    const bucket = stats.get(bucketOf(url));
    const s = search.get(url.url);
    const inSearch = url.in_search || Boolean(s?.impressions);
    bucket.in_search += inSearch ? 1 : 0;
    bucket.in_sitemap += url.in_sitemap ? 1 : 0;
    bucket.checked += url.status_code ? 1 : 0;
    bucket.clicks += s?.clicks || 0;
    bucket.no_clicks += inSearch && !s?.clicks ? 1 : 0;
    if (url.status_code && (url.status_code >= 400 || url.status_code === 0)) {
      dead.in_sitemap += url.in_sitemap ? 1 : 0;
      dead.checked += 1;
    }
    if (url.status_code === 200 && url.quality && Number(url.quality.text_chars ?? 999) < 50) {
      empty.in_sitemap += url.in_sitemap ? 1 : 0;
      empty.checked += 1;
    }
  }
  const decisions = settings?.config?.index_decisions || {};
  return [...stats.values(), dead, empty].map((item) => ({
    ...item,
    in_search: hasSearch ? item.in_search : null,
    clicks: hasSearch ? item.clicks : null,
    no_clicks: hasSearch ? item.no_clicks : null,
    decision: decisions[item.key] || "",
  }));
}

const COMPOSITION_COLUMNS = [
  col("label", "Тип"),
  col("in_search", "В индексе", "int"),
  col("in_sitemap", "В sitemap", "int"),
  col("checked", "Проверено HTTP", "int"),
  col("clicks", "Клики 28д", "int"),
  col("no_clicks", "Без кликов", "int"),
  col("decision", "Решение", "bucket_decision"),
];

async function viewIndex(query, sources, settings) {
  const list = await compositionRows(query, sources, settings);
  return {
    sections: [section("index", "Index Composition — состав индекса", COMPOSITION_COLUMNS, list, {
      note: "Корзины — по шаблону адреса. «Мёртвые» и «Пустые» считаются по проверенным HTTP адресам и пересекаются с корзинами выше.",
      source: "sitemap · обход · Вебмастер",
    })],
  };
}

async function queryLinks(query) {
  const list = await rows(query, "SELECT from_url, to_url, anchor FROM seo_links WHERE link_type = 'query'");
  return list.map((item) => {
    let params = [];
    try { params = [...new URL(item.to_url).searchParams.entries()].filter(([key]) => key !== "id"); } catch { /* битый адрес */ }
    return { ...item, params };
  });
}

async function viewFilters(query, sources, settings) {
  const policy = Array.isArray(settings?.config?.filter_params) && settings.config.filter_params.length ? settings.config.filter_params : DEFAULT_FILTER_PARAMS;
  const links = await queryLinks(query);
  const found = new Map();
  for (const link of links) {
    for (const [param] of link.params) {
      if (!found.has(param)) found.set(param, { links: 0, pages: new Set(), targets: new Set() });
      const entry = found.get(param);
      entry.links += 1;
      entry.pages.add(link.from_url);
      entry.targets.add(pathOf(link.to_url));
    }
  }
  const known = new Set(policy.map((item) => item.param));
  const list = [
    ...policy.map((item) => ({ ...item, described: true })),
    ...[...found.keys()].filter((param) => !known.has(param)).map((param) => ({ param, example: `?${param}=…`, own_url: "", index: "", canonical: "", link: "", described: false })),
  ].map((item) => {
    const entry = found.get(item.param);
    return { ...item, found_links: entry ? entry.links : 0, found_pages: entry ? entry.pages.size : 0, found_targets: entry ? entry.targets.size : 0 };
  });
  return {
    sections: [section("filters", "Query / Filter Policy — контракт параметров", [
      col("param", "Параметр", "code"),
      col("example", "Пример", "code"),
      col("own_url", "Отдельный SEO URL", "edit"),
      col("index", "Index", "edit"),
      col("canonical", "Canonical", "edit"),
      col("link", "Внутренняя ссылка", "edit"),
      col("found_links", "Ссылок на сайте", "int"),
      col("found_pages", "Страниц-источников", "int"),
      col("described", "Описан", "bool"),
    ], list, {
      note: "Всё, что не описано здесь, в индекс не попадает. Ссылки — по страницам, проверенным обходом; карточки туров подгружаются скриптом и видны только Obscura.",
      source: "настройки · обход",
    })],
  };
}

async function viewLinks(query, sources) {
  const [links, urls] = await Promise.all([queryLinks(query), rows(query, "SELECT path FROM seo_urls")]);
  const paths = new Set(urls.map((item) => item.path.replace(/\/+$/, "")));
  const groups = new Map();
  for (const link of links) {
    let base = "/";
    try { base = new URL(link.to_url).pathname; } catch { /* оставить корень */ }
    for (const [param, value] of link.params) {
      const key = `${base}?${param}=${value}`;
      if (!groups.has(key)) {
        const guess = `${base.replace(/\/+$/, "")}/${value}`;
        groups.set(key, { target: key, param, anchor: link.anchor, pages: new Set(), should: paths.has(guess) ? guess : "", });
      }
      groups.get(key).pages.add(pathOf(link.from_url));
    }
  }
  const list = [...groups.values()]
    .map((item) => ({ target: item.target, param: item.param, anchor: item.anchor, pages: item.pages.size, sample: [...item.pages][0] || "", should: item.should }))
    .sort((a, b) => (b.should ? 1 : 0) - (a.should ? 1 : 0) || b.pages - a.pages);
  const total = await scalar(query, "SELECT count(*)::int FROM seo_links");
  return {
    sections: [section("links", "Internal Links Audit — куда ведёт навигация", [
      col("anchor", "Элемент (текст ссылки)"),
      col("target", "Сейчас ведёт на", "code"),
      col("should", "Должен вести на", "url"),
      col("pages", "Страниц со ссылкой", "int"),
      col("sample", "Пример страницы", "url"),
    ], list, {
      empty: total ? "Ссылок на ?параметр= среди проверенных страниц нет" : "Нет данных: обход ещё не собрал внутренние ссылки",
      note: `Всего внутренних ссылок в базе: ${num(total).toLocaleString("ru-RU")}. «Должен вести на» — существующий ЧПУ-адрес для того же состояния.`,
      source: "обход HTTP",
    })],
  };
}

async function viewCannibal(query, sources) {
  const pairs = sources.has.webmaster ? await queryPairs(query) : [];
  const byQuery = new Map();
  for (const pair of pairs) {
    if (!pair.impressions) continue;
    if (!byQuery.has(pair.query)) byQuery.set(pair.query, []);
    byQuery.get(pair.query).push(pair);
  }
  const queryRows = [...byQuery.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([q, list]) => {
      const sorted = [...list].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const [a, b] = sorted;
      return {
        cluster: q,
        url1: pathOf(a.url), clicks1: a.clicks, pos1: round(a.position),
        url2: pathOf(b.url), clicks2: b.clicks, pos2: round(b.position),
        urls: list.length,
        impressions: list.reduce((sum, item) => sum + item.impressions, 0),
      };
    })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 500);

  const urls = await rows(query, "SELECT url, path FROM seo_urls WHERE in_sitemap");
  const search = await searchByUrl(query);
  const slugs = new Map();
  for (const url of urls) {
    const parts = url.path.split("?")[0].replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length < 2) continue;
    const slug = parts[parts.length - 1];
    if (!slugs.has(slug)) slugs.set(slug, []);
    slugs.get(slug).push({ ...url, section: parts[0] });
  }
  const slugRows = [...slugs.entries()]
    .map(([slug, list]) => ({ slug, list, sections: new Set(list.map((item) => item.section)) }))
    .filter((item) => item.sections.size >= 2)
    .map((item) => ({
      slug: item.slug,
      sections: item.sections.size,
      urls: item.list.map((entry) => entry.path).join("\n"),
      clicks: sources.has.webmaster ? item.list.reduce((sum, entry) => sum + (search.get(entry.url)?.clicks || 0), 0) : null,
      with_impressions: sources.has.webmaster ? item.list.filter((entry) => search.get(entry.url)?.impressions).length : null,
    }))
    .sort((a, b) => b.sections - a.sections || String(a.slug).localeCompare(String(b.slug)));

  return {
    sections: [
      section("cannibal_queries", "Cannibalization Monitor — один запрос, несколько наших URL", [
        col("cluster", "Запрос"),
        col("url1", "URL 1", "url"), col("clicks1", "Клики", "int"), col("pos1", "Поз", "num"),
        col("url2", "URL 2", "url"), col("clicks2", "Клики", "int"), col("pos2", "Поз", "num"),
        col("urls", "Наших URL", "int"),
        col("impressions", "Показы 28д", "int"),
      ], queryRows, { empty: emptyFor(sources, "webmaster"), source: "Вебмастер", note: "Решение — одно из трёх: развести интенты, 301 для явного дубля, canonical и перелинковка. Структура адресов не меняется." }),
      section("cannibal_slugs", "Одинаковое окончание адреса в разных разделах", [
        col("slug", "Окончание", "code"),
        col("sections", "Разделов", "int"),
        col("urls", "Адреса", "multiline"),
        col("with_impressions", "С показами", "int"),
        col("clicks", "Клики 28д", "int"),
      ], slugRows, { source: "sitemap · Вебмастер", note: `${slugRows.length} окончаний встречаются минимум в двух разделах sitemap.` }),
    ],
  };
}

// ─── Страницы ─────────────────────────────────────────────────────────────────

async function viewQuality(query) {
  const urls = await rows(query, "SELECT url, path, url_type, quality FROM seo_urls WHERE quality ? 'checked_at' OR quality ? 'has_h1' OR quality ?| $1 ORDER BY path", [QUALITY_FEATURES.map(([key]) => key)]);
  const list = urls.map((url) => {
    const q = url.quality || {};
    const known = QUALITY_FEATURES.filter(([key]) => typeof q[key] === "boolean");
    const score = known.length ? Math.round((known.filter(([key]) => q[key]).length / known.length) * 100) : null;
    return {
      path: url.path,
      type: TYPE_LABELS[url.url_type] || url.url_type,
      ...Object.fromEntries(QUALITY_FEATURES.map(([key]) => [key, typeof q[key] === "boolean" ? q[key] : null])),
      score,
      has_h1: typeof q.has_h1 === "boolean" ? q.has_h1 : null,
      title_length: q.title_length ?? null,
      description_length: q.description_length ?? null,
      text_chars: q.text_chars ?? null,
    };
  });
  const byType = new Map();
  for (const item of list) {
    if (!byType.has(item.type)) byType.set(item.type, { type: item.type, pages: 0, no_h1: 0, no_description: 0, empty: 0, title_sum: 0, title_n: 0 });
    const entry = byType.get(item.type);
    entry.pages += 1;
    if (item.has_h1 === false) entry.no_h1 += 1;
    if (item.description_length === 0) entry.no_description += 1;
    if (item.text_chars !== null && item.text_chars < 50) entry.empty += 1;
    if (item.title_length !== null) { entry.title_sum += item.title_length; entry.title_n += 1; }
  }
  const typeRows = [...byType.values()].map((item) => ({ ...item, title_avg: item.title_n ? Math.round(item.title_sum / item.title_n) : null })).sort((a, b) => b.pages - a.pages);
  return {
    sections: [
      section("quality_types", "Качество по шаблонам (одна задача на шаблон, а не двести на страницы)", [
        col("type", "Тип", "badge"), col("pages", "Проверено", "int"), col("no_h1", "Без H1", "int"),
        col("no_description", "Без description", "int"), col("empty", "Пустые", "int"), col("title_avg", "Средний title, симв.", "int"),
      ], typeRows, { empty: "Нет данных: обход ещё не проверял страницы", source: "обход HTTP" }),
      section("quality", "Page Quality — ответы на странице", [
        col("path", "URL", "url"), col("type", "Тип", "badge"),
        ...QUALITY_FEATURES.map(([key, label]) => col(key, label, "bool")),
        col("score", "Quality Score", "pct_int"),
        col("has_h1", "H1", "bool"), col("title_length", "Title", "int"), col("text_chars", "Текст, симв.", "int"),
      ], list, { empty: "Нет данных: обход ещё не проверял страницы", source: "обход HTTP · Obscura", note: "Цена, даты, отправление, время в пути, FAQ, отзывы, карта и фото заполняет сессия через Obscura: карточки подгружаются скриптом. Пусто — значит «не проверено», а не «нет»." }),
    ],
  };
}

async function viewCompetitors(query, sources) {
  const list = await rows(query, `
    WITH latest AS (SELECT query, max(captured_at) AS at FROM seo_serp_snapshots GROUP BY query)
    SELECT s.domain, count(DISTINCT s.query)::int AS queries, avg(s.position)::float AS position,
           min(s.position)::int AS best, array_agg(DISTINCT s.query) AS sample
    FROM seo_serp_snapshots s JOIN latest l ON l.query = s.query AND l.at = s.captured_at
    WHERE s.position <= 10 AND s.domain <> ''
    GROUP BY s.domain ORDER BY queries DESC, position ASC LIMIT 200`);
  const totalQueries = num(await scalar(query, "SELECT count(DISTINCT query)::int FROM seo_serp_snapshots"));
  const rowsOut = list.map((item) => ({
    domain: item.domain,
    ours: OUR_DOMAIN.test(item.domain),
    queries: item.queries,
    share: totalQueries ? Math.round((item.queries / totalQueries) * 100) : null,
    position: round(item.position),
    best: item.best,
    sample: (item.sample || []).slice(0, 3).join(", "),
  }));
  return {
    sections: [section("competitors", "SERP Competitor Gap — кто стабильно в топ-10", [
      col("domain", "Домен"), col("ours", "Мы", "bool"), col("queries", "Запросов в топ-10", "int"),
      col("share", "Доля запросов", "pct_int"), col("position", "Средняя поз", "num"), col("best", "Лучшая", "int"), col("sample", "Примеры запросов"),
    ], rowsOut, { empty: emptyFor(sources, "topvisor_serp"), source: "Topvisor · выдача", note: "Разрыв по возможностям (даты, цены, карта, отзывы…) сессия снимает через Obscura по 3–5 конкурентам из этого списка." })],
  };
}

// ─── Клики и спрос ────────────────────────────────────────────────────────────

async function viewCtr(query, sources) {
  if (!sources.has.webmaster) {
    return { sections: [section("ctr", "CTR Opportunities — упущенные клики", [], [], { empty: emptyFor(sources, "webmaster"), source: "Вебмастер" })] };
  }
  const [pairs, expected] = await Promise.all([queryPairs(query), ctrCurve(query)]);
  const list = pairs
    .filter((item) => item.impressions > 0)
    .map((item) => {
      const ctr = item.clicks / item.impressions;
      const exp = expected(item.position);
      const lost = Math.max(0, item.impressions * (exp - ctr));
      return { query: item.query, path: pathOf(item.url), impressions: item.impressions, position: round(item.position), ctr: round(ctr * 100, 2), expected: round(exp * 100, 2), lost: Math.round(lost) };
    })
    .filter((item) => item.lost > 0)
    .sort((a, b) => b.lost - a.lost)
    .slice(0, 500);
  return {
    sections: [section("ctr", "CTR Opportunities — упущенные клики", [
      col("query", "Запрос"), col("path", "URL", "url"), col("impressions", "Показы 28д", "int"), col("position", "Позиция", "num"),
      col("ctr", "CTR, %", "num"), col("expected", "Ожидаемый CTR, %", "num"), col("lost", "Потерянные клики", "int"),
    ], list, { source: "Вебмастер", note: "Lost Clicks = Impressions × (Expected CTR − Current CTR). Ожидаемый CTR — по нашей же кривой «позиция → CTR» за 28 дней." })],
  };
}

async function opportunityRows(query, sources) {
  if (!sources.has.webmaster) return [];
  const [pairs, expected, traffic] = await Promise.all([
    queryPairs(query),
    ctrCurve(query),
    rows(query, `SELECT url, sum(visits)::int AS visits, sum(COALESCE((SELECT sum(value::numeric) FROM jsonb_each_text(goals)), 0))::float AS leads
                  FROM seo_traffic_snapshots WHERE captured_on > CURRENT_DATE - 28 GROUP BY url`),
  ]);
  const conv = new Map(traffic.map((item) => [item.url, item.visits ? item.leads / item.visits : null]));
  const byUrl = new Map();
  for (const pair of pairs) {
    if (!byUrl.has(pair.url)) byUrl.set(pair.url, { url: pair.url, impressions: 0, clicks: 0, weighted: 0, potential: 0, top: "", topImp: 0 });
    const entry = byUrl.get(pair.url);
    entry.impressions += pair.impressions;
    entry.clicks += pair.clicks;
    entry.weighted += (pair.position || 0) * pair.impressions;
    if (pair.impressions > entry.topImp) { entry.top = pair.query; entry.topImp = pair.impressions; }
    const ctr = pair.impressions ? pair.clicks / pair.impressions : 0;
    // Запас: до ожидаемого CTR своей позиции, а для 4–20 — до CTR третьей позиции (забрать клики с занятых мест).
    const target = pair.position > 3 && pair.position <= 20 ? expected(3) : expected(pair.position);
    entry.potential += Math.max(0, pair.impressions * (target - ctr));
  }
  const list = [...byUrl.values()].map((item) => {
    const position = item.impressions ? item.weighted / item.impressions : null;
    const conversion = conv.get(item.url) ?? null;
    // Opportunity = спрос × запас по позиции × ценность; ценность — конверсия, пока нет Метрики — 1.
    const value = conversion === null ? 1 : Math.max(0.2, conversion * 50);
    return {
      path: pathOf(item.url),
      cluster: item.top,
      impressions: item.impressions,
      clicks: item.clicks,
      position: round(position),
      ctr: item.impressions ? round((item.clicks / item.impressions) * 100, 2) : null,
      conversion: conversion === null ? null : round(conversion * 100, 2),
      potential: Math.round(item.potential),
      score: item.potential * value,
    };
  }).filter((item) => item.potential > 0).sort((a, b) => b.score - a.score);
  const a = Math.ceil(list.length * 0.2);
  const b = Math.ceil(list.length * 0.5);
  return list.map((item, index) => ({ ...item, priority: index < a ? "A" : index < b ? "B" : "C" }));
}

async function viewOpportunities(query, sources) {
  const list = (await opportunityRows(query, sources)).slice(0, 500);
  return {
    sections: [section("opportunities", "SEO Opportunities — сколько можно забрать", [
      col("priority", "Приоритет", "priority"), col("path", "URL", "url"), col("cluster", "Кластер (главный запрос)"),
      col("impressions", "Показы", "int"), col("clicks", "Клики", "int"), col("position", "Поз", "num"), col("ctr", "CTR, %", "num"),
      col("conversion", "Конверсия, %", "num"), col("potential", "Потенциал кликов", "int"),
    ], list, { empty: emptyFor(sources, "webmaster"), source: "Вебмастер · Метрика", note: "Opportunity = спрос × запас по позиции × ценность для бизнеса. Внутренняя модель, чтобы выбирать 3–5 задач в неделю." })],
  };
}

async function viewPositions(query, sources) {
  const list = await rows(query, `
    WITH latest AS (SELECT DISTINCT ON (query) query, url, position, captured_at FROM seo_rank_snapshots ORDER BY query, captured_at DESC),
         week AS (SELECT DISTINCT ON (query) query, position FROM seo_rank_snapshots WHERE captured_at < now() - interval '6 days' ORDER BY query, captured_at DESC)
    SELECT l.query, l.url, l.position, w.position AS week_position, l.captured_at::text
    FROM latest l LEFT JOIN week w ON w.query = l.query ORDER BY l.position NULLS LAST`);
  const buckets = [["Топ-3", 1, 3], ["Топ-10", 1, 10], ["11–20", 11, 20], ["4–20", 4, 20], ["21–50", 21, 50], ["Дальше 50 или нет", 51, 10000]];
  const dist = buckets.map(([label, from, to]) => ({
    label,
    now: list.filter((item) => item.position !== null ? item.position >= from && item.position <= to : from > 50).length,
    week: list.filter((item) => item.week_position !== null && item.week_position >= from && item.week_position <= to).length,
  }));
  const outRows = list.map((item) => ({
    query: item.query,
    path: item.url ? pathOf(item.url) : "",
    position: round(item.position),
    change: item.position !== null && item.week_position !== null ? round(item.week_position - item.position) : null,
    stale: /20(1\d|2[0-5])/.test(item.query),
    at: item.captured_at,
  }));
  return {
    sections: [
      section("positions_dist", "Срез мониторинга", [col("label", "Диапазон"), col("now", "Сейчас", "int"), col("week", "Неделю назад", "int")], list.length ? dist : [], { empty: emptyFor(sources, "topvisor_ranks"), source: "Topvisor · позиции", note: list.length ? `${list.length} отслеживаемых запросов.` : "" }),
      section("positions", "Позиции по запросам", [
        col("query", "Запрос"), col("path", "Ранжируется URL", "url"), col("position", "Позиция", "num"), col("change", "За неделю", "delta"),
        col("stale", "Устаревший (год в запросе)", "bool"), col("at", "Снимок", "datetime"),
      ], outRows, { empty: emptyFor(sources, "topvisor_ranks"), source: "Topvisor · позиции", note: "Запросы с годами 2023–2025 — кандидаты на чистку ядра: мониторинг мёртвого спроса." }),
    ],
  };
}

async function viewSerp(query, sources) {
  const list = await rows(query, `
    WITH latest AS (SELECT query, max(captured_at) AS at FROM seo_serp_snapshots GROUP BY query)
    SELECT s.query, s.position, s.domain, s.url, s.title, s.snippet, s.features, s.captured_at::text
    FROM seo_serp_snapshots s JOIN latest l ON l.query = s.query AND l.at = s.captured_at
    ORDER BY s.query, s.position LIMIT 3000`);
  return {
    sections: [section("serp", "Выдача и сниппеты — последний снимок топ-10", [
      col("query", "Запрос"), col("position", "Поз", "int"), col("domain", "Домен"), col("ours", "Мы", "bool"),
      col("title", "Title"), col("snippet", "Сниппет", "multiline"), col("features", "Элементы выдачи"),
    ], list.map((item) => ({
      query: item.query, position: item.position, domain: item.domain, ours: OUR_DOMAIN.test(item.domain || hostOf(item.url)),
      title: item.title, snippet: item.snippet, features: Object.keys(item.features || {}).join(", "),
    })), { empty: emptyFor(sources, "topvisor_serp"), source: "Topvisor · выдача", note: "Для запросов с упущенными кликами сравнивайте наш сниппет с соседями: цена, даты, длительность, обрезанный title, чужой раздел нашего сайта." })],
  };
}

async function viewDemand(query, sources) {
  const pages = await rows(query, `
    SELECT url, count(*)::int AS queries, sum(demand)::int AS demand, sum(impressions)::int AS impressions
    FROM seo_page_semantics GROUP BY url ORDER BY sum(demand) DESC LIMIT 1000`);
  const demand = await rows(query, `
    SELECT DISTINCT ON (query, region) query, region, demand, month, captured_at::text
    FROM seo_demand_snapshots ORDER BY query, region, captured_at DESC LIMIT 2000`);
  return {
    sections: [
      section("potential", "Потенциал страниц — спрос семантики и охват", [
        col("path", "Посадочная", "url"), col("queries", "Запросов", "int"), col("demand", "Спрос / мес", "int"),
        col("impressions", "Наши показы", "int"), col("coverage", "Охват", "pct"),
      ], pages.map((item) => ({ path: pathOf(item.url), queries: item.queries, demand: item.demand, impressions: item.impressions, coverage: item.demand ? round(item.impressions / item.demand, 3) : null })),
      { empty: emptyFor(sources, "wordstat"), source: "Wordstat · Вебмастер", note: "Потенциал = суммарный спрос семантики; охват = наши показы ÷ спрос. Высокий спрос и низкий охват — страница недорабатывает." }),
      section("demand", "Спрос по запросам (Wordstat)", [
        col("query", "Запрос"), col("region", "Регион"), col("demand", "Частотность", "int"), col("month", "Месяц"), col("captured_at", "Снимок", "datetime"),
      ], demand, { empty: emptyFor(sources, "wordstat"), source: "Wordstat" }),
    ],
  };
}

async function viewTraffic(query, sources) {
  const list = await rows(query, `
    SELECT url, sum(visits)::int AS visits, sum(bounces)::int AS bounces,
           avg(page_depth)::float AS depth, avg(visit_duration)::float AS duration,
           sum(COALESCE((SELECT sum(value::numeric) FROM jsonb_each_text(goals)), 0))::float AS leads
    FROM seo_traffic_snapshots WHERE captured_on > CURRENT_DATE - 28 GROUP BY url ORDER BY sum(visits) DESC LIMIT 1000`);
  const outRows = list.map((item) => ({
    path: pathOf(item.url),
    type: TYPE_LABELS[pageKind(pathOf(item.url)).type] || "",
    visits: item.visits,
    bounce: item.visits ? round((item.bounces / item.visits) * 100) : null,
    depth: round(item.depth, 2),
    duration: item.duration === null ? null : Math.round(item.duration),
    leads: Math.round(item.leads),
    per100: item.visits ? round((item.leads / item.visits) * 100, 2) : null,
    no_leads: item.visits >= 30 && !item.leads,
  }));
  return {
    sections: [section("traffic", "Поисковый трафик, поведение и заявки за 28 дней", [
      col("path", "Страница входа", "url"), col("type", "Тип", "badge"), col("visits", "Визиты", "int"), col("bounce", "Отказы, %", "num"),
      col("depth", "Глубина", "num"), col("duration", "Время, с", "int"), col("leads", "Заявки", "int"), col("per100", "Заявок на 100 визитов", "num"),
      col("no_leads", "Трафик без заявок", "bool"),
    ], outRows, { empty: emptyFor(sources, "metrica"), source: "Метрика", note: "Детекторы «Поведение» и «Трафик без заявок»: сравнение со страницами того же шаблона." })],
  };
}

// ─── Авторитет ────────────────────────────────────────────────────────────────

export const OUTREACH_STATUSES = { found: "найдено", contacted: "написали", replied: "ответили", link: "ссылка получена", declined: "отказ" };

async function viewOutreach(query) {
  const list = await rows(query, `
    SELECT id::text, domain, site_type, page_url, mentions_us, has_link, contact, potential, status, note, updated_at::text
    FROM seo_outreach ORDER BY updated_at DESC`);
  return {
    sections: [section("outreach", "Link Outreach — площадки", [
      col("domain", "Домен"), col("site_type", "Тип"), col("page_url", "Страница", "url"), col("mentions_us", "Упоминают нас", "bool"),
      col("has_link", "Есть ссылка", "bool"), col("contact", "Контакт"), col("potential", "Потенциал", "badge"), col("status", "Статус", "outreach_status"),
      col("updated_at", "Обновлено", "datetime"),
    ], list, { empty: "Площадок пока нет: их находит сессия «20 число» или добавляет владелец", source: "сессия · владелец", note: "Самый быстрый источник ссылок — площадки, которые уже упоминают «Вокруг света» текстом, но не ссылаются." })],
    options: { statuses: OUTREACH_STATUSES },
  };
}

// ─── Неделя: очередь, решения, изменения ─────────────────────────────────────

async function viewQueue(query) {
  const list = await rows(query, `
    SELECT t.id::text, t.title, t.status, t.priority, t.created_at::text, t.updated_at::text,
           i.detector, i.affected_count, i.potential_score, i.evidence, i.summary
    FROM todos t LEFT JOIN seo_issues i ON i.id::text = t.props->>'issue_id'
    WHERE t.props->>'seo_wizard' = 'true'
    ORDER BY (t.status IN ('done', 'cancelled')), t.created_at DESC LIMIT 200`);
  return {
    sections: [section("queue", "SEO Weekly Queue — очередь недели", [
      col("priority", "Приоритет", "priority"), col("url", "URL / шаблон", "url"), col("problem", "Проблема"), col("evidence", "Доказательство"),
      col("title", "Действие"), col("status", "Статус", "badge"), col("created_at", "Создана", "datetime"),
    ], list.map((item) => {
      const sample = item.evidence?.sample_urls?.[0] || item.evidence?.url || item.evidence?.sample?.[0]?.path || "";
      return {
        id: item.id,
        priority: item.priority === "high" ? "A" : item.priority === "low" ? "C" : "B",
        url: typeof sample === "string" ? pathOf(sample) : sample?.path || "",
        problem: DETECTOR_LABELS[item.detector] || item.detector || "",
        evidence: item.affected_count ? `${num(item.affected_count).toLocaleString("ru-RU")} затронуто · потенциал ${Math.round(num(item.potential_score)).toLocaleString("ru-RU")}` : item.summary || "",
        title: String(item.title || "").replace(/^SEO:\s*/, ""),
        status: TODO_STATUS[item.status] || item.status,
        created_at: item.created_at,
      };
    }), { empty: "Очередь пуста: задачи создаются из находок кнопкой «В задачи» или сессией «SEO: понедельник»", source: "задачи MBOX", note: "Столбец «Доказательство» обязателен: задача без цифры в очередь не попадает." })],
  };
}

const TODO_STATUS = { open: "открыта", next: "в очереди", doing: "в работе", done: "готово", cancelled: "отменена", blocked: "заблокирована" };

export const DETECTOR_LABELS = {
  "01_sitemap_technical": "01 · технические адреса в sitemap",
  "01_sitemap_lastmod_stale": "01 · старые lastmod",
  "01_tours_missing_from_sitemap": "01 · туры не в sitemap",
  "01_home_duplicate_index_php": "01 · дубль главной",
  "01_sitemap_canonical_elsewhere": "01 · canonical не на себя",
  "01_sitemap_broken": "01 · sitemap не 200",
  "01_sitemap_empty_pages": "01 · пустые страницы",
  "02_internal_query_links": "02 · ссылки на ?параметр",
  "03_duplicate_slug_across_sections": "03 · каннибализация окончаний",
  "04_home_h1_missing": "04 · нет H1 на главной",
  source_sitemap_unavailable: "источник · sitemap недоступен",
};

async function viewDecisions(query) {
  const pending = await rows(query, `
    SELECT id::text, title, body, priority, created_at::text
    FROM agent_inbox WHERE requires_human = true AND status IN ('open', 'doing') AND props->>'seo_wizard' = 'true'
    ORDER BY created_at DESC LIMIT 100`).catch(() => []);
  const log = await rows(query, `
    SELECT id::text, title, decision, rationale, impact, actor, created_at::text
    FROM decision_log WHERE props->>'seo_wizard' = 'true' OR title ILIKE 'SEO%'
    ORDER BY created_at DESC LIMIT 200`);
  return {
    sections: [
      section("pending", "Ждут решения «да/нет»", [
        col("title", "Вопрос"), col("body", "Суть", "multiline"), col("priority", "Важность", "badge"), col("age", "Ждёт", "age"),
      ], pending.map((item) => ({ ...item, age: item.created_at })), { empty: "Нет решений, ждущих человека", source: "входящие MBOX", note: "301, canonical, noindex, объединение, новая страница и изменение правил — только через решение человека." }),
      section("decision_log", "Журнал решений", [
        col("created_at", "Когда", "datetime"), col("title", "Что"), col("decision", "Решение"), col("rationale", "Почему", "multiline"), col("actor", "Кто"),
      ], log, { empty: "Решений пока нет", source: "журнал решений MBOX" }),
    ],
  };
}

async function viewChanges(query) {
  const list = await rows(query, `
    SELECT c.id::text, c.change_type, c.url, c.description, c.baseline, c.result, c.status, c.detected_at::text,
           c.measure_after::text, c.created_at::text, i.title AS reason
    FROM seo_changes c LEFT JOIN seo_issues i ON i.id = c.issue_id
    ORDER BY c.created_at DESC LIMIT 500`);
  return {
    sections: [section("changes", "SEO Change Log — журнал изменений", [
      col("created_at", "Дата", "date"), col("path", "URL", "url"), col("description", "Что изменили"), col("reason", "Причина"),
      col("impressions_before", "Показы до", "int"), col("position_before", "Позиция до", "num"), col("ctr_before", "CTR до, %", "num"),
      col("measure_after", "Проверка", "date"), col("result", "Результат", "badge"),
    ], list.map((item) => ({
      id: item.id,
      created_at: item.created_at,
      path: pathOf(item.url),
      description: [item.change_type, item.description].filter(Boolean).join(" · "),
      reason: item.reason || "",
      impressions_before: item.baseline?.impressions ?? null,
      position_before: round(item.baseline?.position),
      ctr_before: item.baseline?.ctr !== undefined && item.baseline?.ctr !== null ? round(item.baseline.ctr, 2) : null,
      measure_after: item.measure_after,
      result: CHANGE_RESULTS[item.result?.verdict] || (item.status === "measured" ? "измерено" : item.status === "live" ? "на сайте" : "запланировано"),
    })), { empty: "Изменений пока нет: их записывает сессия «SEO: четверг» или владелец", source: "журнал изменений", note: "Если изменение не записано — через месяц мы не узнаем, работало оно или нет. Проверка — через 28 дней." })],
  };
}

const CHANGE_RESULTS = { helped: "помогло", no_effect: "без эффекта", worse: "хуже", unknown: "нельзя судить" };

// ─── Отчёты ──────────────────────────────────────────────────────────────────

async function runStats(query, olderThanDays = 0) {
  const row = (await rows(query, `
    SELECT stats, started_at::text FROM seo_runs
    WHERE status = 'ok' AND (stats->>'sitemap_urls')::int > 0 AND started_at < now() - ($1 || ' days')::interval
    ORDER BY started_at DESC LIMIT 1`, [String(olderThanDays)]))[0];
  return row || null;
}

async function viewReport10(query, sources, settings) {
  const [now, before, issues, composition] = await Promise.all([
    runStats(query, 0),
    runStats(query, 20),
    rows(query, `SELECT detector, title, affected_count, status, last_seen_at::text FROM seo_issues
                  WHERE (detector LIKE '01%' OR detector LIKE '02%' OR detector LIKE '03%') ORDER BY status = 'open' DESC, potential_score DESC`),
    compositionRows(query, sources, settings),
  ]);
  const metric = (key, label) => ({ label, now: now?.stats?.[key] ?? null, before: before?.stats?.[key] ?? null });
  const metrics = [
    metric("sitemap_urls", "URL в sitemap"),
    metric("technical_in_sitemap", "Технические адреса в sitemap"),
    metric("legacy_in_sitemap", "Legacy (/toursg/) в sitemap"),
    metric("sitemap_not_200", "Из sitemap не отдают 200 (проверенные)"),
    metric("sitemap_empty_200", "Из sitemap пустые при 200"),
    metric("sitemap_canonical_elsewhere", "Из sitemap с canonical не на себя"),
    metric("internal_query_links", "Внутренних ссылок на ?параметр"),
    metric("crawled_urls", "Проверено обходом"),
  ].map((item) => ({ ...item, delta: item.now !== null && item.before !== null ? item.now - item.before : null }));
  return {
    sections: [
      section("report10_metrics", "10 число · архитектура, sitemap, индекс", [
        col("label", "Показатель"), col("now", "Сейчас", "int"), col("before", "Месяц назад", "int"), col("delta", "Изменение", "delta_inverse"),
      ], now ? metrics : [], { empty: "Нет данных: не было ни одного успешного прогона с sitemap", source: "прогоны SEO", note: now ? `Последний прогон: ${now.started_at.slice(0, 16).replace("T", " ")}${before ? ` · сравнение с ${before.started_at.slice(0, 10)}` : " · прошлого месяца для сравнения ещё нет"}.` : "" }),
      section("report10_index", "Index Health", COMPOSITION_COLUMNS.filter((item) => item.key !== "decision"), composition, { source: "sitemap · обход · Вебмастер" }),
      section("report10_issues", "Находки направлений 01–03", [
        col("detector", "Детектор", "detector"), col("title", "Находка"), col("affected_count", "Затронуто", "int"), col("status", "Статус", "issue_status"), col("last_seen_at", "Видели", "datetime"),
      ], issues, { empty: "Находок нет", source: "детекторы" }),
    ],
    options: { detectors: DETECTOR_LABELS },
  };
}

async function viewReport20(query) {
  const list = await rows(query, "SELECT status, count(*)::int AS n, count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS month FROM seo_outreach GROUP BY status");
  const fresh = await rows(query, "SELECT domain, site_type, status, has_link, updated_at::text FROM seo_outreach WHERE updated_at > now() - interval '30 days' ORDER BY updated_at DESC LIMIT 100");
  return {
    sections: [
      section("report20_status", "20 число · внешний авторитет", [col("status", "Статус", "outreach_status"), col("n", "Всего", "int"), col("month", "За 30 дней", "int")], list, { empty: "Площадок пока нет", source: "Link Outreach" }),
      section("report20_recent", "Движение за месяц", [col("domain", "Домен"), col("site_type", "Тип"), col("status", "Статус", "outreach_status"), col("has_link", "Ссылка", "bool"), col("updated_at", "Когда", "datetime")], fresh, { empty: "За месяц движения не было", source: "Link Outreach" }),
    ],
    options: { statuses: OUTREACH_STATUSES },
  };
}

async function viewReport25(query, sources) {
  const periods = await rows(query, `
    SELECT CASE WHEN captured_at > now() - interval '28 days' THEN 'now' ELSE 'before' END AS period,
           sum(impressions)::int AS impressions, sum(clicks)::int AS clicks,
           CASE WHEN sum(impressions) > 0 THEN sum(COALESCE(position, 0) * impressions) / sum(impressions) END AS position
    FROM seo_search_snapshots WHERE captured_at > now() - interval '56 days' GROUP BY 1`);
  const traffic = await rows(query, `
    SELECT CASE WHEN captured_on > CURRENT_DATE - 28 THEN 'now' ELSE 'before' END AS period, sum(visits)::int AS visits,
           sum(COALESCE((SELECT sum(value::numeric) FROM jsonb_each_text(goals)), 0))::float AS leads
    FROM seo_traffic_snapshots WHERE captured_on > CURRENT_DATE - 56 GROUP BY 1`);
  const p = Object.fromEntries(periods.map((item) => [item.period, item]));
  const t = Object.fromEntries(traffic.map((item) => [item.period, item]));
  const ctr = (item) => (item?.impressions ? round((item.clicks / item.impressions) * 100, 2) : null);
  const summary = [
    { label: "Показы", now: p.now?.impressions ?? null, before: p.before?.impressions ?? null },
    { label: "Клики", now: p.now?.clicks ?? null, before: p.before?.clicks ?? null },
    { label: "CTR, %", now: ctr(p.now), before: ctr(p.before) },
    { label: "Средняя позиция", now: round(p.now?.position), before: round(p.before?.position) },
    { label: "Поисковые визиты", now: t.now?.visits ?? null, before: t.before?.visits ?? null },
    { label: "Заявки", now: t.now ? Math.round(t.now.leads) : null, before: t.before ? Math.round(t.before.leads) : null },
  ].map((item) => ({ ...item, delta: item.now !== null && item.before !== null ? round(item.now - item.before, 2) : null }));
  const ranks = await rows(query, `
    WITH now_r AS (SELECT DISTINCT ON (query) query, position FROM seo_rank_snapshots ORDER BY query, captured_at DESC),
         old_r AS (SELECT DISTINCT ON (query) query, position FROM seo_rank_snapshots WHERE captured_at < now() - interval '27 days' ORDER BY query, captured_at DESC)
    SELECT 'now' AS period, count(*) FILTER (WHERE position <= 3)::int AS top3, count(*) FILTER (WHERE position <= 10)::int AS top10, count(*) FILTER (WHERE position <= 20)::int AS top20 FROM now_r
    UNION ALL SELECT 'before', count(*) FILTER (WHERE position <= 3)::int, count(*) FILTER (WHERE position <= 10)::int, count(*) FILTER (WHERE position <= 20)::int FROM old_r`);
  const r = Object.fromEntries(ranks.map((item) => [item.period, item]));
  const hasRanks = sources.has.topvisor_ranks;
  const rankRows = hasRanks ? ["top3", "top10", "top20"].map((key) => ({ label: { top3: "Top-3", top10: "Top-10", top20: "Top-20" }[key], now: r.now?.[key] ?? null, before: r.before?.[key] ?? null }))
    .map((item) => ({ ...item, delta: item.now !== null && item.before !== null ? item.now - item.before : null })) : [];
  const movers = await rows(query, `
    SELECT url, sum(clicks) FILTER (WHERE captured_at > now() - interval '28 days')::int AS now_clicks,
           sum(clicks) FILTER (WHERE captured_at <= now() - interval '28 days')::int AS before_clicks
    FROM seo_search_snapshots WHERE captured_at > now() - interval '56 days' GROUP BY url`);
  const moved = movers.map((item) => ({ path: pathOf(item.url), now: item.now_clicks || 0, before: item.before_clicks || 0, delta: (item.now_clicks || 0) - (item.before_clicks || 0) })).filter((item) => item.delta !== 0);
  const measured = await rows(query, "SELECT url, change_type, description, result, measure_after::text FROM seo_changes WHERE status = 'measured' ORDER BY measure_after DESC LIMIT 100");
  const moverColumns = [col("path", "URL", "url"), col("before", "Клики до", "int"), col("now", "Клики сейчас", "int"), col("delta", "Изменение", "delta")];
  return {
    sections: [
      section("report25_summary", "25 число · итоги 28 дней к предыдущим 28", [col("label", "Показатель"), col("now", "28 дней", "num"), col("before", "Предыдущие 28", "num"), col("delta", "Изменение", "delta")], sources.has.webmaster || sources.has.metrica ? summary : [], { empty: "Нет данных: нужен Вебмастер или Метрика", source: "Вебмастер · Метрика" }),
      section("report25_ranks", "Top-3 / Top-10 / Top-20", [col("label", "Диапазон"), col("now", "Сейчас", "int"), col("before", "Месяц назад", "int"), col("delta", "Изменение", "delta")], rankRows, { empty: emptyFor(sources, "topvisor_ranks"), source: "Topvisor · позиции" }),
      section("report25_up", "Выросшие URL", moverColumns, moved.filter((item) => item.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 30), { empty: emptyFor(sources, "webmaster"), source: "Вебмастер" }),
      section("report25_down", "Упавшие URL", moverColumns, moved.filter((item) => item.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 30), { empty: emptyFor(sources, "webmaster"), source: "Вебмастер" }),
      section("report25_experiments", "Результаты экспериментов (28 дней после изменения)", [col("path", "URL", "url"), col("what", "Что меняли"), col("verdict", "Итог", "badge"), col("measure_after", "Замер", "date")],
        measured.map((item) => ({ path: pathOf(item.url), what: [item.change_type, item.description].filter(Boolean).join(" · "), verdict: CHANGE_RESULTS[item.result?.verdict] || "", measure_after: item.measure_after })),
        { empty: "Измеренных изменений пока нет", source: "журнал изменений" }),
    ],
  };
}

async function viewSessions(query) {
  const note = (await rows(query, "SELECT id::text, content, updated_at::text FROM notes WHERE title = 'SEO · журнал сессий' ORDER BY id LIMIT 1").catch(() => []))[0];
  const blocks = String(note?.content || "").split(/\n(?=## )/).map((block) => block.trim()).filter((block) => block.startsWith("## "));
  const list = blocks.reverse().map((block) => {
    const [head, ...body] = block.split("\n");
    return { title: head.replace(/^##\s+/, ""), text: body.join("\n").trim() };
  });
  return {
    sections: [section("sessions", "Журнал сессий старшей модели", [col("title", "Сессия"), col("text", "Отчёт", "markdown")], list, { empty: "Сессий ещё не было: отчёт пишет навык seo-wizard в конце сессии", source: note ? `заметка #${note.id}` : "заметка «SEO · журнал сессий»" })],
  };
}

async function viewPackages(query) {
  const list = await rows(query, `
    SELECT id::text, scenario, status, created_at::text, run_id::text,
           jsonb_array_length(COALESCE(payload->'candidates', '[]'::jsonb))::int AS candidates,
           jsonb_array_length(COALESCE(payload->'obscura_checks', '[]'::jsonb))::int AS obscura,
           jsonb_array_length(COALESCE(payload->'pending_decisions', '[]'::jsonb))::int AS pending
    FROM seo_packages ORDER BY created_at DESC LIMIT 100`);
  return {
    sections: [section("packages", "Пакеты для сессий", [
      col("created_at", "Собран", "datetime"), col("scenario", "Сценарий", "scenario"), col("candidates", "Кандидатов", "int"),
      col("pending", "Решений ждут", "int"), col("obscura", "Проверок Obscura", "int"), col("run_id", "Прогон"),
    ], list, { empty: "Пакетов ещё нет", source: "сборщик пакетов" })],
  };
}

async function viewRuns(query) {
  const list = await rows(query, "SELECT id::text, scenario, status, started_at::text, finished_at::text, stats, errors FROM seo_runs ORDER BY started_at DESC LIMIT 100");
  return {
    sections: [section("runs", "Прогоны сервера", [
      col("started_at", "Старт", "datetime"), col("scenario", "Сценарий", "scenario"), col("status", "Статус", "run_status"), col("duration", "Длилось, с", "int"),
      col("sitemap_urls", "URL sitemap", "int"), col("crawled_urls", "Проверено", "int"), col("issues", "Находок", "int"), col("errors", "Ошибки", "multiline"),
    ], list.map((item) => ({
      started_at: item.started_at,
      scenario: item.scenario,
      status: item.status,
      duration: item.finished_at ? Math.round((Date.parse(item.finished_at) - Date.parse(item.started_at)) / 1000) : null,
      sitemap_urls: item.stats?.sitemap_urls ?? null,
      crawled_urls: item.stats?.crawled_urls ?? null,
      issues: item.stats?.issues_detected ?? null,
      errors: (item.errors || []).map((error) => `${error.source ? `${error.source}: ` : ""}${error.message}`).join("\n"),
    })), { empty: "Прогонов ещё не было", source: "seo_runs", note: "Прогон пишет, что получилось и что нет: «ничего не нашёл» отличается от «не смог собрать данные»." })],
  };
}

async function viewIssues(query) {
  const list = await rows(query, `
    SELECT id::text, detector, severity, status, title, summary, affected_count, potential_score, first_seen_at::text, last_seen_at::text
    FROM seo_issues ORDER BY status IN ('open', 'review') DESC, potential_score DESC, last_seen_at DESC LIMIT 500`);
  return {
    sections: [section("issues", "Находки детекторов", [
      col("detector", "Детектор", "detector"), col("title", "Находка"), col("severity", "Важность", "severity"), col("affected_count", "Затронуто", "int"),
      col("potential_score", "Потенциал", "int"), col("status", "Статус", "issue_status"), col("last_seen_at", "Видели", "datetime"), col("actions", "", "issue_actions"),
    ], list.map((item) => ({ ...item, potential_score: Math.round(num(item.potential_score)) })), { empty: "Находок нет", source: "детекторы", note: "Задача создаётся только из находки с цифрой. Шум и повторы помечаются, чтобы сессия не считала их проблемой второй раз." })],
    options: { detectors: DETECTOR_LABELS },
  };
}

export const SCENARIOS = [
  { id: "daily", when: "Каждый день", server: "Снимки Вебмастера, Topvisor (позиции), Метрики; сторожевые проверки: падения, массовые 404, смена canonical/robots, критичные ошибки аудита", session: "не запускается", notify: "только при критике" },
  { id: "monday", when: "Понедельник", server: "Снимки выдачи по кластерам-кандидатам; детекторы 03, 05 (CTR, сниппеты, выдача), позиции, поведение, потенциал → пакет недели", session: "«SEO: понедельник» — очередь недели 3–5 задач, решения человеку, отчёт", notify: "сводка недели" },
  { id: "thursday", when: "Четверг", server: "Повторный аудит и обход по страницам из утверждённых задач → пакет внедрения", session: "«SEO: четверг» — что внедрено, журнал изменений со снимком «до», что застряло", notify: "если есть что отметить" },
  { id: "architecture", when: "10 число", server: "Полный обход и аудит, детекторы 01, 02, состав индекса; семантика и потенциал по Wordstat; выдача по ядру → пакет архитектуры", session: "«SEO: архитектура» — состав индекса, нарушения политики, каннибализация, решения по разделам", notify: "сводка" },
  { id: "authority", when: "20 число", server: "Поиск упоминаний → пакет авторитета", session: "«SEO: авторитет» — площадки через Obscura, кому писать", notify: "список площадок" },
  { id: "monthly", when: "25 число", server: "Метрика, Вебмастер, Topvisor за месяц; изменения старше 28 дней с «до/после» → пакет итогов", session: "«SEO: итоги» — что сработало, уроки в память, что поменять", notify: "итог месяца" },
];

async function viewScenarios(query) {
  const latest = await rows(query, "SELECT DISTINCT ON (scenario) scenario, created_at::text, jsonb_array_length(COALESCE(payload->'candidates', '[]'::jsonb))::int AS candidates FROM seo_packages ORDER BY scenario, created_at DESC");
  const byScenario = Object.fromEntries(latest.map((item) => [item.scenario, item]));
  return {
    sections: [section("scenarios", "Расписание: сервер готовит пакет, старшая модель разбирает", [
      col("when", "Когда"), col("server", "Сервер (cron, без модели)", "multiline"), col("session", "Сессия Claude/Codex", "multiline"),
      col("notify", "Кому сообщает"), col("last_package", "Последний пакет", "datetime"), col("candidates", "Кандидатов", "int"), col("run", "", "run_scenario"),
    ], SCENARIOS.map((item) => ({ ...item, last_package: byScenario[item.id]?.created_at || "", candidates: byScenario[item.id]?.candidates ?? null })), { source: "стратегия · заметка #27", note: "Пропущенная сессия ничего не теряет: следующая берёт накопленное." })],
  };
}

// ─── Дашборд ─────────────────────────────────────────────────────────────────

export async function seoDashboard(query, settings) {
  const sources = await seoSources(query);
  const [composition, opportunities, cannibal, counts, search, ranks, queue] = await Promise.all([
    compositionRows(query, sources, settings),
    opportunityRows(query, sources),
    viewCannibal(query, sources),
    rows(query, `SELECT count(*) FILTER (WHERE in_sitemap)::int AS sitemap, count(*) FILTER (WHERE status_code IS NOT NULL)::int AS checked,
                        count(*) FILTER (WHERE in_search)::int AS in_search FROM seo_urls`),
    rows(query, `SELECT sum(impressions)::int AS impressions, sum(clicks)::int AS clicks, count(DISTINCT url)::int AS urls
                  FROM seo_search_snapshots WHERE captured_at > now() - interval '${WINDOW}'`),
    rows(query, `WITH latest AS (SELECT DISTINCT ON (query) query, position FROM seo_rank_snapshots ORDER BY query, captured_at DESC)
                  SELECT count(*)::int AS tracked, count(*) FILTER (WHERE position <= 10)::int AS top10 FROM latest`),
    rows(query, `SELECT count(*) FILTER (WHERE status NOT IN ('done', 'cancelled'))::int AS open FROM todos WHERE props->>'seo_wizard' = 'true'`),
  ]);
  const issues = await rows(query, "SELECT count(*) FILTER (WHERE status IN ('open', 'review'))::int AS open, count(*) FILTER (WHERE severity = 'high' AND status IN ('open', 'review'))::int AS high FROM seo_issues");
  const c = counts[0] || {};
  const s = search[0] || {};
  const r = ranks[0] || {};
  const kpis = [
    { key: "sitemap", label: "URL в sitemap", value: c.sitemap ?? 0, hint: `проверено HTTP: ${c.checked ?? 0}` },
    { key: "indexed", label: "Страниц в поиске", value: sources.has.webmaster ? (c.in_search || s.urls || 0) : null, hint: sources.has.webmaster ? "Вебмастер" : "нужен Вебмастер" },
    { key: "clicks", label: "Клики 28д", value: sources.has.webmaster ? s.clicks ?? 0 : null, hint: sources.has.webmaster ? "Вебмастер" : "нужен Вебмастер" },
    { key: "impressions", label: "Показы 28д", value: sources.has.webmaster ? s.impressions ?? 0 : null, hint: sources.has.webmaster ? "Вебмастер" : "нужен Вебмастер" },
    { key: "ctr", label: "CTR", value: sources.has.webmaster && s.impressions ? round((s.clicks / s.impressions) * 100, 2) : null, unit: "%", hint: sources.has.webmaster ? "Вебмастер" : "нужен Вебмастер" },
    { key: "top10", label: "Запросов в Top-10", value: sources.has.topvisor_ranks ? r.top10 ?? 0 : null, hint: sources.has.topvisor_ranks ? `из ${r.tracked}` : "нужен Topvisor" },
    { key: "issues", label: "Открытые находки", value: issues[0]?.open ?? 0, hint: `важных: ${issues[0]?.high ?? 0}` },
    { key: "queue", label: "Задачи недели", value: queue[0]?.open ?? 0, hint: "цель — 3–5" },
  ];
  const cannibalSections = cannibal.sections;
  const cannibalRows = cannibalSections[0].rows.length ? cannibalSections[0].rows.slice(0, 6) : [];
  const slugRows = cannibalSections[1].rows.slice(0, 6).map((item) => ({ ...item, example: String(item.urls || "").split("\n")[0] || "" }));
  return {
    kpis,
    sources: sources.sources,
    run: sources.run ? { id: sources.run.id, status: sources.run.status, started_at: sources.run.started_at, finished_at: sources.run.finished_at } : null,
    sections: [
      section("growth", "Growth Opportunities", [col("priority", "Приоритет", "priority"), col("path", "URL", "url"), col("impressions", "Показы", "int"), col("position", "Поз", "num"), col("potential", "Потенциал", "int")], opportunities.slice(0, 6), { empty: emptyFor(sources, "webmaster"), source: "Вебмастер" }),
      cannibalRows.length
        ? section("cannibal", "Cannibalization", [col("cluster", "Запрос"), col("url1", "URL", "url"), col("clicks1", "Клики", "int"), col("urls", "Наших URL", "int")], cannibalRows, { source: "Вебмастер" })
        : section("cannibal", "Cannibalization · окончания адресов", [col("slug", "Окончание", "code"), col("sections", "Разделов", "int"), col("example", "Например", "url")], slugRows, { source: "sitemap", total: cannibalSections[1].rows.length }),
      section("index_health", "Index Health", [col("label", "Тип"), col("in_search", "Индекс", "int"), col("in_sitemap", "Sitemap", "int"), col("no_clicks", "Без трафика", "int")], composition, { source: "sitemap · Вебмастер" }),
    ],
  };
}

const VIEWS = {
  scenarios: viewScenarios,
  queue: viewQueue,
  decisions: viewDecisions,
  changes: viewChanges,
  registry: viewRegistry,
  index: viewIndex,
  filters: viewFilters,
  links: viewLinks,
  cannibal: viewCannibal,
  quality: viewQuality,
  competitors: viewCompetitors,
  ctr: viewCtr,
  opportunities: viewOpportunities,
  positions: viewPositions,
  serp: viewSerp,
  demand: viewDemand,
  traffic: viewTraffic,
  outreach: viewOutreach,
  report10: viewReport10,
  report20: viewReport20,
  report25: viewReport25,
  sessions: viewSessions,
  packages: viewPackages,
  runs: viewRuns,
  issues: viewIssues,
};

export async function seoView(query, id, settings) {
  const view = VIEWS[id];
  if (!view) return null;
  const sources = await seoSources(query);
  const result = await view(query, sources, settings);
  return { id, ...result, sources: sources.sources };
}

// ─── Записи из интерфейса ────────────────────────────────────────────────────

export async function setUrlDecision(query, { id, decision, note = "" }) {
  const value = Object.hasOwn(URL_DECISIONS, decision) ? decision : "";
  const row = (await rows(query, `UPDATE seo_urls SET decision = $2, decision_note = $3, decided_at = CASE WHEN $2 = '' THEN NULL ELSE now() END
                                   WHERE id = $1 RETURNING id::text, path, decision`, [id, value, String(note || "").slice(0, 500)]))[0];
  // 301/canonical/noindex — решения человека: они же история для сессий (журнал решений читается перед разбором).
  if (row && value) {
    await query(
      `INSERT INTO decision_log(actor, title, decision, rationale, props) VALUES ('Человек', $1, $2, $3, $4::jsonb)`,
      [`SEO: решение по ${row.path}`, URL_DECISIONS[value], String(note || ""), JSON.stringify({ seo_wizard: true, url_id: row.id, url_decision: value })],
    );
  }
  return row || null;
}

export async function saveOutreach(query, body) {
  const domain = String(body.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").slice(0, 200);
  if (!domain) throw new Error("domain_required");
  const status = Object.hasOwn(OUTREACH_STATUSES, body.status) ? body.status : "found";
  const bool = (value) => (value === true || value === false ? value : null);
  if (body.id) {
    return (await rows(query, `UPDATE seo_outreach SET domain = $2, site_type = $3, page_url = $4, mentions_us = $5, has_link = $6, contact = $7, potential = $8, status = $9, note = $10, updated_at = now()
                                WHERE id = $1 RETURNING id::text`, [body.id, domain, String(body.site_type || ""), String(body.page_url || ""), bool(body.mentions_us), bool(body.has_link), String(body.contact || ""), String(body.potential || ""), status, String(body.note || "")]))[0] || null;
  }
  return (await rows(query, `INSERT INTO seo_outreach(domain, site_type, page_url, mentions_us, has_link, contact, potential, status, note)
                              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                              ON CONFLICT (domain, page_url) DO UPDATE SET site_type = EXCLUDED.site_type, mentions_us = EXCLUDED.mentions_us, has_link = EXCLUDED.has_link,
                                contact = EXCLUDED.contact, potential = EXCLUDED.potential, status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now()
                              RETURNING id::text`, [domain, String(body.site_type || ""), String(body.page_url || ""), bool(body.mentions_us), bool(body.has_link), String(body.contact || ""), String(body.potential || ""), status, String(body.note || "")]))[0];
}

/** Запись изменения с базовой линией «до»: показы/клики/позиция из Вебмастера, визиты из Метрики — за 28 дней. */
export async function recordChange(query, body) {
  const url = String(body.url || "").trim();
  if (!url) throw new Error("url_required");
  const baseline = (await rows(query, `
    SELECT sum(impressions)::int AS impressions, sum(clicks)::int AS clicks,
           CASE WHEN sum(impressions) > 0 THEN sum(COALESCE(position, 0) * impressions) / sum(impressions) END AS position
    FROM seo_search_snapshots WHERE url = $1 AND captured_at > now() - interval '${WINDOW}'`, [url]))[0] || {};
  const visits = await scalar(query, "SELECT sum(visits)::int FROM seo_traffic_snapshots WHERE url = $1 AND captured_on > CURRENT_DATE - 28", [url]);
  const base = {
    impressions: baseline.impressions ?? null,
    clicks: baseline.clicks ?? null,
    position: baseline.position ?? null,
    ctr: baseline.impressions ? (baseline.clicks / baseline.impressions) * 100 : null,
    visits: visits ?? null,
    captured_at: new Date().toISOString(),
  };
  return (await rows(query, `
    INSERT INTO seo_changes(issue_id, todo_id, change_type, url, description, baseline, status, detected_at, measure_after)
    VALUES (NULLIF($1, '')::bigint, NULLIF($2, '')::bigint, $3, $4, $5, $6::jsonb, 'live', now(), CURRENT_DATE + 28)
    RETURNING id::text`, [String(body.issue_id || ""), String(body.todo_id || ""), String(body.change_type || ""), url, String(body.description || ""), JSON.stringify(base)]))[0];
}
