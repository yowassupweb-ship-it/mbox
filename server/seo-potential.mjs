// Потенциал запроса: сколько кликов в месяц он может дать, если поднять его в топ-3, и насколько это достижимо.
// Спрос — Wordstat (частотность за месяц), позиция — Topvisor (последняя проверка), CTR по позиции — наша же кривая
// из Вебмастера, а когда данных мало, запасная отраслевая. Чистые функции: данные приходят снаружи, БД здесь нет.

export const TARGET_POSITION = 3;

/** Запасная кривая «позиция → CTR», если своей статистики Вебмастера ещё нет. */
const FALLBACK_CTR = [0, 0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];

export function fallbackCtr(position) {
  const pos = Math.round(Number(position));
  if (!Number.isFinite(pos) || pos < 1) return 0.002;
  if (pos <= 10) return FALLBACK_CTR[pos];
  if (pos <= 20) return 0.008;
  if (pos <= 50) return 0.003;
  return 0.001;
}

/** Вероятность дотянуть до цели: чем дальше от топа, тем меньше. Нет позиции в проверке — считаем «дальше 50». */
export function reachability(position) {
  const pos = position === null || position === undefined ? NaN : Number(position);
  if (!Number.isFinite(pos) || pos > 50) return 0.05;
  if (pos <= TARGET_POSITION) return 1;
  if (pos <= 10) return 0.7;
  if (pos <= 20) return 0.4;
  return 0.15;
}

/** Уровни по ожидаемому приросту кликов в месяц. Пороги — константы, их можно подкрутить после первых данных. */
export function tierOf(expected) {
  if (expected >= 100) return "A";
  if (expected >= 30) return "B";
  if (expected >= 5) return "C";
  return "D";
}

export function isStaleQuery(text) {
  return /\b20(1\d|2[0-5])\b/.test(String(text || ""));
}

/**
 * Потенциал одного запроса.
 *  demand   — частотность в месяц (null: Wordstat ещё не собирался);
 *  position — позиция в последней проверке (null: не найден в проверенной глубине);
 *  ctr      — функция позиции → CTR (своя кривая), иначе запасная.
 * Возвращает clicks_now (сколько кликов получаем сейчас), clicks_target (в топ-3), gain (разница),
 * reach (достижимость 0..1), expected (gain × reach — по нему сортируем), tier и reason, когда посчитать нельзя.
 */
export function queryPotential({ query = "", demand, position, ctr }) {
  const curve = typeof ctr === "function" ? ctr : fallbackCtr;
  if (isStaleQuery(query)) return { tier: "—", reason: "устаревший запрос (год в тексте): мёртвый спрос", gain: 0, expected: 0 };
  if (demand === null || demand === undefined) return { tier: "—", reason: "нет данных о спросе (Wordstat не собран)", gain: null, expected: null };
  const d = Number(demand);
  if (!Number.isFinite(d) || d <= 0) return { tier: "D", reason: "спроса нет", clicks_now: 0, clicks_target: 0, gain: 0, reach: reachability(position), expected: 0 };
  const pos = position === null || position === undefined ? null : Number(position);
  const now = d * (pos === null ? 0 : Math.max(0, curve(Math.round(pos)) || fallbackCtr(pos)));
  const target = d * (curve(TARGET_POSITION) || fallbackCtr(TARGET_POSITION));
  const gain = Math.max(0, target - now);
  const reach = reachability(pos);
  const expected = gain * reach;
  return {
    tier: tierOf(expected),
    reason: pos !== null && pos <= TARGET_POSITION ? "уже в топ-3: держим позицию" : "",
    clicks_now: Math.round(now),
    clicks_target: Math.round(target),
    gain: Math.round(gain),
    reach,
    expected: Math.round(expected),
  };
}

export function normalizePhrase(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Ответ topRequests → частотность фразы. Точное совпадение, если есть в списке; иначе общая сумма (помечается basis). */
export function demandFromTop(data, phrase) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const wanted = normalizePhrase(phrase);
  const exact = results.find((item) => normalizePhrase(item?.phrase) === wanted);
  if (exact) return { demand: Number(exact.count) || 0, basis: "exact", total: Number(data?.totalCount) || 0 };
  return { demand: Number(data?.totalCount) || 0, basis: "total", total: Number(data?.totalCount) || 0 };
}
