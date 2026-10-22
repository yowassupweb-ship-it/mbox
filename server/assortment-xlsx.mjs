// Выгрузка ассортимента в Excel: книга, которую отдают сотрудникам. Собирается из тех же данных,
// что и отчёт на экране (reportData), поэтому цифры в книге и на экране всегда одни и те же.
// Состав листов зависит от выключателя рекомендаций: при «без рекомендаций» листы с решениями
// («Убрать сейчас», «Что делать») не попадают в книгу вовсе, а статус тура пишется фактом.
import ExcelJS from "exceljs";
import { DEPT_LABELS, SEASONS, STATUS_LABELS, STATUS_ORDER } from "./assortment-performance.mjs";
import { normalizeView } from "./assortment-view.mjs";

const HEAD_FILL = "FFF1F5F9";
const TITLE_SIZE = 14;
const ru = (iso) => (iso ? String(iso).split("-").reverse().join(".") : "");
const share = (x) => (x === null || x === undefined ? null : x);

/** Лист: заголовок, подпись, таблица. Числа остаются числами, доли — процентным форматом. */
function addSheet(book, { name, title, note, columns, rows, widths }) {
  const ws = book.addWorksheet(name.slice(0, 31));
  ws.getCell("A1").value = title;
  ws.getCell("A1").font = { bold: true, size: TITLE_SIZE };
  if (note) {
    ws.getCell("A2").value = note;
    ws.getCell("A2").font = { color: { argb: "FF64748B" } };
  }
  const headRow = note ? 4 : 3;
  columns.forEach((c, i) => {
    const cell = ws.getCell(headRow, i + 1);
    cell.value = c.label;
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_FILL } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  rows.forEach((row, r) => {
    columns.forEach((c, i) => {
      const cell = ws.getCell(headRow + 1 + r, i + 1);
      const value = c.value(row);
      cell.value = value === undefined ? null : value;
      if (c.format) cell.numFmt = c.format;
    });
  });
  ws.columns.forEach((col, i) => { col.width = (widths && widths[i]) || Math.min(48, Math.max(10, (columns[i]?.label || "").length + 4)); });
  ws.views = [{ state: "frozen", ySplit: headRow }];
  if (rows.length) ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: headRow, column: columns.length } };
  return ws;
}

const PCT = "0.0%";
const tourColumns = (perf, labels) => [
  { label: "Отдел", value: (t) => t.dept_label || "" },
  { label: "ID", value: (t) => t.id },
  { label: "Название тура", value: (t) => t.name || "" },
  { label: "Чей", value: (t) => (t.matched ? (t.own ? "свой" : "партнёрский") : "нет в каталоге") },
  { label: "Статус", value: (t) => labels[t.status] },
  { label: "Направление", value: (t) => t.direction || "" },
  { label: "Дат в архиве", value: (t) => t.dates_past },
  { label: "Дат с продажами", value: (t) => t.dates_sold },
  { label: "Мест в архиве", value: (t) => t.seats_past },
  { label: "Продано в архиве", value: (t) => t.sold_past },
  { label: "Заполнение архива", value: (t) => share(t.fill_past), format: PCT },
  { label: "Дат впереди", value: (t) => t.dates_future },
  { label: "Мест впереди", value: (t) => t.seats_future },
  { label: "Забронировано впереди", value: (t) => t.sold_future },
  { label: "Заполнение глубины", value: (t) => share(t.fill_future), format: PCT },
  { label: "Продано всего", value: (t) => t.sold },
  { label: "Месяцев с продажами", value: (t) => t.months_sold },
  { label: "Первая продажа", value: (t) => ru(t.first_sale) },
  { label: "Последняя продажа", value: (t) => ru(t.last_sale) },
  { label: "Дней без продаж", value: (t) => t.days_since_sale },
  { label: "Профиль сезонности", value: (t) => t.profile },
  { label: "Сезоны без продаж", value: (t) => t.dead_seasons.map((id) => SEASONS.find((s) => s.id === id).label).join(", ") },
  ...SEASONS.map((s) => ({ label: `${s.label}: продано`, value: (t) => t.seasons[s.id].sold })),
  ...SEASONS.map((s) => ({ label: `${s.label}: дат`, value: (t) => t.seasons[s.id].dates })),
];

/** Главные цифры: та же таблица, что в сводке отчёта — всего, по отделам, свой против партнёрского. */
function summaryRows(data) {
  const p = data.performance;
  const groups = [["Всего", p.totals], ...p.by_dept.map((d) => [d.dept_label, d]), ["Свой продукт", p.by_owner.own], ["Партнёрский", p.by_owner.partner]];
  const metrics = [
    ["Туров в выгрузке", (g) => g.tours],
    ["Продавали хотя бы раз", (g) => g.with_sales],
    ["Не продали ни одного места", (g) => g.zero],
    ["Продано мест всего", (g) => g.sold],
    ["Продано в архиве", (g) => g.sold_past],
    ["Забронировано в глубину", (g) => g.sold_future],
    ["Мест выставлено в архиве", (g) => g.seats_past],
    ["Мест выставлено вперёд", (g) => g.seats_future],
    ["Заполнение архива", (g) => share(g.fill_past), PCT],
    ["Заполнение глубины", (g) => share(g.fill_future), PCT],
    ["Дат в архиве", (g) => g.dates_past],
    ["Из них с продажами", (g) => g.dates_sold],
    ["Доля дат с продажами", (g) => share(g.dates_sold_share), PCT],
    ["Дат впереди", (g) => g.dates_future],
    ["Мест на одну дату", (g) => g.seats_per_date],
  ];
  return { groups, metrics };
}

/**
 * Книга ассортимента. data — результат reportData (уже после applyView), view — состав.
 * Возвращает Buffer: его отдают как файл.
 */
export async function buildAssortmentWorkbook(data, viewIn = {}) {
  const view = normalizeView(viewIn);
  const p = data.performance;
  const book = new ExcelJS.Workbook();
  book.creator = "MBOX · Ассортимент";
  book.created = new Date();

  const period = p ? `архив ${ru(p.period.archive?.[0])} – ${ru(p.period.archive?.[1])}, глубина ${p.period.depth ? `${ru(p.period.depth[0])} – ${ru(p.period.depth[1])}` : "нет"}` : "";
  const labels = p ? (p.status_labels || STATUS_LABELS) : STATUS_LABELS;
  const tours = p ? Object.values(p.tours) : [];
  const byId = new Map(tours.map((t) => [t.id, t]));
  const pick = (list) => (list || []).map((id) => byId.get(id)).filter(Boolean);

  if (p) {
    // --- Сводка
    const { groups, metrics } = summaryRows(data);
    const ws = book.addWorksheet("Сводка");
    ws.getCell("A1").value = "Ассортимент туров: что продаётся, а что занимает место";
    ws.getCell("A1").font = { bold: true, size: 16 };
    ws.getCell("A2").value = `Снимок каталога ${ru(String(data.meta.snapshot_at).slice(0, 10))}. Продажи считаются по местам: «продано» — занятые места. Период: ${period}.`;
    ws.getCell("A2").font = { color: { argb: "FF64748B" } };
    ws.getCell("A4").value = "Показатель";
    ws.getCell("A4").font = { bold: true };
    groups.forEach(([label], i) => {
      const cell = ws.getCell(4, i + 2);
      cell.value = label;
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD_FILL } };
    });
    metrics.forEach(([label, fn, format], r) => {
      ws.getCell(5 + r, 1).value = label;
      groups.forEach(([, g], i) => {
        const cell = ws.getCell(5 + r, i + 2);
        cell.value = fn(g);
        if (format) cell.numFmt = format;
      });
    });
    let row = 6 + metrics.length;
    ws.getCell(row, 1).value = "Туры по статусу";
    ws.getCell(row, 1).font = { bold: true };
    row += 1;
    for (const key of STATUS_ORDER) {
      ws.getCell(row, 1).value = labels[key];
      ws.getCell(row, 2).value = p.by_status[key] || 0;
      row += 1;
    }
    row += 1;
    ws.getCell(row, 1).value = "Концентрация продаж";
    ws.getCell(row, 1).font = { bold: true };
    ws.getCell(row + 1, 1).value = "Топ-10 туров дают";
    ws.getCell(row + 1, 2).value = share(p.concentration.top10_share);
    ws.getCell(row + 1, 2).numFmt = PCT;
    ws.getCell(row + 2, 1).value = "Топ-50 туров дают";
    ws.getCell(row + 2, 2).value = share(p.concentration.top50_share);
    ws.getCell(row + 2, 2).numFmt = PCT;
    ws.getColumn(1).width = 34;
    groups.forEach((_, i) => { ws.getColumn(i + 2).width = 16; });
    ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4 }];

    // --- Выводы
    addSheet(book, {
      name: "Выводы", title: "Что показывают цифры",
      note: view.advice ? "Готовые формулировки по продажам и ассортименту." : "Только факты: решения «что снять» в этом отчёте не показываются.",
      columns: [
        { label: "Важность", value: (i) => ({ alarm: "тревога", warn: "внимание", info: "справка" })[i.level] || i.level },
        { label: "Вывод", value: (i) => i.title },
        { label: "Подробно", value: (i) => i.text },
        { label: "Туров", value: (i) => (i.tours || []).length },
      ],
      rows: data.insights || [], widths: [12, 60, 110, 10],
    });

    // --- Все туры
    addSheet(book, {
      name: "Все туры", title: `Все туры: ${tours.length} строк`,
      note: "Одна строка — один тур. Архив — прошедшие даты, глубина — выставленные вперёд. Заполнение архива и глубины между собой не сравнивают.",
      columns: tourColumns(p, labels), rows: tours, widths: [8, 8, 46],
    });

    // --- Продавались
    const sold = pick(p.top).concat(tours.filter((t) => t.sold > 0 && !p.top.includes(t.id)).sort((a, b) => b.sold - a.sold));
    addSheet(book, {
      name: "Продавались", title: `Туры, которые продавались: ${sold.length}`,
      note: "Отсортировано по числу проданных мест за период.",
      columns: tourColumns(p, labels), rows: sold, widths: [8, 8, 46],
    });

    // --- Без продаж
    addSheet(book, {
      name: "Без продаж", title: `Туры без продаж: ${p.zero.length} из ${tours.length}`,
      note: "Ни одного проданного места за период. «Новый: нет истории» — судить не по чему, у тура нет прошедших дат.",
      columns: tourColumns(p, labels), rows: pick(p.zero), widths: [8, 8, 46],
    });

    // --- Сезонность по месяцам
    addSheet(book, {
      name: "Сезонность", title: "Сезонность: месяцы архива",
      note: "Только прошедшие даты. Сезонность отражает не только спрос, но и то, какие даты ставили в продажу.",
      columns: [
        { label: "Месяц", value: (m) => m.month },
        { label: "Отдел", value: (m) => DEPT_LABELS[m.dept] || m.dept },
        { label: "Дат", value: (m) => m.dates },
        { label: "Дат с продажами", value: (m) => m.dates_sold },
        { label: "Мест", value: (m) => m.seats },
        { label: "Продано", value: (m) => m.sold },
        { label: "Заполнение", value: (m) => (m.seats ? m.sold / m.seats : null), format: PCT },
      ],
      rows: p.months || [], widths: [12, 10, 10, 16, 10, 12, 14],
    });

    // --- Тренды: сезон продаётся, другой стоял и не продался
    addSheet(book, {
      name: "Тренды", title: `Сезоны без продаж: ${(p.trends || []).length} случаев`,
      note: "Тур продаётся в одном сезоне, а в другом даты стояли (от трёх) и не продались ни разу. Такие туры не снимают — у них убирают даты мёртвого сезона.",
      columns: [
        { label: "Отдел", value: (x) => DEPT_LABELS[x.dept] || x.dept || "" },
        { label: "ID", value: (x) => x.id },
        { label: "Тур", value: (x) => x.name || "" },
        { label: "Продаётся", value: (x) => x.sells_label },
        { label: "Продано в сезоне", value: (x) => x.sells_sold },
        { label: "Мёртвый сезон", value: (x) => x.dead_label },
        { label: "Дат в мёртвом сезоне", value: (x) => x.dead_dates },
        { label: "Мест в мёртвом сезоне", value: (x) => x.dead_seats },
        { label: "Продано всего", value: (x) => x.sold_total },
      ],
      rows: p.trends || [], widths: [8, 8, 46, 12, 16, 14, 18, 18, 14],
    });

    // --- Свой продукт: агрегаты, пока продажи не на API
    if (p.own_product && p.own_product.tours.length) {
      addSheet(book, {
        name: "Свой продукт", title: `Свой продукт: ${p.own_product.tours.length} туров`,
        note: "Выгрузка своего продукта приходит построчно по турам: разбивки мест на архив и глубину, дат продаж и сезонов в ней нет — " +
          "пустые столбцы здесь честно пустые. Появятся, когда продажи переведут на API.",
        columns: [
          { label: "ID", value: (t) => t.id },
          { label: "Тур", value: (t) => t.name || "" },
          { label: "Статус", value: (t) => labels[t.status] },
          { label: "Дат в архиве", value: (t) => t.dates_past },
          { label: "Дат впереди", value: (t) => t.dates_future },
          { label: "Дат с продажами", value: (t) => t.dates_sold },
          { label: "Мест всего", value: (t) => t.seats },
          { label: "Продано", value: (t) => t.sold },
          { label: "Заполнение", value: (t) => share(t.fill), format: PCT },
          { label: "Заполнение глубины", value: (t) => share(t.fill_future), format: PCT },
          { label: "Нет в каталоге сайта", value: (t) => (t.matched ? "" : "не найден") },
        ],
        rows: p.own_product.tours, widths: [8, 46, 22, 12, 12, 16, 12, 10, 14, 18, 20],
      });
    }

    // --- Что не сопоставилось с каталогом: писать честно, а не прятать
    addSheet(book, {
      name: "Нет в каталоге", title: `Туры выгрузки, не найденные в каталоге сайта: ${p.unmatched.length} из ${p.matching.feed}`,
      note: "Номера туров в CRM и на сайте — разные системы, поэтому часть выгрузки не сопоставляется. Продажи этих туров не участвуют " +
        "в анализе конфликтов, направлений и дублей; в сводных цифрах по местам они учтены.",
      columns: [
        { label: "Отдел", value: (t) => t.dept_label || (t.own ? "свой продукт" : "") },
        { label: "ID в CRM", value: (t) => t.id },
        { label: "Название в выгрузке", value: (t) => t.name || "" },
        { label: "Статус", value: (t) => labels[t.status] },
        { label: "Продано", value: (t) => t.sold },
        { label: "Мест", value: (t) => t.seats },
        { label: "Дат в архиве", value: (t) => t.dates_past },
        { label: "Дат впереди", value: (t) => t.dates_future },
      ],
      rows: p.unmatched, widths: [14, 10, 50, 22, 10, 10, 12, 12],
    });

    // --- Карточки сайта без данных о продажах
    addSheet(book, {
      name: "Без данных", title: `Карточки каталога без данных о продажах: ${p.no_data.length} из ${p.matching.catalog}`,
      note: "Эти туры стоят на сайте, но в выгрузках CRM их нет. Нулевые продажи им не приписываются: по ним просто нет данных.",
      columns: [
        { label: "ID", value: (t) => t.id },
        { label: "Тур", value: (t) => t.name },
        { label: "Чей", value: (t) => (t.own ? "свой" : "партнёрский") },
        { label: "Направление", value: (t) => t.direction || "" },
        { label: "Заездов в каталоге", value: (t) => t.dates },
      ],
      rows: p.no_data, widths: [8, 50, 14, 24, 18],
    });

    // --- Давно без продаж
    addSheet(book, {
      name: "Давно без продаж", title: `Продавались, но давно: ${p.stale.length}`,
      note: "Последняя продажа больше полугода назад, а даты вперёд выставлены. Проверить: сезон кончился или тур умер.",
      columns: tourColumns(p, labels), rows: pick(p.stale), widths: [8, 8, 46],
    });

    // --- Рекомендации (только для владельца)
    if (view.advice) {
      addSheet(book, {
        name: "Убрать сейчас", title: `Убрать из продажи: ${p.remove.length} туров`,
        note: "Условие: в архиве даты были, продаж ноль, при этом даты вперёд выставлены. Свои туры не снимаются.",
        columns: tourColumns(p, labels), rows: pick(p.remove), widths: [8, 8, 46],
      });
      addSheet(book, {
        name: "Что делать", title: "Что делать в первую очередь",
        note: "Самое важное из каждой категории анализа каталога.",
        columns: [
          { label: "Важность", value: (a) => a.severity },
          { label: "Что", value: (a) => a.title },
          { label: "Подробно", value: (a) => a.detail },
          { label: "Раздел", value: (a) => a.tab },
        ],
        rows: data.actions || [], widths: [12, 60, 90, 14],
      });
    }
  }

  // --- Конфликты каталога (факт, не рекомендация)
  addSheet(book, {
    name: "Конфликты", title: `Конфликты туров: ${(data.conflicts || []).length}`,
    note: "Пары туров, которые конкурируют между собой: одно направление, близкая длительность, общие места и даты.",
    columns: [
      { label: "Серьёзность", value: (c) => data.meta.sev_labels[c.sev] || c.sev },
      { label: "Вид", value: (c) => data.meta.pair_labels[c.pair] || c.pair },
      { label: "Тур A", value: (c) => c.a },
      { label: "Название A", value: (c) => data.tours[c.a]?.n || "" },
      { label: "Тур B", value: (c) => c.b },
      { label: "Название B", value: (c) => data.tours[c.b]?.n || "" },
      { label: "Общие даты", value: (c) => (c.shared || []).length },
      { label: "Общие места", value: (c) => (c.common || []).join(", ") },
      { label: "Почему", value: (c) => c.why },
    ],
    rows: data.conflicts || [], widths: [14, 22, 8, 40, 8, 40, 12, 36, 70],
  });

  // --- Методика: без неё цифрами легко соврать
  const caveats = [
    ["Что считаем", "«Продано» — занятые места в дате, а не деньги: выручки и цен в выгрузках нет. Все выводы про объём в местах."],
    ["Заполнение", "Заполнение = продано / выставлено, по местам, а не по числу дат."],
    ["Архив и глубина", `Архив — прошедшие даты, глубина — выставленные вперёд. Точка слияния: ${p ? ru(p.period.cutoff) : "—"}.`],
    ["Чего нельзя сравнивать", "Заполнение глубины с заполнением архива: в глубине видны только текущие брони, далёкие даты всегда выглядят пустыми."],
    ["Отделы", "ЖД и ТА — разные отделы с разной экономикой (разный размер группы и число мест на дату). Напрямую их заполнение не сравнивают."],
    ["Свой и партнёрский", "По абсолютным продажам сравнивать нельзя: партнёрских туров в разы больше. Корректно — заполнение мест и поведение в глубине."],
    ["Сезонность", "Отражает не только спрос, но и то, какие даты вообще ставили в продажу. «Не продавался весной» может означать, что весенних дат не было."],
    ["Нули", "Причина нулевой даты в данных не видна: мог не набраться минимум, могли отменить, могли не выставить в продажу. Цифра одна — 0."],
    ["Новые туры", "Нет прошедших дат — судить по продажам нельзя, нужен отдельный срок проверки."],
    ["Период", "Один год не отделяет тренд от разовой истории: Новый год всегда даёт пик."],
    ["Связь с сайтом", p ? `CRM и каталог сайта — разные системы с разными номерами туров. Сопоставлено по номеру ${p.matching.matched} из ${p.matching.feed}; ` +
      `не найдено ${p.matching.unmatched} (лист «Нет в каталоге»). Ещё по ${p.matching.no_data} карточкам каталога продаж в выгрузке нет (лист «Без данных»).` : ""],
    ["Свой продукт", p?.own_product?.awaiting_api
      ? "Приходит отдельной выгрузкой и только построчно по турам: мест всего, продано, заполнение, доля заполнения глубины. Разбивки мест на архив и глубину, " +
        "дат продаж и сезонов в ней нет, поэтому эти столбцы по своему продукту пустые. Сравнение со партнёрским корректно только по общему заполнению."
      : ""],
    ["Источник данных", "Выгрузки из CRM файлом — временное решение. Ждём перевода продаж на API: тогда свой продукт пойдёт теми же заездами, " +
      "появятся архив и глубина по местам, сезонность и давность продаж, а цифры будут обновляться сами."],
  ].filter((r) => r[1]);
  addSheet(book, {
    name: "Методика", title: "Методика и оговорки",
    note: "Без этих оговорок цифрами легко соврать.",
    columns: [{ label: "Тема", value: (r) => r[0] }, { label: "Что важно знать", value: (r) => r[1] }],
    rows: caveats, widths: [26, 120],
  });

  return Buffer.from(await book.xlsx.writeBuffer());
}

/** Имя файла выгрузки: с датой снимка, чтобы у сотрудника в папке не копились одинаковые. */
export const workbookFileName = (data, viewIn = {}) =>
  `Ассортимент_${String(data.meta?.snapshot_at || "").slice(0, 10) || "отчёт"}${normalizeView(viewIn).advice ? "" : "_без_рекомендаций"}.xlsx`;
