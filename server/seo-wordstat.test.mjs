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
