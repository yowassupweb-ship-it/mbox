import test from "node:test";
import assert from "node:assert/strict";
import { htmlText, htmlTitle, starterHtml, handleDesignSystemsApi } from "./design-systems.mjs";

test("htmlText оставляет только видимый текст без стилей и скриптов", () => {
  const text = htmlText("<style>a{color:red}</style><h1>Цвета&nbsp;бренда</h1><script>alert(1)</script><!-- заметка --><p>Синий &amp; белый</p>");
  assert.equal(text, "Цвета бренда Синий & белый");
});

test("htmlTitle берёт <title>, иначе первый <h1>", () => {
  assert.equal(htmlTitle("<title>Система А</title><h1>Другое</h1>"), "Система А");
  assert.equal(htmlTitle("<body><h1>Только <b>заголовок</b></h1></body>"), "Только заголовок");
  assert.equal(htmlTitle("<p>без заголовков</p>"), "");
});

test("starterHtml — самодостаточная страница и название не ломает разметку", () => {
  const html = starterHtml('Бренд <script>"x"</script>');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<script>/);
});

test("чужие пути обработчик не берёт, участник без проекта не создаёт в чужом", async () => {
  const sent = [];
  const base = { res: {}, readBody: async () => ({ title: "x", project_id: "7" }), sendJson: (_res, status, body) => sent.push({ status, body }), query: async () => ({ rows: [] }), actor: "t" };
  assert.equal(await handleDesignSystemsApi({ ...base, req: { method: "GET" }, url: new URL("http://x/api/mbox/notes") }), false);
  assert.equal(await handleDesignSystemsApi({ ...base, req: { method: "POST" }, url: new URL("http://x/api/mbox/design-systems"), scope: { all: false, projectIds: ["1"], userId: "5" } }), true);
  assert.equal(sent[0].status, 403);
});
