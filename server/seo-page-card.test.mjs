import assert from "node:assert/strict";
import test from "node:test";
import { coreTerms, diffSnapshots, effectAround, pathOfUrl, seasonality, sitemapNote, sumSeries } from "./seo-page-card.mjs";

test("путь страницы сводится к одному виду", () => {
  assert.equal(pathOfUrl("https://www.vs-travel.ru/odnodnevnye/zolotoe-koltso/"), "/odnodnevnye/zolotoe-koltso");
  assert.equal(pathOfUrl("https://vs-travel.ru/"), "/");
  assert.equal(pathOfUrl("/a//b?x=1"), "/a/b?x=1");
  assert.equal(pathOfUrl(""), "");
});

test("сравнение версий: title, canonical, большой скачок текста; мелочь не считается", () => {
  const a = { status_code: 200, canonical: "https://s/a", title: "Тур А", h1: "А", meta: { noindex: false, text_chars: 1000 } };
  const b = { status_code: 200, canonical: "https://s/b", title: "Тур Б", h1: "А", meta: { noindex: false, text_chars: 1100 } };
  assert.deepEqual(diffSnapshots(a, b).map((c) => c.field), ["canonical", "title"]);
  assert.deepEqual(diffSnapshots(a, { ...b, meta: { noindex: false, text_chars: 1600 } }).map((c) => c.field), ["canonical", "title", "text_chars"]);
});

test("разметка сравнивается только если она есть в обоих снимках", () => {
  const old = { status_code: 200, canonical: "", title: "T", h1: "H", meta: { text_chars: 500 } };
  const withMarkup = { ...old, meta: { text_chars: 500, markup: { description: "новое", robots: "", og: {}, schema: { types: ["Product"] }, hreflang: [], h2: [] } } };
  assert.deepEqual(diffSnapshots(old, withMarkup), []);
  const changed = { ...withMarkup, meta: { text_chars: 500, markup: { description: "другое", robots: "", og: {}, schema: { types: ["Product", "FAQPage"] }, hreflang: [], h2: [] } } };
  assert.deepEqual(diffSnapshots(withMarkup, changed).map((c) => c.field), ["description", "schema"]);
  assert.equal(diffSnapshots(null, changed).length, 0);
});

test("сезонность: мало истории — честный отказ; выраженный пик находится", () => {
  assert.equal(seasonality([{ month: "2026-01", value: 10 }]).enough, false);
  const series = [];
  for (let year = 2024; year <= 2025; year += 1) for (let m = 1; m <= 12; m += 1) series.push({ month: `${year}-${String(m).padStart(2, "0")}`, value: m === 7 || m === 8 ? 300 : 100 });
  const out = seasonality(series);
  assert.equal(out.enough, true);
  assert.equal(out.seasonal, true);
  assert.deepEqual(out.peak, ["июль", "август"]);
  const flat = seasonality(series.map((item) => ({ ...item, value: 100 })));
  assert.equal(flat.seasonal, false);
});

test("ряды по запросам суммируются по месяцам", () => {
  assert.deepEqual(sumSeries([[{ month: "2026-01", value: 5 }], [{ month: "2026-01", value: 7 }, { month: "2026-02", value: 1 }]]), [{ month: "2026-01", value: 12 }, { month: "2026-02", value: 1 }]);
});

test("эффект изменения: позиции до и после по общим запросам, клики по дням", () => {
  const ranks = [
    { date: "2026-10-02", positions: new Map([["тур", 15], ["экскурсия", 8], ["только до", 3]]) },
    { date: "2026-10-16", positions: new Map([["тур", 9], ["экскурсия", 8], ["только после", 40]]) },
  ];
  const daily = [];
  for (let i = 1; i <= 14; i += 1) daily.push({ date: `2026-09-${String(30 - i + 1).padStart(2, "0")}`, clicks: 10, impressions: 100 });
  for (let i = 2; i <= 9; i += 1) daily.push({ date: `2026-10-${String(i + 5).padStart(2, "0")}`, clicks: 16, impressions: 100 });
  const out = effectAround("2026-10-05", { ranks, daily });
  assert.equal(out.positions.queries, 2);
  assert.equal(out.positions.delta, 3);
  assert.equal(out.positions.improved, 1);
  assert.equal(out.verdict, "помогло");
});

test("нет проверки после изменения — нельзя судить", () => {
  const out = effectAround("2026-10-05", { ranks: [{ date: "2026-10-02", positions: new Map([["тур", 5]]) }], daily: [] });
  assert.equal(out.positions, null);
  assert.equal(out.verdict, "нельзя судить");
});

test("ядро семантики и заметка по sitemap", () => {
  const terms = coreTerms([{ query: "экскурсии по золотому кольцу", impressions: 100 }, { query: "золотое кольцо на 1 день", impressions: 50 }]);
  assert.equal(terms[0].term, "экскурсии");
  assert.ok(terms.some((item) => item.term === "золотому"));
  assert.match(sitemapNote({ in_sitemap: false }).note, /нет в sitemap/);
  assert.match(sitemapNote({ in_sitemap: true, lastmod: "2024-01-01", now: new Date("2026-10-09") }).note, /старше года/);
});
