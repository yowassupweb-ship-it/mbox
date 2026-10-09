import assert from "node:assert/strict";
import test from "node:test";
import { extractMarkup, jsonLdTypes } from "./seo-markup.mjs";

const html = `<!doctype html><html lang="ru"><head>
<title>Тур</title>
<meta name="description" content="Описание &amp; цена">
<meta name="robots" content="index, FOLLOW">
<meta name="viewport" content="width=device-width">
<meta property="og:title" content="OG заголовок">
<meta property="og:image" content="https://x/y.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" hreflang="en" href="https://x/en">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Тур","offers":{"@type":"Offer"}},{"@type":["BreadcrumbList","Thing"]}]}</script>
<script type="application/ld+json">{ битый json </script>
</head><body>
<h1>Тур по Золотому кольцу</h1>
<h2>Программа</h2><h2>Что включено</h2><h3>День 1</h3>
<img src="a.jpg" alt="Владимир"><img src="b.jpg"><img src="c.jpg" alt="">
<p itemscope>Едем во Владимир и Суздаль на автобусе</p>
<script>var x = "не текст страницы";</script>
</body></html>`;

test("метатеги, OG, robots, язык и hreflang", () => {
  const m = extractMarkup(html);
  assert.equal(m.description, "Описание & цена");
  assert.equal(m.robots, "index, follow");
  assert.equal(m.lang, "ru");
  assert.equal(m.viewport, true);
  assert.equal(m.og.title, "OG заголовок");
  assert.equal(m.og.image, "https://x/y.jpg");
  assert.equal(m.twitter_card, "summary_large_image");
  assert.deepEqual(m.hreflang, ["en"]);
});

test("JSON-LD: вложенные типы из @graph и массивов, битый блок считается отдельно", () => {
  const ld = jsonLdTypes(html);
  assert.equal(ld.blocks, 2);
  assert.equal(ld.broken, 1);
  assert.deepEqual(ld.types, ["BreadcrumbList", "Offer", "Product", "Thing"]);
  assert.equal(extractMarkup(html).schema.microdata, 1);
});

test("заголовки, картинки без alt и слова без скриптов", () => {
  const m = extractMarkup(html);
  assert.equal(m.h2_count, 2);
  assert.deepEqual(m.h2, ["Программа", "Что включено"]);
  assert.equal(m.h3_count, 1);
  assert.equal(m.images, 3);
  assert.equal(m.images_without_alt, 2);
  assert.ok(m.words > 5 && m.words < 25);
});

test("пустой HTML не ломает разбор", () => {
  const m = extractMarkup("");
  assert.equal(m.description, "");
  assert.equal(m.schema.types.length, 0);
  assert.equal(m.words, 0);
});
