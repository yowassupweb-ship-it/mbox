import assert from "node:assert/strict";
import test from "node:test";
import { demandFromTop, fallbackCtr, queryPotential, reachability, tierOf } from "./seo-potential.mjs";

test("запрос на 12 позиции получает прирост и уровень", () => {
  const out = queryPotential({ query: "туры по россии", demand: 79124, position: 12 });
  assert.equal(out.clicks_target, Math.round(79124 * 0.1));
  assert.equal(out.clicks_now, Math.round(79124 * 0.008));
  assert.equal(out.reach, 0.4);
  assert.equal(out.expected, Math.round(out.gain * 0.4));
  assert.equal(out.tier, "A");
});

test("в топ-3 прироста нет, но запрос не теряется", () => {
  const out = queryPotential({ query: "тур", demand: 5000, position: 2 });
  assert.equal(out.gain, 0);
  assert.equal(out.expected, 0);
  assert.match(out.reason, /топ-3/);
});

test("нет спроса или он не собран — это разные вещи", () => {
  assert.equal(queryPotential({ query: "a", demand: null, position: 5 }).gain, null);
  assert.equal(queryPotential({ query: "a", demand: 0, position: 5 }).tier, "D");
});

test("устаревшие запросы с годом не получают потенциал", () => {
  const out = queryPotential({ query: "туры на майские 2024", demand: 9000, position: 30 });
  assert.equal(out.expected, 0);
  assert.match(out.reason, /устаревший/);
});

test("используется своя кривая CTR, если она передана", () => {
  const out = queryPotential({ query: "x", demand: 1000, position: 8, ctr: (pos) => (pos === 3 ? 0.2 : 0.01) });
  assert.equal(out.clicks_target, 200);
  assert.equal(out.clicks_now, 10);
});

test("позиция не найдена (null) считается далёкой", () => {
  const out = queryPotential({ query: "x", demand: 1000, position: null });
  assert.equal(out.clicks_now, 0);
  assert.equal(out.reach, 0.05);
});

test("пороги уровней и достижимость", () => {
  assert.deepEqual([100, 30, 5, 4].map(tierOf), ["A", "B", "C", "D"]);
  assert.ok(reachability(5) > reachability(15) && reachability(15) > reachability(40));
  assert.ok(fallbackCtr(1) > fallbackCtr(10));
});

test("частотность: точная фраза из списка или общая сумма", () => {
  const data = { totalCount: "79124", results: [{ phrase: "Туры по России", count: "70000" }, { phrase: "x", count: "1" }] };
  assert.deepEqual(demandFromTop(data, "туры по россии"), { demand: 70000, basis: "exact", total: 79124 });
  assert.deepEqual(demandFromTop(data, "другое"), { demand: 79124, basis: "total", total: 79124 });
});
