// Состав отчёта и выгрузка в Excel: что уходит при «без рекомендаций» и что приходит из книги CRM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import ExcelJS from "exceljs";
import { analyze, reportData } from "./assortment-engine.mjs";
import { feedFromCsv, feedFromWorkbook, DEFAULT_CUTOFF } from "./assortment-sales-import.mjs";
import { applyView, normalizeView } from "./assortment-view.mjs";
import { buildAssortmentWorkbook, workbookFileName } from "./assortment-xlsx.mjs";

const dir = new URL("./fixtures/assortment/", import.meta.url);
const gz = (f) => JSON.parse(gunzipSync(readFileSync(new URL(f + ".json.gz", dir))).toString("utf8"));
const plain = (f) => JSON.parse(readFileSync(new URL(f + ".json", dir), "utf8"));
const an = analyze(gz("snapshot"), plain("config"), {
  feedback: plain("feedback"), exclusions: plain("exclusions"), salesDates: gz("sales-dates"), cutoff: "2026-10-21",
});
const full = reportData(an, null, { learnings: "" });
const sheetNames = async (buffer) => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return book.worksheets.map((w) => w.name);
};

test("состав по умолчанию — всё, рекомендации на месте", () => {
  const data = applyView(full, {});
  assert.equal(data.view.advice, true);
  assert.ok(data.actions.length > 0);
  assert.ok(data.insights.some((i) => i.advice));
  assert.ok(data.performance.remove.length > 0);
  assert.equal(data.performance.status_labels.remove, "Убрать из продажи");
});

test("без рекомендаций: уходят решения, остаются факты", () => {
  const data = applyView(full, { advice: false });
  assert.equal(data.view.advice, false);
  assert.deepEqual(data.actions, []);
  assert.equal(data.insights.some((i) => i.advice), false);
  assert.ok(data.insights.length > 0, "факты остаются");
  assert.deepEqual(data.performance.remove, []);
  assert.equal(data.performance.status_labels.remove, "Без продаж, даты впереди есть");
  assert.ok(data.directions.every((d) => d.cut.length === 0));
  assert.ok(data.clusters.every((k) => !k.advice || k.advice.drop.length === 0));
  // цифры не трогаем: заполнение, продажи и конфликты те же
  assert.equal(data.performance.totals.sold, full.performance.totals.sold);
  assert.equal(data.conflicts.length, full.conflicts.length);
  // исходные данные не испорчены
  assert.ok(full.actions.length > 0);
  assert.ok(full.performance.remove.length > 0);
});

test("ссылка не может вернуть себе рекомендации, которых нет", () => {
  assert.equal(normalizeView(undefined).advice, true);
  assert.equal(normalizeView({ advice: false }).advice, false);
  const strict = applyView(applyView(full, { advice: false }), { advice: true });
  assert.deepEqual(strict.actions, [], "повторный проход с advice:true не возвращает рекомендации в уже урезанные данные");
});

test("книга для сотрудников: листы, имя файла, рекомендательные листы только владельцу", async () => {
  const owner = applyView(full, {});
  const staff = applyView(full, { advice: false });
  const ownerBook = await buildAssortmentWorkbook(owner, { advice: true });
  const staffBook = await buildAssortmentWorkbook(staff, { advice: false });
  const ownerSheets = await sheetNames(ownerBook);
  const staffSheets = await sheetNames(staffBook);
  for (const name of ["Сводка", "Выводы", "Все туры", "Продавались", "Без продаж", "Сезонность", "Тренды", "Нет в каталоге", "Без данных", "Конфликты", "Методика"]) {
    assert.ok(ownerSheets.includes(name), `нет листа ${name}`);
    assert.ok(staffSheets.includes(name), `нет листа ${name} в книге сотрудника`);
  }
  assert.ok(ownerSheets.includes("Убрать сейчас"));
  assert.ok(ownerSheets.includes("Что делать"));
  assert.equal(staffSheets.includes("Убрать сейчас"), false);
  assert.equal(staffSheets.includes("Что делать"), false);
  assert.match(workbookFileName(owner, { advice: true }), /^Ассортимент_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.match(workbookFileName(staff, { advice: false }), /_без_рекомендаций\.xlsx$/);
});

test("книга собирается и без продаж: тогда в ней только каталог", async () => {
  const plainAn = analyze(gz("snapshot"), plain("config"), { feedback: plain("feedback"), exclusions: plain("exclusions") });
  const data = applyView(reportData(plainAn, null, { learnings: "" }), {});
  assert.equal(data.performance, undefined);
  const sheets = await sheetNames(await buildAssortmentWorkbook(data, { advice: true }));
  assert.deepEqual(sheets, ["Конфликты", "Методика"]);
});

test("книга CRM: заезды из детальных листов и свой продукт агрегатами", async () => {
  const book = new ExcelJS.Workbook();
  const detail = book.addWorksheet("ЖД детально");
  detail.getCell("A1").value = "ЖД: каждая дата каждого тура";
  ["ID", "Тур", "Решение", "Поток", "Дата", "Мест", "Продано", "Заполнение"].forEach((h, i) => { detail.getCell(4, i + 1).value = h; });
  const rows = [
    [1001, "Тур один", "Ядро: 21+", "архив", "01.06.2026", 10, 4, 0.4],
    [1001, "Тур один", "Ядро: 21+", "архив", "08.06.2026", 10, 0, 0],
    [1001, "Тур один", "Ядро: 21+", "глубина", "01.06.2027", 10, 1, 0.1],
    [1002, "Тур два", "Уже снят", "архив", "03.03.2026", 12, 0, 0],
  ];
  rows.forEach((r, i) => r.forEach((v, c) => { detail.getCell(5 + i, c + 1).value = v; }));
  const own = book.addWorksheet("Свой продукт");
  own.getCell("A1").value = "Свой продукт: 2 тура туроператора";
  ["ID", "Тур", "Дат в прошлом", "Дат впереди", "Мест всего", "Продано", "Заполнение", "Впереди", "Дат с продажами", "Решение"].forEach((h, i) => { own.getCell(4, i + 1).value = h; });
  [[2001, "Свой тур", 14, 13, 894, 544, 0.6085, 0.121, 16, "Ядро: 21+"], [2002, "Свой новый", 0, 1, 10, 0, 0, 0, 0, "Ноль продаж"]]
    .forEach((r, i) => r.forEach((v, c) => { own.getCell(5 + i, c + 1).value = v; }));

  const feed = await feedFromWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
  assert.equal(feed.source, "xlsx");
  assert.equal(feed.cutoff, DEFAULT_CUTOFF);
  assert.equal(feed.rows.length, 4);
  assert.equal(feed.stats.tours, 2);
  assert.equal(feed.stats.archive, 3);
  assert.equal(feed.stats.depth, 1);
  assert.equal(feed.stats.sold, 5);
  assert.equal(feed.stats.seats, 42);
  assert.equal(feed.own.length, 2);
  assert.equal(feed.stats.own_sold, 544);
  assert.equal(feed.own[0].fill_future, 0.121);
  assert.deepEqual(feed.stats.sheets, [{ sheet: "ЖД детально", rows: 4 }, { sheet: "Свой продукт", rows: 2, kind: "aggregate" }]);
  assert.equal(feed.rows.every((r) => r.dept === "ЖД детально" || r.dept === "ЖД"), true);
});

test("CSV-выгрузка: русские заголовки, суммирование повторов, мусор пропускается", () => {
  const feed = feedFromCsv([
    "ID тура;Дата заезда;Мест выставлено;Мест занято;Отдел",
    "1001;01.06.2026;10;4;ЖД отдел",
    "1001;01.06.2026;0;1;ЖД отдел",
    "1002;2026-12-31;8;8;ТА отдел",
    "мусор;нет даты;1;1;",
  ].join("\n"), { cutoff: "2026-10-21" });
  assert.equal(feed.rows.length, 2);
  const first = feed.rows.find((r) => r.id === 1001);
  assert.equal(first.sold, 5);
  assert.equal(first.seats, 10);
  assert.equal(feed.stats.depth, 1);
  assert.equal(feed.stats.tours, 2);
});

test("мест выставлено не бывает меньше занятых", () => {
  const feed = feedFromCsv(["ID тура;Дата;Мест;Продано", "1;01.06.2026;2;7"].join("\n"), { cutoff: "2026-10-21" });
  assert.equal(feed.rows[0].seats, 7);
});

test("пустая выгрузка — понятная ошибка, а не пустой отчёт", () => {
  assert.throws(() => feedFromCsv("ID тура;Дата\n"), /столбец мест/);
  assert.throws(() => feedFromCsv("ID тура;Дата;Мест;Продано\n"), /не нашлось строк/);
  assert.throws(() => feedFromCsv("просто текст"), /столбцы тура и даты|не нашлось/);
});
