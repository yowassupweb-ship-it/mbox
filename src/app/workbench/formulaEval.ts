import type { CellValue, Worksheet } from "exceljs";

/**
 * Вычисление формул прямо в редакторе таблицы. exceljs формулы не считает: новая «=A1+A2» оставалась
 * пустой ячейкой, пока файл не откроют в Excel. Здесь — то, что покрывает обычные таблицы: числа, строки,
 * ссылки (A1, $B$2), диапазоны (A1:B5), + - * / ^ &, сравнения и функции SUM, AVERAGE, MIN, MAX, COUNT,
 * COUNTA, IF, ROUND, ABS, CONCAT. Незнакомая функция — ошибка, и в ячейке остаётся прежний результат из файла.
 */

type Value = number | string | boolean | null;
type Token = { kind: "num" | "str" | "ref" | "range" | "name" | "op" | "(" | ")" | ","; text: string };

const ERROR = "#ERROR!";

function columnIndex(letters: string) {
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index;
}

function parseRef(text: string) {
  const match = text.replace(/\$/g, "").match(/^([A-Za-z]{1,3})(\d+)$/);
  return match ? { c: columnIndex(match[1]), r: Number(match[2]) } : null;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  // Русская запись Excel: аргументы через «;», дробь через запятую. Английская: аргументы через запятую.
  const commaDecimal = source.includes(";");
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const space = rest.match(/^\s+/);
    if (space) { i += space[0].length; continue; }
    const range = rest.match(/^\$?[A-Za-z]{1,3}\$?\d+:\$?[A-Za-z]{1,3}\$?\d+/);
    if (range) { tokens.push({ kind: "range", text: range[0] }); i += range[0].length; continue; }
    const ref = rest.match(/^\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z(])/);
    if (ref) { tokens.push({ kind: "ref", text: ref[0] }); i += ref[0].length; continue; }
    const num = rest.match(commaDecimal ? /^\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?/ : /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (num) { tokens.push({ kind: "num", text: num[0].replace(",", ".") }); i += num[0].length; continue; }
    if (rest[0] === '"') {
      const end = rest.indexOf('"', 1);
      if (end < 0) throw new Error("незакрытая строка");
      tokens.push({ kind: "str", text: rest.slice(1, end) });
      i += end + 1;
      continue;
    }
    const name = rest.match(/^[A-Za-zА-Яа-я_][A-Za-zА-Яа-я_0-9.]*/);
    if (name) { tokens.push({ kind: "name", text: name[0].toUpperCase() }); i += name[0].length; continue; }
    const op = rest.match(/^(<=|>=|<>|[-+*/^&=<>;])/);
    if (op) { tokens.push({ kind: op[0] === ";" ? "," : "op", text: op[0] === ";" ? "," : op[0] }); i += op[0].length; continue; }
    if (rest[0] === "(" || rest[0] === ")" || rest[0] === ",") { tokens.push({ kind: rest[0] as "(" | ")" | ",", text: rest[0] }); i += 1; continue; }
    throw new Error(`непонятный символ «${rest[0]}»`);
  }
  return tokens;
}

function toNumber(value: Value | Value[]): number {
  if (Array.isArray(value)) return toNumber(value[0] ?? null);
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === "") return 0;
  const parsed = Number(String(value).replace(",", "."));
  if (Number.isNaN(parsed)) throw new Error("не число");
  return parsed;
}

function flat(values: Array<Value | Value[]>) {
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

const FUNCTIONS: Record<string, (args: Array<Value | Value[]>) => Value> = {
  SUM: (args) => flat(args).filter((v) => typeof v === "number").reduce<number>((sum, v) => sum + (v as number), 0),
  СУММ: (args) => FUNCTIONS.SUM(args),
  AVERAGE: (args) => { const nums = flat(args).filter((v) => typeof v === "number") as number[]; return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; },
  СРЗНАЧ: (args) => FUNCTIONS.AVERAGE(args),
  MIN: (args) => { const nums = flat(args).filter((v) => typeof v === "number") as number[]; return nums.length ? Math.min(...nums) : 0; },
  МИН: (args) => FUNCTIONS.MIN(args),
  MAX: (args) => { const nums = flat(args).filter((v) => typeof v === "number") as number[]; return nums.length ? Math.max(...nums) : 0; },
  МАКС: (args) => FUNCTIONS.MAX(args),
  COUNT: (args) => flat(args).filter((v) => typeof v === "number").length,
  СЧЁТ: (args) => FUNCTIONS.COUNT(args),
  COUNTA: (args) => flat(args).filter((v) => v !== null && v !== "").length,
  СЧЁТЗ: (args) => FUNCTIONS.COUNTA(args),
  IF: (args) => (toNumber(args[0] ?? null) ? (args[1] as Value) ?? true : (args[2] as Value) ?? false),
  ЕСЛИ: (args) => FUNCTIONS.IF(args),
  ROUND: (args) => { const digits = toNumber(args[1] ?? 0); const factor = 10 ** digits; return Math.round(toNumber(args[0] ?? null) * factor) / factor; },
  ОКРУГЛ: (args) => FUNCTIONS.ROUND(args),
  ABS: (args) => Math.abs(toNumber(args[0] ?? null)),
  CONCAT: (args) => flat(args).map((v) => (v === null ? "" : String(v))).join(""),
  СЦЕП: (args) => FUNCTIONS.CONCAT(args),
};

/** Значение ячейки для формулы: результат формулы, число, строка. */
export function scalarOf(value: CellValue): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object") {
    if ("result" in value) {
      const result = (value as { result?: unknown }).result;
      return typeof result === "number" || typeof result === "string" || typeof result === "boolean" ? result : null;
    }
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String((value as { text: unknown }).text);
  }
  return null;
}

export function evaluateFormula(formula: string, read: (r: number, c: number) => Value): Value {
  const tokens = tokenize(formula);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function primary(): Value | Value[] {
    const token = take();
    if (!token) throw new Error("формула оборвалась");
    if (token.kind === "num") return Number(token.text);
    if (token.kind === "str") return token.text;
    if (token.kind === "ref") { const ref = parseRef(token.text)!; return read(ref.r, ref.c); }
    if (token.kind === "range") {
      const [a, b] = token.text.split(":").map((part) => parseRef(part)!);
      const values: Value[] = [];
      for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r += 1) {
        for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c += 1) values.push(read(r, c));
      }
      return values;
    }
    if (token.kind === "name") {
      if (token.text === "TRUE" || token.text === "ИСТИНА") return true;
      if (token.text === "FALSE" || token.text === "ЛОЖЬ") return false;
      const fn = FUNCTIONS[token.text];
      if (!fn || take()?.kind !== "(") throw new Error(`неизвестная функция ${token.text}`);
      const args: Array<Value | Value[]> = [];
      if (peek()?.kind !== ")") {
        for (;;) {
          args.push(comparison());
          if (peek()?.kind === ",") { take(); continue; }
          break;
        }
      }
      if (take()?.kind !== ")") throw new Error("нет закрывающей скобки");
      return fn(args);
    }
    if (token.kind === "(") {
      const value = comparison();
      if (take()?.kind !== ")") throw new Error("нет закрывающей скобки");
      return value;
    }
    if (token.kind === "op" && (token.text === "-" || token.text === "+")) {
      const value = toNumber(unaryPower());
      return token.text === "-" ? -value : value;
    }
    throw new Error(`неожиданное «${token.text}»`);
  }

  function unaryPower(): Value | Value[] {
    let left = primary();
    while (peek()?.text === "^") { take(); left = toNumber(left) ** toNumber(primary()); }
    return left;
  }

  function term(): Value | Value[] {
    let left = unaryPower();
    while (peek()?.text === "*" || peek()?.text === "/") {
      const op = take().text;
      const right = toNumber(unaryPower());
      if (op === "/" && right === 0) throw new Error("#DIV/0!");
      left = op === "*" ? toNumber(left) * right : toNumber(left) / right;
    }
    return left;
  }

  function sum(): Value | Value[] {
    let left = term();
    while (peek()?.text === "+" || peek()?.text === "-" || peek()?.text === "&") {
      const op = take().text;
      const right = term();
      left = op === "&" ? `${Array.isArray(left) ? left[0] ?? "" : left ?? ""}${Array.isArray(right) ? right[0] ?? "" : right ?? ""}` : op === "+" ? toNumber(left) + toNumber(right) : toNumber(left) - toNumber(right);
    }
    return left;
  }

  function comparison(): Value | Value[] {
    const left = sum();
    const op = peek()?.text;
    if (!op || !["=", "<>", "<", ">", "<=", ">="].includes(op)) return left;
    take();
    const right = sum();
    const a = Array.isArray(left) ? left[0] ?? null : left;
    const b = Array.isArray(right) ? right[0] ?? null : right;
    const numeric = typeof a === "number" || typeof b === "number";
    const x = numeric ? toNumber(a) : String(a ?? "");
    const y = numeric ? toNumber(b) : String(b ?? "");
    switch (op) {
      case "=": return x === y;
      case "<>": return x !== y;
      case "<": return x < y;
      case ">": return x > y;
      case "<=": return x <= y;
      default: return x >= y;
    }
  }

  const result = comparison();
  if (pos < tokens.length) throw new Error("лишние символы в формуле");
  return Array.isArray(result) ? result[0] ?? null : result;
}

/**
 * Пересчитать все формулы листа. Несколько проходов — формула может ссылаться на другую формулу;
 * циклическая ссылка просто остановится на последнем проходе.
 */
export function recalculate(sheet: Worksheet) {
  const formulas: Array<{ r: number; c: number; formula: string }> = [];
  sheet.eachRow({ includeEmpty: false }, (row, r) => {
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      const value = cell.value;
      if (value && typeof value === "object" && "formula" in value && !("sharedFormula" in value)) formulas.push({ r, c, formula: String(value.formula) });
    });
  });
  if (!formulas.length) return;
  const read = (r: number, c: number) => scalarOf(sheet.getCell(r, c).value);
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const item of formulas) {
      let result: Value;
      try {
        result = evaluateFormula(item.formula, read);
      } catch (error) {
        // Незнакомая функция — оставляем результат, который посчитал Excel; ошибка вычисления — пишем её.
        if (error instanceof Error && error.message.startsWith("неизвестная функция")) continue;
        result = error instanceof Error && error.message.startsWith("#") ? error.message : ERROR;
      }
      const cell = sheet.getCell(item.r, item.c);
      const previous = scalarOf(cell.value);
      if (previous !== result) {
        cell.value = { formula: item.formula, result: result === null ? undefined : result } as CellValue;
        changed = true;
      }
    }
    if (!changed) break;
  }
}
