// Карточка страницы поверх базы SEO Wizard: собирает данные всех источников по одному адресу.
// Тонкие места (запросы к Вебмастеру и Wordstat по требованию, кривая CTR) приходят снаружи через deps,
// чтобы модуль не зависел от остального SEO Wizard и проверялся на подставной базе.
import { queryPotential, fallbackCtr } from "./seo-potential.mjs";
import { coreTerms, effectAround, pathOfUrl, seasonality, sitemapNote, sumSeries } from "./seo-page-card.mjs";

const DAY = 86_400_000;
const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const round = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits);

// Путь страницы из абсолютного адреса в SQL: без хоста и завершающего «/», корень — «/».
const PATH_SQL = (column) => `COALESCE(NULLIF(rtrim(regexp_replace(${column}, '^https?://[^/]+', ''), '/'), ''), '/')`;

const sum = (rows, key) => rows.reduce((total, row) => total + num(row[key]), 0);

function periodTotals(daily, days, offset = 0, now = new Date()) {
  const end = now.getTime() - offset * DAY;
  const start = end - days * DAY;
  const rows = daily.filter((row) => { const t = Date.parse(`${row.date}T00:00:00Z`); return t > start && t <= end; });
  const impressions = sum(rows, "impressions");
  const clicks = sum(rows, "clicks");
  const weighted = rows.filter((row) => row.position).reduce((total, row) => total + row.position * row.impressions, 0);
  const weight = rows.filter((row) => row.position).reduce((total, row) => total + row.impressions, 0);
  return { days: rows.length, impressions, clicks, ctr: impressions ? round((clicks / impressions) * 100, 2) : null, avg_position: weight ? round(weighted / weight) : null };
}

export async function pageCard(query, input, deps = {}) {
  const path = pathOfUrl(input);
  if (!path) throw Object.assign(new Error("Укажите адрес или путь страницы"), { status: 400 });
  const now = deps.now || new Date();
  const gaps = [];

  const urlRow = (await query(
    `SELECT url, path, url_type, section, status_code, canonical, in_sitemap, in_search, lastmod::text AS lastmod, title, h1, quality, decision, decision_note, source_flags
       FROM seo_urls WHERE ${PATH_SQL("url")} = $1 ORDER BY in_sitemap DESC, updated_at DESC LIMIT 1`,
    [path],
  ).catch(() => ({ rows: [] }))).rows[0] || null;
  if (!urlRow) gaps.push("Страницы нет в реестре адресов: она не попала ни в sitemap, ни в обход. Данные ниже — только из Вебмастера, Topvisor и Метрики, если они есть.");

  // Метатеги и разметка — последний снимок обхода.
  const snapshot = urlRow ? (await query("SELECT captured_at::text AS captured_at, status_code, canonical, title, h1, meta FROM seo_page_snapshots WHERE url = $1 ORDER BY captured_at DESC LIMIT 1", [urlRow.url])).rows[0] : null;
  const markup = snapshot?.meta?.markup || null;
  if (snapshot && !markup) gaps.push("В последнем снимке страницы нет разметки (он сделан до карточки): полные метатеги появятся после следующего обхода.");

  // Вебмастер: суточные итоги страницы и её запросы.
  const daily = (await query(
    "SELECT captured_on::text AS date, impressions, clicks, position FROM seo_page_stats WHERE url = $1 AND query = '' ORDER BY captured_on",
    [path],
  ).catch(() => ({ rows: [] }))).rows.map((row) => ({ date: row.date, impressions: num(row.impressions), clicks: num(row.clicks), position: row.position === null ? null : num(row.position) }));
  let pairs = await readPairs(query, path);
  if (!pairs.length && deps.collectQueries) {
    const got = await deps.collectQueries(path).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    if (got?.ok) pairs = await readPairs(query, path);
    else if (got?.error) gaps.push(`Запросы страницы из Вебмастера не получены: ${got.error}`);
  }
  if (!daily.length) gaps.push("Нет итогов Вебмастера по этой странице: она не показывалась в поиске за период хранения или сбор по страницам ещё не запускался.");

  // Topvisor: последняя позиция по запросам, где ранжируется эта страница, и по запросам страницы из Вебмастера.
  const queryNames = [...new Set(pairs.map((row) => row.query))];
  const ranks = (await query(
    `SELECT DISTINCT ON (query) query, url, position, captured_at::date::text AS date
       FROM seo_rank_snapshots
      WHERE source = 'topvisor' AND (${PATH_SQL("url")} = $1 OR query = ANY($2::text[]))
      ORDER BY query, captured_at DESC`,
    [path, queryNames],
  ).catch(() => ({ rows: [] }))).rows;
  const rankBy = new Map(ranks.map((row) => [row.query, row]));
  for (const row of ranks) if (!queryNames.includes(row.query) && pathOfUrl(row.url) === path) queryNames.push(row.query);

  const demandRows = queryNames.length ? (await query(
    "SELECT DISTINCT ON (query) query, demand, month FROM seo_demand_snapshots WHERE query = ANY($1::text[]) ORDER BY query, captured_at DESC",
    [queryNames],
  ).catch(() => ({ rows: [] }))).rows : [];
  const demandBy = new Map(demandRows.map((row) => [row.query, row]));
  const ctr = deps.ctr || fallbackCtr;

  const pairBy = new Map(pairs.map((row) => [row.query, row]));
  const queries = queryNames.map((text) => {
    const pair = pairBy.get(text);
    const rank = rankBy.get(text);
    const demand = demandBy.get(text);
    const position = rank && rank.position !== null ? num(rank.position) : null;
    const potential = queryPotential({ query: text, demand: demand ? num(demand.demand) : null, position: rank ? position : pair?.position ?? null, ctr });
    return {
      query: text,
      demand: demand ? num(demand.demand) : null,
      demand_month: demand?.month || "",
      topvisor_position: position,
      topvisor_date: rank?.date || "",
      topvisor_url: rank?.url ? pathOfUrl(rank.url) : "",
      other_page_ranks: Boolean(rank?.url && pathOfUrl(rank.url) !== path),
      impressions: pair ? pair.impressions : null,
      clicks: pair ? pair.clicks : null,
      ctr: pair && pair.impressions ? round((pair.clicks / pair.impressions) * 100, 2) : null,
      webmaster_position: pair ? pair.position : null,
      webmaster_days: pair ? pair.days : 0,
      ...potential,
    };
  }).sort((a, b) => (num(b.expected) - num(a.expected)) || (num(b.clicks) - num(a.clicks)) || (num(b.impressions) - num(a.impressions)));
  if (queries.length && !queries.some((item) => item.demand !== null)) gaps.push("Для запросов страницы ещё не собран спрос Wordstat: потенциал не посчитан.");
  if (!queries.length) gaps.push("У страницы не найдено запросов ни в Вебмастере, ни в Topvisor: семантику определить нельзя.");

  // Метрика: визиты и цели страницы из поиска.
  const traffic = (await query(
    `SELECT captured_on::text AS date, visits, bounces, page_depth, visit_duration, raw FROM seo_traffic_snapshots
      WHERE source = 'metrica' AND ${PATH_SQL("url")} = $1 AND captured_on > current_date - 60 ORDER BY captured_on`,
    [path],
  ).catch(() => ({ rows: [] }))).rows;
  const metrica = metricaSummary(traffic, deps.goalNotes || [], now);

  // Что менялось.
  const found = (await query("SELECT detected_at::text AS at, field, label, old_value, new_value FROM seo_page_changes WHERE path = $1 ORDER BY detected_at DESC LIMIT 100", [path]).catch(() => ({ rows: [] }))).rows;
  const manualForPage = (await query(`SELECT created_at::text AS at, change_type, description, status, baseline, result, url FROM seo_changes WHERE ${PATH_SQL("url")} = $1 ORDER BY created_at DESC LIMIT 50`, [path]).catch(() => ({ rows: [] }))).rows;
  const changeDates = [...new Set([...found.map((row) => row.at.slice(0, 10)), ...manualForPage.map((row) => row.at.slice(0, 10))])].sort().reverse().slice(0, 10);

  // Позиции страницы по проверкам Topvisor — для эффекта изменений.
  const history = queryNames.length ? (await query(
    "SELECT captured_at::date::text AS date, query, position FROM seo_rank_snapshots WHERE source = 'topvisor' AND query = ANY($1::text[]) ORDER BY captured_at",
    [queryNames],
  ).catch(() => ({ rows: [] }))).rows : [];
  const checks = new Map();
  for (const row of history) {
    if (!checks.has(row.date)) checks.set(row.date, new Map());
    checks.get(row.date).set(row.query, row.position === null ? null : num(row.position));
  }
  const rankChecks = [...checks.entries()].map(([date, positions]) => ({ date, positions }));
  const effects = changeDates.map((date) => effectAround(date, { ranks: rankChecks, daily }));
  if (changeDates.length && !rankChecks.length) gaps.push("Нет проверок Topvisor по запросам страницы: эффект изменений на позиции посчитать нельзя.");

  // Сезонность по помесячному спросу Wordstat для главных запросов страницы.
  const seasonQueries = queries.filter((item) => item.demand !== null).sort((a, b) => num(b.demand) - num(a.demand)).slice(0, 3).map((item) => item.query);
  let season = null;
  let dynamicsError = "";
  if (seasonQueries.length) {
    const series = [];
    for (const text of seasonQueries) {
      let rows = (await query("SELECT month, demand FROM seo_demand_history WHERE query = $1 ORDER BY month", [text]).catch(() => ({ rows: [] }))).rows;
      if (!rows.length && deps.fetchDynamics) {
        const fetched = await deps.fetchDynamics(text).catch((error) => { dynamicsError = String(error?.message || error); return null; });
        if (fetched?.length) {
          for (const item of fetched) await query("INSERT INTO seo_demand_history(query, month, demand) VALUES ($1, $2, $3) ON CONFLICT (query, month) DO UPDATE SET demand = EXCLUDED.demand, fetched_at = now()", [text, item.month, item.value]);
          rows = fetched.map((item) => ({ month: item.month, demand: item.value }));
        }
      }
      series.push(rows.map((row) => ({ month: row.month, value: num(row.demand) })));
    }
    const total = sumSeries(series.filter((rows) => rows.length));
    season = { ...seasonality(total), queries: seasonQueries, series: total };
    if (!season.enough) {
      if (dynamicsError) {
        season = { ...season, note: `История спроса Wordstat не получена: ${dynamicsError}` };
        gaps.push(`Сезонность не посчитана: история спроса Wordstat не получена (${dynamicsError}). Повторите позже, запрос подтянется сам.`);
      } else gaps.push(`Сезонность: ${season.note}`);
    }
  } else {
    gaps.push("Сезонность не оценить: нет запросов с известным спросом.");
  }

  return {
    page: urlRow ? {
      url: urlRow.url, path, type: urlRow.url_type, section: urlRow.section, status_code: urlRow.status_code, canonical: urlRow.canonical || "",
      canonical_is_self: urlRow.canonical ? pathOfUrl(urlRow.canonical) === path : null,
      in_search: urlRow.in_search, decision: urlRow.decision || "", decision_note: urlRow.decision_note || "",
      noindex: Boolean(urlRow.quality?.noindex),
    } : { url: "", path },
    meta: {
      title: snapshot?.title || urlRow?.title || "", title_length: (snapshot?.title || urlRow?.title || "").length,
      h1: snapshot?.h1 || urlRow?.h1 || "", h1_count: snapshot?.meta?.h1_count ?? null,
      description: markup?.description ?? null, description_length: markup ? markup.description.length : snapshot?.meta?.description_length ?? null,
      robots: markup?.robots ?? null, lang: markup?.lang ?? null, viewport: markup?.viewport ?? null,
      og: markup?.og ?? null, twitter_card: markup?.twitter_card ?? null,
      hreflang: markup?.hreflang ?? null, h2: markup?.h2 ?? null, h2_count: markup?.h2_count ?? null, images: markup?.images ?? null,
      images_without_alt: markup?.images_without_alt ?? null, words: markup?.words ?? null, text_chars: snapshot?.meta?.text_chars ?? null,
      snapshot_at: snapshot?.captured_at || "",
    },
    markup: markup ? { schema: markup.schema, microdata: markup.schema?.microdata ?? 0 } : null,
    sitemap: sitemapNote({ in_sitemap: Boolean(urlRow?.in_sitemap), lastmod: urlRow?.lastmod, source: urlRow?.source_flags?.sitemap_source, now }),
    webmaster: { last_14: periodTotals(daily, 14, 0, now), previous_14: periodTotals(daily, 14, 14, now), days_stored: daily.length, first_day: daily[0]?.date || "", last_day: daily[daily.length - 1]?.date || "", daily: daily.slice(-60) },
    semantics: { total_queries: queries.length, with_demand: queries.filter((item) => item.demand !== null).length, core_terms: coreTerms(queries), queries: queries.slice(0, 100) },
    metrica,
    seasonality: season,
    changes: { detected: found, manual: manualForPage },
    effects,
    gaps,
  };
}

/** Пары «страница — запрос» из накопленной статистики Вебмастера: сумма за всё хранимое время и средняя позиция по показам. */
async function readPairs(query, path) {
  const rows = (await query(
    `SELECT query, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks, count(*)::int AS days,
            CASE WHEN sum(impressions) FILTER (WHERE position IS NOT NULL) > 0
                 THEN sum(position * impressions) FILTER (WHERE position IS NOT NULL) / sum(impressions) FILTER (WHERE position IS NOT NULL) END AS position
       FROM seo_page_stats WHERE url = $1 AND query <> '' GROUP BY query ORDER BY sum(impressions) DESC LIMIT 300`,
    [path],
  ).catch(() => ({ rows: [] }))).rows;
  return rows.map((row) => ({ query: row.query, impressions: num(row.impressions), clicks: num(row.clicks), days: num(row.days), position: row.position === null ? null : round(num(row.position)) }));
}

function metricaSummary(rows, goalNotes, now) {
  const at = (row) => Date.parse(`${row.date}T00:00:00Z`);
  const last = rows.filter((row) => at(row) > now.getTime() - 28 * DAY);
  const prev = rows.filter((row) => at(row) <= now.getTime() - 28 * DAY && at(row) > now.getTime() - 56 * DAY);
  const goals = new Map();
  for (const row of last) for (const [id, value] of Object.entries(row.raw?.goals || {})) goals.set(id, (goals.get(id) || 0) + num(value));
  const notes = new Map(goalNotes.map((item) => [item.goal_id, item]));
  const visits = sum(last, "visits");
  return {
    visits_28: visits,
    visits_prev_28: sum(prev, "visits"),
    bounce_rate: visits ? round((sum(last, "bounces") / visits) * 100) : null,
    goals: [...goals.entries()].map(([id, reaches]) => ({ goal_id: id, goal: notes.get(id)?.goal || "", note: notes.get(id)?.note || "", role: notes.get(id)?.role || "", reaches: Math.round(reaches), conversion: visits ? round((reaches / visits) * 100, 2) : null })).sort((a, b) => b.reaches - a.reaches).slice(0, 30),
    note: rows.length ? "" : "Нет визитов из поиска по этой странице за 60 дней или цели ещё не собирались.",
  };
}
