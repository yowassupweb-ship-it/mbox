import assert from "node:assert/strict";
import test from "node:test";
import { seoView } from "./seo-views.mjs";

// Подставная база: отвечает по характерному куску SQL.
function fakeQuery() {
  return async (sql) => {
    if (/FROM seo_competitor_ranks r JOIN seo_competitors/.test(sql)) return { rows: [
      { date: "2026-08-03", domain: "rtoperator.ru", query: "туры в ярославль", position: 14, url: "https://rt/y" },
      { date: "2026-10-09", domain: "rtoperator.ru", query: "туры в ярославль", position: 4, url: "https://rt/y" },
      { date: "2026-10-09", domain: "magput.ru", query: "туры в ярославль", position: 3, url: "https://mp/y" },
    ] };
    if (/FROM seo_rank_snapshots/.test(sql) && /region = \(SELECT region/.test(sql)) return { rows: [
      { date: "2026-08-03", query: "туры в ярославль", url: "https://vs-travel.ru/a", position: 20 },
      { date: "2026-10-09", query: "туры в ярославль", url: "https://vs-travel.ru/a", position: 18 },
    ] };
    if (/FROM seo_demand_snapshots/.test(sql)) return { rows: [{ query: "туры в ярославль", demand: 10000 }] };
    if (/FROM seo_competitors ORDER BY name/.test(sql)) return { rows: [{ name: "rtoperator.ru", site: "rtoperator.ru", tracking: false, updated_at: "2026-10-09" }, { name: "magput.ru", site: "magput.ru", tracking: true, updated_at: "2026-10-09" }] };
    return { rows: [] };
  };
}

test("представление «Конкуренты»: шесть таблиц, наши позиции рядом с конкурентами, подсказка про выключенное слежение", async () => {
  const view = await seoView(fakeQuery(), "competitors", { config: { site_origin: "https://www.vs-travel.ru" } });
  const ids = view.sections.map((section) => section.id);
  assert.deepEqual(ids.slice(0, 6), ["competitors_summary", "competitors_gaps", "competitors_wins", "competitors_movers", "competitors_pages", "competitors_trend"]);
  const summary = view.sections[0];
  assert.deepEqual(summary.rows.map((row) => row.domain).sort(), ["magput.ru", "rtoperator.ru", "vs-travel.ru"]);
  assert.equal(summary.rows.find((row) => row.domain === "vs-travel.ru").status, "мы");
  assert.match(summary.note, /слежение выключено у 1 из 2/);
  const gaps = view.sections[1].rows;
  assert.equal(gaps[0].rival, "magput.ru");
  assert.equal(gaps[0].ours, 18);
  assert.ok(gaps[0].lost > 0);
  assert.equal(view.sections[3].rows[0].kind, "поднялся");
  assert.ok(view.sections[5].columns.some((column) => column.label === "vs-travel.ru (мы)"));
});

test("без данных по конкурентам таблицы пустые и говорят, что делать", async () => {
  const view = await seoView(async () => ({ rows: [] }), "competitors", { config: {} });
  assert.equal(view.sections[0].rows.length, 0);
  assert.match(view.sections[0].empty, /нет конкурентов/);
});
