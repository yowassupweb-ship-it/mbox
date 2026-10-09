// Статистика позиций по проверкам Topvisor: динамика по датам, кто вырос/упал/вошёл в топ/выпал, срез по разделам сайта,
// запросы, у которых «гуляет» страница. Чистые функции над снимками {query, url, position, date}: БД здесь нет.

const BUCKETS = [["top3", 3], ["top10", 10], ["top20", 20], ["top50", 50]];

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);

/** Снимки → { date: Map(query → { position, url }) }, даты по возрастанию. Позиция null — запроса нет в проверенной глубине. */
export function groupByDate(snapshots) {
  const byDate = new Map();
  for (const item of snapshots) {
    const date = String(item.date || "").slice(0, 10);
    if (!date || !item.query) continue;
    if (!byDate.has(date)) byDate.set(date, new Map());
    const position = item.position === null || item.position === undefined ? null : Number(item.position);
    byDate.get(date).set(item.query, { position: Number.isFinite(position) ? position : null, url: item.url || "" });
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Динамика по проверкам. weight(query, position) — необязательно: ожидаемые клики запроса на этой позиции
 * (спрос × CTR); сумма по запросам даёт «видимость» — единое число, которое растёт, когда запросы поднимаются.
 */
export function trendByCheck(grouped, weight) {
  return grouped.map(([date, map]) => {
    const found = [...map.entries()].filter(([, value]) => value.position !== null);
    const positions = found.map(([, value]) => value.position);
    const row = { date, tracked: map.size, found: found.length, avg_position: round1(positions.length ? positions.reduce((s, v) => s + v, 0) / positions.length : null), median_position: round1(median(positions)) };
    for (const [key, limit] of BUCKETS) row[key] = positions.filter((position) => position <= limit).length;
    if (typeof weight === "function") row.visibility = Math.round([...map.entries()].reduce((sum, [query, value]) => sum + (weight(query, value.position) || 0), 0));
    return row;
  });
}

/** Что изменилось между двумя последними проверками. threshold — минимальный сдвиг, считающийся «ростом/падением». */
export function movers(grouped, { threshold = 3, limit = 100 } = {}) {
  if (grouped.length < 2) return { from: null, to: grouped[0]?.[0] || null, rows: [], counts: {} };
  const [fromDate, before] = grouped[grouped.length - 2];
  const [toDate, after] = grouped[grouped.length - 1];
  const rows = [];
  const counts = { up: 0, down: 0, entered_top10: 0, left_top10: 0, entered_top3: 0, left_top3: 0, lost: 0, appeared: 0 };
  for (const [query, now] of after) {
    const prev = before.get(query);
    if (!prev) continue;
    const a = prev.position;
    const b = now.position;
    let kind = "";
    if (a !== null && b === null) kind = "lost";
    else if (a === null && b !== null) kind = "appeared";
    else if (a !== null && b !== null) {
      if (a - b >= threshold) kind = "up";
      else if (b - a >= threshold) kind = "down";
    }
    if (a !== null && b !== null) {
      if (a > 10 && b <= 10) counts.entered_top10 += 1;
      if (a <= 10 && b > 10) counts.left_top10 += 1;
      if (a > 3 && b <= 3) counts.entered_top3 += 1;
      if (a <= 3 && b > 3) counts.left_top3 += 1;
    }
    if (!kind) continue;
    counts[kind] += 1;
    rows.push({ query, kind, from: a, to: b, delta: a !== null && b !== null ? a - b : null, url: now.url || prev.url });
  }
  const weightOf = (row) => Math.abs(row.delta ?? 60);
  rows.sort((x, y) => weightOf(y) - weightOf(x));
  return { from: fromDate, to: toDate, rows: rows.slice(0, limit), counts };
}

/** Срез по разделам сайта (первый сегмент адреса) по последней проверке. */
export function bySection(grouped, sectionOf) {
  if (!grouped.length) return [];
  const [, map] = grouped[grouped.length - 1];
  const sections = new Map();
  for (const [, value] of map) {
    const name = value.url ? sectionOf(value.url) || "корень" : "без страницы";
    const entry = sections.get(name) || { section: name, queries: 0, positions: [] };
    entry.queries += 1;
    if (value.position !== null) entry.positions.push(value.position);
    sections.set(name, entry);
  }
  return [...sections.values()].map((entry) => ({
    section: entry.section,
    queries: entry.queries,
    found: entry.positions.length,
    avg_position: round1(entry.positions.length ? entry.positions.reduce((s, v) => s + v, 0) / entry.positions.length : null),
    top10: entry.positions.filter((position) => position <= 10).length,
    top10_share: entry.positions.length ? Math.round((entry.positions.filter((position) => position <= 10).length / entry.positions.length) * 100) : null,
  })).sort((a, b) => b.queries - a.queries);
}

/** Запросы, у которых за проверки менялась ранжируемая страница: каннибализация или нестабильная выдача. */
export function urlFlapping(grouped, { limit = 100 } = {}) {
  const urls = new Map();
  for (const [date, map] of grouped) {
    for (const [query, value] of map) {
      if (!value.url) continue;
      const list = urls.get(query) || [];
      if (!list.length || list[list.length - 1].url !== value.url) list.push({ url: value.url, date });
      urls.set(query, list);
    }
  }
  return [...urls.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([query, list]) => ({ query, changes: list.length - 1, urls: list.map((item) => item.url), last_change: list[list.length - 1].date }))
    .sort((a, b) => b.changes - a.changes || b.last_change.localeCompare(a.last_change))
    .slice(0, limit);
}
