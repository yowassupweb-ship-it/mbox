import assert from "node:assert/strict";
import test from "node:test";
import { adviceFor, classifyTarget, cleanAnchor, priorityOf } from "./seo-links-kind.mjs";

test("текст ссылки: пустой — значок, длинный блок — обрезается, nbsp убирается", () => {
  assert.equal(cleanAnchor(""), "(значок без текста)");
  assert.equal(cleanAnchor("  Подробнее&nbsp;о туре "), "Подробнее о туре");
  assert.match(cleanAnchor(`Подробнее Автор: Юлия Лавринова 04.12.2025 ${"текст ".repeat(30)}`), /… \(ссылка-блок\)$/);
});

test("тип ссылки по адресу и параметру", () => {
  assert.equal(classifyTarget("/lk/profile?favorites=1", "favorites").kind, "cabinet");
  assert.equal(classifyTarget("/podbor-tura?TopFilter_topic=216", "TopFilter_topic").kind, "filter");
  assert.equal(classifyTarget("/podbor-tura/?s=калуга", "s").kind, "search");
  assert.equal(classifyTarget("/sale/?page=2", "page").kind, "pagination");
  assert.equal(classifyTarget("/toursh_list.php?mode=place", "mode").kind, "legacy");
  assert.equal(classifyTarget("/x?utm=1", "utm").label, "Параметр ?utm=");
});

test("совет называет число страниц и либо чистый адрес, либо что решить", () => {
  assert.match(adviceFor({ kind: "cabinet", pages: 1595, should: "" }), /1\s?595 страницах/);
  assert.match(adviceFor({ kind: "filter", pages: 819, should: "" }), /сделайте ЧПУ/);
  assert.match(adviceFor({ kind: "filter", pages: 819, should: "/podbor-tura/novyy-god" }), /\/podbor-tura\/novyy-god/);
  assert.match(adviceFor({ kind: "legacy", pages: 1, should: "" }), /301/);
  assert.match(adviceFor({ kind: "search", pages: 1, should: "" }), /noindex/);
});

test("порядок: с известным чистым адресом выше, пагинация в конце", () => {
  assert.ok(priorityOf({ kind: "filter", pages: 2, should: "/x" }) > priorityOf({ kind: "cabinet", pages: 1595, should: "" }));
  assert.equal(priorityOf({ kind: "pagination", pages: 500, should: "" }), 0);
});
