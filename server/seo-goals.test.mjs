import assert from "node:assert/strict";
import test from "node:test";
import { goalsCsv } from "./seo-wizard.mjs";

test("CSV целей: BOM, разделитель «;», кавычки и переводы строк экранируются", () => {
  const csv = goalsCsv({ goals: [{ counter: "VS", counter_id: "1", site: "vs-travel.ru", goal_id: "7", goal: 'Клик "Позвонить"; шапка', type: "action", role: "lead", reaches_all: 10, conversion_all: 1.5, reaches_organic: 4, conversion_organic: 0.8, reaches_organic_prev: 2, change_organic: 100 }] });
  assert.ok(csv.startsWith("﻿Счётчик;"));
  const [, row] = csv.trim().split("\r\n");
  assert.ok(row.includes('"Клик ""Позвонить""; шапка"'));
  assert.ok(row.endsWith(";4;0.8;2;100"));
});
