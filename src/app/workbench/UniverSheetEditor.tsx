import { useEffect, useRef, useState } from "react";
import type { CellValue, Workbook as ExcelWorkbook } from "exceljs";
import { createUniver, LocaleType, mergeLocales, type ICellData, type IWorkbookData } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreRuRU from "@univerjs/preset-sheets-core/locales/ru-RU";
import { defaultTheme, type Theme } from "@univerjs/themes";
import "@univerjs/preset-sheets-core/lib/index.css";

type Props = {
  book: ExcelWorkbook;
  sheetName: string;
  onSheetName: (name: string) => void;
  onChange: () => void;
  visible: boolean;
  readOnly?: boolean;
};

/** Univer создаёт собственный canvas, поэтому одних CSS-токенов MBOX ему недостаточно. */
function mboxSheetTheme(theme: string): Theme {
  const base = defaultTheme;
  if (theme === "light") return base;
  if (theme === "black") {
    return {
      ...base,
      gray: { ...base.gray, 700: "#17181b", 800: "#101013", 900: "#0b0b0d" },
    };
  }
  return {
    ...base,
    // Универсальная палитра используется и canvas-выделением: .600 — контур
    // активного диапазона. Насыщенный небесный тон и светлые уровни выше
    // оставляют его заметным на графитовом полотне, не превращая таблицу в
    // неоновую сетку.
    primary: {
      ...base.primary,
      400: "#237ed0",
      500: "#3194ee",
      600: "#52adff",
      700: "#8cc9ff",
      800: "#b9ddff",
      900: "#e3f1ff",
    },
    gray: {
      ...base.gray,
      0: "#f5f5f7",
      50: "#eceef1",
      100: "#dce0e5",
      200: "#c5cad2",
      300: "#9ba3ae",
      400: "#7b838e",
      500: "#5e6670",
      600: "#454b53",
      700: "#34383e",
      800: "#2a2b2f",
      900: "#242529",
    },
  };
}

function valueToCell(value: CellValue): ICellData | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return { v: value };
  if (value instanceof Date) return { v: value.toISOString() };
  if (typeof value === "object" && "formula" in value) {
    const formula = String(value.formula || "");
    const result = value.result;
    return { f: formula.startsWith("=") ? formula : `=${formula}`, v: typeof result === "string" || typeof result === "number" || typeof result === "boolean" ? result : null };
  }
  if (typeof value === "object" && "richText" in value) return { v: value.richText.map((part) => part.text).join("") };
  if (typeof value === "object" && "text" in value) return { v: String(value.text || "") };
  return { v: String(value) };
}

function excelToUniver(book: ExcelWorkbook): Partial<IWorkbookData> {
  const sheets: IWorkbookData["sheets"] = {};
  const sheetOrder: string[] = [];
  for (const [index, sheet] of book.worksheets.entries()) {
    const id = `sheet-${index + 1}`;
    sheetOrder.push(id);
    const cellData: Record<number, Record<number, ICellData>> = {};
    const columnData: Record<number, { w: number }> = {};
    sheet.columns.forEach((column, columnIndex) => {
      if (typeof column.width === "number") columnData[columnIndex] = { w: Math.round(column.width * 7.5) };
    });
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const next = valueToCell(cell.value);
        if (!next) return;
        (cellData[rowNumber - 1] ||= {})[columnNumber - 1] = next;
      });
    });
    sheets[id] = {
      id,
      name: sheet.name,
      rowCount: Math.max(100, sheet.rowCount + 20),
      columnCount: Math.max(26, sheet.columnCount + 8),
      cellData,
      columnData,
    };
  }
  return {
    id: `mbox-${crypto.randomUUID()}`,
    name: "MBOX",
    appVersion: "1.0.2",
    locale: LocaleType.RU_RU,
    styles: {},
    sheetOrder,
    sheets,
  };
}

function applySnapshot(book: ExcelWorkbook, snapshot: IWorkbookData) {
  for (const sheetId of snapshot.sheetOrder) {
    const source = snapshot.sheets[sheetId];
    if (!source?.name) continue;
    const target = book.getWorksheet(source.name) ?? book.addWorksheet(source.name);
    target.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => { cell.value = null; }));
    for (const [rowKey, columns] of Object.entries(source.cellData || {})) {
      for (const [columnKey, cell] of Object.entries((columns || {}) as Record<string, ICellData>)) {
        const targetCell = target.getCell(Number(rowKey) + 1, Number(columnKey) + 1);
        if (cell.f) targetCell.value = { formula: cell.f.replace(/^=/, ""), result: cell.v as string | number | boolean | undefined };
        else targetCell.value = (cell.v ?? null) as CellValue;
      }
    }
    for (const [columnKey, column] of Object.entries(source.columnData || {})) {
      const width = (column as { w?: unknown }).w;
      if (typeof width === "number" && Number.isFinite(width)) target.getColumn(Number(columnKey) + 1).width = Math.max(0.1, width / 7.5);
    }
  }
}

export function SheetEditor({ book, sheetName, onSheetName, onChange, visible, readOnly = false }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "graphite");
  const onChangeRef = useRef(onChange);
  const onSheetNameRef = useRef(onSheetName);
  onChangeRef.current = onChange;
  onSheetNameRef.current = onSheetName;

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme || "graphite"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetSheetsCoreRuRU) },
      darkMode: theme !== "light",
      theme: mboxSheetTheme(theme),
      // «Classic» keeps functions in their named groups. Unlike the flat «simple» ribbon,
      // its overflow contains only commands of the current group and never a full-screen tray.
      // A public view link is a viewer, not a disabled editor: no ribbon, formula input or
      // edit context menu is mounted there. Sheet tabs remain available for navigation.
      presets: [UniverSheetsCorePreset({
        container: host,
        header: !readOnly,
        toolbar: !readOnly,
        formulaBar: !readOnly,
        contextMenu: !readOnly,
        menu: {},
        ribbonType: "classic",
      })],
    });
    // В preset начальный флаг применяется до монтирования UI и иногда остаётся светлым.
    // Повторяем через публичный facade: он меняет класс `univer-dark` и перерисовывает canvas.
    univerAPI.toggleDarkMode(theme !== "light");
    univerAPI.setTheme(mboxSheetTheme(theme));
    const workbook = univerAPI.createWorkbook(excelToUniver(book));
    workbook.setEditable(!readOnly);
    const initial = workbook.getSheetByName(sheetName);
    if (initial) workbook.setActiveSheet(initial);
    let ready = false;
    const readyTimer = window.setTimeout(() => { ready = true; }, 250);
    let syncTimer = 0;
    const listener = workbook.onCommandExecuted((command) => {
      if (!ready || readOnly) return;
      // Выбор ячейки, фокус, прокрутка и пересчёт формул тоже проходят через command bus,
      // но не должны помечать файл изменённым. Изменение ширины — delta-column-width,
      // поэтому прежний узкий список команд его пропускал и Excel-снимок оставался старым.
      if (!/^sheet\.(?:command|operation)\.(set-range-values|set-style|insert-|remove-|delete-|set-worksheet-name|move-range|hide-|show-|merge-|unmerge-|delta-column-width|delta-row-height|set-worksheet-col-width|set-row-height|set-col-is-auto-width|set-row-is-auto-height|paste-col-width|set-col-auto-width)/.test(command.id)) return;
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => {
        applySnapshot(book, workbook.getWorkbook().getSnapshot());
        onSheetNameRef.current(workbook.getActiveSheet().getSheetName());
        onChangeRef.current();
      }, 120);
    });
    return () => {
      window.clearTimeout(readyTimer);
      window.clearTimeout(syncTimer);
      listener.dispose();
      univer.dispose();
      host.replaceChildren();
    };
  }, [book, readOnly, theme]);

  useEffect(() => {
    if (!visible) return;
    window.dispatchEvent(new Event("resize"));
  }, [visible]);

  return <div className="wb-univer-sheet" ref={hostRef} aria-label="Редактор таблицы Univer" />;
}
