import assert from "node:assert/strict";
import test from "node:test";
import { conclude, pathForExample, spread } from "./seo-verify.mjs";

const page = (path, over = {}) => ({ path, status: 200, noindex: false, canonical_self: true, text_chars: 500, ...over });

test("пример находки превращается в адрес для проверки", () => {
  assert.equal(pathForExample({ path: "тур № 1079" }), "/tour?id=1079");
  assert.equal(pathForExample({ path: "/ajax/x" }), "/ajax/x");
  assert.equal(pathForExample({ path: "золотому" }), "");
});

test("выборка равномерная: начало, середина и конец, а не первые N", () => {
  const list = Array.from({ length: 100 }, (_, i) => i);
  const picked = spread(list, 10);
  assert.equal(picked.length, 10);
  assert.equal(picked[0], 0);
  assert.ok(picked[9] >= 90);
  assert.deepEqual(spread([1, 2], 10), [1, 2]);
});

test("туры не в sitemap: рабочие индексируемые страницы подтверждают находку, закрытые и чужой canonical — нет", () => {
  const good = Array.from({ length: 10 }, (_, i) => page(`/tour?id=${i}`));
  assert.equal(conclude("01_tours_missing_from_sitemap", good).verdict, "confirmed");
  const mixed = [...good.slice(0, 5), page("/tour?id=90", { noindex: true }), page("/tour?id=91", { canonical_self: false }), page("/tour?id=92", { status: 404 }), page("/tour?id=93", { status: 404 }), page("/tour?id=94", { status: 404 })];
  const out = conclude("01_tours_missing_from_sitemap", mixed);
  assert.equal(out.verdict, "partly");
  assert.equal(out.bad.length, 5);
  assert.equal(conclude("01_tours_missing_from_sitemap", [page("/tour?id=1", { status: 404 })]).verdict, "not_confirmed");
});

test("битые адреса и пустые страницы: подтверждается тем, что проблема на месте", () => {
  assert.equal(conclude("01_sitemap_broken", [page("/a", { status: 404 }), page("/b", { status: 500 })]).verdict, "confirmed");
  assert.equal(conclude("01_sitemap_broken", [page("/a"), page("/b")]).verdict, "not_confirmed");
  const empty = conclude("01_sitemap_empty_pages", [page("/a", { text_chars: 3 }), page("/b", { text_chars: 10 })]);
  assert.equal(empty.verdict, "confirmed");
  assert.match(empty.text, /JavaScript/);
  assert.match(empty.text, /2 страницы/);
});

test("canonical и технические адреса", () => {
  assert.equal(conclude("01_sitemap_canonical_elsewhere", [page("/a", { canonical_self: false })]).verdict, "confirmed");
  assert.equal(conclude("01_sitemap_technical", [page("/ajax/a", { noindex: true })]).verdict, "not_confirmed");
  assert.equal(conclude("unknown_detector", []).verdict, "unknown");
});
