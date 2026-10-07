import test from "node:test";
import assert from "node:assert/strict";
import { eventFields, expandEvent, isoLocal, localDate, mergeProps, nextDue, parseRule } from "./planner.mjs";

const event = { id: "1", starts_at: "2026-10-05T10:00:00", ends_at: "2026-10-05T11:00:00", recurrence_rule: "FREQ=WEEKLY;BYDAY=MO,WE" };
const starts = (rows) => rows.map((row) => row.starts_at);

test("будни по неделям: длительность сохраняется, у повторения id серии", () => {
  const rows = expandEvent(event, "2026-10-05T00:00:00", "2026-10-13T00:00:00");
  assert.deepEqual(starts(rows), ["2026-10-05T10:00:00", "2026-10-07T10:00:00", "2026-10-12T10:00:00"]);
  assert.equal(rows[1].ends_at, "2026-10-07T11:00:00");
  assert.equal(rows[1].id, "1::2026-10-07T10:00:00");
  assert.equal(rows[1].master_id, "1");
});

test("серия, начатая давно, видна в позднем диапазоне; исключения пропускаются", () => {
  const rows = expandEvent({ ...event, exdates: ["2026-12-09T10:00:00"] }, "2026-12-07T00:00:00", "2026-12-14T00:00:00");
  assert.deepEqual(starts(rows), ["2026-12-07T10:00:00"]);
});

test("каждые две недели считаются от недели начала серии", () => {
  const rows = expandEvent({ ...event, recurrence_rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" }, "2026-10-01T00:00:00", "2026-11-01T00:00:00");
  assert.deepEqual(starts(rows), ["2026-10-05T10:00:00", "2026-10-19T10:00:00"]);
});

test("UNTIL и COUNT обрывают серию", () => {
  assert.equal(expandEvent({ ...event, recurrence_rule: "FREQ=DAILY;UNTIL=20261007T095959" }, "2026-10-01T00:00:00", "2026-11-01T00:00:00").length, 2);
  assert.equal(expandEvent({ ...event, recurrence_rule: "FREQ=DAILY;COUNT=3" }, "2026-10-01T00:00:00", "2026-11-01T00:00:00").length, 3);
});

test("ежемесячно 31-го — только в месяцах, где он есть", () => {
  const rows = expandEvent({ id: "2", starts_at: "2026-01-31T09:00:00", ends_at: "2026-01-31T10:00:00", recurrence_rule: "FREQ=MONTHLY" }, "2026-01-01T00:00:00", "2026-06-01T00:00:00");
  assert.deepEqual(starts(rows), ["2026-01-31T09:00:00", "2026-03-31T09:00:00", "2026-05-31T09:00:00"]);
});

test("одиночное событие: внутри диапазона — да, кончилось до него — нет", () => {
  assert.equal(expandEvent({ ...event, recurrence_rule: null }, "2026-10-05T00:00:00", "2026-10-06T00:00:00").length, 1);
  assert.equal(expandEvent({ ...event, recurrence_rule: null }, "2026-10-06T00:00:00", "2026-10-07T00:00:00").length, 0);
});

test("повтор задачи: следующий срок", () => {
  assert.equal(nextDue("2026-10-09", "weekdays"), "2026-10-12");
  assert.equal(nextDue("2026-10-07", "weekly"), "2026-10-14");
  assert.equal(nextDue("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(nextDue("2026-10-07", "never"), null);
});

test("props задачи: null удаляет ключ, хозяина правкой не сменить, мусор отбрасывается", () => {
  const next = mergeProps({ owner_user_id: "1", due: "2026-10-07", source: "x" }, { due: null, owner_user_id: "2", repeat: "hourly", assignees: ["user:1", "user:1", "agent:Claude"] });
  assert.deepEqual(next, { owner_user_id: "1", source: "x", assignees: ["user:1", "agent:Claude"] });
});

test("поля события: время к локальному виду, правило нормализуется, неизвестный цвет — синий", () => {
  const fields = eventFields({ start: "2026-10-07T10:00", end: "2026-10-07 11:30:00", color: "pink", recurrence_rule: "RRULE:freq=weekly;byday=MO" });
  assert.equal(fields.starts_at, "2026-10-07T10:00:00");
  assert.equal(fields.ends_at, "2026-10-07T11:30:00");
  assert.equal(fields.color, "blue");
  assert.deepEqual(parseRule(fields.recurrence_rule), { FREQ: "WEEKLY", BYDAY: "MO" });
  assert.equal(eventFields({ title: "x" }).starts_at, undefined);
});

test("локальные даты не сдвигаются на UTC", () => {
  assert.equal(isoLocal(localDate("2026-10-06T09:30:00")), "2026-10-06T09:30:00");
});

test("автоматизация события: агент и задание обязательны, лишнее отбрасывается", async () => {
  const { automationOf } = await import("./planner.mjs");
  assert.deepEqual(automationOf({ agent: " Claude ", prompt: " Собери отчёт ", project_id: "7", junk: 1 }), { agent: "Claude", prompt: "Собери отчёт", project_id: "7" });
  assert.equal(automationOf({ agent: "Claude", prompt: "  " }), null);
  assert.equal(automationOf({ prompt: "x" }), null);
  assert.deepEqual(automationOf({ agent: "Джарвис", prompt: "x", project_id: "abc" }), { agent: "Джарвис", prompt: "x" });
});

test("стена часов — по поясу человека, а не сервера", async () => {
  const { wallClock } = await import("./planner.mjs");
  assert.equal(wallClock(new Date("2026-10-07T12:00:00Z"), "Europe/Moscow"), "2026-10-07T15:00:00");
  assert.equal(wallClock(new Date("2026-10-07T21:30:00Z"), "Europe/Moscow"), "2026-10-08T00:30:00");
});
