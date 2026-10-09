import assert from "node:assert/strict";
import test from "node:test";
import { buildShortAgentContext, SHORT_LIMITS } from "./agent-context-short.mjs";

const longText = "слово ".repeat(500);

function fixture() {
  return {
    project: { id: "1", name: "MBOX", props: { philosophy: longText, short: "ok", obj: { a: longText } } },
    todos: [
      { id: "1", title: "закрыта", status: "done", priority: "high", note: longText, props: {} },
      { id: "2", title: "в архиве", status: "archived", priority: "low", note: "x", props: {} },
      { id: "3", title: "открыта", status: "open", priority: "high", note: longText, props: { a: 1 }, claimed_by: "Claude", claimed_until: "t", heartbeat_at: "h" },
      { id: "4", title: "следующая", status: "next", priority: "normal", note: "коротко", props: {} },
    ],
    decisions: Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `d${i}`, decision: longText })),
    inbox: Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: `i${i}`, body: longText })),
    runs: Array.from({ length: 30 }, (_, i) => ({ id: String(i), goal: longText, result: longText, touched_files: Array.from({ length: 30 }, (_, n) => `f${n}`) })),
    history: Array.from({ length: 30 }, (_, i) => ({ id: String(i), summary: longText })),
    memories: [{ id: "m1", title: "память", content_preview: longText, score: 0.5, extra: "lost" }],
  };
}

test("short оставляет только незакрытые задачи и считает остальные", () => {
  const out = buildShortAgentContext(fixture());
  assert.deepEqual(out.todos.map((t) => t.id), ["3", "4"]);
  assert.equal(out.counts.todos, 4);
  assert.equal(out.counts.todos_open, 2);
  assert.deepEqual(out.counts.todos_by_status, { done: 1, archived: 1, open: 1, next: 1 });
});

test("short обрезает тексты и списки до лимитов", () => {
  const out = buildShortAgentContext(fixture());
  assert.equal(out.decisions.length, SHORT_LIMITS.decisions);
  assert.equal(out.inbox.length, SHORT_LIMITS.inbox);
  assert.equal(out.runs.length, SHORT_LIMITS.runs);
  assert.equal(out.history.length, SHORT_LIMITS.history);
  assert.equal(out.counts.inbox, 30);
  assert.ok(out.todos[0].note_preview.length <= SHORT_LIMITS.todoNote);
  assert.equal(out.todos[0].note_truncated, true);
  assert.equal(out.todos[1].note_truncated, false);
  assert.ok(out.project.props.philosophy.length <= SHORT_LIMITS.propText);
  assert.equal(out.project.props.short, "ok");
  assert.ok(out.runs[0].touched_files.length <= 8);
  assert.ok(out.memories[0].content_preview.length <= SHORT_LIMITS.memoryText);
  assert.equal(out.memories[0].extra, undefined);
});

test("short не тащит пустые claimed_* и props_keys", () => {
  const out = buildShortAgentContext(fixture());
  assert.equal(out.todos[0].claimed_by, "Claude");
  assert.deepEqual(out.todos[0].props_keys, ["a"]);
  assert.equal("claimed_by" in out.todos[1], false);
  assert.equal("props_keys" in out.todos[1], false);
});

test("short остаётся компактным на большом проекте", () => {
  const input = fixture();
  input.todos = Array.from({ length: 300 }, (_, i) => ({ id: String(i), title: `t${i}`, status: i < 20 ? "open" : "done", priority: "normal", note: longText, props: {} }));
  const size = JSON.stringify(buildShortAgentContext(input)).length;
  assert.ok(size < 30000, `слишком большой ответ: ${size}`);
});

test("short показывает коммиты у незакрытых задач и список needs_closing", () => {
  const data = fixture();
  data.todos[2].commits = [{ sha: "abc12345", subject: "Fix lease (#3)" }];
  const out = buildShortAgentContext(data);
  assert.deepEqual(out.needs_closing, ["3"]);
  assert.deepEqual(out.todos[0].commits, ["abc12345 Fix lease (#3)"]);
  assert.equal(buildShortAgentContext(fixture()).needs_closing, undefined);
});
