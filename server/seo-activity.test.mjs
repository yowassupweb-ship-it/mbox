import assert from "node:assert/strict";
import test from "node:test";
import { activityFeed, logActivity, watchdog } from "./seo-activity.mjs";

const NOW = new Date("2026-10-09T09:00:00Z"); // 12:00 МСК
const ids = (alerts) => alerts.map((item) => item.id);
const okRun = (at) => ({ started_at: at, status: "ok", scenario: "daily", sources: {} });

test("всё в порядке — тревог нет", () => {
  const alerts = watchdog({ now: NOW, autorun: true, tickAt: "2026-10-09T08:55:00Z", runs: [okRun("2026-10-09T01:30:00Z")], lastCheck: { status: "done", requested_at: "2026-10-05T05:00:00Z" }, ranksAt: "2026-10-05T12:00:00Z", jobs: { webmaster_page_queries: { last_at: "2026-10-06T05:00:00Z" } }, demand: { all: 200, todo: 0, last_at: "2026-10-09T08:00:00Z" } });
  assert.deepEqual(alerts, []);
});

test("автозапуск выключен — это главная тревога", () => {
  const alerts = watchdog({ now: NOW, autorun: false, runs: [okRun("2026-10-09T01:30:00Z")] });
  assert.deepEqual(ids(alerts), ["autorun_off"]);
  assert.equal(alerts[0].level, "high");
});

test("планировщик замолчал и ежедневный сбор не прошёл", () => {
  const alerts = watchdog({ now: NOW, autorun: true, tickAt: "2026-10-09T07:00:00Z", runs: [okRun("2026-10-07T01:30:00Z")] });
  assert.ok(ids(alerts).includes("scheduler_stalled"));
  assert.ok(ids(alerts).includes("daily_missed"));
  assert.match(alerts.find((item) => item.id === "daily_missed").text, /2 дня назад/);
  // ночью (до 08:00 МСК) пропуск ещё не пропуск
  const night = watchdog({ now: new Date("2026-10-09T02:00:00Z"), autorun: true, tickAt: "2026-10-09T01:58:00Z", runs: [okRun("2026-10-08T01:30:00Z")] });
  assert.ok(!ids(night).includes("daily_missed"));
});

test("упавший сбор и источники с ошибкой называются по именам", () => {
  const alerts = watchdog({ now: NOW, autorun: true, tickAt: "2026-10-09T08:59:00Z", runs: [{ started_at: "2026-10-09 06:00:00+00", status: "ok", scenario: "step1", sources: { topvisor_audit: { status: "error", error: "fetch failed (EAI_AGAIN)" }, metrica: { status: "ok" } } }, okRun("2026-10-08T01:30:00Z")] });
  const sources = alerts.find((item) => item.id === "source_errors");
  assert.match(sources.text, /Topvisor: fetch failed \(EAI_AGAIN\)/);
  assert.ok(!/Метрика/.test(sources.text));
  const failed = watchdog({ now: NOW, autorun: true, tickAt: "2026-10-09T08:59:00Z", runs: [{ started_at: "2026-10-09 06:00:00+00", status: "error", scenario: "step1", sources: {} }, okRun("2026-10-08T01:30:00Z")] });
  assert.ok(ids(failed).includes("last_run_failed"));
});

test("проверка позиций: ошибка заказа, зависшая, просроченная, устаревшие позиции", () => {
  const base = { now: NOW, autorun: true, tickAt: "2026-10-09T08:59:00Z", runs: [okRun("2026-10-09T01:30:00Z")] };
  assert.ok(ids(watchdog({ ...base, lastCheck: { status: "error", requested_at: "2026-10-09T05:00:00Z" } })).includes("positions_check_error"));
  assert.ok(ids(watchdog({ ...base, lastCheck: { status: "requested", requested_at: "2026-10-08T05:00:00Z" } })).includes("positions_check_stuck"));
  assert.ok(ids(watchdog({ ...base, lastCheck: { status: "done", requested_at: "2026-09-25T05:00:00Z" } })).includes("positions_check_overdue"));
  assert.ok(ids(watchdog({ ...base, ranksAt: "2026-08-03T12:00:00Z" })).includes("positions_stale"));
});

test("спрос Wordstat: тревога, только если сбор не движется", () => {
  const base = { now: NOW, autorun: true, tickAt: "2026-10-09T08:59:00Z", runs: [okRun("2026-10-09T01:30:00Z")] };
  assert.ok(ids(watchdog({ ...base, demand: { all: 200, todo: 50, last_at: "2026-10-09T03:00:00Z" } })).includes("demand_incomplete"));
  assert.ok(!ids(watchdog({ ...base, demand: { all: 200, todo: 50, last_at: "2026-10-09T08:00:00Z" } })).includes("demand_incomplete"));
});

test("лента объединяет действия, прогоны, пакеты и проверки; ошибка записи истории не ломает действие", async () => {
  const query = async (sql) => {
    if (/FROM seo_activity/.test(sql)) return { rows: [{ at: "2026-10-09 09:10:00+00", kind: "demand", title: "Спрос Wordstat", status: "skipped", detail: "квота", source: "scheduler" }] };
    if (/FROM seo_runs/.test(sql)) return { rows: [{ at: "2026-10-09 09:02:00+00", scenario: "step1", status: "ok", stats: { crawled_urls: 1725, issues_detected: 33 }, sources: { topvisor_audit: { status: "error" } } }] };
    if (/FROM seo_packages/.test(sql)) return { rows: [{ at: "2026-10-09 09:05:00+00", scenario: "monday", candidates: 30 }] };
    if (/FROM seo_rank_checks/.test(sql)) return { rows: [{ at: "2026-10-09 08:00:00+00", status: "done", error: "" }] };
    return { rows: [] };
  };
  const feed = await activityFeed(query);
  assert.deepEqual(feed.map((item) => item.kind), ["demand", "package", "run", "positions"]);
  assert.equal(feed[2].status, "partial");
  assert.match(feed[2].detail, /Не ответили: Topvisor/);
  await assert.doesNotReject(() => logActivity(async () => { throw new Error("нет таблицы"); }, { kind: "x", title: "y" }));
});
