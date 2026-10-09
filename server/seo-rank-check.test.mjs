import assert from "node:assert/strict";
import test from "node:test";
import { nextPositionsAction } from "./seo-rank-check.mjs";

const at = (iso) => new Date(iso);

test("первой проверки ещё не было: просим утром по Москве, ночью ждём", () => {
  assert.equal(nextPositionsAction({ now: at("2026-10-09T05:00:00Z"), last: null }), "request"); // 08:00 МСК
  assert.equal(nextPositionsAction({ now: at("2026-10-09T00:30:00Z"), last: null }), null); // 03:30 МСК
});

test("проверка запрошена: сначала ждём, потом забираем, потом сдаёмся", () => {
  const last = { status: "requested", requested_at: "2026-10-09T05:00:00Z" };
  assert.equal(nextPositionsAction({ now: at("2026-10-09T05:10:00Z"), last }), null);
  assert.equal(nextPositionsAction({ now: at("2026-10-09T05:30:00Z"), last }), "collect");
  assert.equal(nextPositionsAction({ now: at("2026-10-09T13:30:00Z"), last }), "give_up");
});

test("после завершённой проверки следующая — не раньше чем через неделю", () => {
  const last = { status: "done", requested_at: "2026-10-02T05:00:00Z" };
  assert.equal(nextPositionsAction({ now: at("2026-10-08T05:00:00Z"), last }), null);
  assert.equal(nextPositionsAction({ now: at("2026-10-09T05:00:00Z"), last }), "request");
});

test("после ошибки повторяем через сутки, не каждые десять минут", () => {
  const last = { status: "error", requested_at: "2026-10-09T05:00:00Z" };
  assert.equal(nextPositionsAction({ now: at("2026-10-09T06:00:00Z"), last }), null);
  assert.equal(nextPositionsAction({ now: at("2026-10-10T05:30:00Z"), last }), "request");
});

test("формат времени Postgres без T тоже разбирается", () => {
  const last = { status: "requested", requested_at: "2026-10-09 05:00:00+00" };
  assert.equal(nextPositionsAction({ now: at("2026-10-09T05:30:00Z"), last }), "collect");
});
