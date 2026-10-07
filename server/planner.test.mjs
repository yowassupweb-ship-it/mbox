import test from "node:test";
import assert from "node:assert/strict";
import { expandRecurringEvent, isoLocal, localDate } from "./planner.mjs";

const event = { id: "1", starts_at: "2026-10-05T10:00:00", ends_at: "2026-10-05T11:00:00", recurrence_rule: "FREQ=WEEKLY;BYDAY=MO,WE" };
test("expands weekly weekdays and preserves duration", () => {
  const rows = expandRecurringEvent(event, "2026-10-05", "2026-10-12T23:59:59");
  assert.deepEqual(rows.map((row) => row.starts_at), ["2026-10-05T10:00:00", "2026-10-07T10:00:00", "2026-10-12T10:00:00"]);
  assert.equal(rows[1].ends_at, "2026-10-07T11:00:00");
});
test("returns a single non-recurring event inside range", () => {
  assert.equal(expandRecurringEvent({ ...event, recurrence_rule: null }, "2026-10-05", "2026-10-06").length, 1);
});
test("local calendar dates do not acquire a UTC shift", () => {
  assert.equal(isoLocal(localDate("2026-10-06T09:30:00")), "2026-10-06T09:30:00");
});
