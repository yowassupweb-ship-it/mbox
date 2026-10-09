// Сбор спроса из Wordstat (Yandex Search API) для отслеживаемых запросов. Частотность месячная, поэтому запрос
// спрашиваем один раз в календарный месяц: повторный прогон в том же месяце не тратит квоту.
import { demandFromTop, isStaleQuery } from "./seo-potential.mjs";

const ENDPOINT = "https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests";
const MAX_PER_RUN = 400;
const CONCURRENCY = 3;

export async function wordstatTop({ apiKey, folderId = "" }, phrase, fetchImpl = fetch) {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Api-Key ${apiKey}` },
    body: JSON.stringify({ phrase, numPhrases: 20, ...(folderId ? { folderId } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* не JSON */ }
  if (!response.ok) {
    throw Object.assign(new Error(`Wordstat ${response.status}: ${(data?.message || text).slice(0, 200)}`), { status: response.status });
  }
  return data;
}

/** Запросы для сбора: отслеживаемые в Topvisor, без устаревших (год в тексте) и без уже собранных в этом месяце. */
export async function wordstatTargets(query, month) {
  const list = (await query(
    `SELECT DISTINCT ON (query) query FROM seo_rank_snapshots ORDER BY query, captured_at DESC`,
  )).rows.map((row) => row.query).filter((text) => text && !isStaleQuery(text));
  if (!list.length) return { all: 0, todo: [] };
  const done = new Set((await query(
    "SELECT DISTINCT query FROM seo_demand_snapshots WHERE source = 'wordstat_api' AND month = $1 AND query = ANY($2::text[])",
    [month, list],
  )).rows.map((row) => row.query));
  return { all: list.length, todo: list.filter((text) => !done.has(text)) };
}

export async function collectWordstatDemand(query, auth, { fetchImpl = fetch, limit = MAX_PER_RUN, now = new Date() } = {}) {
  const month = now.toISOString().slice(0, 7);
  const { all, todo } = await wordstatTargets(query, month);
  const batch = todo.slice(0, limit);
  let saved = 0;
  let failed = 0;
  let stopped = "";
  let index = 0;
  const worker = async () => {
    while (index < batch.length && !stopped) {
      const phrase = batch[index++];
      try {
        const data = await wordstatTop(auth, phrase, fetchImpl);
        const { demand, basis, total } = demandFromTop(data, phrase);
        await query(
          "INSERT INTO seo_demand_snapshots(source, query, region, demand, month, raw) VALUES ('wordstat_api', $1, '', $2, $3, $4::jsonb)",
          [phrase, demand, month, JSON.stringify({ basis, total_count: total })],
        );
        saved += 1;
      } catch (error) {
        failed += 1;
        // Квота или недоступность — дальше стучаться бессмысленно: остаток доберётся следующим прогоном.
        if ([401, 403, 429, 503].includes(error.status)) stopped = error.message;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { month, tracked: all, already_collected: all - todo.length, requested: batch.length, saved, failed, left: Math.max(0, todo.length - saved), ...(stopped ? { stopped } : {}) };
}
