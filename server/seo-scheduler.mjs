// Расписание SEO Wizard: раз в несколько минут проверяет, не пора ли собрать данные и пакет, и запускает сбор в фоне.
// Правила «что пора» — dueScenarios (seo-strategy.mjs), здесь только таймер и защита от наложения. По умолчанию
// выключено: сбор — это тысяча запросов к сайту, включается явно переменной SEO_AUTORUN=1 на сервере.
import { dueScenarios } from "./seo-strategy.mjs";
import { logActivity } from "./seo-activity.mjs";
import { demandTick, liveSeoRun, pageQueriesTick, positionsTick, startSeoRun } from "./seo-wizard.mjs";

const TICK_MS = Number(process.env.SEO_AUTORUN_TICK_MS || 10 * 60_000);
const state = { enabled: false, started_at: "", last_tick_at: "", last_start: null, last_error: "" };

export function seoSchedulerStatus() {
  return { ...state };
}

export function seoAutorunEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env.SEO_AUTORUN || "").toLowerCase());
}

async function tick(query, log) {
  state.last_tick_at = new Date().toISOString();
  // Позиции Topvisor: раз в неделю и независимо от дневного сбора: заказ проверки, ожидание, забор результата.
  const positions = await positionsTick(query);
  if (positions.action) {
    state.last_positions = { ...positions, at: new Date().toISOString() };
    // В историю идут итоги, а не каждое «ждём» раз в десять минут.
    if (positions.action === "request") await logActivity(query, positions.ok === false ? { kind: "positions", title: "Заказ проверки позиций не принят", status: "failed", detail: positions.error || "" } : { kind: "positions", title: "Заказана проверка позиций в Topvisor", detail: "Без платных снимков выдачи. Результат заберём через 20 минут." });
    else if (positions.action === "done") await logActivity(query, { kind: "positions", title: "Позиции Topvisor обновлены", detail: `Проверка от ${positions.last_check}` });
    else if (positions.action === "give_up") await logActivity(query, { kind: "positions", title: "Проверка позиций не завершилась за 8 часов", status: "failed" });
    else if (positions.action === "error") await logActivity(query, { kind: "positions", title: "Сбой при обновлении позиций", status: "failed", detail: positions.error || "" });
    log(`[seo-scheduler] позиции: ${positions.action}${positions.error ? ` — ${positions.error}` : ""}${positions.last_check ? ` (проверка от ${positions.last_check})` : ""}`);
  }
  // Запросы страниц из Вебмастера: раз в неделю, у самых крупных страниц (API хранит две недели, история копится у нас).
  const pages = await pageQueriesTick(query);
  if (pages) await logActivity(query, pages.error ? { kind: "page_queries", title: "Запросы страниц из Вебмастера: ошибка", status: "failed", detail: pages.error } : { kind: "page_queries", title: "Запросы страниц из Вебмастера собраны", status: pages.failed ? "partial" : "ok", detail: `Страниц ${pages.done} из ${pages.pages}, строк ${pages.rows}${pages.failed ? `, ошибок ${pages.failed}` : ""}` });
  if (pages) log(`[seo-scheduler] запросы страниц Вебмастера: ${pages.error ? `ошибка ${pages.error}` : `страниц ${pages.done}/${pages.pages}, строк ${pages.rows}, ошибок ${pages.failed}`}`);
  const demand = await demandTick(query);
  if (demand && (demand.saved || demand.stopped || demand.error)) await logActivity(query, demand.error ? { kind: "demand", title: "Спрос Wordstat: ошибка", status: "failed", detail: demand.error } : { kind: "demand", title: demand.stopped ? "Спрос Wordstat: упёрлись в квоту, добор через час" : "Спрос Wordstat собран порцией", status: demand.stopped ? "skipped" : "ok", detail: `Собрано ${demand.saved ?? 0}, осталось ${demand.left ?? "?"}${demand.stopped ? `. ${demand.stopped}` : ""}` });
  if (demand) log(`[seo-scheduler] спрос Wordstat: собрано ${demand.saved ?? 0}, осталось ${demand.left ?? "?"}${demand.stopped ? `, стоп: ${demand.stopped}` : ""}${demand.error ? `, ошибка: ${demand.error}` : ""}`);
  if (liveSeoRun()) return;
  try {
    const packages = (await query("SELECT DISTINCT ON (scenario) scenario, created_at::text AS at FROM seo_packages ORDER BY scenario, created_at DESC")).rows;
    const lastRun = (await query("SELECT max(started_at)::text AS at FROM seo_runs WHERE status = 'ok'")).rows[0]?.at || null;
    const due = dueScenarios({ now: new Date(), lastAt: Object.fromEntries(packages.map((item) => [item.scenario, item.at])), lastRunAt: lastRun });
    if (!due.length) return;
    const scenario = due[0];
    // daily — только сбор и детекторы без пакета: пакеты недели и месяца собираются своими сценариями.
    const started = await startSeoRun(query, { scenario, buildPackage: scenario !== "daily" });
    state.last_start = { scenario, run_id: started.run_id, at: new Date().toISOString() };
    state.last_error = "";
    log(`[seo-scheduler] запущен сбор «${scenario}» (прогон ${started.run_id})`);
    await logActivity(query, { kind: "run", title: `Запущен сбор «${scenario}» по расписанию`, detail: `Прогон ${started.run_id}` });
  } catch (error) {
    state.last_error = error instanceof Error ? error.message : String(error);
    log(`[seo-scheduler] ${state.last_error}`);
    await logActivity(query, { kind: "run", title: "Не удалось запустить сбор по расписанию", status: "failed", detail: state.last_error });
  }
}

/** Запустить расписание. Возвращает остановщик; без SEO_AUTORUN=1 ничего не делает. */
export function startSeoScheduler({ query, log = console.log, env = process.env } = {}) {
  if (!seoAutorunEnabled(env)) return () => {};
  state.enabled = true;
  state.started_at = new Date().toISOString();
  const safeTick = () => tick(query, log).catch((error) => { state.last_error = error instanceof Error ? error.message : String(error); log(`[seo-scheduler] тик упал: ${state.last_error}`); });
  const first = setTimeout(() => void safeTick(), 2 * 60_000);
  const timer = setInterval(() => void safeTick(), TICK_MS);
  first.unref?.();
  timer.unref?.();
  log(`[seo-scheduler] расписание включено, проверка каждые ${Math.round(TICK_MS / 60_000)} мин`);
  return () => { clearTimeout(first); clearInterval(timer); state.enabled = false; };
}
