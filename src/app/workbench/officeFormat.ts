import type { Cell, CellValue, Worksheet } from "exceljs";

// Общее для вкладки таблицы (LocalOfficeDocument) и операций агентов над локальными таблицами
// (officeOps.ts): ячейка читается и пишется одинаково — формула как «=…», число числом.

export function base64ToArrayBuffer(base64: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function bytesToBase64(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let from = 0; from < bytes.length; from += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(from, Math.min(bytes.length, from + 0x8000)));
  }
  return window.btoa(binary);
}

export function formulaOf(value: CellValue) {
  return value && typeof value === "object" && "formula" in value ? String(value.formula) : "";
}

export function rawValue(value: CellValue) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleString("ru-RU");
  if (typeof value === "object") {
    if ("formula" in value) return `=${value.formula}`;
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
    return JSON.stringify(value);
  }
  return String(value);
}

export function cellText(cell?: Cell) {
  if (!cell) return "";
  return cell.text || rawValue(cell.value);
}

export function cellInput(cell?: Cell) {
  if (!cell) return "";
  const formula = formulaOf(cell.value);
  return formula ? `=${formula}` : rawValue(cell.value);
}

export function nextCell(value: string): CellValue {
  if (!value) return null;
  if (value.startsWith("=")) return { formula: value.slice(1), result: undefined };
  if (/^-?(?:\d+|\d*[.,]\d+)$/.test(value.trim())) return Number(value.replace(",", "."));
  if (/^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  return value;
}

// --- Цвета xlsx -----------------------------------------------------------------------------
// В файле цвет лежит тремя способами: argb («FFFFFF00»), номер цвета темы с оттенком (tint) или
// номер старой палитры (indexed). Тема — стандартная Office: свою тему файла exceljs не разбирает.

const THEME_COLORS = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];
const INDEXED_COLORS = (
  "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF " +
  "800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF " +
  "000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 " +
  "3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333"
).split(" ");

type XlsxColor = { argb?: string; theme?: number; tint?: number; indexed?: number };

function applyTint(hex: string, tint: number) {
  return hex.match(/../g)!.map((part) => {
    const value = parseInt(part, 16);
    const next = tint < 0 ? value * (1 + tint) : value + (255 - value) * tint;
    return Math.round(Math.min(255, Math.max(0, next))).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}

/** Цвет xlsx → «#RRGGBB»; пустая строка, если цвета нет или он не разбирается. */
export function xlsxColorHex(color: Partial<XlsxColor> | undefined) {
  if (!color) return "";
  let hex = "";
  if (typeof color.argb === "string" && /^[0-9a-f]{6,8}$/i.test(color.argb)) hex = color.argb.slice(-6).toUpperCase();
  else if (typeof color.theme === "number") hex = THEME_COLORS[color.theme] ?? "";
  else if (typeof color.indexed === "number") hex = INDEXED_COLORS[color.indexed] ?? "";
  if (!hex) return "";
  return `#${color.tint ? applyTint(hex, color.tint) : hex}`;
}

/** Заливка ячейки — только сплошная (pattern solid), как её ставит Excel кнопкой «Цвет заливки». */
export function cellFillHex(cell: Cell) {
  const fill = cell.fill as { type?: string; pattern?: string; fgColor?: XlsxColor } | undefined;
  if (!fill || fill.type !== "pattern" || fill.pattern !== "solid") return "";
  return xlsxColorHex(fill.fgColor);
}

const NAMED_COLORS: Record<string, string> = {
  yellow: "FFFF00", red: "FF0000", green: "00B050", blue: "0070C0", orange: "FFC000", gray: "BFBFBF", grey: "BFBFBF",
  white: "FFFFFF", black: "000000", lightgreen: "C6EFCE", lightred: "FFC7CE", lightyellow: "FFEB9C", lightblue: "DDEBF7",
  purple: "7030A0", pink: "FFC0CB",
  желтый: "FFFF00", жёлтый: "FFFF00", красный: "FF0000", зеленый: "00B050", зелёный: "00B050", синий: "0070C0",
  оранжевый: "FFC000", серый: "BFBFBF", белый: "FFFFFF", черный: "000000", чёрный: "000000",
};

/** «#FF0», «ff0000», «yellow», «жёлтый» → argb «FFFF0000» для exceljs. */
export function parseColor(value: string) {
  const text = value.trim().toLowerCase();
  const named = NAMED_COLORS[text.replace(/[\s_-]/g, "")];
  if (named) return `FF${named}`;
  const hex = text.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(hex)) return `FF${hex.split("").map((char) => char + char).join("").toUpperCase()}`;
  if (/^[0-9a-f]{6}$/.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-f]{8}$/.test(hex)) return hex.toUpperCase();
  throw new Error(`не понял цвет «${value}» — нужен #RRGGBB или имя (yellow, red, green…)`);
}

export function columnName(index: number) {
  let result = "";
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

export function parseDelimited(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === delimiter) { row.push(cell); cell = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function quoteDelimited(value: string, delimiter: string) {
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function delimitedContent(sheet: Worksheet, delimiter: string) {
  const rows: string[] = [];
  for (let row = 1; row <= sheet.actualRowCount; row += 1) {
    const values: string[] = [];
    for (let column = 1; column <= sheet.actualColumnCount; column += 1) values.push(quoteDelimited(cellInput(sheet.getCell(row, column)), delimiter));
    rows.push(values.join(delimiter));
  }
  return rows.join("\r\n");
}
