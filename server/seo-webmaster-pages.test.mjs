import assert from "node:assert/strict";
import test from "node:test";
import { collectPageQueries, collectPageTotals, parseAnalytics } from "./seo-webmaster-pages.mjs";

const sample = (value, days) => ({
  text_indicator: { type: "URL", value },
  statistics: days.flatMap(([date, imp, clk, pos]) => [
    { date, field: "POSITION", value: pos }, { date, field: "CLICKS", value: clk }, { date, field: "CTR", value: 1 }, { date, field: "IMPRESSIONS", value: imp },
  ]),
});

test("разбор ответа: показы, клики и позиция по дням; пустые дни и чужие поля пропускаются", () => {
  const rows = parseAnalytics({ text_indicator_to_statistics: [sample("/a", [["2026-09-20", 756, 141, 3.9], ["2026-09-21", 0, 0, 0]])] });
  assert.deepEqual(rows, [{ date: "2026-09-20", key: "/a", impressions: 756, clicks: 141, position: 3.9 }]);
  assert.deepEqual(parseAnalytics(null), []);
});

function fakeDb() {
  const writes = [];
  return { writes, query: async (sql, params) => { if (/INSERT INTO seo_page_stats/.test(sql)) writes.push(JSON.parse(params[0])); return { rows: [] }; } };
}

test("итоги по страницам: страницы листаются порциями, строки пишутся с пустым запросом", async () => {
  const db = fakeDb();
  const calls = [];
  const call = async (body) => {
    calls.push(body.offset);
    const items = body.offset === 0 ? Array.from({ length: 500 }, (_, i) => sample(`/p${i}`, [["2026-09-20", 10, 1, 5]])) : [sample("/last", [["2026-09-20", 4, 0, 9]])];
    return { count: 501, text_indicator_to_statistics: items };
  };
  const out = await collectPageTotals(db.query, call);
  assert.deepEqual(calls, [0, 500]);
  assert.equal(out.pages, 501);
  assert.equal(db.writes.flat().every((row) => row.query === ""), true);
});

test("запросы страниц: фильтр по URL, пары пишутся с путём страницы; 429 останавливает сбор", async () => {
  const db = fakeDb();
  const seen = [];
  const call = async (body) => {
    seen.push(body.filters.text_filters[0].value);
    if (body.filters.text_filters[0].value === "/stop") throw new Error("429: quota");
    return { count: 1, text_indicator_to_statistics: [sample("экскурсии по кольцу", [["2026-09-20", 34, 2, 6.1]])] };
  };
  const out = await collectPageQueries(db.query, call, ["/a", "/b", "/stop", "/c", "/d", "/e", "/f"], { concurrency: 1 });
  assert.equal(out.done, 2);
  assert.equal(out.failed, 1);
  assert.deepEqual(seen, ["/a", "/b", "/stop"]);
  assert.deepEqual(db.writes[0][0], { captured_on: "2026-09-20", url: "/a", query: "экскурсии по кольцу", impressions: 34, clicks: 2, position: 6.1 });
});
