import assert from "node:assert/strict";
import test from "node:test";
import { dailyTokenLimits, mergeWindows, normalizeWindows, shapeDailyModels, shapeWindows, usageAgentName } from "./agent-usage.mjs";

test("имена агентов приводятся к каталожным", () => {
  assert.equal(usageAgentName("claude"), "Claude");
  assert.equal(usageAgentName("Codex"), "ChatGPT");
  assert.equal(usageAgentName("ChatGPT"), "ChatGPT");
  assert.equal(usageAgentName("jarvis"), "");
});

test("облачные агенты публикуют под своим именем, а не под локальной подпиской", () => {
  assert.equal(usageAgentName("ClaudeCloud"), "ClaudeCloud");
  assert.equal(usageAgentName("codexcloud"), "CodexCloud");
});

test("суточные квоты Джарвиса: умолчание и переопределение из окружения", () => {
  assert.equal(dailyTokenLimits("")["openai/gpt-oss-120b"], 200000);
  const limits = dailyTokenLimits("openai/gpt-oss-20b=500000, bad, x=-1, @cf/meta/llama=10000");
  assert.equal(limits["openai/gpt-oss-20b"], 500000);
  assert.equal(limits["@cf/meta/llama"], 10000);
  assert.equal(limits.x, undefined);
});

test("расход Джарвиса за сегодня: доля квоты только там, где она известна", () => {
  const rows = shapeDailyModels([
    { model: "openai/gpt-oss-120b", tokens_today: "50000", calls_today: 4 },
    { model: "gemini-3.5-flash-lite", tokens_today: "11673", calls_today: 2 },
    { model: "openai/gpt-oss-20b", tokens_today: "0", calls_today: 0 },
  ], { "openai/gpt-oss-120b": 200000 });
  assert.deepEqual(rows, [
    { model: "openai/gpt-oss-120b", tokens_today: 50000, calls_today: 4, limit_tokens: 200000, used_percent: 25 },
    { model: "gemini-3.5-flash-lite", tokens_today: 11673, calls_today: 2 },
  ]);
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
