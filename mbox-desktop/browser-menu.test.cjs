const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return { app: { getPath: () => "/dl" }, shell: {} };
  return originalLoad.call(this, request, ...rest);
};
const { buildTemplate, short } = require("./browser-menu");
const { safeFileName, uniquePath, isRisky } = require("./browser-downloads");

const act = new Proxy({}, { get: (_t, name) => () => name });
const ctx = { pageUrl: "https://a.ru/x", canGoBack: true, canGoForward: false, engine: "Яндексе", devTools: false };
const labels = (template) => template.filter((i) => i.label).map((i) => i.label);

// страница без выделения
let items = labels(buildTemplate({}, ctx, act));
assert.ok(items.includes("Назад") && items.includes("Печать…") && items.includes("Сохранить как PDF…"));
assert.ok(!items.includes("Исследовать элемент"));

// ссылка: открыть, копировать, сохранить; навигация страницы не примешивается
items = labels(buildTemplate({ linkURL: "https://b.ru/f.zip" }, ctx, act));
assert.deepEqual(items, ["Открыть ссылку в новой вкладке", "Открыть в системном браузере", "Копировать адрес ссылки", "Сохранить ссылку как…"]);

// mailto: только копирование адреса
items = labels(buildTemplate({ linkURL: "mailto:me%40a.ru?subject=1" }, ctx, act));
assert.deepEqual(items, ["Копировать адрес почты"]);

// картинка внутри ссылки: и то и другое
items = labels(buildTemplate({ linkURL: "https://b.ru", mediaType: "image", srcURL: "https://b.ru/i.png" }, ctx, act));
assert.ok(items.includes("Копировать изображение") && items.includes("Сохранить изображение как…") && items.includes("Открыть ссылку в новой вкладке"));

// data: картинка не открывается во вкладке
items = labels(buildTemplate({ mediaType: "image", srcURL: "data:image/png;base64,AAAA" }, ctx, act));
assert.ok(!items.includes("Открыть изображение в новой вкладке") && items.includes("Копировать изображение"));

// выделенный текст: копировать и поиск с названием поисковика, усечённым до 32 знаков
const long = "очень длинный выделенный текст для проверки усечения строки";
items = labels(buildTemplate({ selectionText: long }, ctx, act));
assert.equal(items[0], "Копировать");
assert.match(items[1], /^Найти «.{1,32}» в Яндексе$/);
assert.equal(short("  a   b  "), "a b");

// поле ввода: правка, но не страничное меню; недоступное — выключено
const edit = buildTemplate({ isEditable: true, editFlags: { canPaste: true } }, ctx, act);
assert.equal(edit.find((i) => i.label === "Вставить").enabled, true);
assert.equal(edit.find((i) => i.label === "Вырезать").enabled, undefined);
assert.ok(!labels(edit).includes("Назад"));

// закладка и копирование адреса отключены для не-http страниц
const blank = buildTemplate({}, { ...ctx, pageUrl: "about:blank" }, act);
assert.equal(blank.find((i) => i.label === "Добавить в закладки").enabled, false);

// имена файлов
assert.equal(safeFileName("../../evil/..\\x:y*.txt"), "_.._evil_.._x_y_.txt");
assert.equal(safeFileName("  .. "), "download");
assert.equal(safeFileName("CON.txt"), "_CON.txt");
assert.equal(safeFileName("a".repeat(300) + ".pdf").length, 150);
assert.ok(safeFileName("a".repeat(300) + ".pdf").endsWith(".pdf"));
assert.equal(safeFileName(""), "download");
assert.ok(!/[\\/:*?"<>|]/.test(safeFileName('a/b\\c:d*e?f"g<h>i|j')));

// уникальные пути
const taken = new Set(["/dl/f.pdf", "/dl/f (1).pdf"]);
assert.equal(uniquePath("/dl", "f.pdf", (p) => taken.has(p)).replace(/\\/g, "/"), "/dl/f (2).pdf");
assert.equal(uniquePath("/dl", "g.pdf", (p) => taken.has(p)).replace(/\\/g, "/"), "/dl/g.pdf");

// опасные расширения
assert.ok(isRisky("setup.EXE") && isRisky("x.ps1") && !isRisky("report.pdf") && !isRisky("noext"));
console.log("browser-menu tests: ok");
