import assert from "node:assert/strict";
import test from "node:test";
import { collectWordstatDemand } from "./seo-wordstat.mjs";

function fakeDb({ tracked, done = [] }) {
  const inserts = [];
  const query = async (sql, params) => {
    if (/FROM seo_rank_snapshots/.test(sql)) return { rows: tracked.map((q) => ({ query: q })) };
    if (/FROM seo_demand_snapshots/.test(sql)) return { rows: done.map((q) => ({ query: q })) };
    if (/INSERT INTO seo_demand_snapshots/.test(sql)) { inserts.push(params); return { rows: [] }; }
    throw new Error(`unexpected sql ${sql}`);
  };
  return { query, inserts };
}
const ok = (count) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ totalCount: String(count), results: [] }) });

test("собирает спрос только для ещё не собранных в этом месяце и без запросов с годом", async () => {
  const db = fakeDb({ tracked: ["туры по россии", "тур 2024", "алтай тур"], done: ["алтай тур"] });
  const out = await collectWordstatDemand(db.query, { apiKey: "k" }, { fetchImpl: ok(500), now: new Date("2026-10-09") });
  assert.equal(out.requested, 1);
  assert.equal(out.saved, 1);
  assert.equal(out.already_collected, 1 + 0);
  assert.deepEqual(db.inserts[0].slice(0, 3), ["туры по россии", 500, "2026-10"]);
});

test("при 429 останавливается и не продолжает стучаться", async () => {
  const db = fakeDb({ tracked: Array.from({ length: 20 }, (_, i) => `запрос ${i}`) });
  let calls = 0;
  const limited = async () => { calls += 1; return { ok: false, status: 429, text: async () => '{"message":"quota"}' }; };
  const out = await collectWordstatDemand(db.query, { apiKey: "k" }, { fetchImpl: limited });
  assert.ok(out.stopped.includes("429"));
  assert.ok(calls <= 3, `слишком много обращений после лимита: ${calls}`);
  assert.equal(out.saved, 0);
  assert.equal(out.left, 20);
});

test("секундный лимит 429 не останавливает сбор: ждём и повторяем", async () => {
  const db = fakeDb({ tracked: ["туры", "экскурсии"] });
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 2) return { ok: false, status: 429, text: async () => '{"message":"search-api.wordstatRequestsPerSecond.rate rate quota limit exceed: allowed 10 requests"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ totalCount: "7", results: [] }) };
  };
  const pauses = [];
  const out = await collectWordstatDemand(db.query, { apiKey: "k" }, { fetchImpl: flaky, sleep: async (ms) => { pauses.push(ms); }, gapMs: 0 });
  assert.equal(out.saved, 2);
  assert.equal(out.stopped, undefined);
  assert.ok(pauses.includes(1100));
});

test("запросы идут не чаще заданного ритма", async () => {
  const db = fakeDb({ tracked: ["a", "b", "c", "d"] });
  const starts = [];
  const timed = async () => { starts.push(Date.now()); return { ok: true, status: 200, text: async () => JSON.stringify({ totalCount: "1", results: [] }) }; };
  await collectWordstatDemand(db.query, { apiKey: "k" }, { fetchImpl: timed, gapMs: 40 });
  const gaps = starts.slice(1).map((time, i) => time - starts[i]);
  assert.ok(Math.min(...gaps) >= 30, `слишком частые запросы: ${gaps}`);
});

test("дособор: после упора в часовую квоту ждёт, потом заходит снова", async () => {
  const { topUpDemand, resetDemandBlock } = await import("./seo-wordstat.mjs");
  resetDemandBlock();
  const db = fakeDb({ tracked: ["туры", "экскурсии"] });
  let calls = 0;
  const hourly = async () => { calls += 1; return { ok: false, status: 429, text: async () => '{"message":"search-api.wordstatRequestsPerHour.rate rate quota limit exceed: allowed 100 requests"}' }; };
  const t0 = new Date("2026-10-09T10:00:00Z");
  const first = await topUpDemand(db.query, { apiKey: "k" }, { now: t0, fetchImpl: hourly, sleep: async () => {} });
  assert.ok(first.stopped.includes("PerHour"));
  const callsAfterFirst = calls;
  assert.equal(await topUpDemand(db.query, { apiKey: "k" }, { now: new Date("2026-10-09T10:30:00Z"), fetchImpl: hourly, sleep: async () => {} }), null);
  assert.equal(calls, callsAfterFirst, "в часе ожидания обращений быть не должно");
  const later = await topUpDemand(db.query, { apiKey: "k" }, { now: new Date("2026-10-09T11:05:00Z"), fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ totalCount: "3", results: [] }) }), sleep: async () => {} });
  assert.equal(later.saved, 2);
  resetDemandBlock();
});
