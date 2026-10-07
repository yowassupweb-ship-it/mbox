import assert from "node:assert/strict";
import test from "node:test";
import { claudeWindowFromEvent, claudeWindowsFromEvent, parseCodexRateLimits } from "./usage-report.mjs";

test("событие Claude: доля становится процентами, окно получает имя", () => {
  assert.deepEqual(claudeWindowFromEvent({ rateLimitType: "five_hour", utilization: 0.234, resetsAt: 1791289500 }), { id: "5h", label: "5 часов", used_percent: 23.4, resets_at: 1791289500 });
  assert.equal(claudeWindowFromEvent({ rateLimitType: "seven_day", utilization: 0.5 }).id, "week");
  assert.equal(claudeWindowFromEvent({ rateLimitType: "seven_day_opus", utilization: 0.1 }).id, "seven_day_opus");
  assert.equal(claudeWindowFromEvent({ rateLimitType: "five_hour" }), null);
  assert.equal(claudeWindowFromEvent(null), null);
});

test("событие Claude Code 2.1.29x: оба окна из unifiedWindows", () => {
  // Живое событие от 07.10.2026: в корне utilization нет, доли — по окнам.
  const info = { status: "allowed", resetsAt: 1791401400, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1791401400 }, seven_day: { utilization: 0.36, resetsAt: 1791817200 } } };
  assert.deepEqual(claudeWindowsFromEvent(info), [
    { id: "5h", label: "5 часов", used_percent: 15, resets_at: 1791401400 },
    { id: "week", label: "Неделя", used_percent: 36, resets_at: 1791817200 },
  ]);
  assert.deepEqual(claudeWindowsFromEvent({ rateLimitType: "five_hour", utilization: 0.2 }).map((w) => w.used_percent), [20]);
  assert.deepEqual(claudeWindowsFromEvent({ rateLimitType: "five_hour" }), []);
});

const LINE = (limits) => `{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":${JSON.stringify(limits)}}}`;

test("Codex: берётся последняя запись лимитов, окна 300 и 10080 минут", () => {
  const old = LINE({ primary: { used_percent: 10, window_minutes: 300, resets_at: 100 }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: 200 } });
  const fresh = LINE({ limit_id: "codex", primary: { used_percent: 23, window_minutes: 300, resets_at: 1791289500 }, secondary: { used_percent: 56, window_minutes: 10080, resets_at: 1791623905 }, credits: { has_credits: false } });
  const windows = parseCodexRateLimits(`${old}\n${fresh}\n`);
  assert.deepEqual(windows, [
    { id: "5h", label: "5 часов", used_percent: 23, resets_at: 1791289500 },
    { id: "week", label: "Неделя", used_percent: 56, resets_at: 1791623905 },
  ]);
});

test("Codex: обрезанная последняя строка не ломает разбор, нет записи — null", () => {
  const good = LINE({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1 }, secondary: null });
  assert.equal(parseCodexRateLimits(`${good}\n{"payload":{"rate_limits":{"primary":{"used_pe`)?.[0].used_percent, 5);
  assert.equal(parseCodexRateLimits('{"nothing":true}'), null);
});
