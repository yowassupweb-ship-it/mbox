// Приём выгрузки продаж: книга Excel или CSV → нормализованный фид заездов.
// Фид — единственное, что знает хранилище: {source, cutoff, rows:[{id, day, seats, sold, dept, name}]}.
// Сейчас данные приходят файлом из CRM — это временное решение; когда продажи переведут на API,
// меняется только адаптер (появится feedFromApi), а движок, отчёт и выгрузка остаются как есть.
import ExcelJS from "exceljs";
import { parseSalesDatesCsv } from "./assortment-store.mjs";

/** Точка слияния архива и глубины по умолчанию: последний день архива в выгрузках владельца. */
export const DEFAULT_CUTOFF = "2026-10-21";

const text = (v) => (v == null ? "" : String(typeof v === "object" ? (v.result !== undefined ? v.result : (v.text ?? "")) : v)).trim();
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Дата из ячейки: Excel отдаёт Date, выгрузки CRM — «ДД.ММ.ГГГГ», редкие файлы — «ГГГГ-ММ-ДД». */
function cellDay(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = text(value);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
const intOf = (v) => { const n = Math.trunc(Number(String(text(v)).replace(/[\s\u00a0]/g, "").replace(",", "."))); return Number.isFinite(n) ? Math.max(0, n) : 0; };

const COLUMNS = {
  id: ["id тура", "id", "номер тура", "№ тура", "tour_id"],
  name: ["тур", "название тура", "название", "name"],
  day: ["дата заезда", "дата выезда", "дата", "day", "date"],
  seats: ["мест выставлено", "мест", "всего мест", "мест всего", "квота", "seats"],
  sold: ["продано", "мест занято", "занято", "отправлено", "продано мест", "sold"],
  dept: ["отдел", "dept", "department"],
  flow: ["поток", "flow"],
};
// Лист своего продукта: построчно по турам, без дат. Пока это всё, что даёт выгрузка, — ждём API.
const OWN_COLUMNS = {
  id: ["id тура", "id", "номер тура", "tour_id"],
  name: ["тур", "название тура", "название"],
  dates_past: ["дат в прошлом", "дат архива", "дат в архиве"],
  dates_future: ["дат впереди", "дат в глубине"],
  seats: ["мест всего", "мест выставлено", "мест"],
  sold: ["продано", "продано мест"],
  fill: ["заполнение"],
  fill_future: ["впереди", "заполнение глубины", "заполнение впереди"],
  dates_sold: ["дат с продажами"],
};
/** Имя листа своего продукта: он один и называется прямо. */
const isOwnSheet = (name) => /свой продукт|то архив|туроператор/i.test(name);
function findOwnHeader(sheet) {
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const cells = [];
    for (let c = 1; c <= sheet.columnCount; c++) cells.push(norm(text(sheet.getCell(r, c).value)));
    const at = (key) => cells.findIndex((h) => h && OWN_COLUMNS[key].some((n) => h === n));
    if (at("id") >= 0 && at("sold") >= 0 && at("seats") >= 0) {
      return { row: r, ...Object.fromEntries(Object.keys(OWN_COLUMNS).map((k) => [k, at(k) + 1])) };
    }
  }
  return null;
}
const numOrNull = (v) => { const s = text(v); if (!s) return null; const n = Number(s.replace(/[\s\u00a0]/g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
/** Строка заголовков: ищем её в первых десяти строках — у выгрузок сверху заголовок и подпись. */
function findHeader(sheet) {
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const cells = [];
    for (let c = 1; c <= sheet.columnCount; c++) cells.push(norm(text(sheet.getCell(r, c).value)));
    const at = (key) => cells.findIndex((h) => h && COLUMNS[key].some((n) => h === n || h.startsWith(n)));
    const idc = at("id"), dayc = at("day");
    if (idc >= 0 && dayc >= 0 && (at("seats") >= 0 || at("sold") >= 0)) {
      return { row: r, id: idc + 1, name: at("name") + 1, day: dayc + 1, seats: at("seats") + 1, sold: at("sold") + 1, dept: at("dept") + 1, flow: at("flow") + 1 };
    }
  }
  return null;
}

/**
 * Книга Excel → фид. Берутся все листы, где есть столбцы тура, даты и мест: в книге владельца это
 * «ЖД детально» и «ТА детально», а сводные листы и методика пропускаются. Отдел берётся из столбца,
 * а если его нет — из имени листа («ЖД детально» → ЖД).
 */
export async function feedFromWorkbook(buffer, { cutoff = DEFAULT_CUTOFF, source = "xlsx" } = {}) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const by = new Map();
  const sheets = [];
  let own = [];
  for (const sheet of book.worksheets) {
    if (isOwnSheet(sheet.name)) {
      const head = findOwnHeader(sheet);
      if (head) {
        own = readOwnSheet(sheet, head);
        sheets.push({ sheet: sheet.name, rows: own.length, kind: "aggregate" });
        continue;
      }
    }
    const head = findHeader(sheet);
    if (!head) continue;
    let kept = 0;
    for (let r = head.row + 1; r <= sheet.rowCount; r++) {
      const id = Number.parseInt(text(sheet.getCell(r, head.id).value), 10);
      const day = cellDay(sheet.getCell(r, head.day).value);
      if (!Number.isFinite(id) || !day) continue;
      const key = `${id}\u0000${day}`;
      const row = by.get(key) || { id, day, seats: 0, sold: 0, dept: "", name: "" };
      if (head.seats > 0) row.seats += intOf(sheet.getCell(r, head.seats).value);
      if (head.sold > 0) row.sold += intOf(sheet.getCell(r, head.sold).value);
      if (!row.dept) row.dept = head.dept > 0 ? text(sheet.getCell(r, head.dept).value) || sheet.name : sheet.name;
      if (!row.name && head.name > 0) row.name = text(sheet.getCell(r, head.name).value);
      by.set(key, row);
      kept += 1;
    }
    if (kept) sheets.push({ sheet: sheet.name, rows: kept });
  }
  if (!by.size) throw new Error("в книге не нашлось листа с заездами: нужны столбцы тура, даты и мест («ID», «Дата», «Мест», «Продано»)");
  return finishFeed([...by.values()], { cutoff, source, sheets, own });
}

/** Свой продукт: одна строка — один тур. Разбивки мест на архив и глубину в файле нет. */
function readOwnSheet(sheet, head) {
  const out = [];
  for (let r = head.row + 1; r <= sheet.rowCount; r++) {
    const id = Number.parseInt(text(sheet.getCell(r, head.id).value), 10);
    if (!Number.isFinite(id)) continue;
    const cell = (key) => (head[key] > 0 ? sheet.getCell(r, head[key]).value : null);
    out.push({
      id, name: head.name > 0 ? text(cell("name")) : "",
      dates_past: intOf(cell("dates_past")), dates_future: intOf(cell("dates_future")),
      seats: intOf(cell("seats")), sold: intOf(cell("sold")),
      dates_sold: intOf(cell("dates_sold")), fill: numOrNull(cell("fill")), fill_future: numOrNull(cell("fill_future")),
    });
  }
  return out;
}

/** CSV или TSV со строками «тур + дата + мест + продано» → фид. */
export function feedFromCsv(csv, { cutoff = DEFAULT_CUTOFF, source = "csv" } = {}) {
  const rows = parseSalesDatesCsv(csv);
  if (!rows.length) throw new Error("в файле не нашлось строк с туром и датой заезда");
  return finishFeed(rows, { cutoff, source, sheets: [] });
}

function finishFeed(rows, { cutoff, source, sheets, own = [] }) {
  // мест выставлено не меньше занятых: иначе заполнение выйдет больше 100%
  for (const r of rows) if (r.seats < r.sold) r.seats = r.sold;
  const days = rows.map((r) => r.day).sort();
  const tours = new Set(rows.map((r) => r.id));
  return {
    source, cutoff, rows, own,
    stats: { rows: rows.length, tours: tours.size, from: days[0], to: days[days.length - 1], sheets,
      own_tours: own.length, own_sold: own.reduce((s, r) => s + r.sold, 0), own_seats: own.reduce((s, r) => s + r.seats, 0),
      archive: rows.filter((r) => r.day <= cutoff).length, depth: rows.filter((r) => r.day > cutoff).length,
      seats: rows.reduce((s, r) => s + r.seats, 0), sold: rows.reduce((s, r) => s + r.sold, 0) },
  };
}
