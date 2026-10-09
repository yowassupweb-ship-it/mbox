// Недельное обновление позиций Topvisor. Раз в неделю просим Topvisor перепроверить позиции (это его платная операция,
// поэтому не чаще и без снимков выдачи), затем, когда проверка пройдёт, забираем свежие позиции и спрос.
// Здесь только решение «что делать сейчас» — без сети и БД, чтобы правило проверялось тестом.

export const CHECK_EVERY_MS = 6.9 * 86_400_000; // чуть меньше недели: сдвиг тика на десять минут не откладывает проверку на неделю
export const COLLECT_AFTER_MS = 20 * 60_000;    // раньше проверка вряд ли завершится: не дёргаем историю зря
export const GIVE_UP_AFTER_MS = 8 * 3_600_000;  // не пришла за восемь часов — отмечаем и ждём следующей недели
export const RETRY_AFTER_ERROR_MS = 86_400_000;

const MSK_OFFSET = 3 * 3_600_000;

/** Час по Москве: ночью не запускаем, чтобы проверка шла к утру. */
function mskHour(now) {
  return new Date(now.getTime() + MSK_OFFSET).getUTCHours();
}

/**
 * Что делать на этом тике. last — последняя строка seo_rank_checks ({ status, requested_at }) или null.
 * Возвращает "request" | "collect" | "give_up" | null.
 */
export function nextPositionsAction({ now = new Date(), last = null }) {
  const at = last ? Date.parse(String(last.requested_at).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")) : NaN;
  const age = Number.isFinite(at) ? now.getTime() - at : Infinity;
  if (last?.status === "requested") {
    if (age >= GIVE_UP_AFTER_MS) return "give_up";
    return age >= COLLECT_AFTER_MS ? "collect" : null;
  }
  if (mskHour(now) < 4) return null;
  if (!last) return "request";
  if (last.status === "error") return age >= RETRY_AFTER_ERROR_MS ? "request" : null;
  return age >= CHECK_EVERY_MS ? "request" : null;
}
