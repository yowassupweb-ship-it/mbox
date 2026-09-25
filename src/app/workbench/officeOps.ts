import type { Borders, Cell, CellValue, Workbook, Worksheet } from "exceljs";
import { base64ToArrayBuffer, bytesToBase64, cellFillHex, cellInput, columnName, delimitedContent, nextCell, parseColor, parseDelimited, rawValue, xlsxColorHex } from "./officeFormat";
import type { WorkspaceBridge } from "./localWorkspace";

/**
 * Операции агентов над таблицами и документами Word в локальных папках (очередь workspace_ops,
 * MCP workspace_read_table / workspace_write_cells / workspace_read_document). Выполняются здесь,
 * в странице MBOX Desktop, теми же exceljs и mammoth, что показывают файл во вкладке: агент видит
 * таблицу так же, как человек, а после записи открытая вкладка перечитывает файл с диска.
 */

const MAX_READ_ROWS = 500;
const MAX_READ_COLUMNS = 60;
const MAX_CELL_TEXT = 500;
const MAX_FORMAT_CELLS = 200_000;
const MAX_STYLE_LINES = 200;

function extensionOf(path: string) {
  return path.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
}

function delimiterOf(path: string, text = "") {
  if (extensionOf(path) === ".tsv") return "\t";
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  // В русской локали Excel пишет CSV через «;» — считаем, какой разделитель встречается чаще.
  return (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
}

function isDelimited(path: string) {
  return [".csv", ".tsv"].includes(extensionOf(path));
}

async function loadBook(bridge: WorkspaceBridge, key: string, path: string, allowMissing: boolean) {
  const { Workbook: ExcelWorkbook } = await import("exceljs");
  const book: Workbook = new ExcelWorkbook();
  let delimiter = delimiterOf(path);
  let mtime: number | undefined;
  try {
    if (!bridge.readData) throw new Error("обновите MBOX Desktop: чтение таблиц недоступно");
    const file = await bridge.readData(key, path);
    if (file.tooLarge) throw new Error(`файл слишком большой (${file.size} байт)`);
    mtime = file.mtime;
    const buffer = base64ToArrayBuffer(file.base64);
    if (isDelimited(path)) {
      const text = new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, "");
      delimiter = delimiterOf(path, text);
      book.addWorksheet("Лист 1").addRows(parseDelimited(text, delimiter));
    } else await book.xlsx.load(buffer);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!allowMissing || !/ENOENT|no such file|не найден/i.test(message)) throw cause;
  }
  return { book, delimiter, mtime };
}

function pickSheet(book: Workbook, name: string | undefined, create: boolean): Worksheet {
  if (name) {
    const found = book.getWorksheet(name);
    if (found) return found;
    if (create) return book.addWorksheet(name);
    throw new Error(`листа «${name}» нет; есть: ${book.worksheets.map((sheet) => sheet.name).join(", ") || "ни одного"}`);
  }
  return book.worksheets[0] ?? book.addWorksheet("Лист 1");
}

/**
 * «B2:F40» → границы. «1:10» — строки целиком, «A:C» — столбцы целиком (в пределах заполненной
 * части листа). Пусто — весь заполненный диапазон. Нераспознанный диапазон при strict — ошибка.
 */
function parseRange(range: string | undefined, sheet: Worksheet, strict = false) {
  const text = String(range || "").toUpperCase().replace(/\s+/g, "");
  const colIndex = (letters: string) => letters.split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
  const lastRow = Math.max(1, sheet.actualRowCount);
  const lastCol = Math.max(1, sheet.actualColumnCount);
  const cells = text.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  const rows = text.match(/^(\d+)(?::(\d+))?$/);
  const cols = text.match(/^([A-Z]+):([A-Z]+)$/);
  let box = { top: 1, left: 1, bottom: lastRow, right: lastCol };
  if (cells) {
    const top = Number(cells[2]);
    const left = colIndex(cells[1]);
    box = { top, left, bottom: cells[4] ? Number(cells[4]) : top, right: cells[3] ? colIndex(cells[3]) : left };
  } else if (rows) box = { top: Number(rows[1]), left: 1, bottom: Number(rows[2] ?? rows[1]), right: lastCol };
  else if (cols) box = { top: 1, left: colIndex(cols[1]), bottom: lastRow, right: colIndex(cols[2]) };
  else if (strict) throw new Error(`неверный диапазон «${range ?? ""}» — нужен вида A1:H10, 1:10 или A:C`);
  return {
    top: Math.min(box.top, box.bottom), bottom: Math.max(box.top, box.bottom),
    left: Math.min(box.left, box.right), right: Math.max(box.left, box.right),
  };
}

export type TableRead = {
  sheets: Array<{ name: string; rows: number; columns: number }>;
  sheet: string;
  top: number;
  left: number;
  columns: string[];
  rows: Array<{ row: number; cells: string[] }>;
  truncated: boolean;
  /** Только при styles: «A1:H10 fill #FFFF00, bold» — прямоугольники с одинаковым оформлением. */
  styles?: string[];
};

/** Короткое описание оформления ячейки для агента; пусто — оформления нет. */
function styleOf(cell: Cell) {
  const parts: string[] = [];
  const fill = cellFillHex(cell);
  if (fill) parts.push(`fill ${fill}`);
  const color = xlsxColorHex(cell.font?.color);
  if (color && color !== "#000000") parts.push(`color ${color}`);
  if (cell.font?.bold) parts.push("bold");
  if (cell.font?.italic) parts.push("italic");
  if (cell.font?.underline) parts.push("underline");
  if (cell.font?.strike) parts.push("strike");
  const align = cell.alignment?.horizontal;
  if (align) parts.push(`align ${align}`);
  return parts.join(", ");
}

type StyleBlock = { top: number; bottom: number; left: number; right: number; style: string };

/** Оформление диапазона → прямоугольники: в строке склеиваем соседние столбцы, затем одинаковые полосы соседних строк. */
function describeStyles(sheet: Worksheet, box: { top: number; left: number; bottom: number; right: number }) {
  const open = new Map<string, StyleBlock>();
  const done: StyleBlock[] = [];
  for (let row = box.top; row <= box.bottom; row += 1) {
    const runs: Array<{ left: number; right: number; style: string }> = [];
    for (let column = box.left; column <= box.right; column += 1) {
      const style = styleOf(sheet.getCell(row, column));
      if (!style) continue;
      const last = runs[runs.length - 1];
      if (last && last.style === style && last.right === column - 1) last.right = column;
      else runs.push({ left: column, right: column, style });
    }
    const seen = new Set<string>();
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
  const address = (row: number, column: number) => `${columnName(column)}${row}`;
  const lines = done.slice(0, MAX_STYLE_LINES).map((block) => {
    const from = address(block.top, block.left);
    const to = address(block.bottom, block.right);
    return `${from === to ? from : `${from}:${to}`} ${block.style}`;
  });
  if (done.length > MAX_STYLE_LINES) lines.push(`… и ещё ${done.length - MAX_STYLE_LINES} — сузь range`);
  return lines;
}

export async function readTable(bridge: WorkspaceBridge, key: string, path: string, request: { sheet?: string; range?: string; styles?: boolean }): Promise<TableRead> {
  const { book } = await loadBook(bridge, key, path, false);
  const sheet = pickSheet(book, request.sheet, false);
  const range = parseRange(request.range, sheet);
  const bottom = Math.min(range.bottom, range.top + MAX_READ_ROWS - 1);
  const right = Math.min(range.right, range.left + MAX_READ_COLUMNS - 1);
  const rows: TableRead["rows"] = [];
  for (let row = range.top; row <= bottom; row += 1) {
    const cells: string[] = [];
    for (let column = range.left; column <= right; column += 1) {
      const cell = sheet.getCell(row, column);
      const input = cellInput(cell);
      // Формулу агенту нужно видеть вместе с результатом: «=SUM(B2:B9) → 1250». Результат есть, только
      // если файл сохранял Excel: exceljs формулы не пересчитывает, и тогда видна одна формула.
      const result = cell.value && typeof cell.value === "object" && "result" in cell.value ? cell.value.result : undefined;
      const shown = input.startsWith("=") && result !== undefined && result !== null ? `${input} → ${rawValue(result as CellValue)}` : input;
      cells.push(shown.length > MAX_CELL_TEXT ? `${shown.slice(0, MAX_CELL_TEXT)}…` : shown);
    }
    if (cells.some(Boolean)) rows.push({ row, cells });
  }
  return {
    sheets: book.worksheets.map((item) => ({ name: item.name, rows: item.actualRowCount, columns: item.actualColumnCount })),
    sheet: sheet.name,
    top: range.top,
    left: range.left,
    columns: Array.from({ length: right - range.left + 1 }, (_, index) => columnName(range.left + index)),
    rows,
    truncated: bottom < range.bottom || right < range.right,
    ...(request.styles ? { styles: describeStyles(sheet, { top: range.top, left: range.left, bottom, right }) } : {}),
  };
}

/**
 * Оформление диапазона (MCP workspace_format_cells). Каждое свойство необязательно: заданное
 * меняется, остальное оформление ячейки остаётся. fill/color: null или "none" — снять.
 */
export type FormatRule = {
  range: string;
  fill?: string | null;
  color?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  align?: "left" | "center" | "right" | "general";
  wrap?: boolean;
  number_format?: string;
  border?: "thin" | "medium" | "thick" | "none";
};

const isCleared = (value: unknown) => value === null || String(value).trim().toLowerCase() === "none";

function applyFormat(sheet: Worksheet, rule: FormatRule) {
  if (!rule?.range) throw new Error("у правила оформления нет range");
  const box = parseRange(rule.range, sheet, true);
  const count = (box.bottom - box.top + 1) * (box.right - box.left + 1);
  if (count > MAX_FORMAT_CELLS) throw new Error(`диапазон ${rule.range} слишком большой (${count} ячеек)`);
  const fill = rule.fill === undefined ? undefined : isCleared(rule.fill) ? null : parseColor(String(rule.fill));
  const color = rule.color === undefined ? undefined : isCleared(rule.color) ? null : parseColor(String(rule.color));
  const fontChange: Record<string, unknown> = {};
  if (color !== undefined) fontChange.color = color ? { argb: color } : undefined;
  for (const name of ["bold", "italic", "strike", "underline"] as const) if (typeof rule[name] === "boolean") fontChange[name] = rule[name];
  if (typeof rule.size === "number" && rule.size > 0) fontChange.size = rule.size;
  const side = rule.border && rule.border !== "none" ? { style: rule.border, color: { argb: "FF000000" } } : undefined;
  for (let row = box.top; row <= box.bottom; row += 1) {
    for (let column = box.left; column <= box.right; column += 1) {
      const cell = sheet.getCell(row, column);
      // exceljs после загрузки даёт ячейкам с одинаковым стилем один общий объект style, а сеттеры
      // cell.font/fill пишут прямо в него — без своей копии оформление расползётся по всему листу.
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
      if (rule.border !== undefined) cell.border = (side ? { top: side, left: side, bottom: side, right: side } : {}) as Partial<Borders>;
    }
  }
  return count;
}

/**
 * Запись ячеек: `cells` — { "B3": "текст", "C3": 12, "D3": "=B3*C3", "E3": null }; `format` — правила
 * оформления диапазонов (FormatRule), применяются после значений. Файла нет — создаётся (xlsx или
 * csv по расширению). Остальное содержимое книги не трогается.
 */
export async function writeCells(bridge: WorkspaceBridge, key: string, path: string, request: { sheet?: string; cells?: Record<string, unknown>; format?: FormatRule[] }) {
  if (!bridge.writeData) throw new Error("обновите MBOX Desktop: запись таблиц недоступна");
  const entries = Object.entries(request.cells ?? {});
  const format = Array.isArray(request.format) ? request.format : [];
  if (!entries.length && !format.length) throw new Error("не передано ни одной ячейки и ни одного правила оформления");
  if (format.length && isDelimited(path)) throw new Error("в CSV/TSV нет оформления — цвет и шрифт хранятся только в .xlsx");
  const { book, delimiter, mtime } = await loadBook(bridge, key, path, true);
  const sheet = pickSheet(book, request.sheet, true);
  for (const [address, value] of entries) {
    if (!/^[A-Z]{1,3}\d{1,7}$/i.test(address)) throw new Error(`неверный адрес ячейки: ${address}`);
    const cell = sheet.getCell(address.toUpperCase());
    if (value === null || value === undefined) cell.value = null;
    else if (typeof value === "number" || typeof value === "boolean") cell.value = value;
    else cell.value = nextCell(String(value));
  }
  let formatted = 0;
  for (const rule of format) formatted += applyFormat(sheet, rule);
  const base64 = isDelimited(path)
    ? bytesToBase64(new TextEncoder().encode(delimitedContent(sheet, delimiter)))
    : bytesToBase64(await book.xlsx.writeBuffer());
  const written = await bridge.writeData(key, path, base64, mtime);
  return { path: written.path, size: written.size, sheet: sheet.name, cells: entries.length, formatted };
}

/** Word → текст с разметкой (заголовки, списки, таблицы как markdown) — mammoth, как во вкладке. */
export async function readDocument(bridge: WorkspaceBridge, key: string, path: string) {
  if (!bridge.readData) throw new Error("обновите MBOX Desktop: чтение документов недоступно");
  if (extensionOf(path) !== ".docx") throw new Error("читается только .docx; для .txt/.md — workspace_read_file");
  const file = await bridge.readData(key, path);
  if (file.tooLarge) throw new Error(`файл слишком большой (${file.size} байт)`);
  const mammoth = await import("mammoth");
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: base64ToArrayBuffer(file.base64) });
  return { path: file.path, size: file.size, content: htmlToMarkdown(html) };
}

/** Упрощённый HTML mammoth → markdown: агенту хватает структуры, стили ему не нужны. */
function htmlToMarkdown(html: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const lines: string[] = [];
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    const inner = [...node.childNodes].map(inline).join("");
    if (node.tagName === "STRONG" || node.tagName === "B") return inner.trim() ? `**${inner}**` : inner;
    if (node.tagName === "EM" || node.tagName === "I") return inner.trim() ? `*${inner}*` : inner;
    if (node.tagName === "A") return `[${inner}](${node.getAttribute("href") ?? ""})`;
    if (node.tagName === "BR") return "\n";
    return inner;
  };
  for (const node of [...doc.body.children]) {
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) lines.push(`${"#".repeat(Number(tag[1]))} ${inline(node).trim()}`);
    else if (tag === "UL" || tag === "OL") {
      [...node.children].forEach((item, index) => lines.push(`${tag === "OL" ? `${index + 1}.` : "-"} ${inline(item).trim()}`));
    } else if (tag === "TABLE") {
      const rows = [...node.querySelectorAll("tr")].map((row) => [...row.children].map((cell) => inline(cell).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()));
      rows.forEach((row, index) => {
        lines.push(`| ${row.join(" | ")} |`);
        if (index === 0) lines.push(`| ${row.map(() => "---").join(" | ")} |`);
      });
    } else lines.push(inline(node).trim());
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
