import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { ExternalLink, FolderOpen, RefreshCw, Save, Search } from "lucide-react";
import type { Cell, CellValue, Workbook, Worksheet } from "exceljs";
import { formatBytes } from "../../lib/format";
import { DocShell } from "./docLayout";
import { useDocumentFind } from "./DocumentTools";
import { onWorkspaceChange, rootName, workspaceBridge, type DataRead } from "./localWorkspace";
import type { TabsApi } from "./tabs";

type Kind = "pdf" | "docx" | "legacy" | "sheet";
const MAX_ROWS = 200;
const MAX_COLUMNS = 50;

function cleanError(cause: unknown) {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function extension(path: string) {
  const match = path.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

function kindOf(path: string): Kind {
  const ext = extension(path);
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".doc" || ext === ".xls") return "legacy";
  return "sheet";
}

function base64ToArrayBuffer(base64: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function bytesToBase64(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let from = 0; from < bytes.length; from += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(from, Math.min(bytes.length, from + 0x8000)));
  }
  return window.btoa(binary);
}

function formulaOf(value: CellValue) {
  return value && typeof value === "object" && "formula" in value ? String(value.formula) : "";
}

function rawValue(value: CellValue) {
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

function cellText(cell?: Cell) {
  if (!cell) return "";
  return cell.text || rawValue(cell.value);
}

function cellInput(cell?: Cell) {
  if (!cell) return "";
  const formula = formulaOf(cell.value);
  return formula ? `=${formula}` : rawValue(cell.value);
}

function nextCell(value: string): CellValue {
  if (!value) return null;
  if (value.startsWith("=")) return { formula: value.slice(1), result: undefined };
  if (/^-?(?:\d+|\d*[.,]\d+)$/.test(value.trim())) return Number(value.replace(",", "."));
  if (/^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  return value;
}

function columnName(index: number) {
  let result = "";
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

function parseDelimited(text: string, delimiter: string) {
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

function quoteDelimited(value: string, delimiter: string) {
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

function delimitedContent(sheet: Worksheet, delimiter: string) {
  const rows: string[] = [];
  for (let row = 1; row <= sheet.actualRowCount; row += 1) {
    const values: string[] = [];
    for (let column = 1; column <= sheet.actualColumnCount; column += 1) values.push(quoteDelimited(cellInput(sheet.getCell(row, column)), delimiter));
    rows.push(values.join(delimiter));
  }
  return rows.join("\r\n");
}

export function LocalOfficeDocument({ rootKey, path, tabs, tabKey, visible, onDirty }: {
  rootKey: string;
  path: string;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const bridge = workspaceBridge();
  const kind = kindOf(path);
  const ext = extension(path);
  const [file, setFile] = useState<DataRead | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [docxHtml, setDocxHtml] = useState("");
  const [docxWarnings, setDocxWarnings] = useState<string[]>([]);
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [selected, setSelected] = useState("A1");
  const [input, setInput] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const previewRef = useRef<HTMLElement | null>(null);
  const emptyEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const find = useDocumentFind({ editorRef: emptyEditorRef, previewRef, text: "", enabled: visible && kind === "docx" });

  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, onDirty, tabKey]);
  useEffect(() => () => onDirty(tabKey, false), [onDirty, tabKey]);

  const load = useCallback(async () => {
    if (!bridge?.readData) return;
    setLoading(true);
    setError("");
    try {
      const next = await bridge.readData(rootKey, path);
      setFile(next);
      if (next.tooLarge) return;
      const arrayBuffer = base64ToArrayBuffer(next.base64);
      if (kind === "docx") {
        const mammoth = await import("mammoth");
        const converted = await mammoth.convertToHtml({ arrayBuffer });
        setDocxHtml(DOMPurify.sanitize(converted.value, { USE_PROFILES: { html: true } }));
        setDocxWarnings(converted.messages.map((message) => message.message));
      } else if (kind === "sheet") {
        const { Workbook: ExcelWorkbook } = await import("exceljs");
        const workbook = new ExcelWorkbook();
        if (ext === ".csv" || ext === ".tsv") {
          const worksheet = workbook.addWorksheet("Лист 1");
          const rows = parseDelimited(new TextDecoder("utf-8").decode(arrayBuffer), ext === ".tsv" ? "\t" : ",");
          worksheet.addRows(rows);
        } else await workbook.xlsx.load(arrayBuffer);
        const first = workbook.worksheets[0]?.name ?? "";
        setBook(workbook);
        setSheetName(first);
        setSelected("A1");
        setInput(cellInput(first ? workbook.getWorksheet(first)?.getCell("A1") : undefined));
      }
      setDirty(false);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setLoading(false);
    }
  }, [bridge, kind, path, rootKey]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => onWorkspaceChange((key, paths) => {
    if (key !== rootKey || !paths.includes(path)) return;
    if (dirtyRef.current) setError("Файл изменился на диске. Сохранение остановлено — перезагрузите файл или откройте внешнюю версию.");
    else void load();
  }), [load, path, rootKey]);

  const sheet = book && sheetName ? book.getWorksheet(sheetName) : undefined;
  const range = useMemo(() => {
    if (!sheet) return null;
    return {
      rows: Math.min(MAX_ROWS, Math.max(20, sheet.actualRowCount)),
      columns: Math.min(MAX_COLUMNS, Math.max(10, sheet.actualColumnCount)),
      truncated: sheet.actualRowCount > MAX_ROWS || sheet.actualColumnCount > MAX_COLUMNS,
    };
  }, [revision, sheet]);

  function chooseCell(address: string) {
    setSelected(address);
    setInput(cellInput(sheet?.getCell(address)));
  }

  function commitCell() {
    if (!sheet) return;
    sheet.getCell(selected).value = nextCell(input);
    setDirty(true);
    setRevision((value) => value + 1);
  }

  async function save() {
    if (!bridge?.writeData || !book || !file || saving) return;
    setSaving(true);
    setError("");
    try {
      let base64 = "";
      if (ext === ".csv" || ext === ".tsv") {
        const activeSheet = book.getWorksheet(sheetName);
        if (!activeSheet) throw new Error("Лист не найден");
        const content = delimitedContent(activeSheet, ext === ".tsv" ? "\t" : ",");
        base64 = bytesToBase64(new TextEncoder().encode(content));
      } else {
        const output = await book.xlsx.writeBuffer();
        base64 = bytesToBase64(output);
      }
      const written = await bridge.writeData(rootKey, path, base64, file.mtime);
      setFile({ ...file, base64, size: written.size, mtime: written.mtime });
      setDirty(false);
      tabs.pin(tabKey);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!visible || kind !== "sheet") return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!bridge) return <div className="wb-doc-missing">Документы из локальных папок открываются в MBOX Desktop.</div>;
  if (!bridge.readData) return <div className="wb-doc-missing">Обновите MBOX Desktop, чтобы смотреть PDF, Word и таблицы.</div>;

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-doc-crumbs">{rootName(rootKey)} › {path.split("/").join(" › ")}{dirty && <b className="wb-dirty-mark"> ●</b>}</span>
          <div className="wb-doc-actions">
            {kind === "docx" && <button type="button" onClick={find.openFind} title="Найти в документе"><Search size={14} /></button>}
            <button type="button" onClick={() => void load()} title="Перечитать с диска"><RefreshCw size={14} /></button>
            <button type="button" onClick={() => void bridge.reveal(rootKey, path)} title="Показать в проводнике"><FolderOpen size={14} /></button>
            <button type="button" onClick={() => void bridge.openDefault(rootKey, path)} title="Открыть в программе по умолчанию"><ExternalLink size={14} /> Открыть</button>
            {kind === "sheet" && <button type="button" className="is-primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? "Сохраняю…" : "Сохранить"}</button>}
          </div>
        </>
      )}
    >
      {find.bar}
      {error && <div className="wb-banner is-error">{error}</div>}
      {loading ? <div className="wb-doc-missing">Открываю {path}…</div>
        : file?.tooLarge ? <div className="wb-doc-missing">Файл {formatBytes(file.size)} — слишком большой для встроенного просмотра.</div>
          : kind === "pdf" && file ? (
            <div className="wb-pdf-view"><iframe title={path} src={`data:${file.mime};base64,${file.base64}`} /></div>
          ) : kind === "legacy" ? (
            <div className="wb-doc-missing">Старый формат {ext} открывается установленной программой. Для работы внутри MBOX сохраните файл как {ext === ".doc" ? ".docx" : ".xlsx"}.<button type="button" className="wb-inline-btn" onClick={() => void bridge.openDefault(rootKey, path)}>Открыть файл</button></div>
          ) : kind === "docx" ? (
            <div className="wb-office-scroll">
              <article ref={previewRef} className="wb-docx-page" dangerouslySetInnerHTML={{ __html: docxHtml }} />
              {!!docxWarnings.length && <details className="wb-office-warnings"><summary>Особенности преобразования · {docxWarnings.length}</summary>{docxWarnings.map((message, index) => <p key={index}>{message}</p>)}</details>}
            </div>
          ) : book && sheet && range ? (
            <div className="wb-sheet-shell">
              <div className="wb-sheet-formula">
                <b>{selected}</b>
                <input value={input} onChange={(event) => setInput(event.target.value)} onBlur={commitCell} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitCell(); } }} aria-label={`Значение ячейки ${selected}`} />
                {range.truncated && <span>Показаны первые {MAX_ROWS} × {MAX_COLUMNS}; весь файл можно открыть в Excel.</span>}
              </div>
              <div className="wb-sheet-grid-wrap">
                <table className="wb-sheet-grid">
                  <thead><tr><th className="is-corner" />{Array.from({ length: range.columns }, (_, column) => <th key={column}>{columnName(column + 1)}</th>)}</tr></thead>
                  <tbody>
                    {Array.from({ length: range.rows }, (_, row) => (
                      <tr key={row}>
                        <th>{row + 1}</th>
                        {Array.from({ length: range.columns }, (__, column) => {
                          const address = `${columnName(column + 1)}${row + 1}`;
                          return <td key={address} className={selected === address ? "is-selected" : undefined} onClick={() => chooseCell(address)} onDoubleClick={() => document.querySelector<HTMLInputElement>(".wb-sheet-formula input")?.focus()} title={address}>{cellText(sheet.getCell(row + 1, column + 1))}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="wb-sheet-tabs" role="tablist" aria-label="Листы книги">
                {book.worksheets.map((worksheet) => <button type="button" role="tab" aria-selected={worksheet.name === sheetName} className={worksheet.name === sheetName ? "is-active" : undefined} key={worksheet.id} onClick={() => { setSheetName(worksheet.name); setSelected("A1"); setInput(cellInput(worksheet.getCell("A1"))); }}>{worksheet.name}</button>)}
              </div>
            </div>
          ) : <div className="wb-doc-missing">Не удалось прочитать документ.</div>}
    </DocShell>
  );
}
