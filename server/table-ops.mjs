// Операции над таблицами MBOX на сервере — то, чем пользуются агенты (MCP table_*): прочитать диапазон,
// записать ячейки, оформить, дописать строки. Тот же exceljs и те же правила адресов и цветов, что у
// клиента (src/app/workbench/officeOps.ts для локальных файлов): агент видит таблицу так же, как человек.
// Таблица в базе — xlsx в base64, поэтому все операции читают книгу, меняют её и отдают новую base64.

import ExcelJS from "exceljs";

const MAX_READ_ROWS = 500;
const MAX_READ_COLUMNS = 60;
const MAX_CELL_TEXT = 500;
const MAX_FORMAT_CELLS = 200_000;
const MAX_STYLE_LINES = 200;
const MAX_WRITE_CELLS = 50_000;
const MAX_APPEND_ROWS = 5_000;

export function columnName(index) {
  let result = "";
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

const columnIndex = (letters) => letters.split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);

// --- Значения ------------------------------------------------------------------------------------

function formulaOf(value) {
  return value && typeof value === "object" && "formula" in value ? String(value.formula) : "";
}

function rawValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  if (typeof value === "object") {
    if ("formula" in value) return `=${value.formula}`;
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
    return JSON.stringify(value);
  }
  return String(value);
}

function cellInput(cell) {
  const formula = formulaOf(cell.value);
  return formula ? `=${formula}` : rawValue(cell.value);
}

/** Строка от агента → значение ячейки: «=…» формула, число числом, true/false логическим. */
export function nextCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value);
  if (!text) return null;
  if (text.startsWith("=")) return { formula: text.slice(1), result: undefined };
  if (/^-?(?:\d+|\d*[.,]\d+)$/.test(text.trim())) return Number(text.replace(",", "."));
  if (/^(true|false)$/i.test(text.trim())) return text.trim().toLowerCase() === "true";
  return text;
}

// --- Цвета ---------------------------------------------------------------------------------------

const THEME_COLORS = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];
const NAMED_COLORS = {
  yellow: "FFFF00", red: "FF0000", green: "00B050", blue: "0070C0", orange: "FFC000", gray: "BFBFBF", grey: "BFBFBF",
  white: "FFFFFF", black: "000000", lightgreen: "C6EFCE", lightred: "FFC7CE", lightyellow: "FFEB9C", lightblue: "DDEBF7",
  purple: "7030A0", pink: "FFC0CB",
  желтый: "FFFF00", жёлтый: "FFFF00", красный: "FF0000", зеленый: "00B050", зелёный: "00B050", синий: "0070C0",
  оранжевый: "FFC000", серый: "BFBFBF", белый: "FFFFFF", черный: "000000", чёрный: "000000",
};

function applyTint(hex, tint) {
  return hex.match(/../g).map((part) => {
    const value = parseInt(part, 16);
    const next = tint < 0 ? value * (1 + tint) : value + (255 - value) * tint;
    return Math.round(Math.min(255, Math.max(0, next))).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}

function xlsxColorHex(color) {
  if (!color) return "";
  let hex = "";
  if (typeof color.argb === "string" && /^[0-9a-f]{6,8}$/i.test(color.argb)) hex = color.argb.slice(-6).toUpperCase();
  else if (typeof color.theme === "number") hex = THEME_COLORS[color.theme] ?? "";
  if (!hex) return "";
  return `#${color.tint ? applyTint(hex, color.tint) : hex}`;
}

export function parseColor(value) {
  const text = String(value).trim().toLowerCase();
  const named = NAMED_COLORS[text.replace(/[\s_-]/g, "")];
  if (named) return `FF${named}`;
  const hex = text.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(hex)) return `FF${hex.split("").map((char) => char + char).join("").toUpperCase()}`;
  if (/^[0-9a-f]{6}$/.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-f]{8}$/.test(hex)) return hex.toUpperCase();
  throw new Error(`не понял цвет «${value}» — нужен #RRGGBB или имя (yellow, red, green…)`);
}

function cellFillHex(cell) {
  const fill = cell.fill;
  if (!fill || fill.type !== "pattern" || fill.pattern !== "solid") return "";
  return xlsxColorHex(fill.fgColor);
}

// --- Книга ---------------------------------------------------------------------------------------

export async function loadWorkbook(base64) {
  const book = new ExcelJS.Workbook();
  if (base64) await book.xlsx.load(Buffer.from(base64, "base64"));
  else book.addWorksheet("Лист 1");
  if (!book.worksheets.length) book.addWorksheet("Лист 1");
  return book;
}

export async function workbookToBase64(book) {
  return Buffer.from(await book.xlsx.writeBuffer()).toString("base64");
}

/** Новая таблица из двумерного массива (первая строка — заголовки, если headers). */
export async function workbookFromRows(rows, { sheet = "Лист 1", headers = true } = {}) {
  const book = new ExcelJS.Workbook();
  const worksheet = book.addWorksheet(String(sheet).slice(0, 31) || "Лист 1");
  (Array.isArray(rows) ? rows : []).slice(0, MAX_APPEND_ROWS).forEach((row, rowIndex) => {
    (Array.isArray(row) ? row : [row]).forEach((value, columnIndexValue) => {
      worksheet.getCell(rowIndex + 1, columnIndexValue + 1).value = nextCell(value);
    });
  });
  if (headers && worksheet.rowCount) {
    const head = worksheet.getRow(1);
    head.font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
  }
  return workbookToBase64(book);
}

function pickSheet(book, name, create) {
  if (name) {
    const found = book.getWorksheet(name);
    if (found) return found;
    if (create) return book.addWorksheet(String(name).slice(0, 31));
    throw new Error(`листа «${name}» нет; есть: ${book.worksheets.map((sheet) => sheet.name).join(", ") || "ни одного"}`);
  }
  return book.worksheets[0] ?? book.addWorksheet("Лист 1");
}

/** «B2:F40», «1:10» (строки целиком), «A:C» (столбцы целиком); пусто — весь заполненный диапазон. */
function parseRange(range, sheet, strict = false) {
  const text = String(range || "").toUpperCase().replace(/\s+/g, "");
  const lastRow = Math.max(1, sheet.actualRowCount);
  const lastCol = Math.max(1, sheet.actualColumnCount);
  const cells = text.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  const rows = text.match(/^(\d+)(?::(\d+))?$/);
  const cols = text.match(/^([A-Z]+):([A-Z]+)$/);
  let box = { top: 1, left: 1, bottom: lastRow, right: lastCol };
  if (cells) {
    const top = Number(cells[2]);
    const left = columnIndex(cells[1]);
    box = { top, left, bottom: cells[4] ? Number(cells[4]) : top, right: cells[3] ? columnIndex(cells[3]) : left };
  } else if (rows) box = { top: Number(rows[1]), left: 1, bottom: Number(rows[2] ?? rows[1]), right: lastCol };
  else if (cols) box = { top: 1, left: columnIndex(cols[1]), bottom: lastRow, right: columnIndex(cols[2]) };
  else if (strict) throw new Error(`неверный диапазон «${range ?? ""}» — нужен вида A1:H10, 1:10 или A:C`);
  return { top: Math.min(box.top, box.bottom), bottom: Math.max(box.top, box.bottom), left: Math.min(box.left, box.right), right: Math.max(box.left, box.right) };
}

function styleOf(cell) {
  const parts = [];
  const fill = cellFillHex(cell);
  if (fill) parts.push(`fill ${fill}`);
  const color = xlsxColorHex(cell.font?.color);
  if (color && color !== "#000000") parts.push(`color ${color}`);
  if (cell.font?.bold) parts.push("bold");
  if (cell.font?.italic) parts.push("italic");
  if (cell.font?.underline) parts.push("underline");
  if (cell.font?.strike) parts.push("strike");
  if (cell.alignment?.horizontal) parts.push(`align ${cell.alignment.horizontal}`);
  return parts.join(", ");
}

function describeStyles(sheet, box) {
  const open = new Map();
  const done = [];
  for (let row = box.top; row <= box.bottom; row += 1) {
    const runs = [];
    for (let column = box.left; column <= box.right; column += 1) {
      const style = styleOf(sheet.getCell(row, column));
      if (!style) continue;
      const last = runs[runs.length - 1];
      if (last && last.style === style && last.right === column - 1) last.right = column;
      else runs.push({ left: column, right: column, style });
    }
    const seen = new Set();
    for (const run of runs) {
      const id = `${run.left}:${run.right}:${run.style}`;
      seen.add(id);
      const block = open.get(id);
      if (block) block.bottom = row;
      else open.set(id, { top: row, bottom: row, ...run });
    }
    for (const [id, block] of open) if (!seen.has(id)) { done.push(block); open.delete(id); }
  }
  done.push(...open.values());
  done.sort((a, b) => a.top - b.top || a.left - b.left);
  const address = (row, column) => `${columnName(column)}${row}`;
  const lines = done.slice(0, MAX_STYLE_LINES).map((block) => {
    const from = address(block.top, block.left);
    const to = address(block.bottom, block.right);
    return `${from === to ? from : `${from}:${to}`} ${block.style}`;
  });
  if (done.length > MAX_STYLE_LINES) lines.push(`… и ещё ${done.length - MAX_STYLE_LINES} — сузь range`);
  return lines;
}

/** Чтение диапазона: формулы показываются вместе с результатом («=SUM(B2:B9) → 1250»), если файл их считал. */
export function readTable(book, { sheet: sheetName, range, styles = false } = {}) {
  const sheet = pickSheet(book, sheetName, false);
  const box = parseRange(range, sheet);
  const bottom = Math.min(box.bottom, box.top + MAX_READ_ROWS - 1);
  const right = Math.min(box.right, box.left + MAX_READ_COLUMNS - 1);
  const rows = [];
  for (let row = box.top; row <= bottom; row += 1) {
    const cells = [];
    for (let column = box.left; column <= right; column += 1) {
      const cell = sheet.getCell(row, column);
      const input = cellInput(cell);
      const result = cell.value && typeof cell.value === "object" && "result" in cell.value ? cell.value.result : undefined;
      const shown = input.startsWith("=") && result !== undefined && result !== null ? `${input} → ${rawValue(result)}` : input;
      cells.push(shown.length > MAX_CELL_TEXT ? `${shown.slice(0, MAX_CELL_TEXT)}…` : shown);
    }
    if (cells.some(Boolean)) rows.push({ row, cells });
  }
  return {
    sheets: book.worksheets.map((item) => ({ name: item.name, rows: item.actualRowCount, columns: item.actualColumnCount })),
    sheet: sheet.name,
    top: box.top,
    left: box.left,
    columns: Array.from({ length: right - box.left + 1 }, (_, index) => columnName(box.left + index)),
    rows,
    truncated: bottom < box.bottom || right < box.right,
    ...(styles ? { styles: describeStyles(sheet, { top: box.top, left: box.left, bottom, right }) } : {}),
  };
}

const isCleared = (value) => value === null || String(value).trim().toLowerCase() === "none";

function applyFormat(sheet, rule) {
  if (!rule?.range) throw new Error("у правила оформления нет range");
  const box = parseRange(rule.range, sheet, true);
  const count = (box.bottom - box.top + 1) * (box.right - box.left + 1);
  if (count > MAX_FORMAT_CELLS) throw new Error(`диапазон ${rule.range} слишком большой (${count} ячеек)`);
  const fill = rule.fill === undefined ? undefined : isCleared(rule.fill) ? null : parseColor(rule.fill);
  const color = rule.color === undefined ? undefined : isCleared(rule.color) ? null : parseColor(rule.color);
  const fontChange = {};
  if (color !== undefined) fontChange.color = color ? { argb: color } : undefined;
  for (const name of ["bold", "italic", "strike", "underline"]) if (typeof rule[name] === "boolean") fontChange[name] = rule[name];
  if (typeof rule.size === "number" && rule.size > 0) fontChange.size = rule.size;
  const side = rule.border && rule.border !== "none" ? { style: rule.border, color: { argb: "FF000000" } } : undefined;
  for (let row = box.top; row <= box.bottom; row += 1) {
    for (let column = box.left; column <= box.right; column += 1) {
      const cell = sheet.getCell(row, column);
      // После загрузки ячейки с одинаковым стилем делят один объект style: без своей копии оформление расползётся.
      cell.style = { ...cell.style };
      if (fill !== undefined) cell.fill = fill ? { type: "pattern", pattern: "solid", fgColor: { argb: fill } } : { type: "pattern", pattern: "none" };
      if (Object.keys(fontChange).length) cell.font = { ...cell.font, ...fontChange };
      if (rule.align !== undefined || rule.wrap !== undefined) {
        cell.alignment = {
          ...cell.alignment,
          ...(rule.align !== undefined ? { horizontal: rule.align === "general" ? undefined : rule.align } : {}),
          ...(rule.wrap !== undefined ? { wrapText: rule.wrap } : {}),
        };
      }
      if (rule.number_format !== undefined) cell.numFmt = rule.number_format;
      if (rule.border !== undefined) cell.border = side ? { top: side, left: side, bottom: side, right: side } : {};
    }
  }
  return count;
}

/** Запись ячеек и оформления. Остальное содержимое книги не трогается. */
export function writeCells(book, { sheet: sheetName, cells = {}, format = [] } = {}) {
  const entries = Object.entries(cells && typeof cells === "object" ? cells : {});
  const rules = Array.isArray(format) ? format : [];
  if (!entries.length && !rules.length) throw new Error("не передано ни одной ячейки и ни одного правила оформления");
  if (entries.length > MAX_WRITE_CELLS) throw new Error(`слишком много ячеек за раз (${entries.length}), разбейте на части`);
  const sheet = pickSheet(book, sheetName, true);
  for (const [address, value] of entries) {
    if (!/^[A-Z]{1,3}\d{1,7}$/i.test(address)) throw new Error(`неверный адрес ячейки: ${address}`);
    sheet.getCell(address.toUpperCase()).value = nextCell(value);
  }
  let formatted = 0;
  for (const rule of rules) formatted += applyFormat(sheet, rule);
  return { sheet: sheet.name, cells: entries.length, formatted };
}

/** Дописывает строки под последней заполненной: агенту не надо считать, куда писать. Возвращает диапазон записанного. */
export function appendRows(book, { sheet: sheetName, rows = [] } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("нужен непустой массив rows: [[…], […]]");
  if (rows.length > MAX_APPEND_ROWS) throw new Error(`слишком много строк за раз (${rows.length}), разбейте на части`);
  const sheet = pickSheet(book, sheetName, true);
  let start = 1;
  for (let row = sheet.rowCount; row >= 1; row -= 1) {
    if (sheet.getRow(row).values.some((value) => value !== null && value !== undefined && value !== "")) { start = row + 1; break; }
  }
  let widest = 1;
  rows.forEach((row, rowIndex) => {
    const values = Array.isArray(row) ? row : [row];
    widest = Math.max(widest, values.length);
    values.forEach((value, columnIndexValue) => { sheet.getCell(start + rowIndex, columnIndexValue + 1).value = nextCell(value); });
  });
  return { sheet: sheet.name, range: `A${start}:${columnName(widest)}${start + rows.length - 1}`, rows: rows.length };
}

/** Все текстовые и числовые ячейки книги одной строкой — для поиска. Ограничено, чтобы огромная таблица не раздула базу. */
export function extractText(book, limit = 200_000) {
  const parts = [];
  let size = 0;
  for (const sheet of book.worksheets) {
    if (size >= limit) break;
    parts.push(sheet.name);
    size += sheet.name.length;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (size >= limit) return;
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        const text = value && typeof value === "object" && "formula" in value ? (value.result != null ? rawValue(value.result) : "") : rawValue(value);
        if (text) cells.push(text);
      });
      if (!cells.length) return;
      const line = cells.join(" ");
      parts.push(line);
      size += line.length + 1;
    });
  }
  return parts.join("\n").slice(0, limit);
}

/** Прямоугольник, накрывающий адреса ячеек и диапазоны оформления: что подсветить человеку, пока пишет агент. */
export function touchedRange(cells = {}, format = []) {
  let top = Infinity; let left = Infinity; let bottom = 0; let right = 0;
  const take = (r1, c1, r2, c2) => { top = Math.min(top, r1); left = Math.min(left, c1); bottom = Math.max(bottom, r2); right = Math.max(right, c2); };
  for (const address of Object.keys(cells || {})) {
    const m = address.toUpperCase().match(/^([A-Z]{1,3})(\d{1,7})$/);
    if (m) take(Number(m[2]), columnIndex(m[1]), Number(m[2]), columnIndex(m[1]));
  }
  for (const rule of Array.isArray(format) ? format : []) {
    const m = String(rule?.range || "").toUpperCase().replace(/\s+/g, "").match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
    if (m) take(Number(m[2]), columnIndex(m[1]), Number(m[4] ?? m[2]), m[3] ? columnIndex(m[3]) : columnIndex(m[1]));
  }
  if (!Number.isFinite(top)) return "";
  const from = `${columnName(left)}${top}`;
  const to = `${columnName(right)}${bottom}`;
  return from === to ? from : `${from}:${to}`;
}
