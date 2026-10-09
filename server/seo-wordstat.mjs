// Сбор спроса из Wordstat (Yandex Search API) для отслеживаемых запросов. Частотность месячная, поэтому запрос
// спрашиваем один раз в календарный месяц: повторный прогон в том же месяце не тратит квоту.
import { demandFromTop, isStaleQuery } from "./seo-potential.mjs";

const ENDPOINT = "https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests";
// Квота Wordstat API — 100 запросов в час (search-api.wordstatRequestsPerHour): порция с запасом, остаток добирается следующими часами.
const MAX_PER_RUN = 90;
const CONCURRENCY = 3;
// Лимит Wordstat API — 10 запросов в секунду (search-api.wordstatRequestsPerSecond). Держим 8 с запасом и ждём,
// если всё же получили 429 по секундной квоте; суточная и прочие квоты останавливают сбор до следующего прогона.
const MIN_GAP_MS = 125;
const SECOND_LIMIT_RETRIES = 3;
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

export async function collectWordstatDemand(query, auth, { fetchImpl = fetch, limit = MAX_PER_RUN, now = new Date(), sleep = sleepFor, gapMs = MIN_GAP_MS } = {}) {
  const month = now.toISOString().slice(0, 7);
  const { all, todo } = await wordstatTargets(query, month);
  const batch = todo.slice(0, limit);
  let saved = 0;
  let failed = 0;
  let stopped = "";
  let index = 0;
  let nextSlot = 0;
  // Общий для потоков ритм: каждый запрос получает своё место не раньше gapMs после предыдущего.
  const takeSlot = async () => {
    const at = Math.max(Date.now(), nextSlot);
    nextSlot = at + gapMs;
    if (at > Date.now()) await sleep(at - Date.now());
  };
  const fetchTop = async (phrase) => {
    for (let attempt = 0; ; attempt += 1) {
      await takeSlot();
      try {
        return await wordstatTop(auth, phrase, fetchImpl);
      } catch (error) {
        const perSecond = error.status === 429 && /PerSecond/i.test(error.message);
        if (!perSecond || attempt >= SECOND_LIMIT_RETRIES) throw error;
        nextSlot = Math.max(nextSlot, Date.now() + 1100);
        await sleep(1100);
      }
    }
  };
  const worker = async () => {
    while (index < batch.length && !stopped) {
      const phrase = batch[index++];
      try {
        const data = await fetchTop(phrase);
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

// Следующий допустимый заход после упора в квоту. Хранится в памяти процесса: после перезапуска первый заход просто
// упрётся в квоту ещё раз и снова подождёт.
let blockedUntil = 0;

/**
 * Дособор спроса: вызывается тиком расписания. Пока есть нехватающие запросы текущего месяца, заходит раз в час порцией,
 * не мешая ручным запускам. Возвращает null, если делать нечего или ждём квоту.
 */
export async function topUpDemand(query, auth, { now = new Date(), fetchImpl, sleep } = {}) {
  if (now.getTime() < blockedUntil) return null;
  const month = now.toISOString().slice(0, 7);
  const { todo } = await wordstatTargets(query, month);
  if (!todo.length) return null;
  const result = await collectWordstatDemand(query, auth, { now, ...(fetchImpl ? { fetchImpl } : {}), ...(sleep ? { sleep } : {}) });
  if (result.stopped) blockedUntil = now.getTime() + (/PerHour/i.test(result.stopped) ? 61 * 60_000 : /PerSecond/i.test(result.stopped) ? 5 * 60_000 : 6 * 3_600_000);
  return result;
}

export function resetDemandBlock() { blockedUntil = 0; }
