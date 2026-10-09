import assert from "node:assert/strict";
import test from "node:test";
import { bySection, groupByDate, movers, trendByCheck, urlFlapping } from "./seo-rank-stats.mjs";

const snaps = [
  { date: "2026-10-02", query: "тур а", url: "https://s/a/1", position: 15 },
  { date: "2026-10-02", query: "тур б", url: "https://s/b/1", position: 4 },
  { date: "2026-10-02", query: "тур в", url: "https://s/a/2", position: 2 },
  { date: "2026-10-02", query: "тур г", url: "", position: null },
  { date: "2026-10-09", query: "тур а", url: "https://s/a/1", position: 8 },
  { date: "2026-10-09", query: "тур б", url: "https://s/b/2", position: 12 },
  { date: "2026-10-09", query: "тур в", url: "https://s/a/2", position: 2 },
  { date: "2026-10-09", query: "тур г", url: "https://s/a/3", position: 40 },
];

test("динамика по проверкам: корзины, средняя и медиана", () => {
  const trend = trendByCheck(groupByDate(snaps));
  assert.equal(trend.length, 2);
  assert.deepEqual([trend[0].tracked, trend[0].found, trend[0].top3, trend[0].top10, trend[0].top20], [4, 3, 1, 2, 3]);
  assert.equal(trend[0].avg_position, 7);
  assert.equal(trend[1].median_position, 10);
  assert.equal(trend[1].top50, 4);
});

test("видимость считается через переданный вес", () => {
  const trend = trendByCheck(groupByDate(snaps), (query, position) => (position === null ? 0 : 100 / position));
  assert.ok(trend[1].visibility > 0);
});

test("изменения: рост, падение, вход в топ-10 и выход, появление", () => {
  const out = movers(groupByDate(snaps));
  assert.equal(out.from, "2026-10-02");
  assert.equal(out.to, "2026-10-09");
  assert.equal(out.counts.up, 1);
  assert.equal(out.counts.down, 1);
  assert.equal(out.counts.entered_top10, 1);
  assert.equal(out.counts.left_top10, 1);
  assert.equal(out.counts.appeared, 1);
  assert.equal(out.rows.find((row) => row.query === "тур а").delta, 7);
  assert.equal(out.rows[0].query, "тур г");
});

test("с одной проверкой изменений нет", () => {
  assert.deepEqual(movers(groupByDate(snaps.slice(0, 4))).rows, []);
});

test("срез по разделам и страницы, которые гуляют", () => {
  const sections = bySection(groupByDate(snaps), (url) => new URL(url).pathname.split("/")[1]);
  const a = sections.find((item) => item.section === "a");
  assert.deepEqual([a.queries, a.found, a.top10], [3, 3, 2]);
  const flapping = urlFlapping(groupByDate(snaps));
  assert.deepEqual(flapping.map((item) => item.query), ["тур б"]);
});
