import assert from "node:assert/strict";
import test from "node:test";
import { formatSearch } from "./search-format.mjs";

const rows = [
  { kind: "note", id: "5", title: "Правки corp", project: "Вокруг света", snippet: "…цена тура 1183 выросла…" },
  { kind: "todo", id: "382", title: "Вкладка отдаёт содержимое", project: "MBOX", status: "doing", snippet: "шаг 1 сделан" },
  { kind: "memory", id: "2079", title: "Иконки", snippet: "подключены" },
];

test("каждая строка говорит, чем читать найденное", () => {
  const out = formatSearch(rows, { query: "тур" });
  assert.match(out, /^Найдено по «тур» \(3\):/);
  assert.match(out, /note #5 «Правки corp» \[Вокруг света\].*\n\s+читать: note_read 5/);
  assert.match(out, /todo #382.*\[MBOX, doing\].*\n\s+читать: get_task 382/);
  assert.match(out, /читать: get_memory 2079/);
});

test("фильтр по видам и лимит", () => {
  const out = formatSearch(rows, { query: "x", kinds: ["todo"] });
  assert.match(out, /\(1\)/);
  assert.doesNotMatch(out, /note #5/);
  assert.equal(formatSearch(rows, { query: "x", limit: 2 }).split("читать:").length - 1, 2);
});

test("запасной режим объясняет, что слова искались по отдельности", () => {
  assert.match(formatSearch(rows, { query: "тур цена", fallback: true }), /пусто — показано, где встречается ЛЮБОЕ/);
});

test("пустой результат подсказывает, что делать", () => {
  assert.match(formatSearch([], { query: "zzz", kinds: ["note"] }), /Ничего не найдено по «zzz» среди: note/);
});
