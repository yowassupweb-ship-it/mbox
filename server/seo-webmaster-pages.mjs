// Вебмастер по страницам: query-analytics/list отдаёт статистику по адресам страниц и по запросам конкретной страницы,
// но хранит всего две недели. Поэтому складываем в seo_page_stats каждый день (страницы) и раз в неделю (запросы страниц):
// история копится у нас, и карточка страницы видит клики и запросы страницы за месяцы, а не за 14 дней.
// call(body) — запрос POST к query-analytics/list (токен и адрес хоста знает вызывающий), здесь только разбор и запись.

const PAGE_LIMIT = 500;
const FIELDS = { IMPRESSIONS: "impressions", CLICKS: "clicks", POSITION: "position" };

/** Ответ query-analytics → строки { date, key, impressions, clicks, position }; key — значение text_indicator (путь страницы или запрос). */
export function parseAnalytics(data) {
  const rows = [];
  for (const item of data?.text_indicator_to_statistics || []) {
    const key = String(item?.text_indicator?.value ?? "");
    if (!key) continue;
    const byDate = new Map();
    for (const stat of item.statistics || []) {
      const field = FIELDS[stat.field];
      if (!field || !/^\d{4}-\d{2}-\d{2}$/.test(String(stat.date))) continue;
      const entry = byDate.get(stat.date) || { date: stat.date, key, impressions: 0, clicks: 0, position: null };
      entry[field] = field === "position" ? (Number(stat.value) > 0 ? Number(stat.value) : null) : Math.round(Number(stat.value) || 0);
      byDate.set(stat.date, entry);
    }
    for (const entry of byDate.values()) if (entry.impressions || entry.clicks) rows.push(entry);
  }
  return rows;
}

async function upsert(query, rows) {
  for (let i = 0; i < rows.length; i += 1000) {
    await query(
      `INSERT INTO seo_page_stats(captured_on, url, query, impressions, clicks, position)
       SELECT r.captured_on, r.url, r.query, r.impressions, r.clicks, r.position
       FROM jsonb_to_recordset($1::jsonb) AS r(captured_on DATE, url TEXT, query TEXT, impressions INT, clicks INT, position DOUBLE PRECISION)
       ON CONFLICT (captured_on, url, query) DO UPDATE SET impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, position = EXCLUDED.position`,
      [JSON.stringify(rows.slice(i, i + 1000))],
    );
  }
}

/** Суточная статистика по всем страницам (query = ''). Пять-шесть запросов к API на весь сайт. */
export async function collectPageTotals(query, call, { maxPages = 5000 } = {}) {
  let pages = 0;
  let stored = 0;
  for (let offset = 0; offset < maxPages; offset += PAGE_LIMIT) {
    const data = await call({ text_indicator: "URL", device_type_indicator: "ALL", limit: PAGE_LIMIT, offset });
    const rows = parseAnalytics(data).map((row) => ({ captured_on: row.date, url: row.key, query: "", impressions: row.impressions, clicks: row.clicks, position: row.position }));
    if (rows.length) await upsert(query, rows);
    const got = (data?.text_indicator_to_statistics || []).length;
    pages += got;
    stored += rows.length;
    if (got < PAGE_LIMIT || offset + PAGE_LIMIT >= Number(data?.count || 0)) break;
  }
  return { pages, rows: stored };
}

/** Запросы каждой из страниц (по одному запросу к API на страницу): пары «страница — запрос» по дням. */
export async function collectPageQueries(query, call, paths, { concurrency = 4 } = {}) {
  let done = 0;
  let stored = 0;
  let failed = 0;
  let index = 0;
  const worker = async () => {
    while (index < paths.length) {
      const path = paths[index++];
      try {
        const data = await call({
          text_indicator: "QUERY", device_type_indicator: "ALL", limit: PAGE_LIMIT, offset: 0,
          filters: { text_filters: [{ text_indicator: "URL", operation: "TEXT_MATCH", value: path }] },
        });
        const rows = parseAnalytics(data).map((row) => ({ captured_on: row.date, url: path, query: row.key, impressions: row.impressions, clicks: row.clicks, position: row.position }));
        if (rows.length) await upsert(query, rows);
        stored += rows.length;
        done += 1;
      } catch (error) {
        failed += 1;
        // Лимит запросов или недоступность — дальше стучаться бессмысленно, остаток доберётся в следующий заход.
        if (/429|403|401/.test(String(error?.message))) index = paths.length;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { pages: paths.length, done, failed, rows: stored };
}

/** Страницы, для которых имеет смысл собирать запросы: с показами за последние дни, самые крупные первыми. */
export async function topPagePaths(query, limit = 400) {
  const rows = (await query(
    `SELECT url, sum(impressions)::int AS impressions FROM seo_page_stats
      WHERE query = '' AND captured_on > current_date - 30
      GROUP BY url HAVING sum(impressions) > 0 ORDER BY sum(impressions) DESC LIMIT $1`,
    [limit],
  )).rows;
  return rows.map((row) => row.url);
}
