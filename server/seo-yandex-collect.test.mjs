import assert from "node:assert/strict";
import test from "node:test";
import { collectYandexView } from "./seo-wizard.mjs";

// Весь сборщик на подставных ответах API Вебмастера: ловит необъявленные имена и неверный порядок вызовов, которые синтаксис не видит.
test("сборщик «Яндекс видит» проходит целиком, постранично собирает страницы и пишет снимок", async () => {
  process.env.YANDEX_WEBMASTER_TOKEN = "test-token";
  process.env.YANDEX_WEBMASTER_HOST_ID = "https:vs-travel.ru:443";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (url.pathname === "/v4/user") return json({ user_id: 42 });
    if (url.pathname.endsWith("/summary")) return json({ sqi: 1570, excluded_pages_count: 3345, searchable_pages_count: 250 });
    if (url.pathname.endsWith("/diagnostics")) return json({ problems: {} });
    if (url.pathname.endsWith("/recrawl/quota")) return json({ daily_quota: 1280, quota_remainder: 1280 });
    if (url.pathname.endsWith("/indexing/history")) return json({ indicators: {} });
    if (url.pathname.endsWith("/search-urls/in-search/history")) return json({ history: [{ date: "2026-10-07T10:00:00.000+03:00", value: 250 }] });
    if (url.pathname.endsWith("/important-urls")) return json({ urls: [] });
    if (url.pathname.endsWith("/links/external/history")) return json({ indicators: {} });
    if (url.pathname.endsWith("/search-urls/in-search/samples")) {
      const offset = Number(url.searchParams.get("offset"));
      const count = Math.min(100, 250 - offset);
      return json({ count: 250, samples: Array.from({ length: Math.max(0, count) }, (_, i) => ({ url: `https://vs-travel.ru/tour?id=${offset + i}`, title: "Тур", last_access: "2026-10-09T01:00:00.000+03:00" })) });
    }
    if (url.pathname.endsWith("/links/external/samples")) return json({ count: 2, links: [{ source_url: "https://a.ru/x", destination_url: "https://vs-travel.ru/old.php", discovery_date: "2026-10-01" }, { source_url: "https://b.ru/y", destination_url: "https://vs-travel.ru/", discovery_date: "2026-10-02" }] });
    throw new Error(`неожиданный адрес ${url.pathname}`);
  };
  const writes = { snapshots: 0, pagesInserted: 0, deleted: 0 };
  const query = async (sql, params = []) => {
    if (/INSERT INTO seo_yandex_snapshots/.test(sql)) { writes.snapshots += 1; return { rows: [] }; }
    if (/INSERT INTO seo_yandex_pages/.test(sql)) { writes.pagesInserted += JSON.parse(params[0]).length; return { rows: [] }; }
    if (/DELETE FROM seo_yandex_pages/.test(sql)) { writes.deleted += 1; return { rows: [] }; }
    return { rows: [] }; // схема, настройки: пусто — токен и сайт берутся из окружения
  };
  try {
    const result = await collectYandexView(query);
    assert.equal(result.in_search, 250);
    assert.equal(result.collected, 250);
    assert.equal(result.links, 2);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(writes, { snapshots: 1, pagesInserted: 250, deleted: 1 });
    assert.equal(calls.filter((item) => item.includes("/in-search/samples")).length, 3, "250 страниц = три запроса по 100");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.YANDEX_WEBMASTER_TOKEN;
    delete process.env.YANDEX_WEBMASTER_HOST_ID;
  }
});
