import assert from "node:assert/strict";
import test from "node:test";
import { buildCalendar, parseMonth, seoCalendarData } from "./seo-calendar.mjs";
import { scenariosOnDay } from "./seo-strategy.mjs";

const base = { year: 2026, month: 10, today: "2026-10-09", scenariosOnDay };
const day = (days, number) => days.find((item) => item.day === number);

test("месяц разбирается из строки, мусор — текущий месяц по Москве", () => {
  assert.deepEqual(parseMonth("2026-12"), { year: 2026, month: 12 });
  assert.deepEqual(parseMonth("2026-13", new Date("2026-10-09T12:00:00Z")), { year: 2026, month: 10 });
  assert.deepEqual(parseMonth("", new Date("2026-10-31T22:00:00Z")), { year: 2026, month: 11 });
});

test("у каждого дня есть сбор данных; понедельники и четверги, 10/20/25 числа получают свои названия", () => {
  const days = buildCalendar(base);
  assert.equal(days.length, 31);
  assert.ok(days.every((item) => item.items[0].id === "daily"));
  assert.deepEqual(day(days, 5).items.map((i) => i.title), ["Сбор данных", "Очередь недели"]); // понедельник
  assert.deepEqual(day(days, 8).items.map((i) => i.title), ["Сбор данных", "Проверка внедрения"]); // четверг
  assert.ok(day(days, 10).items.some((i) => i.title === "Архитектура сайта"));
  assert.ok(day(days, 20).items.some((i) => i.title === "Авторитет и ссылки"));
  assert.ok(day(days, 25).items.some((i) => i.title === "Итоги месяца"));
});

test("прошлое показывает факт: пакет собран, не собран, прогон прошёл или упал", () => {
  const days = buildCalendar({
    ...base,
    packages: [{ scenario: "monday", at: "2026-10-05 08:00:00+00" }],
    runs: [{ day: "2026-10-05", status: "ok" }, { day: "2026-10-06", status: "error" }, { day: "2026-10-07", status: "ok" }],
  });
  const monday = day(days, 5).items.find((i) => i.id === "monday");
  assert.equal(monday.state, "done");
  assert.match(monday.detail, /05\.10\.2026/);
  assert.equal(day(days, 6).items[0].state, "failed");
  assert.equal(day(days, 7).items[0].state, "done");
  assert.equal(day(days, 1).items.find((i) => i.id === "thursday").state, "missed"); // 1 октября, пакета нет
  assert.equal(day(days, 2).items[0].state, "none"); // прогонов не было
});

test("сегодня и будущее: сегодня — «сегодня», дальше — «запланировано»; пакет, собранный позже в пределах недели, засчитывается", () => {
  const days = buildCalendar({ ...base, packages: [{ scenario: "thursday", at: "2026-10-09 07:00:00+00" }] });
  assert.equal(day(days, 8).items.find((i) => i.id === "thursday").state, "done"); // собран в пятницу, срок четверга
  assert.equal(day(days, 9).items[0].state, "today");
  assert.equal(day(days, 12).items.find((i) => i.id === "monday").state, "planned");
  assert.equal(day(days, 30).items[0].state, "planned");
});

test("проверка позиций: заказанная показывается фактом, следующая — планом, правки к замеру — отдельной строкой", () => {
  const days = buildCalendar({ ...base, autorun: true, checks: [{ day: "2026-10-09", status: "done" }], nextPositionsDay: "2026-10-16", measures: [{ day: "2026-10-20", count: 3 }] });
  assert.equal(day(days, 9).items.find((i) => i.id === "positions").state, "done");
  assert.equal(day(days, 16).items.find((i) => i.id === "positions").state, "planned");
  assert.match(day(days, 16).items.find((i) => i.id === "positions").detail, /по расписанию/);
  assert.match(day(days, 20).items.find((i) => i.id === "measure").detail, /Правок к замеру: 3/);
});

test("данные из базы: переходы между месяцами и подстановочная база", async () => {
  const query = async (sql) => {
    if (/FROM seo_rank_checks WHERE status/.test(sql)) return { rows: [{ at: "2026-10-09 08:00:00+00" }] };
    if (/FROM seo_runs/.test(sql)) return { rows: [{ day: "2026-10-09", status: "ok" }] };
    return { rows: [] };
  };
  const data = await seoCalendarData(query, { monthText: "2026-01", now: new Date("2026-10-09T12:00:00Z"), scenariosOnDay, autorun: true });
  assert.equal(data.prev, "2025-12");
  assert.equal(data.next, "2026-02");
  assert.equal(data.title, "январь 2026");
  const october = await seoCalendarData(query, { monthText: "2026-10", now: new Date("2026-10-09T12:00:00Z"), scenariosOnDay, autorun: true });
  assert.equal(october.today, "2026-10-09");
  assert.ok(october.days.find((item) => item.day === 16).items.some((i) => i.id === "positions"), "следующая проверка позиций через 7 дней после последней");
  assert.equal(october.days.find((item) => item.day === 9).items[0].state, "done");
});
