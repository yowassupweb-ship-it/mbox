import assert from "node:assert/strict";
import test from "node:test";
import { dueScenarios, monthRhythm, nextRunDay, scenariosOnDay } from "./seo-strategy.mjs";

// 2026-10-05 — понедельник; 12:00 UTC = 15:00 МСК.
const at = (iso) => new Date(`${iso}Z`);

test("расписание по дням: понедельник, четверг, 10/20/25 число", () => {
  assert.deepEqual(scenariosOnDay(at("2026-10-05T09:00:00")), ["daily", "monday"]);
  assert.deepEqual(scenariosOnDay(at("2026-10-08T09:00:00")), ["daily", "thursday"]);
  assert.ok(scenariosOnDay(at("2026-10-10T09:00:00")).includes("architecture"));
  assert.ok(scenariosOnDay(at("2026-10-20T09:00:00")).includes("authority"));
  assert.ok(scenariosOnDay(at("2026-10-25T09:00:00")).includes("monthly"));
  assert.deepEqual(scenariosOnDay(at("2026-10-06T09:00:00")), ["daily"]);
});

test("день считается по Москве: 22:30 UTC воскресенья — уже понедельник", () => {
  assert.ok(scenariosOnDay(at("2026-10-04T22:30:00")).includes("monday"));
});

test("ближайший запуск", () => {
  assert.equal(nextRunDay("monday", at("2026-10-05T09:00:00")), "2026-10-05");
  assert.equal(nextRunDay("monday", at("2026-10-06T09:00:00")), "2026-10-12");
  assert.equal(nextRunDay("monthly", at("2026-10-26T09:00:00")), "2026-11-25");
});

test("ритм месяца: отметки и сегодняшний день", () => {
  const month = monthRhythm(at("2026-10-05T09:00:00"));
  assert.equal(month.days.length, 31);
  assert.equal(month.today, 5);
  assert.deepEqual(month.days[4].markers, ["monday"]);
  assert.deepEqual(month.days[24].markers, ["monthly"]);
});

test("что пора запускать: понедельник без пакета — monday, с пакетом сегодня — только ежедневный сбор", () => {
  const now = at("2026-10-05T06:00:00"); // 09:00 МСК
  assert.deepEqual(dueScenarios({ now, lastAt: {}, lastRunAt: "2026-10-04 10:00:00+00" }), ["monday"]);
  assert.deepEqual(dueScenarios({ now, lastAt: { monday: "2026-10-05 05:30:00+00" }, lastRunAt: "2026-10-05 05:30:00+00" }), []);
  assert.deepEqual(dueScenarios({ now, lastAt: { monday: "2026-10-05 05:30:00+00" }, lastRunAt: "2026-10-03 05:30:00+00" }), ["daily"]);
});

test("ночью до 04:00 МСК сборов нет; пропущенный сценарий месяца догоняется", () => {
  assert.deepEqual(dueScenarios({ now: at("2026-10-06T00:30:00"), lastAt: {}, lastRunAt: null }).filter((id) => id === "daily"), []);
  // 12 октября: 10 число прошло, пакета архитектуры в этом месяце нет — пора.
  const due = dueScenarios({ now: at("2026-10-12T09:00:00"), lastAt: { architecture: "2026-09-10 05:00:00+00", monday: "2026-10-12 05:00:00+00" }, lastRunAt: "2026-10-12 05:00:00+00" });
  assert.deepEqual(due, ["architecture"]);
});
