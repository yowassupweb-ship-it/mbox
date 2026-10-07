import assert from "node:assert/strict";
import test from "node:test";
import { enrichFocus } from "./focus-excerpt.mjs";
import { focusLines } from "./chat-threads.mjs";

const item = (context) => ({ id: 1, props: { context } });

test("у открытой заметки, документа, таблицы и задачи появляется начало содержимого", async () => {
  const calls = [];
  const fetchJson = async (path) => {
    calls.push(path);
    if (path.startsWith("/api/mbox/notes/")) return { note: { tabs: [{ title: "Основная", content: "Первая строка заметки\n\n\n\nвторая" }] } };
    if (path.startsWith("/api/mbox/documents/")) return { markdown: "# Регламент\n" + "текст ".repeat(300) };
    if (path.startsWith("/api/mbox/tables/")) return { sheet: "Лист 1", columns: ["A", "B"], rows: [{ row: 1, cells: ["Тур", "Цена"] }, { row: 2, cells: ["Казань", "5000"] }] };
    return { todo: { note: "Сделать поиск" } };
  };
  const enriched = await enrichFocus(item([{ kind: "note", id: "5", title: "Идеи" }, { kind: "doc", id: "7", title: "Регламент" }, { kind: "table", id: "3", title: "Туры" }, { kind: "todo", id: "9", title: "Задача" }]), fetchJson);
  const lines = focusLines(enriched).join("\n");
  assert.match(lines, /Первая строка заметки/);
  assert.match(lines, /# Регламент/);
  assert.match(lines, /truncated/);
  assert.match(lines, /1: Тур \| Цена/);
  assert.match(lines, /Сделать поиск/);
  assert.equal(calls.length, 4);
});

test("исходное сообщение не меняется, ошибка чтения не ломает ответ, чужие виды не читаются", async () => {
  const original = item([{ kind: "note", id: "5", title: "Идеи" }, { kind: "web", detail: "https://example.com" }, { kind: "doc", id: "x1", title: "Плохой id" }]);
  const result = await enrichFocus(original, async () => { throw new Error("down"); });
  assert.equal(original.props.context[0].excerpt, undefined);
  assert.ok(focusLines(result).join("\n").includes("MBOX note #5"));
  assert.ok(!focusLines(result).join("\n").includes("begins"));
});

test("без вкладок сообщение возвращается как есть", async () => {
  const empty = { id: 2, props: {} };
  assert.equal(await enrichFocus(empty, async () => ({})), empty);
});
