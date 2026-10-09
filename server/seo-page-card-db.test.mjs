import assert from "node:assert/strict";
import test from "node:test";
import { pageCard } from "./seo-page-card-db.mjs";

// Подставная база: отвечает по характерному куску SQL; всё незнакомое — пустой результат.
function fakeQuery(data) {
  return async (sql, params = []) => {
    for (const [pattern, rows] of data) if (pattern.test(sql)) return { rows: typeof rows === "function" ? rows(params) : rows };
    return { rows: [] };
  };
}

const NOW = new Date("2026-10-09T12:00:00Z");
const urlRow = { url: "https://vs-travel.ru/odnodnevnye/zolotoe-koltso", path: "/odnodnevnye/zolotoe-koltso", url_type: "tour_list", section: "odnodnevnye", status_code: 200, canonical: "https://vs-travel.ru/odnodnevnye/zolotoe-koltso", in_sitemap: true, in_search: true, lastmod: "2024-03-01", title: "Золотое кольцо", h1: "Золотое кольцо", quality: {}, source_flags: { sitemap_source: "https://www.vs-travel.ru/sitemap.xml" } };

const base = [
  [/FROM seo_urls/, [urlRow]],
  [/FROM seo_page_snapshots/, [{ captured_at: "2026-10-09 09:00:00+00", status_code: 200, canonical: urlRow.canonical, title: "Золотое кольцо", h1: "Золотое кольцо", meta: { h1_count: 1, text_chars: 4000, markup: { description: "Однодневные экскурсии", robots: "", lang: "ru", viewport: true, og: { title: "OG" }, schema: { types: ["Product"], microdata: 0 }, hreflang: [], h2: ["Программа"], h2_count: 1, images: 5, images_without_alt: 2, words: 600 } } }]],
  [/FROM seo_page_stats WHERE url = \$1 AND query = ''/, [{ date: "2026-10-01", impressions: 100, clicks: 10, position: 5 }, { date: "2026-10-02", impressions: 100, clicks: 14, position: 4 }]],
  [/FROM seo_page_stats WHERE url = \$1 AND query <> ''/, [{ query: "экскурсии золотое кольцо", impressions: 180, clicks: 20, days: 2, position: 4.5 }, { query: "тур во владимир", impressions: 20, clicks: 4, days: 2, position: 9 }]],
  [/FROM seo_rank_snapshots\s+WHERE source = 'topvisor' AND \(/, [{ query: "экскурсии золотое кольцо", url: "https://vs-travel.ru/odnodnevnye/other", position: 12, date: "2026-10-09" }]],
  [/FROM seo_demand_snapshots/, [{ query: "экскурсии золотое кольцо", demand: 5000, month: "2026-10" }]],
  [/FROM seo_page_changes/, [{ at: "2026-09-20 09:00:00+00", field: "title", label: "Title", old_value: "Старый", new_value: "Золотое кольцо" }]],
];

test("карточка собирает метатеги, sitemap, запросы со спросом и потенциалом и замечает чужую страницу в выдаче", async () => {
  const card = await pageCard(fakeQuery(base), "https://www.vs-travel.ru/odnodnevnye/zolotoe-koltso/", { now: NOW });
  assert.equal(card.page.path, "/odnodnevnye/zolotoe-koltso");
  assert.equal(card.meta.description, "Однодневные экскурсии");
  assert.equal(card.meta.images_without_alt, 2);
  assert.deepEqual(card.markup.schema.types, ["Product"]);
  assert.match(card.sitemap.note, /lastmod/);
  assert.equal(card.webmaster.last_14.clicks, 24);
  const top = card.semantics.queries[0];
  assert.equal(top.query, "экскурсии золотое кольцо");
  assert.equal(top.demand, 5000);
  assert.equal(top.topvisor_position, 12);
  assert.equal(top.other_page_ranks, true, "Topvisor ранжирует под этот запрос другую страницу");
  assert.ok(top.expected > 0);
  assert.equal(card.semantics.with_demand, 1);
  assert.equal(card.changes.detected.length, 1);
});

test("честные пробелы: нет данных — карточка говорит об этом, а не молчит", async () => {
  const card = await pageCard(fakeQuery([]), "/no-such-page", { now: NOW });
  assert.equal(card.page.url, "");
  assert.ok(card.gaps.some((text) => /нет в реестре/.test(text)));
  assert.ok(card.gaps.some((text) => /Нет итогов Вебмастера/.test(text)));
  assert.ok(card.gaps.some((text) => /не найдено запросов/.test(text)));
  assert.equal(card.seasonality, null);
});

test("запросы страницы добираются из Вебмастера по требованию, если пар ещё нет", async () => {
  let collected = 0;
  const rows = { pairs: [] };
  const query = fakeQuery([...base.filter(([pattern]) => !/query <> ''/.test(pattern.source)), [/FROM seo_page_stats WHERE url = \$1 AND query <> ''/, () => rows.pairs]]);
  const card = await pageCard(query, "/odnodnevnye/zolotoe-koltso", { now: NOW, collectQueries: async () => { collected += 1; rows.pairs = [{ query: "новый запрос", impressions: 10, clicks: 1, days: 1, position: 7 }]; return { ok: true }; } });
  assert.equal(collected, 1);
  assert.ok(card.semantics.queries.some((item) => item.query === "новый запрос"));
});

test("сезонность: историю спроса докачивает fetchDynamics и сохраняет", async () => {
  const saved = [];
  const query = async (sql, params = []) => {
    if (/INSERT INTO seo_demand_history/.test(sql)) { saved.push(params); return { rows: [] }; }
    return fakeQuery(base)(sql, params);
  };
  const series = Array.from({ length: 24 }, (_, i) => ({ month: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, value: (i % 12) === 6 ? 900 : 100 }));
  const card = await pageCard(query, "/odnodnevnye/zolotoe-koltso", { now: NOW, fetchDynamics: async () => series });
  assert.equal(saved.length, 24);
  assert.equal(card.seasonality.enough, true);
  assert.equal(card.seasonality.seasonal, true);
  assert.deepEqual(card.seasonality.peak, ["июль"]);
});
