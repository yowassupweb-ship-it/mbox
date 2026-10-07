import assert from "node:assert/strict";
import test from "node:test";
import { applyFragmentEdit, closestFragment } from "./fragment-edit.mjs";

const NOTE = ["# Заголовок", "", "Первый абзац про тур 1183.", "Второй абзац: «цена» 100 руб.", "", "Итог."].join("\n");

test("точное совпадение работает как раньше", () => {
  const out = applyFragmentEdit(NOTE, "Итог.", "Конец.");
  assert.equal(out.fuzzy, false);
  assert.ok(out.text.endsWith("Конец."));
});

test("несколько совпадений: ошибка с номерами строк, replace_all заменяет все", () => {
  const text = "a\nb\na\nb";
  assert.throws(() => applyFragmentEdit(text, "a", "x"), /occurs 2 times \(lines 1, 3\)/);
  assert.equal(applyFragmentEdit(text, "a", "x", { replaceAll: true }).text, "x\nb\nx\nb");
});

test("единственное совпадение без учёта пробелов, переносов и кавычек применяется само", () => {
  const out = applyFragmentEdit(NOTE, 'Второй   абзац:\n"цена" 100 руб.', "Второй абзац: цена 120 руб.");
  assert.equal(out.fuzzy, true);
  assert.ok(out.text.includes("Второй абзац: цена 120 руб."));
  assert.ok(out.text.includes("Первый абзац про тур 1183."));
  assert.ok(out.text.endsWith("Итог."));
});

test("устаревший old_text: ошибка показывает ближайший фрагмент с номером строки", () => {
  assert.throws(
    () => applyFragmentEdit(NOTE, "Первый абзац про тур 1100.", "x", { what: "the note" }),
    (error) => /not found in the note \(6 lines\)/.test(error.message) && /line 3/.test(error.message) && /Первый абзац про тур 1183/.test(error.message),
  );
});

test("совсем непохожий текст: подсказка перечитать", () => {
  assert.throws(() => applyFragmentEdit(NOTE, "zzz qqq", "x", { reread: "re-read it with note_read" }), /Nothing similar found — re-read it with note_read/);
});

test("closestFragment не выдумывает совпадение", () => {
  assert.equal(closestFragment(NOTE, "совсем другое"), null);
});
