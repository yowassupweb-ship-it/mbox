import assert from "node:assert/strict";
import test from "node:test";
import { classifyIndexed, withoutTracking, indexTrend, indexingRows, kindAdvice, linkTargets, pathKey, presentProblems, summarizeIndexed } from "./seo-yandex.mjs";

const sitemap = new Set(["/", "/odnodnevnye", "/tour?id=1", "/podbor-tura/novyy-god"]);

test("ключ адреса: без хоста, www и завершающего слэша; параметры остаются", () => {
  assert.equal(pathKey("https://www.vs-travel.ru/odnodnevnye/"), "/odnodnevnye");
  assert.equal(pathKey("https://vs-travel.ru/tour?id=5"), "/tour?id=5");
  assert.equal(pathKey("https://vs-travel.ru/"), "/");
  assert.equal(pathKey(""), "");
});

test("типы страниц из индекса относительно sitemap", () => {
  assert.equal(classifyIndexed("https://vs-travel.ru/odnodnevnye/", sitemap), "in_sitemap");
  assert.equal(classifyIndexed("https://vs-travel.ru/tour?id=1", sitemap), "in_sitemap");
  assert.equal(classifyIndexed("https://vs-travel.ru/tour?id=2157", sitemap), "tour_outside");
  assert.equal(classifyIndexed("https://vs-travel.ru/podbor-tura?TopFilter_topic=216", sitemap), "param");
  assert.equal(classifyIndexed("https://vs-travel.ru/tours2_list.php", sitemap), "legacy");
  assert.equal(classifyIndexed("https://vs-travel.ru/lk/profile", sitemap), "technical");
  assert.equal(classifyIndexed("https://vs-travel.ru/news/x", sitemap), "other");
  assert.match(kindAdvice("legacy"), /301/);
});

test("сводка по выборке: счёт, доля и примеры, самые частые первыми", () => {
  const pages = [
    { url: "https://vs-travel.ru/tour?id=10" }, { url: "https://vs-travel.ru/tour?id=11" }, { url: "https://vs-travel.ru/tour?id=12" },
    { url: "https://vs-travel.ru/odnodnevnye" }, { url: "https://vs-travel.ru/a.php" },
  ];
  const out = summarizeIndexed(pages, sitemap);
  assert.deepEqual(out.map((item) => [item.kind, item.count]), [["tour_outside", 3], ["in_sitemap", 1], ["legacy", 1]]);
  assert.equal(out[0].share, 60);
  assert.deepEqual(out[0].examples, ["/tour?id=10", "/tour?id=11", "/tour?id=12"]);
});

test("диагностика: только присутствующие проблемы, по важности, с понятным названием", () => {
  const out = presentProblems({ problems: {
    INSIGNIFICANT_CGI_PARAMETER: { severity: "RECOMMENDATION", state: "PRESENT", last_state_update: "2026-10-08T10:00:39.000+03:00" },
    DNS_ERROR: { severity: "FATAL", state: "ABSENT" },
    SLOW_AVG_RESPONSE_TIME: { severity: "POSSIBLE_PROBLEM", state: "PRESENT" },
    UNKNOWN_NEW: { severity: "CRITICAL", state: "PRESENT" },
  } });
  assert.deepEqual(out.map((item) => item.code), ["UNKNOWN_NEW", "SLOW_AVG_RESPONSE_TIME", "INSIGNIFICANT_CGI_PARAMETER"]);
  assert.equal(out[2].title, "Незначимые параметры в адресах");
  assert.equal(out[2].since, "2026-10-08");
  assert.match(out[0].text, /Диагностика/);
});

test("история индексации: строки по дням, ошибки 4xx и 5xx суммируются", () => {
  const rows = indexingRows({ indicators: { HTTP_2XX: [{ date: "2026-10-01T05:00:00.000+03:00", value: 900 }, { date: "2026-10-02T05:00:00.000+03:00", value: 910 }], HTTP_4XX: [{ date: "2026-10-01T05:00:00.000+03:00", value: 150 }, { date: "2026-10-02T05:00:00.000+03:00", value: 300 }], HTTP_5XX: [{ date: "2026-10-02T05:00:00.000+03:00", value: 8 }] } });
  assert.deepEqual(rows.map((row) => [row.date, row.errors]), [["2026-10-02", 308], ["2026-10-01", 150]]);
});

test("динамика индекса: падение от максимума и сравнение с неделей назад", () => {
  const trend = indexTrend({ history: [
    { date: "2026-09-20T10:00:00.000+03:00", value: 13534 }, { date: "2026-09-28T10:00:00.000+03:00", value: 12272 }, { date: "2026-10-05T10:20:00.000+03:00", value: 11368 }, { date: "2026-10-07T10:00:00.000+03:00", value: 11245 },
  ] });
  assert.equal(trend.last.value, 11245);
  assert.equal(trend.peak.value, 13534);
  assert.equal(trend.drop_from_peak_pct, 16.9);
  assert.equal(trend.week_ago.date, "2026-09-28");
  assert.equal(indexTrend({}), null);
});

test("внешние ссылки: назначения, домены и состояние страниц", () => {
  const registry = new Map([["/odnodnevnye", { status_code: 200 }], ["/gone", { status_code: 404 }]]);
  const out = linkTargets([
    { source_url: "https://soboly.com/a", destination_url: "https://vs-travel.ru/ekskursii.php" },
    { source_url: "https://www.soboly.com/b", destination_url: "https://vs-travel.ru/ekskursii.php" },
    { source_url: "https://x.ru/c", destination_url: "https://vs-travel.ru/odnodnevnye" },
    { source_url: "https://y.ru/d", destination_url: "https://vs-travel.ru/gone" },
    { source_url: "https://z.ru/e", destination_url: "https://vs-travel.ru/new-page" },
  ], registry);
  assert.deepEqual(out.map((item) => [item.path, item.links, item.state]), [["/ekskursii.php", 2, "legacy"], ["/odnodnevnye", 1, "ok"], ["/gone", 1, "broken"], ["/new-page", 1, "unknown"]]);
  assert.equal(out[0].domains, 1, "www и без www — один домен");
});

test("параметр — часть адреса: /tour в sitemap не делает /tour?id=N «страницей из sitemap», а рекламные метки отбрасываются", () => {
  const map = new Set(["/tour", "/odnodnevnye"]);
  assert.equal(classifyIndexed("https://vs-travel.ru/tour?id=2157", map), "tour_outside");
  assert.equal(classifyIndexed("https://vs-travel.ru/tour", map), "in_sitemap");
  assert.equal(classifyIndexed("https://vs-travel.ru/odnodnevnye?utm_source=x&yclid=1", map), "in_sitemap");
  assert.equal(withoutTracking("/tour?id=5&utm_medium=cpc"), "/tour?id=5");
  assert.equal(withoutTracking("/p?utm_a=1"), "/p");
});
