import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowDownAZ, ArrowUpAZ, Columns3, Filter, FilterX, Pin, Plus, Redo2, Rows3, Search, Trash2, Undo2, X } from "lucide-react";
import type { Cell, CellValue, Workbook, Worksheet } from "exceljs";
import { cellFillHex, cellInput, cellText, columnName, nextCell, xlsxColorHex } from "./officeFormat";
import { recalculate, scalarOf } from "./formulaEval";
import { WbMenu } from "./WbMenu";

/**
 * Редактор листа как в Excel: виртуальная сетка (рисуются только видимые ячейки — лист на десятки тысяч
 * строк не тормозит), ввод прямо в ячейке, выделение диапазона мышью и клавиатурой, копирование и вставка
 * в формате Excel (TSV), вставка и удаление строк и столбцов, отмена/повтор, ширина столбцов, сортировка,
 * фильтр по столбцу, закреплённая строка заголовков, поиск и сводка по выделению (сумма, среднее).
 *
 * Модель — сам лист exceljs: правки пишутся в него, файл сохраняет вкладка-владелец.
 */

const ROW_H = 24;
const HEAD_W = 52;
const HEAD_H = 24;
const DEFAULT_COL_PX = 104;
const MIN_COL_PX = 36;
const OVERSCAN = 6;

type Cellpos = { r: number; c: number };
type Selection = { anchor: Cellpos; focus: Cellpos };
type Change = { label: string; undo: () => void; redo: () => void };
type MenuState = { x: number; y: number; kind: "cell" | "row" | "col" } | null;

const colPx = (sheet: Worksheet, c: number) => {
  const width = sheet.getColumn(c).width;
  return width ? Math.max(MIN_COL_PX, Math.round(width * 7 + 5)) : DEFAULT_COL_PX;
};

/**
 * Оформление ячейки из файла: заливка, цвет и начертание шрифта, выравнивание. Заливка идёт через
 * --cell-fill, чтобы выделение и фокус подмешивались к ней, а не затирали её. Чёрный шрифт без
 * заливки не ставим: в тёмной теме он пропадёт, а в Excel это просто цвет по умолчанию.
 */
function cellLook(cell: Cell) {
  const look: Record<string, string | number> = {};
  const fill = cellFillHex(cell);
  const font = cell.font;
  const color = xlsxColorHex(font?.color);
  if (fill) {
    look["--cell-fill"] = fill;
    look.color = color || "#000";
  } else if (color && !/^#(000000|FFFFFF)$/.test(color)) look.color = color;
  if (font?.bold) look.fontWeight = 600;
  if (font?.italic) look.fontStyle = "italic";
  const lines = [font?.underline ? "underline" : "", font?.strike ? "line-through" : ""].filter(Boolean);
  if (lines.length) look.textDecoration = lines.join(" ");
  const align = cell.alignment?.horizontal;
  if (align === "left" || align === "center" || align === "right") look.textAlign = align;
  return look;
}

function isNumeric(value: CellValue) {
  const scalar = scalarOf(value);
  return typeof scalar === "number";
}

function normalize(sel: Selection) {
  return {
    r1: Math.min(sel.anchor.r, sel.focus.r),
    r2: Math.max(sel.anchor.r, sel.focus.r),
    c1: Math.min(sel.anchor.c, sel.focus.c),
    c2: Math.max(sel.anchor.c, sel.focus.c),
  };
}

function snapshotRows(sheet: Worksheet, from: number, to: number, cols: number) {
  const rows: CellValue[][] = [];
  for (let r = from; r <= to; r += 1) {
    const row: CellValue[] = [];
    for (let c = 1; c <= cols; c += 1) row.push(sheet.getCell(r, c).value);
    rows.push(row);
  }
  return rows;
}

function restoreRows(sheet: Worksheet, from: number, rows: CellValue[][]) {
  rows.forEach((row, index) => row.forEach((value, c) => { sheet.getCell(from + index, c + 1).value = value ?? null; }));
}

export function SheetEditor({ book, sheetName, onSheetName, onChange, visible, readOnly = false }: {
  book: Workbook;
  sheetName: string;
  onSheetName: (name: string) => void;
  /** Лист изменился — вкладка помечает файл несохранённым. */
  onChange: () => void;
  visible: boolean;
  readOnly?: boolean;
}) {
  const sheet = book.getWorksheet(sheetName) ?? book.worksheets[0];
  const [version, setVersion] = useState(0);
  const [sel, setSel] = useState<Selection>({ anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
  const [editing, setEditing] = useState<{ value: string; pos: Cellpos } | null>(null);
  const [formula, setFormula] = useState("");
  const [scroll, setScroll] = useState({ top: 0, left: 0, width: 800, height: 500 });
  const [menu, setMenu] = useState<MenuState>(null);
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [filterEdit, setFilterEdit] = useState<{ c: number; x: number; y: number } | null>(null);
  const [find, setFind] = useState<{ open: boolean; text: string; hit: string }>({ open: false, text: "", hit: "" });
  const [renamingSheet, setRenamingSheet] = useState<string | null>(null);
  const undoRef = useRef<Change[]>([]);
  const redoRef = useRef<Change[]>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const dragRef = useRef(false);

  // Закреплённая первая строка — это строка заголовков: не сортируется и не фильтруется.
  const frozen = Boolean(sheet?.views?.[0] && (sheet.views[0] as { state?: string; ySplit?: number }).state === "frozen" && ((sheet.views[0] as { ySplit?: number }).ySplit ?? 0) >= 1);
  const bump = useCallback(() => setVersion((value) => value + 1), []);

  // Размер: данные плюс запас для ввода; растёт, когда выделение уходит к краю.
  const dataRows = sheet ? Math.max(sheet.rowCount, sheet.actualRowCount) : 0;
  const dataCols = sheet ? Math.max(sheet.columnCount, sheet.actualColumnCount) : 0;
  const rowCount = Math.max(dataRows + 30, 60, sel.focus.r + 20);
  const colCount = Math.min(16384, Math.max(dataCols + 6, 26, sel.focus.c + 6));

  // Фильтр: какие строки листа видны (номера строк в порядке показа).
  const rowOrder = useMemo(() => {
    const active = Object.entries(filters).filter(([, text]) => text.trim());
    if (!sheet || !active.length) return null;
    const order: number[] = [];
    for (let r = 1; r <= rowCount; r += 1) {
      if (frozen && r === 1) continue;
      if (r > dataRows) break;
      const ok = active.every(([c, text]) => cellText(sheet.getCell(r, Number(c))).toLowerCase().includes(text.trim().toLowerCase()));
      if (ok) order.push(r);
    }
    return order;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sheet, version, rowCount, dataRows, frozen]);

  // Видимая строка №i (0-based, без закреплённой) → номер строки листа.
  const bodyStart = frozen ? 2 : 1;
  const bodyCount = rowOrder ? rowOrder.length : rowCount - (frozen ? 1 : 0);
  const rowAt = useCallback((i: number) => (rowOrder ? rowOrder[i] : i + bodyStart), [rowOrder, bodyStart]);
  const indexOfRow = useCallback((r: number) => (rowOrder ? rowOrder.indexOf(r) : r - bodyStart), [rowOrder, bodyStart]);

  const colLeft = useMemo(() => {
    const lefts = [0];
    for (let c = 1; c <= colCount; c += 1) lefts.push(lefts[c - 1] + (sheet ? colPx(sheet, c) : DEFAULT_COL_PX));
    return lefts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, colCount, version]);
  const totalWidth = colLeft[colCount];
  const headH = HEAD_H + (frozen ? ROW_H : 0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setScroll({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

  // Смена листа — всё с начала.
  useEffect(() => {
    setSel({ anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
    setEditing(null);
    setFilters({});
    undoRef.current = [];
    redoRef.current = [];
    scrollerRef.current?.scrollTo({ top: 0, left: 0 });
  }, [sheetName]);

  useEffect(() => {
    if (sheet) setFormula(cellInput(sheet.getCell(sel.focus.r, sel.focus.c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.focus.r, sel.focus.c, sheet, version]);

  useEffect(() => { if (visible && !editing) scrollerRef.current?.focus({ preventScroll: true }); }, [visible, sheetName, editing]);

  if (!sheet) return <div className="wb-doc-missing">В книге нет листов.</div>;

  // --- Изменения с отменой -------------------------------------------------------------------

  function commit(change: Change) {
    change.redo();
    recalculate(sheet!);
    undoRef.current.push(change);
    if (undoRef.current.length > 200) undoRef.current.shift();
    redoRef.current = [];
    onChange();
    bump();
  }

  function undo() {
    const change = undoRef.current.pop();
    if (!change) return;
    change.undo();
    recalculate(sheet!);
    redoRef.current.push(change);
    onChange();
    bump();
  }

  function redo() {
    const change = redoRef.current.pop();
    if (!change) return;
    change.redo();
    recalculate(sheet!);
    undoRef.current.push(change);
    onChange();
    bump();
  }

  function setCells(cells: Array<{ r: number; c: number; value: CellValue }>, label: string) {
    if (readOnly || !cells.length) return;
    const before = cells.map(({ r, c }) => ({ r, c, value: sheet!.getCell(r, c).value }));
    commit({
      label,
      redo: () => cells.forEach(({ r, c, value }) => { sheet!.getCell(r, c).value = value; }),
      undo: () => before.forEach(({ r, c, value }) => { sheet!.getCell(r, c).value = value; }),
    });
  }

  // --- Выделение и прокрутка -----------------------------------------------------------------

  const range = normalize(sel);

  function scrollIntoView(pos: Cellpos) {
    const el = scrollerRef.current;
    if (!el) return;
    const index = indexOfRow(pos.r);
    if (!(frozen && pos.r === 1) && index >= 0) {
      const top = index * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight - headH) el.scrollTop = top + ROW_H - (el.clientHeight - headH);
    }
    const left = colLeft[pos.c - 1];
    const right = colLeft[pos.c];
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth - HEAD_W) el.scrollLeft = right - (el.clientWidth - HEAD_W);
  }

  function select(focus: Cellpos, extend = false) {
    const next = { anchor: extend ? sel.anchor : focus, focus };
    setSel(next);
    requestAnimationFrame(() => scrollIntoView(focus));
  }

  function moveBy(dr: number, dc: number, extend = false) {
    const from = sel.focus;
    let index = indexOfRow(from.r);
    if (frozen && from.r === 1) index = -1;
    let nextIndex = index + dr;
    let r: number;
    if (frozen && nextIndex < 0) r = 1;
    else {
      nextIndex = Math.max(0, Math.min(bodyCount - 1, nextIndex));
      r = rowAt(nextIndex);
    }
    const c = Math.max(1, Math.min(colCount, from.c + dc));
    select({ r: dr === 0 ? from.r : r, c }, extend);
  }

  /** Ctrl+стрелка: к краю блока данных, как в Excel. */
  function jump(dr: number, dc: number, extend: boolean) {
    const empty = (r: number, c: number) => !cellText(sheet!.getCell(r, c));
    let { r, c } = sel.focus;
    const maxR = Math.max(dataRows, 1);
    const maxC = Math.max(dataCols, 1);
    const inside = (rr: number, cc: number) => rr >= 1 && cc >= 1 && rr <= (dr ? maxR : rowCount) && cc <= (dc ? maxC : colCount);
    if (!inside(r + dr, c + dc)) { select({ r: dr ? (dr > 0 ? maxR : 1) : r, c: dc ? (dc > 0 ? maxC : 1) : c }, extend); return; }
    const startEmpty = empty(r, c) || empty(r + dr, c + dc);
    r += dr; c += dc;
    if (startEmpty) {
      while (inside(r + dr, c + dc) && empty(r, c)) { r += dr; c += dc; }
    } else {
      while (inside(r + dr, c + dc) && !empty(r + dr, c + dc)) { r += dr; c += dc; }
    }
    select({ r, c }, extend);
  }

  // --- Ввод --------------------------------------------------------------------------------

  function startEdit(initial?: string) {
    if (readOnly) return;
    setEditing({ value: initial ?? cellInput(sheet!.getCell(sel.focus.r, sel.focus.c)), pos: sel.focus });
    requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function finishEdit(move: "down" | "up" | "right" | "left" | "stay" = "stay") {
    if (!editing) return;
    const { r, c } = editing.pos;
    const before = cellInput(sheet!.getCell(r, c));
    if (editing.value !== before) setCells([{ r, c, value: nextCell(editing.value) }], "ввод");
    setEditing(null);
    scrollerRef.current?.focus({ preventScroll: true });
    if (move === "down") moveBy(1, 0);
    if (move === "up") moveBy(-1, 0);
    if (move === "right") moveBy(0, 1);
    if (move === "left") moveBy(0, -1);
  }

  function clearRange() {
    const cells: Array<{ r: number; c: number; value: CellValue }> = [];
    for (let r = range.r1; r <= range.r2; r += 1) for (let c = range.c1; c <= range.c2; c += 1) if (sheet!.getCell(r, c).value !== null && sheet!.getCell(r, c).value !== undefined) cells.push({ r, c, value: null });
    setCells(cells, "очистка");
  }

  function rangeTsv() {
    const lines: string[] = [];
    for (let r = range.r1; r <= range.r2; r += 1) {
      if (rowOrder && !rowOrder.includes(r) && !(frozen && r === 1)) continue;
      const cols: string[] = [];
      for (let c = range.c1; c <= range.c2; c += 1) {
        const text = cellText(sheet!.getCell(r, c));
        cols.push(/[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
      }
      lines.push(cols.join("\t"));
    }
    return lines.join("\r\n");
  }

  function pasteText(text: string) {
    if (readOnly) return;
    const rows = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
    const cells: Array<{ r: number; c: number; value: CellValue }> = [];
    // Одно значение на выделенный диапазон — заполнить весь диапазон, как в Excel.
    if (rows.length === 1 && rows[0].length === 1 && (range.r1 !== range.r2 || range.c1 !== range.c2)) {
      for (let r = range.r1; r <= range.r2; r += 1) for (let c = range.c1; c <= range.c2; c += 1) cells.push({ r, c, value: nextCell(rows[0][0]) });
    } else {
      rows.forEach((row, dr) => row.forEach((value, dc) => cells.push({ r: range.r1 + dr, c: range.c1 + dc, value: nextCell(value.replace(/^"([\s\S]*)"$/, "$1").replace(/""/g, '"')) })));
      setSel({ anchor: { r: range.r1, c: range.c1 }, focus: { r: range.r1 + rows.length - 1, c: range.c1 + Math.max(...rows.map((row) => row.length)) - 1 } });
    }
    setCells(cells, "вставка");
  }

  // --- Строки и столбцы ------------------------------------------------------------------------

  function insertRows(at: number, count: number) {
    if (readOnly) return;
    commit({
      label: "вставка строк",
      redo: () => sheet!.spliceRows(at, 0, ...Array.from({ length: count }, () => [])),
      undo: () => sheet!.spliceRows(at, count),
    });
  }

  function deleteRows(from: number, to: number) {
    if (readOnly) return;
    const saved = snapshotRows(sheet!, from, to, Math.max(dataCols, 1));
    commit({
      label: "удаление строк",
      redo: () => sheet!.spliceRows(from, to - from + 1),
      undo: () => { sheet!.spliceRows(from, 0, ...saved.map(() => [])); restoreRows(sheet!, from, saved); },
    });
  }

  function insertCols(at: number, count: number) {
    if (readOnly) return;
    commit({
      label: "вставка столбцов",
      redo: () => sheet!.spliceColumns(at, 0, ...Array.from({ length: count }, () => [])),
      undo: () => sheet!.spliceColumns(at, count),
    });
  }

  function deleteCols(from: number, to: number) {
    if (readOnly) return;
    const rows = Math.max(dataRows, 1);
    const saved: CellValue[][] = [];
    for (let c = from; c <= to; c += 1) saved.push(Array.from({ length: rows }, (_, r) => sheet!.getCell(r + 1, c).value));
    commit({
      label: "удаление столбцов",
      redo: () => sheet!.spliceColumns(from, to - from + 1),
      undo: () => {
        sheet!.spliceColumns(from, 0, ...saved.map(() => []));
        saved.forEach((column, index) => column.forEach((value, r) => { sheet!.getCell(r + 1, from + index).value = value ?? null; }));
      },
    });
  }

  function sortBy(c: number, direction: 1 | -1) {
    if (readOnly) return;
    const from = frozen ? 2 : 1;
    const to = Math.max(dataRows, from);
    const cols = Math.max(dataCols, c);
    const before = snapshotRows(sheet!, from, to, cols);
    const key = (row: CellValue[]) => scalarOf(row[c - 1]);
    const sorted = [...before].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === null || x === "") return 1;
      if (y === null || y === "") return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * direction;
      return String(x).localeCompare(String(y), "ru", { numeric: true }) * direction;
    });
    commit({ label: "сортировка", redo: () => restoreRows(sheet!, from, sorted), undo: () => restoreRows(sheet!, from, before) });
  }

  function toggleFreeze() {
    if (readOnly) return;
    const next = !frozen;
    commit({
      label: "закрепление",
      redo: () => { sheet!.views = next ? [{ state: "frozen", ySplit: 1, xSplit: 0 }] : []; },
      undo: () => { sheet!.views = next ? [] : [{ state: "frozen", ySplit: 1, xSplit: 0 }]; },
    });
    setFilters({});
  }

  // --- Ширина столбцов ------------------------------------------------------------------------

  function startColResize(event: ReactPointerEvent, c: number) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startPx = colPx(sheet!, c);
    const before = sheet!.getColumn(c).width;
    const move = (moveEvent: PointerEvent) => {
      const px = Math.max(MIN_COL_PX, startPx + moveEvent.clientX - startX);
      sheet!.getColumn(c).width = Math.round(((px - 5) / 7) * 10) / 10;
      bump();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const after = sheet!.getColumn(c).width;
      if (after !== before) {
        undoRef.current.push({ label: "ширина столбца", redo: () => { sheet!.getColumn(c).width = after; }, undo: () => { sheet!.getColumn(c).width = before; } });
        redoRef.current = [];
        onChange();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // --- Поиск --------------------------------------------------------------------------------

  function findNext(text: string) {
    const needle = text.trim().toLowerCase();
    if (!needle) return;
    const start = sel.focus;
    const maxR = Math.max(dataRows, 1);
    const maxC = Math.max(dataCols, 1);
    const total = maxR * maxC;
    const index = (start.r - 1) * maxC + (start.c - 1);
    for (let step = 1; step <= total; step += 1) {
      const i = (index + step) % total;
      const r = Math.floor(i / maxC) + 1;
      const c = (i % maxC) + 1;
      if (cellText(sheet!.getCell(r, c)).toLowerCase().includes(needle)) {
        if (rowOrder && !rowOrder.includes(r)) continue;
        select({ r, c });
        setFind((current) => ({ ...current, hit: `${columnName(c)}${r}` }));
        return;
      }
    }
    setFind((current) => ({ ...current, hit: "не найдено" }));
  }

  // --- Клавиатура --------------------------------------------------------------------------

  function onGridKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (editing) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (ctrl && key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (ctrl && key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
    if (ctrl && key.toLowerCase() === "a") { event.preventDefault(); setSel({ anchor: { r: 1, c: 1 }, focus: { r: Math.max(dataRows, 1), c: Math.max(dataCols, 1) } }); return; }
    if (ctrl && key.toLowerCase() === "f") { event.preventDefault(); setFind((current) => ({ ...current, open: true })); return; }
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[key]) {
      event.preventDefault();
      const [dr, dc] = arrows[key];
      if (ctrl) jump(dr, dc, event.shiftKey);
      else moveBy(dr, dc, event.shiftKey);
      return;
    }
    if (key === "Tab") { event.preventDefault(); moveBy(0, event.shiftKey ? -1 : 1); return; }
    if (key === "Enter") { event.preventDefault(); if (event.shiftKey) moveBy(-1, 0); else moveBy(1, 0); return; }
    if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      const page = Math.max(1, Math.floor((scroll.height - headH) / ROW_H) - 1);
      moveBy(key === "PageDown" ? page : -page, 0, event.shiftKey);
      return;
    }
    if (key === "Home") { event.preventDefault(); select(ctrl ? { r: 1, c: 1 } : { r: sel.focus.r, c: 1 }, event.shiftKey); return; }
    if (key === "End") { event.preventDefault(); select(ctrl ? { r: Math.max(dataRows, 1), c: Math.max(dataCols, 1) } : { r: sel.focus.r, c: Math.max(dataCols, 1) }, event.shiftKey); return; }
    if (key === "Delete" || key === "Backspace") { event.preventDefault(); clearRange(); return; }
    if (key === "F2") { event.preventDefault(); startEdit(); return; }
    if (!ctrl && !event.altKey && key.length === 1) { event.preventDefault(); startEdit(key); }
  }

  function onEditorKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") { event.preventDefault(); setEditing(null); scrollerRef.current?.focus({ preventScroll: true }); return; }
    if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      const el = event.currentTarget;
      const next = `${el.value.slice(0, el.selectionStart)}\n${el.value.slice(el.selectionEnd)}`;
      const at = el.selectionStart + 1;
      setEditing((current) => (current ? { ...current, value: next } : current));
      requestAnimationFrame(() => editorRef.current?.setSelectionRange(at, at));
      return;
    }
    if (event.key === "Enter") { event.preventDefault(); finishEdit(event.shiftKey ? "up" : "down"); return; }
    if (event.key === "Tab") { event.preventDefault(); finishEdit(event.shiftKey ? "left" : "right"); }
  }

  // --- Мышь ------------------------------------------------------------------------------

  function cellFromPoint(event: { clientX: number; clientY: number }): Cellpos | null {
    const el = scrollerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = event.clientX - rect.left - HEAD_W + el.scrollLeft;
    const yView = event.clientY - rect.top;
    if (x < 0) return null;
    let c = 1;
    while (c < colCount && colLeft[c] <= x) c += 1;
    if (frozen && yView >= HEAD_H && yView < HEAD_H + ROW_H) return { r: 1, c };
    const y = yView - headH + el.scrollTop;
    if (y < 0) return null;
    const index = Math.min(bodyCount - 1, Math.floor(y / ROW_H));
    return { r: rowAt(index), c };
  }

  function onCellDown(event: ReactMouseEvent, pos: Cellpos) {
    if (event.button !== 0) return;
    if (editing) finishEdit();
    dragRef.current = true;
    select(pos, event.shiftKey);
    scrollerRef.current?.focus({ preventScroll: true });
    const move = (moveEvent: MouseEvent) => {
      if (!dragRef.current) return;
      const at = cellFromPoint(moveEvent);
      if (at) setSel((current) => ({ anchor: current.anchor, focus: at }));
    };
    const up = () => { dragRef.current = false; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function onCellContext(event: ReactMouseEvent, pos: Cellpos, kind: "cell" | "row" | "col") {
    event.preventDefault();
    const inside = pos.r >= range.r1 && pos.r <= range.r2 && pos.c >= range.c1 && pos.c <= range.c2;
    if (!inside) {
      if (kind === "row") setSel({ anchor: { r: pos.r, c: 1 }, focus: { r: pos.r, c: colCount } });
      else if (kind === "col") setSel({ anchor: { r: 1, c: pos.c }, focus: { r: rowCount, c: pos.c } });
      else setSel({ anchor: pos, focus: pos });
    }
    setMenu({ x: event.clientX, y: event.clientY, kind });
  }

  // --- Отрисовка ---------------------------------------------------------------------------

  const firstIndex = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
  const lastIndex = Math.min(bodyCount - 1, Math.ceil((scroll.top + scroll.height) / ROW_H) + OVERSCAN);
  let firstCol = 1;
  while (firstCol < colCount && colLeft[firstCol] < scroll.left) firstCol += 1;
  firstCol = Math.max(1, firstCol - 2);
  let lastCol = firstCol;
  while (lastCol < colCount && colLeft[lastCol - 1] < scroll.left + scroll.width) lastCol += 1;
  lastCol = Math.min(colCount, lastCol + 2);
  const columns = Array.from({ length: lastCol - firstCol + 1 }, (_, i) => firstCol + i);

  const inRange = (r: number, c: number) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;

  const renderCell = (r: number, c: number, top: number, extra = "") => {
    const cell = sheet.getCell(r, c);
    const text = cellText(cell);
    const value = cell.value;
    const hasFormula = Boolean(value && typeof value === "object" && "formula" in value);
    const classes = ["wb-grid-cell"];
    if (extra) classes.push(extra);
    if (isNumeric(value)) classes.push("is-num");
    if (inRange(r, c)) classes.push("is-in-range");
    if (sel.focus.r === r && sel.focus.c === c) classes.push("is-focus");
    if (hasFormula && !text) classes.push("is-formula-empty");
    return (
      <div
        key={`${r}:${c}`}
        className={classes.join(" ")}
        style={{ top, left: HEAD_W + colLeft[c - 1], width: colLeft[c] - colLeft[c - 1], height: ROW_H, ...cellLook(cell) }}
        onMouseDown={(event) => onCellDown(event, { r, c })}
        onDoubleClick={() => startEdit()}
        onContextMenu={(event) => onCellContext(event, { r, c }, "cell")}
        title={text.length > 24 ? text : undefined}
      >
        {text || (hasFormula ? cellInput(cell) : "")}
      </div>
    );
  };

  const bodyRows: ReactNode[] = [];
  for (let i = firstIndex; i <= lastIndex; i += 1) {
    const r = rowAt(i);
    const top = headH + i * ROW_H;
    bodyRows.push(
      <div
        key={`h${r}`}
        className={range.r1 <= r && r <= range.r2 ? "wb-grid-rowhead is-active" : "wb-grid-rowhead"}
        style={{ top, left: scroll.left, height: ROW_H }}
        onMouseDown={(event) => { if (event.button === 0) { setSel({ anchor: event.shiftKey ? sel.anchor : { r, c: 1 }, focus: { r, c: colCount } }); scrollerRef.current?.focus({ preventScroll: true }); } }}
        onContextMenu={(event) => onCellContext(event, { r, c: 1 }, "row")}
      >
        {r}
      </div>,
    );
    for (const c of columns) bodyRows.push(renderCell(r, c, top));
  }

  const numbers: number[] = [];
  let filled = 0;
  if (range.r2 - range.r1 < 5000) {
    for (let r = range.r1; r <= Math.min(range.r2, Math.max(dataRows, 1)); r += 1) {
      for (let c = range.c1; c <= Math.min(range.c2, Math.max(dataCols, 1)); c += 1) {
        const value = scalarOf(sheet.getCell(r, c).value);
        if (value !== null && value !== "") filled += 1;
        if (typeof value === "number") numbers.push(value);
      }
    }
  }
  const sum = numbers.reduce((a, b) => a + b, 0);
  const address = `${columnName(range.c1)}${range.r1}${range.r1 !== range.r2 || range.c1 !== range.c2 ? `:${columnName(range.c2)}${range.r2}` : ""}`;
  const format = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 4 });
  const activeFilters = Object.values(filters).filter((text) => text.trim()).length;

  const editorPos = editing ? {
    top: editing.pos.r === 1 && frozen ? HEAD_H + scroll.top : headH + indexOfRow(editing.pos.r) * ROW_H,
    left: HEAD_W + colLeft[editing.pos.c - 1],
    width: Math.max(colLeft[editing.pos.c] - colLeft[editing.pos.c - 1], 140),
  } : null;

  return (
    <div className="wb-sheet-shell is-advanced">
      <div className="wb-sheet-toolbar" role="toolbar" aria-label="Таблица">
        <button type="button" onClick={undo} disabled={!undoRef.current.length} title="Отменить (Ctrl+Z)"><Undo2 size={14} /></button>
        <button type="button" onClick={redo} disabled={!redoRef.current.length} title="Повторить (Ctrl+Y)"><Redo2 size={14} /></button>
        <span className="wb-sheet-sep" />
        <button type="button" disabled={readOnly} onClick={() => insertRows(range.r1, range.r2 - range.r1 + 1)} title="Вставить строки выше"><Rows3 size={14} /><Plus size={10} /></button>
        <button type="button" disabled={readOnly} onClick={() => deleteRows(range.r1, range.r2)} title="Удалить выделенные строки"><Rows3 size={14} /><Trash2 size={10} /></button>
        <button type="button" disabled={readOnly} onClick={() => insertCols(range.c1, range.c2 - range.c1 + 1)} title="Вставить столбцы слева"><Columns3 size={14} /><Plus size={10} /></button>
        <button type="button" disabled={readOnly} onClick={() => deleteCols(range.c1, range.c2)} title="Удалить выделенные столбцы"><Columns3 size={14} /><Trash2 size={10} /></button>
        <span className="wb-sheet-sep" />
        <button type="button" disabled={readOnly} onClick={() => sortBy(sel.focus.c, 1)} title={`Сортировать по столбцу ${columnName(sel.focus.c)}: А→Я, 0→9`}><ArrowDownAZ size={14} /></button>
        <button type="button" disabled={readOnly} onClick={() => sortBy(sel.focus.c, -1)} title={`Сортировать по столбцу ${columnName(sel.focus.c)}: Я→А, 9→0`}><ArrowUpAZ size={14} /></button>
        <button type="button" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setFilterEdit({ c: sel.focus.c, x: rect.left, y: rect.bottom + 4 }); }} title={`Фильтр по столбцу ${columnName(sel.focus.c)}`}><Filter size={14} /></button>
        {activeFilters > 0 && <button type="button" onClick={() => setFilters({})} title="Снять все фильтры"><FilterX size={14} /> {activeFilters}</button>}
        <button type="button" className={frozen ? "is-on" : undefined} disabled={readOnly} onClick={toggleFreeze} title={frozen ? "Открепить первую строку" : "Закрепить первую строку как заголовки"}><Pin size={14} /></button>
        <span className="wb-sheet-sep" />
        <button type="button" className={find.open ? "is-on" : undefined} onClick={() => setFind((current) => ({ ...current, open: !current.open }))} title="Найти (Ctrl+F)"><Search size={14} /></button>
        {find.open && (
          <span className="wb-sheet-find">
            <input
              autoFocus
              value={find.text}
              placeholder="Найти на листе"
              onChange={(event) => setFind({ open: true, text: event.target.value, hit: "" })}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); findNext(find.text); } if (event.key === "Escape") { setFind({ open: false, text: "", hit: "" }); scrollerRef.current?.focus(); } }}
            />
            {find.hit && <em>{find.hit}</em>}
            <button type="button" onClick={() => setFind({ open: false, text: "", hit: "" })} aria-label="Закрыть поиск"><X size={12} /></button>
          </span>
        )}
      </div>

      <div className="wb-sheet-formula">
        <b>{address}</b>
        <input
          value={formula}
          readOnly={readOnly}
          onChange={(event) => setFormula(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (formula !== cellInput(sheet.getCell(sel.focus.r, sel.focus.c))) setCells([{ r: sel.focus.r, c: sel.focus.c, value: nextCell(formula) }], "ввод");
              scrollerRef.current?.focus();
            }
            if (event.key === "Escape") { setFormula(cellInput(sheet.getCell(sel.focus.r, sel.focus.c))); scrollerRef.current?.focus(); }
          }}
          onBlur={() => { if (formula !== cellInput(sheet.getCell(sel.focus.r, sel.focus.c))) setCells([{ r: sel.focus.r, c: sel.focus.c, value: nextCell(formula) }], "ввод"); }}
          aria-label={`Значение ячейки ${columnName(sel.focus.c)}${sel.focus.r}`}
        />
      </div>

      <div
        ref={scrollerRef}
        className="wb-grid"
        tabIndex={0}
        onScroll={(event) => { const el = event.currentTarget; setScroll({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight }); }}
        onKeyDown={onGridKey}
        onCopy={(event) => { if (editing) return; event.preventDefault(); event.clipboardData.setData("text/plain", rangeTsv()); }}
        onCut={(event) => { if (editing) return; event.preventDefault(); event.clipboardData.setData("text/plain", rangeTsv()); clearRange(); }}
        onPaste={(event) => { if (editing) return; event.preventDefault(); pasteText(event.clipboardData.getData("text/plain")); }}
        aria-label={`Лист ${sheet.name}`}
        role="grid"
      >
        <div className="wb-grid-canvas" style={{ width: HEAD_W + totalWidth, height: headH + bodyCount * ROW_H }}>
          {bodyRows}

          {/* Закреплённая строка заголовков: едет вместе с прокруткой по вертикали. */}
          {frozen && (
            <>
              <div className="wb-grid-rowhead is-frozen" style={{ top: HEAD_H + scroll.top, left: scroll.left, height: ROW_H }} onContextMenu={(event) => onCellContext(event, { r: 1, c: 1 }, "row")}>1</div>
              {columns.map((c) => renderCell(1, c, HEAD_H + scroll.top, "is-frozen"))}
            </>
          )}

          {/* Заголовки столбцов: A, B, C… с ручкой ширины и значком фильтра. */}
          {columns.map((c) => (
            <div
              key={`ch${c}`}
              className={range.c1 <= c && c <= range.c2 ? "wb-grid-colhead is-active" : "wb-grid-colhead"}
              style={{ top: scroll.top, left: HEAD_W + colLeft[c - 1], width: colLeft[c] - colLeft[c - 1], height: HEAD_H }}
              onMouseDown={(event) => { if (event.button === 0) { setSel({ anchor: event.shiftKey ? sel.anchor : { r: 1, c }, focus: { r: rowCount, c } }); scrollerRef.current?.focus({ preventScroll: true }); } }}
              onContextMenu={(event) => onCellContext(event, { r: 1, c }, "col")}
            >
              {columnName(c)}
              {filters[c]?.trim() && <Filter size={10} className="wb-grid-filter-mark" />}
              <span className="wb-grid-resize" onPointerDown={(event) => startColResize(event, c)} onDoubleClick={(event) => { event.stopPropagation(); }} />
            </div>
          ))}
          <div className="wb-grid-corner" style={{ top: scroll.top, left: scroll.left, width: HEAD_W, height: HEAD_H }} onMouseDown={() => setSel({ anchor: { r: 1, c: 1 }, focus: { r: Math.max(dataRows, 1), c: Math.max(dataCols, 1) } })} title="Выделить всё" />

          {editing && editorPos && (
            <textarea
              ref={editorRef}
              className="wb-grid-editor"
              style={{ top: editorPos.top, left: editorPos.left, minWidth: editorPos.width, height: Math.max(ROW_H, (editing.value.split("\n").length) * 18 + 6) }}
              value={editing.value}
              onChange={(event) => setEditing((current) => (current ? { ...current, value: event.target.value } : current))}
              onKeyDown={onEditorKey}
              onBlur={() => finishEdit()}
              spellCheck={false}
            />
          )}
        </div>
      </div>

      <div className="wb-sheet-footer">
        <div className="wb-sheet-tabs" role="tablist" aria-label="Листы книги">
          {book.worksheets.map((worksheet) => (
            renamingSheet === worksheet.name ? (
              <input
                key={worksheet.id}
                className="wb-sheet-rename"
                autoFocus
                defaultValue={worksheet.name}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim().slice(0, 31);
                  setRenamingSheet(null);
                  if (name && name !== worksheet.name && !book.getWorksheet(name)) { worksheet.name = name; onSheetName(name); onChange(); }
                }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setRenamingSheet(null); }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={worksheet.name === sheet.name}
                className={worksheet.name === sheet.name ? "is-active" : undefined}
                key={worksheet.id}
                onClick={() => onSheetName(worksheet.name)}
                onDoubleClick={() => !readOnly && setRenamingSheet(worksheet.name)}
                title="Двойной щелчок — переименовать"
              >
                {worksheet.name}
              </button>
            )
          ))}
          {!readOnly && (
            <button
              type="button"
              className="wb-sheet-add"
              onClick={() => {
                let n = book.worksheets.length + 1;
                while (book.getWorksheet(`Лист ${n}`)) n += 1;
                book.addWorksheet(`Лист ${n}`);
                onSheetName(`Лист ${n}`);
                onChange();
              }}
              title="Новый лист"
            >
              <Plus size={13} />
            </button>
          )}
        </div>
        <div className="wb-sheet-stats" aria-live="polite">
          {numbers.length > 1 ? (
            <>
              <span>Среднее: {format(sum / numbers.length)}</span>
              <span>Количество: {filled}</span>
              <span>Сумма: {format(sum)}</span>
            </>
          ) : filled > 1 ? <span>Количество: {filled}</span> : null}
          {rowOrder && <span>Показано строк: {rowOrder.length}</span>}
        </div>
      </div>

      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button type="button" role="menuitem" onClick={() => { document.execCommand("copy"); setMenu(null); }}>Копировать</button>
          {!readOnly && <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.readText().then(pasteText).catch(() => undefined); setMenu(null); }}>Вставить</button>}
          {!readOnly && <button type="button" role="menuitem" onClick={() => { clearRange(); setMenu(null); }}>Очистить</button>}
          {!readOnly && menu.kind !== "col" && (
            <>
              <button type="button" role="menuitem" onClick={() => { insertRows(range.r1, range.r2 - range.r1 + 1); setMenu(null); }}>Вставить строки выше</button>
              <button type="button" role="menuitem" onClick={() => { insertRows(range.r2 + 1, range.r2 - range.r1 + 1); setMenu(null); }}>Вставить строки ниже</button>
              <button type="button" role="menuitem" onClick={() => { deleteRows(range.r1, range.r2); setMenu(null); }}>Удалить строки {range.r1 === range.r2 ? range.r1 : `${range.r1}–${range.r2}`}</button>
            </>
          )}
          {!readOnly && menu.kind !== "row" && (
            <>
              <button type="button" role="menuitem" onClick={() => { insertCols(range.c1, range.c2 - range.c1 + 1); setMenu(null); }}>Вставить столбцы слева</button>
              <button type="button" role="menuitem" onClick={() => { insertCols(range.c2 + 1, range.c2 - range.c1 + 1); setMenu(null); }}>Вставить столбцы справа</button>
              <button type="button" role="menuitem" onClick={() => { deleteCols(range.c1, range.c2); setMenu(null); }}>Удалить столбцы {range.c1 === range.c2 ? columnName(range.c1) : `${columnName(range.c1)}–${columnName(range.c2)}`}</button>
              <button type="button" role="menuitem" onClick={() => { sortBy(range.c1, 1); setMenu(null); }}>Сортировать А→Я</button>
              <button type="button" role="menuitem" onClick={() => { sortBy(range.c1, -1); setMenu(null); }}>Сортировать Я→А</button>
              <button type="button" role="menuitem" onClick={() => { setFilterEdit({ c: range.c1, x: menu.x, y: menu.y }); setMenu(null); }}>Фильтр по столбцу {columnName(range.c1)}…</button>
            </>
          )}
        </WbMenu>
      )}

      {filterEdit && (
        <WbMenu x={filterEdit.x} y={filterEdit.y} onClose={() => setFilterEdit(null)}>
          <div className="wb-sheet-filter">
            <label>Столбец {columnName(filterEdit.c)} содержит</label>
            <input
              autoFocus
              defaultValue={filters[filterEdit.c] || ""}
              placeholder="текст для отбора строк"
              onKeyDown={(event) => {
                if (event.key === "Enter") { setFilters((current) => ({ ...current, [filterEdit.c]: event.currentTarget.value })); setFilterEdit(null); }
                if (event.key === "Escape") setFilterEdit(null);
              }}
            />
            <div>
              <button type="button" onClick={(event) => { const input = event.currentTarget.parentElement?.previousElementSibling as HTMLInputElement | null; setFilters((current) => ({ ...current, [filterEdit.c]: input?.value || "" })); setFilterEdit(null); }}>Применить</button>
              <button type="button" onClick={() => { setFilters((current) => { const next = { ...current }; delete next[filterEdit.c]; return next; }); setFilterEdit(null); }}>Сбросить</button>
            </div>
          </div>
        </WbMenu>
      )}
    </div>
  );
}
