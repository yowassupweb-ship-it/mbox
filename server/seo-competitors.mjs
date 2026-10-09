// Конкуренты из Topvisor: позиции доменов по нашим запросам и расчёты поверх них — кто сильнее, где нас обходят,
// кто поднялся, какие страницы конкурентов стоит изучить. Данные Topvisor отдаёт по ключам «дата:id_проекта:индекс_региона»,
// конкуренты — те же ключи с их id. Чистые функции: база и сеть снаружи.

const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const round = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits);

/** Ключ ячейки истории Topvisor → { day, projectId, region }. Битый ключ — null. */
export function splitCell(key) {
  const [day, projectId, region] = String(key).split(":");
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && projectId ? { day, projectId, region: region ?? "" } : null;
}

const toPosition = (raw) => {
  if (raw === undefined || raw === null || raw === "" || raw === "--") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** Позиции конкурентов из ответа history: строки { day, competitor_id, query, position, url }. Свой проект пропускается. */
export function parseCompetitorCells(keywords, { ownProjectId, competitorIds, regionIndex }) {
  const wanted = new Set(competitorIds.map(String));
  const rows = [];
  for (const keyword of keywords || []) {
    const query = String(keyword?.name || "").trim();
    if (!query) continue;
    for (const [key, cell] of Object.entries(keyword.positionsData || {})) {
      const parts = splitCell(key);
      if (!parts || parts.projectId === String(ownProjectId) || !wanted.has(parts.projectId)) continue;
      if (regionIndex !== undefined && parts.region !== "" && String(parts.region) !== String(regionIndex)) continue;
      rows.push({ day: parts.day, competitor_id: parts.projectId, query, position: toPosition(cell?.position), url: String(cell?.relevant_url || "") });
    }
  }
  return rows;
}

/** Позиции в удобную структуру: date → domain → query → { position, url }. rows: { date, domain, query, position, url }. */
export function buildBoard(rows) {
  const byDate = new Map();
  const domains = new Set();
  for (const row of rows) {
    if (!row.date || !row.domain || !row.query) continue;
    domains.add(row.domain);
    if (!byDate.has(row.date)) byDate.set(row.date, new Map());
    const day = byDate.get(row.date);
    if (!day.has(row.domain)) day.set(row.domain, new Map());
    day.get(row.domain).set(row.query, { position: row.position === null || row.position === undefined ? null : num(row.position), url: row.url || "" });
  }
  return { dates: [...byDate.keys()].sort(), domains: [...domains], byDate };
}

const BUCKETS = [["top3", 3], ["top10", 10], ["top20", 20]];

/** Показатели домена на одну дату. weight(query, position) — ожидаемые клики: из них складывается «видимость». */
export function domainStats(board, date, domain, weight) {
  const map = board.byDate.get(date)?.get(domain);
  if (!map) return null;
  const found = [...map.values()].filter((item) => item.position !== null);
  const stats = { tracked: map.size, found: found.length, avg_position: round(found.length ? found.reduce((s, i) => s + i.position, 0) / found.length : null) };
  for (const [key, limit] of BUCKETS) stats[key] = found.filter((item) => item.position <= limit).length;
  stats.visibility = typeof weight === "function" ? Math.round([...map.entries()].reduce((sum, [query, item]) => sum + (item.position === null ? 0 : weight(query, item.position) || 0), 0)) : null;
  return stats;
}

/**
 * Сводка «кто сильнее»: по каждому домену последняя проверка, сдвиг к предыдущей и доля голоса среди всех доменов.
 * Домен без данных на последней дате получает stale — по нему Topvisor перестал проверять (слежение выключено).
 */
export function summary(board, ours, weight) {
  const dates = board.dates;
  const last = dates[dates.length - 1];
  const prev = dates[dates.length - 2];
  const list = board.domains.map((domain) => {
    const now = domainStats(board, last, domain, weight);
    const before = prev ? domainStats(board, prev, domain, weight) : null;
    let lastSeen = null;
    for (let i = dates.length - 1; i >= 0; i -= 1) if (board.byDate.get(dates[i])?.has(domain)) { lastSeen = dates[i]; break; }
    return { domain, is_ours: domain === ours, last_seen: lastSeen, stale: !now, now, before };
  });
  const totalVisibility = list.reduce((sum, item) => sum + num(item.now?.visibility), 0);
  return list
    .map((item) => ({
      ...item,
      share: totalVisibility && item.now?.visibility !== null && item.now ? round((num(item.now.visibility) / totalVisibility) * 100, 1) : null,
      delta_top10: item.now && item.before ? item.now.top10 - item.before.top10 : null,
      delta_visibility: item.now && item.before && item.now.visibility !== null ? item.now.visibility - num(item.before.visibility) : null,
    }))
    .sort((a, b) => num(b.now?.visibility) - num(a.now?.visibility) || num(b.now?.top10) - num(a.now?.top10));
}

/** Динамика по проверкам: для каждой даты число запросов в топ-10 у каждого домена. */
export function trendMatrix(board, weight) {
  return board.dates.map((date) => ({ date, cells: Object.fromEntries(board.domains.map((domain) => { const s = domainStats(board, date, domain, weight); return [domain, s ? { top10: s.top10, top3: s.top3, visibility: s.visibility } : null]; })) }));
}

const bestRival = (board, date, ours, query) => {
  let best = null;
  let ahead = 0;
  const own = board.byDate.get(date)?.get(ours)?.get(query)?.position ?? null;
  for (const [domain, map] of board.byDate.get(date) || []) {
    if (domain === ours) continue;
    const item = map.get(query);
    if (!item || item.position === null) continue;
    if (!best || item.position < best.position) best = { domain, position: item.position, url: item.url };
    if (own === null || item.position < own) ahead += 1;
  }
  return { best, ahead, own };
};

/**
 * Где нас обходят: запросы, по которым лучший конкурент выше нас (или нас нет в проверенной глубине, а он есть).
 * demandBy: Map(query → спрос), ctr: позиция → CTR. Потеря = спрос × (CTR конкурента − наш CTR); без спроса сортировка по разрыву.
 */
export function gaps(board, ours, { demandBy = new Map(), ctr = () => 0, limit = 200 } = {}) {
  const date = board.dates[board.dates.length - 1];
  const queries = [...(board.byDate.get(date)?.get(ours)?.keys() || [])];
  const out = [];
  for (const query of queries) {
    const { best, ahead, own } = bestRival(board, date, ours, query);
    if (!best || (own !== null && best.position >= own)) continue;
    const demand = demandBy.has(query) ? num(demandBy.get(query)) : null;
    const lost = demand === null ? null : Math.max(0, Math.round(demand * (ctr(best.position) - (own === null ? 0 : ctr(own)))));
    out.push({ query, demand, ours: own, rival: best.domain, rival_position: best.position, rival_url: best.url, gap: own === null ? null : own - best.position, rivals_ahead: ahead, lost });
  }
  return out.sort((a, b) => (num(b.lost) - num(a.lost)) || (num(b.gap ?? 100) - num(a.gap ?? 100)) || (num(b.demand) - num(a.demand))).slice(0, limit);
}

/** Где мы впереди всех конкурентов: запросы, которые надо защищать. */
export function wins(board, ours, { demandBy = new Map(), limit = 200 } = {}) {
  const date = board.dates[board.dates.length - 1];
  const out = [];
  for (const query of board.byDate.get(date)?.get(ours)?.keys() || []) {
    const { best, own } = bestRival(board, date, ours, query);
    if (own === null || own > 10 || (best && best.position <= own)) continue;
    out.push({ query, demand: demandBy.has(query) ? num(demandBy.get(query)) : null, ours: own, rival: best?.domain || "", rival_position: best?.position ?? null });
  }
  return out.sort((a, b) => num(b.demand) - num(a.demand) || a.ours - b.ours).slice(0, limit);
}

/** Кто из конкурентов поднялся (или упал) между двумя последними проверками: сдвиг от threshold позиций или вход/выход из топ-10. */
export function rivalMovers(board, ours, { threshold = 5, limit = 200 } = {}) {
  if (board.dates.length < 2) return { from: null, to: board.dates[0] || null, rows: [] };
  const to = board.dates[board.dates.length - 1];
  const from = board.dates[board.dates.length - 2];
  const rows = [];
  for (const [domain, nowMap] of board.byDate.get(to) || []) {
    if (domain === ours) continue;
    const beforeMap = board.byDate.get(from)?.get(domain);
    if (!beforeMap) continue;
    for (const [query, now] of nowMap) {
      const before = beforeMap.get(query);
      if (!before) continue;
      const a = before.position;
      const b = now.position;
      let kind = "";
      if (b !== null && (a === null || a - b >= threshold || (a > 10 && b <= 10))) kind = "поднялся";
      else if (a !== null && (b === null || b - a >= threshold || (a <= 10 && b > 10))) kind = "упал";
      if (!kind) continue;
      const mine = board.byDate.get(to)?.get(ours)?.get(query)?.position ?? null;
      rows.push({ domain, query, kind, from: a, to: b, delta: a !== null && b !== null ? a - b : null, ours: mine, url: now.url || before.url });
    }
  }
  const weight = (row) => Math.abs(row.delta ?? 60) + (row.to !== null && row.to <= 10 ? 10 : 0);
  return { from, to, rows: rows.sort((x, y) => weight(y) - weight(x)).slice(0, limit) };
}

/** Страницы конкурентов, которые держат много наших запросов в топ-10: их стоит изучить. */
export function rivalPages(board, ours, { limit = 150 } = {}) {
  const date = board.dates[board.dates.length - 1];
  const pages = new Map();
  for (const [domain, map] of board.byDate.get(date) || []) {
    if (domain === ours) continue;
    for (const [query, item] of map) {
      if (item.position === null || item.position > 10 || !item.url) continue;
      const key = `${domain}|${item.url}`;
      const entry = pages.get(key) || { domain, url: item.url, queries: 0, top3: 0, best_query: query, best_position: item.position, examples: [] };
      entry.queries += 1;
      if (item.position <= 3) entry.top3 += 1;
      if (item.position < entry.best_position) { entry.best_query = query; entry.best_position = item.position; }
      if (entry.examples.length < 5) entry.examples.push(query);
      pages.set(key, entry);
    }
  }
  return [...pages.values()].sort((a, b) => b.queries - a.queries || b.top3 - a.top3).slice(0, limit);
}

/**
 * Наши позиции из ответа history: строки { captured_at, query, url, position, raw }. Берутся только ячейки своего проекта.
 * Ответ с competitors_ids содержит одних конкурентов: для него результат пуст, и вызывающий не должен стирать старые позиции.
 */
export function parseOwnCells(keywords, { ownProjectId }) {
  const rows = [];
  for (const keyword of keywords || []) {
    const query = String(keyword?.name || "").trim();
    if (!query) continue;
    for (const [key, cell] of Object.entries(keyword.positionsData || {})) {
      const parts = splitCell(key);
      if (!parts || parts.projectId !== String(ownProjectId)) continue;
      rows.push({ captured_at: `${parts.day}T12:00:00Z`, query, url: String(cell?.relevant_url || ""), position: toPosition(cell?.position), raw: { keyword_id: keyword.id, cell } });
    }
  }
  return rows;
}
