import assert from "node:assert/strict";
import test from "node:test";
import { parseTodoRefs, recordCommit } from "./todo-commits.mjs";

test("простое упоминание привязывает, но не закрывает", () => {
  assert.deepEqual(parseTodoRefs("Email editor: drag blocks (#315)"), { refs: ["315"], closes: [] });
  assert.deepEqual(parseTodoRefs("Refs #7 and #8"), { refs: ["7", "8"], closes: [] });
});

test("Closes/Fixes/Закрывает закрывают, в том числе списком", () => {
  assert.deepEqual(parseTodoRefs("Fix lease sweep\n\nCloses #12, #13 и #14").closes, ["12", "13", "14"]);
  assert.deepEqual(parseTodoRefs("закрывает #5").closes, ["5"]);
  assert.deepEqual(parseTodoRefs("Done: #9 see also #10"), { refs: ["9", "10"], closes: ["9"] });
});

test("не путает хеши, ссылки и якоря с задачами", () => {
  assert.deepEqual(parseTodoRefs("color #fff, url/page#12, &#39;, a#5").refs, []);
  assert.deepEqual(parseTodoRefs("").refs, []);
});

function fakeQuery(todos) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM todos WHERE id = ANY/.test(sql)) return { rows: todos.filter((t) => params[0].includes(t.id)) };
    return { rows: [] };
  };
  return { query, calls };
}

test("recordCommit закрывает только открытые и только доступные", async () => {
  const { query, calls } = fakeQuery([
    { id: "1", project_id: "10", status: "doing" },
    { id: "2", project_id: "10", status: "done" },
    { id: "3", project_id: "99", status: "open" },
    { id: "4", project_id: "10", status: "open" },
  ]);
  const out = await recordCommit(query, { sha: "ABCDEF1234", message: "Work\n\nCloses #1, #2, #3\nRefs #4 #77" }, { canTouch: (p) => p === "10" });
  assert.deepEqual(out.closed, [{ id: "1", project_id: "10" }]);
  assert.deepEqual(out.already_closed, ["2"]);
  assert.deepEqual(out.forbidden, ["3"]);
  assert.deepEqual(out.unknown, ["77"]);
  assert.deepEqual(out.linked, ["1", "2", "4"]);
  assert.equal(calls.filter((c) => /SET status = 'done'/.test(c.sql)).length, 1);
});

test("recordCommit отклоняет плохой sha и пропускает коммит без номеров", async () => {
  const { query } = fakeQuery([]);
  await assert.rejects(() => recordCommit(query, { sha: "zzz", message: "#1" }), /invalid_sha/);
  assert.deepEqual((await recordCommit(query, { sha: "abcdef1", message: "no refs" })).linked, []);
});
