import assert from "node:assert/strict";
import test from "node:test";
import { seoView } from "./seo-views.mjs";
import { watchdog } from "./seo-activity.mjs";

const snapshot = {
  day: "2026-10-09",
  data: {
    in_search_count: 4, link_count: 13242,
    summary: { sqi: 1570, excluded_pages_count: 3345, searchable_pages_count: 11245 },
    diagnostics: { problems: { INSIGNIFICANT_CGI_PARAMETER: { severity: "RECOMMENDATION", state: "PRESENT", last_state_update: "2026-10-08T10:00:39.000+03:00" } } },
    quota: { daily_quota: 1280, quota_remainder: 1280 },
    indexing: { indicators: { HTTP_4XX: [{ date: "2026-10-01T05:00:00.000+03:00", value: 150 }], HTTP_5XX: [{ date: "2026-10-01T05:00:00.000+03:00", value: 9 }] } },
    indexed_history: { history: [{ date: "2026-09-20T10:00:00.000+03:00", value: 13534 }, { date: "2026-10-07T10:00:00.000+03:00", value: 11245 }] },
    important: { urls: [{ url: "https://vs-travel.ru/podbor-tura/ples", indexing_status: { http_code: 200, access_date: "2026-10-07" }, search_status: { searchable: false, excluded_url_status: "NO_INDEX", title: "Плес" } }] },
    links_history: { indicators: { LINKS_TOTAL_COUNT: [{ date: "2026-10-01T00:00:00.000+03:00", value: 13000 }] } },
    link_samples: [{ source_url: "https://soboly.com/a", destination_url: "https://vs-travel.ru/old.php" }],
  },
};

function fakeQuery() {
  return async (sql) => {
    if (/FROM seo_yandex_snapshots/.test(sql)) return { rows: [snapshot] };
    if (/FROM seo_urls/.test(sql)) return { rows: [{ path: "/", in_sitemap: true, status_code: 200 }, { path: "/odnodnevnye", in_sitemap: true, status_code: 200 }] };
    if (/FROM seo_yandex_pages/.test(sql)) return { rows: [
      { path: "/", url: "https://vs-travel.ru/", title: "Главная", last_access: "2026-10-09" },
      { path: "/tour?id=2157", url: "https://vs-travel.ru/tour?id=2157", title: "Тур", last_access: "2026-10-09" },
      { path: "/podbor-tura?TopFilter_topic=216", url: "https://vs-travel.ru/podbor-tura?TopFilter_topic=216", title: "Фильтр", last_access: "2026-10-08" },
      { path: "/old.php", url: "https://vs-travel.ru/old.php", title: "Старая", last_access: "2026-10-01" },
    ] };
    return { rows: [] };
  };
}

test("«Яндекс видит»: сводка, типы страниц, не в sitemap, ошибки, ссылки и важные страницы собираются из снимка", async () => {
  const view = await seoView(fakeQuery(), "yandex", {});
  const byId = Object.fromEntries(view.sections.map((section) => [section.id, section]));
  assert.deepEqual(Object.keys(byId), ["yandex_summary", "yandex_problems", "yandex_kinds", "yandex_outside", "yandex_errors", "yandex_links", "yandex_important", "yandex_trend"]);
  const summary = byId.yandex_summary.rows;
  assert.equal(summary[0].value, 4);
  assert.match(summary[0].detail, /минус 16\.9%/);
  assert.equal(summary.find((row) => row.label.startsWith("В поиске, но не в sitemap")).value, 3);
  assert.equal(byId.yandex_problems.rows[0].title, "Незначимые параметры в адресах");
  assert.deepEqual(byId.yandex_kinds.rows.map((row) => row.kind).sort(), ["in_sitemap", "legacy", "param", "tour_outside"]);
  assert.equal(byId.yandex_outside.rows.length, 3);
  assert.equal(byId.yandex_errors.rows[0].errors, 159);
  assert.equal(byId.yandex_links.rows[0].state, "legacy");
  assert.match(byId.yandex_links.rows[0].advice, /301/);
  assert.equal(byId.yandex_important.rows[0].problem, "исключена: NO_INDEX");
});

test("без снимка все таблицы пустые и говорят, как получить данные", async () => {
  const view = await seoView(async () => ({ rows: [] }), "yandex", {});
  assert.equal(view.sections.length, 8);
  assert.match(view.sections[0].empty, /раз в неделю/);
});

test("сторож: индекс Яндекса сократился на 15% и больше — тревога; недельный сбор просрочен — тревога", () => {
  const now = new Date("2026-10-09T09:00:00Z");
  const base = { now, autorun: true, tickAt: "2026-10-09T08:58:00Z", runs: [{ started_at: "2026-10-09T01:30:00Z", status: "ok", scenario: "daily", sources: {} }] };
  const drop = watchdog({ ...base, indexDrop: { last: { date: "2026-10-07", value: 11245 }, peak: { date: "2026-09-20", value: 13534 }, drop_from_peak_pct: 16.9 } });
  assert.ok(drop.some((item) => item.id === "index_shrinking" && /16\.9%/.test(item.text)));
  assert.ok(!watchdog({ ...base, indexDrop: { last: { date: "x", value: 95 }, peak: { date: "y", value: 100 }, drop_from_peak_pct: 5 } }).some((item) => item.id === "index_shrinking"));
  const stale = watchdog({ ...base, jobs: { webmaster_yandex_view: { last_at: "2026-09-25T05:00:00Z" } } });
  assert.ok(stale.some((item) => item.id === "yandex_stale"));
});
