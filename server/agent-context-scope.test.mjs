import assert from "node:assert/strict";
import test from "node:test";
import { buildFullAgentContext, parseContextParams, taskRecallQuery, FULL_DEFAULT_LIMIT, FULL_MAX_LIMIT, FULL_NOTE_LIMIT } from "./agent-context-scope.mjs";

const parse = (query) => parseContextParams(new URL(`http://x/api/mbox/agent/context${query}`));
const longText = "слово ".repeat(1000);

function fixture() {
  return {
    project: { id: "1", name: "MBOX" },
    todos: [
      { id: "1", title: "закрыта", status: "done", note: "x" },
      { id: "2", title: "открыта", status: "open", note: longText },
      { id: "3", title: "next", status: "next", note: "коротко" },
    ],
    runs: Array.from({ length: 120 }, (_, i) => ({ id: String(i) })),
    secrets: [{ id: "s1", password: "p" }],
  };
}

test("параметры: значения по умолчанию, границы и фильтр секций", () => {
  const defaults = parse("");
  assert.equal(defaults.limit, FULL_DEFAULT_LIMIT);
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.sections.length, 8);
  assert.equal(parse("?limit=99999").limit, FULL_MAX_LIMIT);
  assert.equal(parse("?limit=-5").limit, 1);
  assert.deepEqual(parse("?sections=runs,nope,todos").sections, ["todos", "runs"]);
  assert.equal(parse("?task_id=496abc").taskId, "496");
});

test("full: закрытые задачи скрыты, длинные заметки обрезаны", () => {
  const out = buildFullAgentContext(fixture(), parse("?sections=todos"));
  assert.deepEqual(out.todos.map((t) => t.id), ["2", "3"]);
  assert.equal(out.todos[0].note_truncated, true);
  assert.ok(out.todos[0].note.length <= FULL_NOTE_LIMIT);
  assert.equal(out.todos[1].note_truncated, undefined);
  assert.equal(parse("?include_closed=1").includeClosed, true);
  assert.equal(buildFullAgentContext(fixture(), parse("?sections=todos&include_closed=1")).todos.length, 3);
});

test("full: страницы и next_offset", () => {
  const first = buildFullAgentContext(fixture(), parse("?sections=runs&limit=50"));
  assert.equal(first.runs.length, 50);
  assert.deepEqual(first.page.runs, { total: 120, offset: 0, returned: 50, next_offset: 50 });
  const last = buildFullAgentContext(fixture(), parse("?sections=runs&limit=50&offset=100"));
  assert.equal(last.runs.length, 20);
  assert.equal(last.page.runs.next_offset, null);
});

test("full: невыбранные секции не попадают в ответ, секреты только по запросу секции", () => {
  const out = buildFullAgentContext(fixture(), parse("?sections=runs"));
  assert.equal(out.todos, undefined);
  assert.equal(out.approved_secrets, undefined);
  assert.equal(buildFullAgentContext(fixture(), parse("?sections=approved_secrets")).approved_secrets.length, 1);
});

test("recall под задачу берёт заголовок и начало заметки", () => {
  const query = taskRecallQuery({ title: "Контекст", note: longText }, { name: "MBOX" });
  assert.ok(query.startsWith("Контекст"));
  assert.ok(query.length < 700);
  assert.equal(taskRecallQuery(null, { name: "MBOX" }), "");
});
