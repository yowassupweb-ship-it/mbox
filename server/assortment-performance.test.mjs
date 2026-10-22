// Сходимость с эталонной книгой владельца «Ассортимент_продажи.xlsx» (пять выгрузок CRM, 21 839 заездов,
// 1 280 туров, точка слияния архива и глубины 21.10.2026): статус тура, заполнение, даты с продажами,
// месяцы с продажами, первая и последняя продажа, давность, сезонные суммы, сезонный профиль и мёртвые сезоны
// совпадают с листом «Все туры» до знака. Эталон снят с книги; заезды — листы «ЖД детально» и «ТА детально».
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import {
  buildPerformance, buildSalesRows, performanceData, performanceInsights, seasonProfile, statusOf,
  STATUS_LABELS, SEASONS, DEAD_SEASON_MIN_DATES,
} from "./assortment-performance.mjs";

const dir = new URL("./fixtures/assortment/", import.meta.url);
const gz = (f) => JSON.parse(gunzipSync(readFileSync(new URL(f + ".json.gz", dir))).toString("utf8"));
const dates = gz("sales-dates");
const reference = gz("sales-reference");
const sales = buildSalesRows(dates, reference.cutoff);
const rowOf = (id) => sales.rows.get(id);

test("выгрузка разобрана целиком", () => {
  assert.equal(sales.rows.size, reference.tours.length);
  assert.equal([...sales.rows.values()].reduce((s, r) => s + r.sold, 0), 5458);
  assert.equal([...sales.rows.values()].reduce((s, r) => s + r.seats, 0), 209630);
});

test("статус тура совпадает с «Решением» книги", () => {
  const bad = reference.tours.filter((t) => STATUS_LABELS[rowOf(t.id).status] !== t.status);
  assert.deepEqual(bad.map((t) => [t.id, t.status, STATUS_LABELS[rowOf(t.id).status]]), []);
  const counts = {};
  for (const t of reference.tours) counts[rowOf(t.id).status] = (counts[rowOf(t.id).status] || 0) + 1;
  // цифры из листа «Сводка»: 535 без продаж (убрать + уже снят + новые без продаж), 47 в ядре
  assert.equal(counts.core, 47);
  assert.equal(counts.remove + counts.gone + counts.fresh, 535);
});

test("места, даты и заполнение совпадают с книгой", () => {
  for (const t of reference.tours) {
    const r = rowOf(t.id);
    const same = (field, want) => assert.equal(r[field], want, `тур ${t.id}: ${field} ${r[field]} != ${want}`);
    same("sold", t.sold);
    same("sold_past", t.sold_past);
    same("sold_future", t.sold_future);
    same("seats_past", t.seats_past);
    same("seats_future", t.seats_future);
    same("dates_past", t.dates_past);
    same("dates_future", t.dates_future);
    same("dates_sold", t.dates_sold);
    assert.equal(Math.round((r.fill_past ?? 0) * 1e4), Math.round((t.fill_past ?? 0) * 1e4), `тур ${t.id}: заполнение архива`);
  }
});

test("давность и месяцы с продажами совпадают с книгой", () => {
  for (const t of reference.tours) {
    const r = rowOf(t.id);
    assert.equal(r.months_sold, t.months_sold, `тур ${t.id}: месяцев с продажами`);
    assert.equal(r.first_sale === null ? null : new Date(r.first_sale * 86400000).toISOString().slice(0, 10), t.first_sale, `тур ${t.id}: первая продажа`);
    assert.equal(r.last_sale === null ? null : new Date(r.last_sale * 86400000).toISOString().slice(0, 10), t.last_sale, `тур ${t.id}: последняя продажа`);
    assert.equal(r.days_since_sale, t.days_since_sale, `тур ${t.id}: дней с последней продажи`);
  }
});

test("сезонные суммы считаются по архиву и совпадают с книгой", () => {
  for (const t of reference.tours) {
    const r = rowOf(t.id);
    for (const s of SEASONS) {
      assert.equal(r.seasons[s.id].sold, t.season_sold[s.id], `тур ${t.id}: ${s.label} продано`);
      assert.equal(r.seasons[s.id].dates, t.season_dates[s.id], `тур ${t.id}: ${s.label} дат`);
    }
  }
});

test("сезонный профиль и мёртвые сезоны совпадают с книгой", () => {
  for (const t of reference.tours) {
    const r = rowOf(t.id);
    assert.equal(r.profile, t.profile, `тур ${t.id}: профиль`);
    const want = t.dead_seasons ? t.dead_seasons.split(",") : [];
    const got = r.dead_seasons.map((id) => SEASONS.find((s) => s.id === id).label);
    assert.deepEqual(got, want, `тур ${t.id}: мёртвые сезоны`);
  }
});

test("сводные цифры по отделам и статусам — как в «Сводке»", () => {
  const perf = buildPerformance([], sales);
  assert.equal(perf.totals.tours, 1280);
  assert.equal(perf.totals.sold, 5458);
  assert.equal(perf.totals.seats, 209630);
  assert.equal(perf.totals.seats_past, 152620);
  assert.equal(perf.totals.seats_future, 57010);
  assert.equal(perf.totals.dates_past, 16209);
  assert.equal(perf.totals.dates_future, 5630);
  assert.equal(perf.totals.dates_sold, 1752);
  const rail = perf.by_dept.find((d) => d.dept === "rail"), agency = perf.by_dept.find((d) => d.dept === "agency");
  assert.equal(rail.tours, 927);
  assert.equal(agency.tours, 353);
  assert.equal(rail.sold, 2565);
  assert.equal(agency.sold, 2893);
  assert.equal(rail.seats_past, 138689);
  assert.equal(agency.seats_past, 13931);
  assert.equal(rail.dates_past, 13878);
  assert.equal(agency.dates_past, 2331);
  assert.equal(rail.dates_future, 4744);
  assert.equal(agency.dates_future, 886);
  // заполнение архива: ЖД 1,67%, ТА 18,58%, всего 3,22%
  assert.equal(Math.round(rail.fill_past * 1e4) / 1e2, 1.67);
  assert.equal(Math.round(agency.fill_past * 1e4) / 1e2, 18.58);
  assert.equal(Math.round(perf.totals.fill_past * 1e4) / 1e2, 3.22);
});

test("концентрация продаж: топ-10 и топ-50", () => {
  const perf = buildPerformance([], sales);
  assert.equal(Math.round(perf.concentration.top10_share * 1000) / 10, 10.8);
  assert.equal(Math.round(perf.concentration.top50_share * 100), 33);
});

test("без выгрузки по туру он не попадает в сопоставленные, но попадает в сводные цифры", () => {
  const tours = [{ id: 1672, name: "карточка сайта", own: false, segment: "multi_day", direction: "Выборг", days: 3, dates: [1, 2] }];
  const perf = buildPerformance(tours, sales);
  assert.equal(perf.items.length, 1);
  assert.equal(perf.orphans.length, 1279);
  assert.equal(perf.totals.tours, 1280);
  assert.equal(perf.items[0].name, "карточка сайта");
  const data = performanceData(perf);
  assert.equal(data.matched, 1);
  assert.equal(data.tours[1672].status, "core");
});

test("выводы по продажам формулируются и помечают рекомендации", () => {
  const perf = buildPerformance([], sales);
  const out = performanceInsights(perf);
  const kinds = out.map((i) => i.kind);
  for (const k of ["perf_zero", "perf_tail", "perf_concentration", "perf_depth", "perf_dept", "perf_remove", "perf_fresh", "perf_season"]) {
    assert.ok(kinds.includes(k), `нет вывода ${k}`);
  }
  assert.deepEqual(out.filter((i) => i.advice).map((i) => i.kind), ["perf_remove"]);
  assert.ok(out.every((i) => i.title && i.text && i.tab === "performance"));
});

test("свой продукт агрегатами: цифры «Сводки», а разбивки по датам честно нет", () => {
  // лист «Свой продукт» книги: по туру только мест всего, продано, заполнение и доля в глубине
  const ownRows = [
    { id: 1371, name: "Под звуки паровозного гудка", dates_past: 14, dates_future: 13, seats: 894, sold: 544, dates_sold: 16, fill: 0.6085011185682326, fill_future: 0.1210526315789474 },
    { id: 3054, name: "Новый год на горе Ахун", dates_past: 0, dates_future: 1, seats: 10, sold: 0, dates_sold: 0, fill: 0, fill_future: 0 },
    { id: 999999, name: "Тур без карточки на сайте", dates_past: 3, dates_future: 0, seats: 30, sold: 0, dates_sold: 0, fill: 0, fill_future: null },
  ];
  const perf = buildPerformance([], sales, { ownRows });
  const own = perf.by_owner.own;
  assert.equal(own.tours, 3);
  assert.equal(own.sold, 544);
  assert.equal(own.seats, 934);
  assert.equal(own.aggregate, true);
  assert.equal(own.awaiting_api, true);
  // архив и глубину по местам выгрузка не делит: выдумывать их нельзя
  assert.equal(own.fill_past, null);
  assert.equal(own.fill_future, null);
  assert.equal(own.seats_past, null);
  const row = perf.own_product.rows.find((r) => r.id === 1371);
  assert.equal(row.status, "core");
  assert.equal(row.fill, 0.608501);
  assert.equal(row.fill_future, 0.121053);
  assert.equal(row.fill_past, null);
  assert.equal(row.months_sold, null);
  assert.equal(row.profile, null);
  assert.deepEqual(row.dead_seasons, []);
  assert.equal(perf.own_product.rows.find((r) => r.id === 3054).status, "fresh");
  // свой продукт не смешивается с партнёрскими заездами
  assert.equal(perf.totals.tours, 1280);
  assert.equal(perf.by_owner.partner.tours, 1280);
  const data = performanceData(perf);
  assert.equal(data.own_product.awaiting_api, 1);
  assert.equal(data.own_product.tours.length, 3);
});

test("ненайденные в каталоге перечисляются поимённо, а не исчезают", () => {
  const tours = [
    { id: 1672, name: "карточка сайта", own: false, segment: "multi_day", direction: "Выборг", days: 3, dates: [1, 2] },
    { id: 777777, name: "карточка без продаж", own: true, segment: "multi_day", direction: "Карелия", days: 4, dates: [3] },
  ];
  const perf = buildPerformance(tours, sales, { ownRows: [{ id: 888888, name: "свой тур без карточки", seats: 10, sold: 2, dates_past: 1, dates_future: 0, dates_sold: 1 }] });
  assert.equal(perf.matching.feed, 1281);
  assert.equal(perf.matching.matched, 1);
  assert.equal(perf.matching.unmatched, 1280);
  assert.equal(perf.matching.catalog, 2);
  assert.equal(perf.matching.no_data, 1);
  const data = performanceData(perf);
  assert.equal(data.unmatched.length, 1280);
  assert.ok(data.unmatched.every((r) => r.name), "у каждого ненайденного тура есть название из выгрузки");
  assert.deepEqual(data.no_data.map((t) => t.id), [777777]);
  const kinds = performanceInsights(perf).map((i) => i.kind);
  assert.ok(kinds.includes("perf_unmatched"));
  assert.ok(kinds.includes("perf_no_data"));
});

test("правила статусов и профиля", () => {
  const base = { sold: 0, dates_past: 0, dates_future: 0, sold_past: 0, seasons: Object.fromEntries(SEASONS.map((s) => [s.id, { dates: 0, seats: 0, sold: 0 }])) };
  assert.equal(statusOf({ ...base }), "fresh");
  assert.equal(statusOf({ ...base, dates_past: 4 }), "gone");
  assert.equal(statusOf({ ...base, dates_past: 4, dates_future: 2 }), "remove");
  assert.equal(statusOf({ ...base, sold: 5, dates_past: 4 }), "weak");
  assert.equal(statusOf({ ...base, sold: 6, dates_past: 4 }), "working");
  assert.equal(statusOf({ ...base, sold: 21, dates_past: 4 }), "core");
  assert.equal(seasonProfile({ ...base, sold: 3 }), "Круглый год");
  const s = Object.fromEntries(SEASONS.map((x) => [x.id, { dates: 0, seats: 0, sold: 0 }]));
  s.summer = { dates: 5, seats: 50, sold: 6 };
  s.autumn = { dates: 5, seats: 50, sold: 4 };
  assert.equal(seasonProfile({ sold: 10, sold_past: 10, seasons: s }), "Летний");
  assert.equal(DEAD_SEASON_MIN_DATES, 3);
});
