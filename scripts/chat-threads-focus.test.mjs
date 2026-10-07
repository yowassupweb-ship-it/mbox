import assert from "node:assert/strict";
import test from "node:test";
import { focusLines } from "./chat-threads.mjs";

const lines = (context) => focusLines({ props: { context } }).slice(1);

test("открытые документ, таблица и файл хранилища приходят с id и инструментом чтения", () => {
  const out = lines([
    { kind: "doc", id: "12", title: "Правки corp" },
    { kind: "table", id: "7", title: "ЖД 2023-2025" },
    { kind: "mbox-file", id: "9", title: "scan.pdf" },
  ]);
  assert.match(out[0], /document #12 «Правки corp».*doc_read/);
  assert.match(out[1], /table #7 «ЖД 2023-2025».*table_read/);
  assert.match(out[2], /storage file #9 «scan\.pdf».*storage_read/);
});

test("неизвестный вид вкладки не теряет id", () => {
  assert.deepEqual(lines([{ kind: "gadget", id: "5", title: "Что-то" }]), ["- gadget #5: Что-то"]);
});

test("пустой контекст не даёт блока", () => {
  assert.deepEqual(focusLines({ props: {} }), []);
});
