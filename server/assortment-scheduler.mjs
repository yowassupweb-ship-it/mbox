// Ежедневное обновление каталога для «Ассортимента»: после 05:00 по Москве, если снимка за сегодня ещё нет.
// ASSORTMENT_AUTORUN=0 отключает (по умолчанию включено). Неудача не страшна: повтор не чаще раза в 30 минут,
// а экран честно показывает время последнего удачного снимка.
import { maybeLearn, moscowDay, refreshSnapshot } from "./assortment-store.mjs";

const TICK_MS = 10 * 60_000;
const RETRY_MS = 30 * 60_000;

export async function runDailyTick(query, { now = new Date(), lastAttempt = 0, log = console.log } = {}) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Moscow", hour: "2-digit", hour12: false }).format(now));
  if (hour < 5) return { attempted: false };
  const today = moscowDay(now);
  const have = (await query("SELECT 1 FROM assortment_snapshots WHERE day = $1", [today])).rows.length > 0;
  if (have || now.getTime() - lastAttempt < RETRY_MS) return { attempted: false };
  try {
    const result = await refreshSnapshot(query, { now });
    log(`assortment: каталог обновлён, ${result.tours} туров`);
    await maybeLearn(query).catch((error) => log(`assortment learn: ${error.message}`));
    return { attempted: true, ok: true, ...result };
  } catch (error) {
    log(`assortment: обновление не удалось: ${error.message}`);
    return { attempted: true, ok: false, error: error.message };
  }
}

export function startAssortmentScheduler({ query, log = console.log, env = process.env } = {}) {
  if (String(env.ASSORTMENT_AUTORUN ?? "1") === "0") return null;
  let last = 0;
  const tick = async () => {
    try {
      const r = await runDailyTick(query, { lastAttempt: last, log });
      if (r.attempted) last = Date.now();
    } catch (error) { log(`assortment scheduler: ${error.message}`); }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.();
  return timer;
}
