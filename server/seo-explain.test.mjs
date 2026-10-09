import assert from "node:assert/strict";
import test from "node:test";
import { examplesOf, explainIssue } from "./seo-explain.mjs";

test("примеры из разных форм evidence приводятся к одному виду", () => {
  assert.deepEqual(examplesOf("x", { sample_urls: ["/ajax/a", { path: "/b", lastmod: "2023-01-01" }] }), [{ path: "/ajax/a", note: "" }, { path: "/b", note: "lastmod 2023-01-01" }]);
  assert.deepEqual(examplesOf("x", { sample: [{ path: "/p", canonical: "/q" }, { path: "/r", status: 404 }, { path: "/e", bytes: 0 }] }).map((i) => i.note), ["canonical → /q", "HTTP 404", "0 байт"]);
  assert.equal(examplesOf("x", { param: "favorites", source_pages: ["/a"] })[0].note, "ссылается на ?favorites=");
  assert.equal(examplesOf("x", { url: "https://s/", status_code: 200 })[0].note, "HTTP 200");
  assert.deepEqual(examplesOf("x", null), []);
});

test("подробности: пояснение по детектору, примеры с показами и пометка об усечении", () => {
  const out = explainIssue(
    { id: "5", detector: "01_sitemap_broken", severity: "high", status: "open", title: "t", summary: "s", affected_count: 111, potential_score: 666, evidence: { by_status: { 404: 100, 301: 11 }, sample: [{ path: "/a", status: 404 }] } },
    { "/a": { impressions: 1200, clicks: 30 } },
  );
  assert.match(out.what, /не 200/);
  assert.equal(out.potential.formula, "число адресов × 6");
  assert.deepEqual(out.examples[0], { path: "/a", note: "HTTP 404", impressions: 1200, clicks: 30 });
  assert.deepEqual(out.affected, { total: 111, shown: 1, truncated: true });
  assert.deepEqual(out.counts.by_status, { 404: 100, 301: 11 });
});

test("неизвестный детектор не ломает разбор", () => {
  const out = explainIssue({ id: "1", detector: "new_one", title: "t", summary: "что-то нашли", affected_count: 0, potential_score: 0, evidence: {} });
  assert.equal(out.what, "что-то нашли");
  assert.deepEqual(out.examples, []);
});

test("ссылки на ?параметр: затронутые адреса — цели ссылок, с числом страниц-источников", () => {
  const out = examplesOf("02_internal_query_links", { param: "favorites", links: [
    { from: "/a", to: "/x?favorites=1" }, { from: "/b", to: "/x?favorites=1" }, { from: "/a", to: "/y?favorites=1" },
  ] });
  assert.deepEqual(out.map((item) => item.path), ["/x?favorites=1", "/y?favorites=1"]);
  assert.match(out[0].note, /ссылок с 2 страниц: \/a, \/b/);
  assert.equal(examplesOf("02", { param: "p", sample_targets: ["/t"] })[0].note, "адрес с параметром");
});
