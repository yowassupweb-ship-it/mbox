import assert from "node:assert/strict";
import test from "node:test";
import { goalsCsv } from "./seo-wizard.mjs";

test("CSV целей: BOM, разделитель «;», кавычки и переводы строк экранируются", () => {
  const csv = goalsCsv({ goals: [{ counter: "VS", counter_id: "1", site: "vs-travel.ru", goal_id: "7", goal: 'Клик "Позвонить"; шапка', type: "action", role: "lead", reaches_all: 10, conversion_all: 1.5, reaches_organic: 4, conversion_organic: 0.8, reaches_organic_prev: 2, change_organic: 100 }] });
  assert.ok(csv.startsWith("﻿Счётчик;"));
  const [, row] = csv.trim().split("\r\n");
  assert.ok(row.includes('"Клик ""Позвонить""; шапка"'));
  assert.ok(row.endsWith(";4;0.8;2;100;"));
});

test("комментарии к целям попадают в список для агентов; цели без роли и без комментария не шумят", async () => {
  const { goalNotesOf } = await import("./seo-wizard.mjs");
  const notes = goalNotesOf({ metrica_counters: [{ id: "1", name: "VS", site: "vs-travel.ru", goals: [
    { id: "10", name: "Клик купить", role: "", description: "Покупательское намерение: ближе всего к заявке" },
    { id: "11", name: "Раздел туров", role: "track", description: "" },
    { id: "12", name: "Шумная", role: "", description: "" },
  ] }] });
  assert.deepEqual(notes.map((item) => item.goal_id), ["10", "11"]);
  assert.equal(notes[0].note, "Покупательское намерение: ближе всего к заявке");
});

test("CSV содержит колонку комментария", () => {
  const csv = goalsCsv({ goals: [{ counter: "VS", counter_id: "1", site: "s", goal_id: "7", goal: "g", type: "", role: "", note: "польза", reaches_all: 1, conversion_all: 1, reaches_organic: 1, conversion_organic: 1, reaches_organic_prev: 0, change_organic: null }] });
  assert.ok(csv.split("\r\n")[0].endsWith("Польза цели (комментарий)"));
  assert.ok(csv.split("\r\n")[1].endsWith(";польза"));
});

test("в задачу уходит начало списков доказательств, а не тысяча адресов", async () => {
  const { evidenceForTask } = await import("./seo-wizard.mjs");
  const text = evidenceForTask({ param: "favorites", sample_targets: Array.from({ length: 248 }, (_, i) => `/t${i}`), count: 248 });
  const parsed = JSON.parse(text);
  assert.equal(parsed.sample_targets.length, 26);
  assert.match(parsed.sample_targets[25], /ещё 223/);
  assert.equal(parsed.count, 248);
});
