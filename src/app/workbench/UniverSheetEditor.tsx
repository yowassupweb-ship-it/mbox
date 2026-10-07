import { useCallback, useEffect, useRef, useState } from "react";
import type { CellValue, Workbook as ExcelWorkbook } from "exceljs";
import { createUniver, LocaleType, mergeLocales, type ICellData, type IWorkbookData } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreRuRU from "@univerjs/preset-sheets-core/locales/ru-RU";
import { mboxUniverTheme as mboxSheetTheme, useDocumentTheme } from "./univerTheme";
import type { AgentPeer, Peer, PresenceState } from "./presence";
import "@univerjs/preset-sheets-core/lib/index.css";
import { FindBar } from "../../components/FindBar";
import { useFindRequest } from "../../hooks/useFindRequest";

type Props = {
  book: ExcelWorkbook;
  sheetName: string;
  onSheetName: (name: string) => void;
  onChange: () => void;
  visible: boolean;
  readOnly?: boolean;
  /** Коллеги и агенты в этой таблице: их ячейки подсвечиваются поверх листа, как в Google Таблицах. */
  peers?: Peer[];
  agents?: AgentPeer[];
  /** Своё выделение — для присутствия: где у меня курсор. */
  onSelect?: (state: PresenceState) => void;
};

type CellHit = { sheet: string; row: number; col: number };

/** Ячейки всех листов, где текст содержит `query` (без учёта регистра): в порядке листов, строк и столбцов. */
function findCells(snapshot: IWorkbookData, query: string): CellHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: CellHit[] = [];
  const order = snapshot.sheetOrder?.length ? snapshot.sheetOrder : Object.keys(snapshot.sheets || {});
  for (const id of order) {
    const sheet = snapshot.sheets?.[id];
    if (!sheet?.cellData) continue;
    const rows = Object.keys(sheet.cellData).map(Number).sort((a, b) => a - b);
    for (const row of rows) {
      const cells = sheet.cellData[row] || {};
      for (const col of Object.keys(cells).map(Number).sort((a, b) => a - b)) {
        const cell = cells[col];
        const text = cell?.v === undefined || cell?.v === null ? "" : String(cell.v);
        if (text && text.toLowerCase().includes(needle)) {
          hits.push({ sheet: sheet.name || id, row, col });
          if (hits.length >= 2000) return hits;
        }
      }
    }
  }
  return hits;
}

type Mark = { key: string; label: string; color: string; left: number; top: number; width: number; height: number; agent: boolean };

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

export function SheetEditor({ book, sheetName, onSheetName, onChange, visible, readOnly = false, peers = [], agents = [], onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [layer, setLayer] = useState({ left: 46, top: 20, width: 0, height: 0 });
  const peersRef = useRef(peers);
  const agentsRef = useRef(agents);
  const onSelectRef = useRef(onSelect);
  const placeRef = useRef<() => void>(() => undefined);
  // Поиск (Ctrl+F): ячейки ищем в данных книги, текущую выделяем и прокручиваем к ней, остальные красим слоем поверх.
  const [find, setFind] = useState<{ open: boolean; n: number }>({ open: false, n: 0 });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CellHit[]>([]);
  const [cursor, setCursor] = useState(-1);
  const findRef = useRef<{ hits: CellHit[]; cursor: number }>({ hits: [], cursor: -1 });
  findRef.current = { hits, cursor };
  const findApi = useRef<{ search: (text: string) => CellHit[]; go: (hit: CellHit) => void; paint: (found: CellHit[], current: number) => void } | null>(null);
  useFindRequest(visible, () => setFind((current) => ({ open: true, n: current.n + 1 })));
  peersRef.current = peers;
  agentsRef.current = agents;
  onSelectRef.current = onSelect;
  const theme = useDocumentTheme();
  const onChangeRef = useRef(onChange);
  const onSheetNameRef = useRef(onSheetName);
  onChangeRef.current = onChange;
  onSheetNameRef.current = onSheetName;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Свой узел на каждый экземпляр: Univer размонтирует деревья не сразу, и очистка общего контейнера
    // до этого давала «removeChild: узел не является потомком».
    const mount = window.document.createElement("div");
    mount.className = "wb-univer-mount";
    host.appendChild(mount);
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
        container: mount,
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
    // Подсветка коллег и агентов: прямоугольники ячеек из Univer (getCellRect — относительно холста листа)
    // переводим в координаты слоя поверх таблицы. Заголовки строк и столбцов закрывает обрезка слоя.
    const wrap = wrapRef.current;
    const header = (() => { try { const first = workbook.getActiveSheet().getRange("A1").getCellRect(); return { left: first.left, top: first.top }; } catch { return { left: 46, top: 20 }; } })();
    const rectOf = (a1: string) => {
      const [from, to = from] = a1.split(":");
      const sheet = workbook.getActiveSheet();
      const first = sheet.getRange(from).getCellRect();
      const last = sheet.getRange(to).getCellRect();
      return { left: Math.min(first.left, last.left), top: Math.min(first.top, last.top), right: Math.max(first.right, last.right), bottom: Math.max(first.bottom, last.bottom) };
    };
    let disposed = false;
    let retryTimer = 0;
    const place = () => {
      // Отложенный вызов уже уничтоженного экземпляра (кадр анимации, наблюдатель) не должен стирать метки нового.
      if (disposed) return;
      const canvas = mount.querySelector<HTMLCanvasElement>('canvas[id^="univer-sheet-main-canvas"]');
      // Холст появляется не сразу после создания редактора: пока его нет, метки не стираем, а пробуем ещё раз.
      if (!canvas || !wrap) { window.clearTimeout(retryTimer); retryTimer = window.setTimeout(place, 200); return; }
      const canvasBox = canvas.getBoundingClientRect();
      const wrapBox = wrap.getBoundingClientRect();
      // Слой лежит ровно на области ячеек (без заголовков и полос прокрутки) и обрезает всё, что прокрутилось за край.
      setLayer({ left: canvasBox.left - wrapBox.left + header.left, top: canvasBox.top - wrapBox.top + header.top, width: Math.max(0, canvasBox.width - header.left), height: Math.max(0, canvasBox.height - header.top) });
      const activeSheet = workbook.getActiveSheet().getSheetName();
      const next: Mark[] = [];
      const add = (key: string, label: string, color: string, a1: string, agent: boolean) => {
        try {
          const rect = rectOf(a1);
          next.push({ key, label, color, agent, left: rect.left - header.left, top: rect.top - header.top, width: rect.right - rect.left, height: rect.bottom - rect.top });
        } catch { /* адрес вне листа */ }
      };
      for (const peer of peersRef.current) {
        const a1 = peer.state.range || peer.state.cell;
        if (a1 && (!peer.state.sheet || peer.state.sheet === activeSheet)) add(`p:${peer.id}`, peer.name, peer.color, a1, false);
      }
      for (const agent of agentsRef.current) if (agent.range && (!agent.sheet || agent.sheet === activeSheet)) add(`a:${agent.name}`, agent.name, agent.color, agent.range, true);
      setMarks(next);
    };
    placeRef.current = place;
    // Подсветку рисует сам Univer (highlightRanges): он учитывает прокрутку и масштаб, свои рамки считались в неверных координатах.
    let findPaint: { dispose: () => void }[] = [];
    const clearPaint = () => { findPaint.forEach((item) => item.dispose()); findPaint = []; };
    findApi.current = {
      paint: (found, current) => {
        clearPaint();
        try {
          const sheet = workbook.getActiveSheet();
          const name = sheet.getSheetName();
          const cells = found.map((hit, at) => ({ hit, at })).filter(({ hit }) => hit.sheet === name).slice(0, 500);
          const others = cells.filter(({ at }) => at !== current).map(({ hit }) => sheet.getRange(hit.row, hit.col));
          if (others.length) findPaint.push(sheet.highlightRanges(others, { stroke: "rgba(245,197,66,0.9)", strokeWidth: 1, fill: "rgba(245,197,66,0.38)" }));
          const now = cells.find(({ at }) => at === current);
          if (now) findPaint.push(sheet.highlightRanges([sheet.getRange(now.hit.row, now.hit.col)], { stroke: "rgba(255,159,28,1)", strokeWidth: 2, fill: "rgba(255,159,28,0.5)" }));
        } catch { /* лист закрыт */ }
      },
      search: (text) => findCells(workbook.getWorkbook().getSnapshot() as IWorkbookData, text),
      go: (hit) => {
        try {
          const target = workbook.getSheetByName(hit.sheet);
          if (!target) return;
          if (workbook.getActiveSheet().getSheetName() !== hit.sheet) workbook.setActiveSheet(target);
          const sheet = workbook.getActiveSheet();
          sheet.getRange(hit.row, hit.col).activate();
          sheet.scrollToCell(hit.row, hit.col);
          onSheetNameRef.current(hit.sheet);
        } catch { /* лист удалён за время поиска */ }
      },
    };
    const scrollEvent = univerAPI.addEvent(univerAPI.Event.Scroll, place);
    const zoomEvent = univerAPI.addEvent(univerAPI.Event.SheetZoomChanged, place);
    // Свой курсор для присутствия. Событие SelectionChanged на клик мышью не срабатывает, поэтому слушаем операцию
    // выделения на шине команд и читаем активный диапазон у листа.
    const publishSelection = () => {
      if (!onSelectRef.current) return;
      const sheet = workbook.getActiveSheet();
      const active = sheet.getSelection()?.getActiveRange();
      if (!active) return;
      const a1 = active.getA1Notation();
      onSelectRef.current({ sheet: sheet.getSheetName(), cell: a1.includes(":") ? undefined : a1, range: a1.includes(":") ? a1 : undefined });
    };
    const selectionListener = workbook.onCommandExecuted((command) => {
      if (command.id === "sheet.operation.set-selections" || command.id === "sheet.operation.set-worksheet-active") publishSelection();
    });
    const resizeObserver = new ResizeObserver(place);
    resizeObserver.observe(host);
    const placeTimer = window.setTimeout(place, 400);

    let ready = false;
    const readyTimer = window.setTimeout(() => { ready = true; }, 250);
    let syncTimer = 0;
    const listener = workbook.onCommandExecuted((command) => {
      if (/^sheet\.(?:operation|mutation|command)\.(?:set-worksheet-active|set-worksheet-col-width|set-worksheet-row-height|set-col-is-auto-width|set-zoom-ratio|set-worksheet-row-is-auto-height)/.test(command.id)) window.requestAnimationFrame(place);
      if (!ready || readOnly) return;
      // Выбор ячейки, фокус, прокрутка и пересчёт формул тоже проходят через command bus,
      // но не должны помечать файл изменённым. Изменение ширины столбца завершается
      // мутацией `sheet.mutation.set-worksheet-col-width`, поэтому сохраняем снимок
      // после команд, операций и мутаций листа.
      if (!/^sheet\.(?:command|operation|mutation)\.(set-range-values|set-style|insert-|remove-|delete-|set-worksheet-name|move-range|hide-|show-|merge-|unmerge-|delta-column-width|delta-row-height|set-worksheet-col-width|set-worksheet-row-height|set-row-height|set-col-is-auto-width|set-row-is-auto-height|set-worksheet-row-is-auto-height|paste-col-width|set-col-auto-width)/.test(command.id)) return;
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => {
        applySnapshot(book, workbook.getWorkbook().getSnapshot());
        onSheetNameRef.current(workbook.getActiveSheet().getSheetName());
        onChangeRef.current();
      }, 120);
    });
    return () => {
      clearPaint();
      findApi.current = null;
      window.clearTimeout(readyTimer);
      window.clearTimeout(syncTimer);
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(placeTimer);
      scrollEvent.dispose();
      zoomEvent.dispose();
      selectionListener.dispose();
      resizeObserver.disconnect();
      placeRef.current = () => undefined;
      listener.dispose();
      univer.dispose();
      window.setTimeout(() => mount.remove(), 0);
    };
  }, [book, readOnly, theme]);

  useEffect(() => {
    if (!visible) return;
    window.dispatchEvent(new Event("resize"));
  }, [visible]);

  // Коллеги пришли или ушли — пересчитываем подсветку, не пересоздавая сам редактор.
  const replace = useCallback(() => placeRef.current(), []);
  useEffect(() => { replace(); }, [peers, agents, replace]);

  const search = (text: string, keep = 0, fresh?: CellHit[]) => {
    const found = fresh ?? findApi.current?.search(text) ?? [];
    const at = found.length ? Math.min(Math.max(keep, 0), found.length - 1) : -1;
    findRef.current = { hits: found, cursor: at };
    setHits(found);
    setCursor(at);
    if (at >= 0) findApi.current?.go(found[at]);
    findApi.current?.paint(found, at);
  };
  useEffect(() => { if (find.open) search(query); }, [query, find.open, book]);
  const stepFind = (delta: number) => {
    const fresh = findApi.current?.search(query) ?? [];
    if (!fresh.length) { search(query, 0, fresh); return; }
    const before = findRef.current.hits[findRef.current.cursor];
    let at = before ? fresh.findIndex((hit) => hit.sheet === before.sheet && hit.row === before.row && hit.col === before.col) : -1;
    if (at < 0) at = 0;
    search(query, (at + delta + fresh.length) % fresh.length, fresh);
  };
  const closeFind = () => {
    setFind((current) => ({ ...current, open: false }));
    findApi.current?.paint([], -1);
    setHits([]); setCursor(-1);
    findRef.current = { hits: [], cursor: -1 };
  };

  return (
    <div className="wb-univer-wrap" ref={wrapRef}>
      <div className="wb-univer-sheet" ref={hostRef} aria-label="Редактор таблицы Univer" />
      {find.open && (
        <FindBar className="is-in-doc" query={query} onQuery={setQuery} count={hits.length} index={cursor} onNext={() => stepFind(1)} onPrev={() => stepFind(-1)} onClose={closeFind} focusKey={find.n} placeholder="Найти в таблице" />
      )}
      <div className="wb-presence-layer" style={{ left: layer.left, top: layer.top, width: layer.width, height: layer.height }} aria-hidden="true">
        {marks.map((mark) => (
          <span key={mark.key} className={mark.agent ? "wb-cell-mark is-agent" : "wb-cell-mark"} style={{ left: mark.left, top: mark.top, width: mark.width, height: mark.height, ["--peer" as string]: mark.color }}>
            <b>{mark.label}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
