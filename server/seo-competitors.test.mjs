import assert from "node:assert/strict";
import test from "node:test";
import { buildBoard, domainStats, gaps, parseCompetitorCells, rivalMovers, rivalPages, splitCell, summary, trendMatrix, wins } from "./seo-competitors.mjs";

const OURS = "vs-travel.ru";
const rows = [
  // 2026-08-03
  { date: "2026-08-03", domain: OURS, query: "туры в ярославль", position: 20, url: "/a" },
  { date: "2026-08-03", domain: OURS, query: "золотое кольцо", position: 3, url: "/b" },
  { date: "2026-08-03", domain: OURS, query: "тур на 3 дня", position: null, url: "" },
  { date: "2026-08-03", domain: "rtoperator.ru", query: "туры в ярославль", position: 14, url: "https://rt/y" },
  { date: "2026-08-03", domain: "rtoperator.ru", query: "золотое кольцо", position: 9, url: "https://rt/z" },
  // 2026-10-09
  { date: "2026-10-09", domain: OURS, query: "туры в ярославль", position: 18, url: "/a" },
  { date: "2026-10-09", domain: OURS, query: "золотое кольцо", position: 2, url: "/b" },
  { date: "2026-10-09", domain: OURS, query: "тур на 3 дня", position: null, url: "" },
  { date: "2026-10-09", domain: "rtoperator.ru", query: "туры в ярославль", position: 4, url: "https://rt/y" },
  { date: "2026-10-09", domain: "rtoperator.ru", query: "золотое кольцо", position: 12, url: "https://rt/z" },
  { date: "2026-10-09", domain: "rtoperator.ru", query: "тур на 3 дня", position: 7, url: "https://rt/3" },
  { date: "2026-10-09", domain: "magput.ru", query: "туры в ярославль", position: 3, url: "https://mp/y" },
];
const board = buildBoard(rows);
const ctr = (position) => (position <= 3 ? 0.1 : position <= 10 ? 0.03 : 0.005);
const demandBy = new Map([["туры в ярославль", 10000], ["золотое кольцо", 5000], ["тур на 3 дня", 20000]]);
const weight = (query, position) => (demandBy.get(query) || 0) * ctr(position);

test("ключи ячеек Topvisor и разбор позиций конкурентов; свой проект и чужие id пропускаются", () => {
  assert.deepEqual(splitCell("2026-10-09:25920382:1"), { day: "2026-10-09", projectId: "25920382", region: "1" });
  assert.equal(splitCell("мусор"), null);
  const out = parseCompetitorCells([{ name: "тур", positionsData: {
    "2026-10-09:25882986:1": { position: "5", relevant_url: "/own" },
    "2026-10-09:25920382:1": { position: "11", relevant_url: "https://s/y" },
    "2026-10-09:25920384:1": { position: "--", relevant_url: "" },
    "2026-10-09:999:1": { position: "1" },
  } }], { ownProjectId: 25882986, competitorIds: [25920382, 25920384], regionIndex: 1 });
  assert.deepEqual(out.map((row) => [row.competitor_id, row.position]), [["25920382", 11], ["25920384", null]]);
});

test("показатели домена: корзины, средняя и видимость", () => {
  const stats = domainStats(board, "2026-10-09", "rtoperator.ru", weight);
  assert.deepEqual([stats.tracked, stats.found, stats.top3, stats.top10, stats.top20], [3, 3, 0, 2, 3]);
  assert.equal(stats.visibility, Math.round(10000 * 0.03 + 5000 * 0.005 + 20000 * 0.03));
  assert.equal(domainStats(board, "2026-10-09", "нет-такого", weight), null);
});

test("сводка: сортировка по видимости, доля голоса, сдвиг к прошлой проверке", () => {
  const list = summary(board, OURS, weight);
  assert.equal(list[0].domain, "magput.ru"); // 1000 против 925: одна позиция №3 по запросу со спросом 10 000
  assert.equal(list.find((item) => item.is_ours).domain, OURS);
  assert.equal(Math.round(list.reduce((sum, item) => sum + (item.share || 0), 0)), 100);
  assert.equal(list.find((item) => item.domain === "rtoperator.ru").delta_top10, 1); // был 1 в топ-10 (9), стало 2 (4 и 7)
  assert.equal(list.find((item) => item.domain === "magput.ru").stale, false);
  assert.equal(list.find((item) => item.domain === "magput.ru").delta_top10, null, "прошлой проверки по домену нет");
});

test("где нас обходят: потеря кликов и число конкурентов выше", () => {
  const list = gaps(board, OURS, { demandBy, ctr });
  assert.deepEqual(list.map((item) => item.query), ["туры в ярославль", "тур на 3 дня"]); // потеря 950 против 600
  const yaroslavl = list.find((item) => item.query === "туры в ярославль");
  assert.equal(yaroslavl.rival, "magput.ru");
  assert.equal(yaroslavl.rival_position, 3);
  assert.equal(yaroslavl.rivals_ahead, 2);
  assert.equal(yaroslavl.lost, Math.round(10000 * (0.1 - 0.005)));
  assert.equal(list[1].ours, null);
  assert.equal(list[1].lost, Math.round(20000 * 0.03));
});

test("где мы впереди: только топ-10 и выше всех конкурентов", () => {
  assert.deepEqual(wins(board, OURS, { demandBy }).map((item) => item.query), ["золотое кольцо"]);
});

test("кто поднялся: вход в топ-10 и сдвиг от 5 позиций; прошлой проверки по домену нет — не считаем", () => {
  const out = rivalMovers(board, OURS);
  assert.deepEqual([out.from, out.to], ["2026-08-03", "2026-10-09"]);
  const up = out.rows.find((row) => row.query === "туры в ярославль");
  assert.equal(up.kind, "поднялся");
  assert.equal(up.delta, 10);
  assert.equal(out.rows.find((row) => row.query === "золотое кольцо").kind, "упал");
  assert.ok(!out.rows.some((row) => row.domain === "magput.ru"));
});

test("страницы конкурентов с наибольшим числом наших запросов в топ-10", () => {
  const pages = rivalPages(board, OURS);
  assert.equal(pages.length, 3);
  assert.ok(pages.every((item) => item.queries >= 1));
  assert.equal(pages.find((item) => item.url === "https://mp/y").top3, 1);
});

test("динамика по проверкам для всех доменов", () => {
  const matrix = trendMatrix(board, weight);
  assert.equal(matrix.length, 2);
  assert.equal(matrix[1].cells["rtoperator.ru"].top10, 2);
  assert.equal(matrix[0].cells["magput.ru"], null);
});
