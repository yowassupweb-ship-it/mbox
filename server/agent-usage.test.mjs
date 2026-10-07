import assert from "node:assert/strict";
import test from "node:test";
import { mergeWindows, normalizeWindows, shapeWindows, usageAgentName } from "./agent-usage.mjs";

test("имена агентов приводятся к каталожным", () => {
  assert.equal(usageAgentName("claude"), "Claude");
  assert.equal(usageAgentName("Codex"), "ChatGPT");
  assert.equal(usageAgentName("ChatGPT"), "ChatGPT");
  assert.equal(usageAgentName("jarvis"), "");
});

test("окна нормализуются: диапазон, id, лишнее отбрасывается", () => {
  const out = normalizeWindows([
    { id: "5h", label: "5 часов", used_percent: 23.04, resets_at: 1791289500.7, junk: 1 },
    { id: "WEEK", used_percent: 140 },
    { id: "bad id!", used_percent: 10 },
    { id: "x", used_percent: "не число" },
    null,
  ]);
  assert.deepEqual(out, [
    { id: "5h", label: "5 часов", used_percent: 23, resets_at: 1791289501 },
    { id: "week", label: "week", used_percent: 100 },
  ]);
  assert.deepEqual(normalizeWindows("нет"), []);
});

test("новое окно заменяет прежнее с тем же id, остальные остаются", () => {
  const merged = mergeWindows([{ id: "5h", label: "a", used_percent: 10 }, { id: "week", label: "b", used_percent: 50 }], [{ id: "5h", label: "a", used_percent: 30 }]);
  assert.deepEqual(merged.map((w) => [w.id, w.used_percent]), [["5h", 30], ["week", 50]]);
});

test("окно, у которого сброс уже прошёл, показывается чистым", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const [past, future, open] = shapeWindows([
    { id: "5h", label: "5 ч", used_percent: 90, resets_at: now / 1000 - 60 },
    { id: "week", label: "нед", used_percent: 56, resets_at: now / 1000 + 3600 },
    { id: "x", label: "без сброса", used_percent: 12 },
  ], now);
  assert.deepEqual([past.used_percent, past.expired], [0, true]);
  assert.deepEqual([future.used_percent, future.expired], [56, false]);
  assert.deepEqual([open.used_percent, open.expired], [12, false]);
});
