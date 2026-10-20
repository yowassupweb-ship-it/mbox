// Самообучение: те же числа, что у Python-версии (vsanalyzer/learn.py), на тех же оценках и снимке.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { crossValidate, f1, fit, runLearning, shouldLearn } from "./assortment-learn.mjs";

const dir = new URL("./fixtures/assortment/", import.meta.url);
const plain = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const snap = JSON.parse(gunzipSync(readFileSync(new URL("snapshot.json.gz", dir))).toString("utf8"));
const cfg = plain("config.json");
const strip = (res) => { const { body, ...rest } = res; return JSON.parse(JSON.stringify(rest)); };

test("оценки, которым не хватает порога точности: результат отклонён, как у Python", () => {
  const res = runLearning(cfg, snap, plain("learn-labels.json"));
  assert.deepEqual(strip(res), plain("learn-reference.json"));
  assert.equal(res.body, undefined);
});
test("чёткие оценки: пороги приняты и совпадают с Python", () => {
  const res = runLearning(cfg, snap, plain("learn-labels2.json"), { now: new Date("2026-10-20T12:00:00Z") });
  assert.deepEqual(strip(res), plain("learn-reference2.json"));
  assert.equal(res.body.meta.at, "2026-10-20T12:00:00+00:00");
  assert.deepEqual(res.body.conflicts.weights, plain("learn-reference2.json").learned.weights);
});
test("мало оценок — не учимся; повторный запуск без новых оценок — «актуально»", () => {
  const few = Object.fromEntries(Object.entries(plain("learn-labels2.json")).slice(0, 10));
  assert.equal(runLearning(cfg, snap, few).status, "few");
  const first = runLearning(cfg, snap, plain("learn-labels2.json"));
  assert.equal(runLearning(cfg, snap, plain("learn-labels2.json"), { previous: first.body }).status, "current");
  assert.equal(shouldLearn(plain("learn-labels2.json"), { meta: { labels: Object.keys(plain("learn-labels2.json")).length } }), false);
  assert.equal(shouldLearn(plain("learn-labels2.json"), null), true);
});
test("fit держится в границах и детерминирован", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ key: `c:${i}-${i + 1}`, label: i % 2 === 0, f: [0.6 + (i % 5) / 10, 1, (i % 3) / 2, 0.5], geo: 0.6 + (i % 5) / 10 }));
  const a = fit(rows, [0.45, 0.2, 0.2, 0.15], 0.55, 0.55), b = fit(rows, [0.45, 0.2, 0.2, 0.15], 0.55, 0.55);
  assert.deepEqual(a, b);
  assert.ok(a[0].every((x) => x >= 0.04 && x <= 0.61));
  assert.ok(Math.abs(a[1] - 0.55) <= 0.15 + 1e-9 && Math.abs(a[2] - 0.55) <= 0.2 + 1e-9);
  assert.ok(crossValidate(rows, [0.45, 0.2, 0.2, 0.15], 0.55, 0.55).every(Number.isFinite));
  assert.equal(f1(rows, [0.45, 0.2, 0.2, 0.15], 0.55, 0.55).length, 3);
});
