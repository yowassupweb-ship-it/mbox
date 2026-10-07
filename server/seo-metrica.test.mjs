import test from "node:test";
import assert from "node:assert/strict";
import { metricaCountersOf } from "./seo-wizard.mjs";

test("старые настройки Метрики (один счётчик + ID целей по ролям) превращаются в список счётчиков", () => {
  const counters = metricaCountersOf({ metrica_counter_id: "12345", metrica_goals: { lead: "111222, 333444", booking: "555666" } });
  assert.equal(counters.length, 1);
  assert.equal(counters[0].id, "12345");
  assert.deepEqual(counters[0].goals.map((goal) => [goal.id, goal.role]), [["111222", "lead"], ["333444", "lead"], ["555666", "booking"]]);
});

test("новый список счётчиков важнее старых полей; мусорные ID и роли отбрасываются, описание сохраняется", () => {
  const counters = metricaCountersOf({
    metrica_counter_id: "12345",
    metrica_counters: [
      { id: "999", name: "Сайт", goals: [{ id: "1", role: "lead", description: "Заявка с формы" }, { id: "x" }, { id: "2", role: "evil" }, { id: "1", role: "booking" }] },
      { id: "999" },
      { id: "777", goals: [] },
    ],
  });
  assert.deepEqual(counters.map((counter) => counter.id), ["999", "777"]);
  assert.deepEqual(counters[0].goals, [
    { id: "1", name: "", type: "", role: "lead", description: "Заявка с формы" },
    { id: "2", name: "", type: "", role: "", description: "" },
  ]);
});

test("без счётчиков — пустой список", () => {
  assert.deepEqual(metricaCountersOf({}), []);
  assert.deepEqual(metricaCountersOf({ metrica_counter_id: "abc" }), []);
});
