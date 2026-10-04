import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { ExternalLink, FolderOpen, RefreshCw, Save, Search } from "lucide-react";
import type { Workbook } from "exceljs";
import { formatBytes } from "../../lib/format";
import { DocShell } from "./docLayout";
import { useDocumentFind } from "./DocumentTools";
import { onWorkspaceChange, rootName, workspaceBridge, type DataRead } from "./localWorkspace";
import type { TabsApi } from "./tabs";
import { base64ToArrayBuffer, bytesToBase64, parseDelimited, delimitedContent } from "./officeFormat";
import { OctopusSpinner } from "../../components/OctopusSpinner";

const PdfViewer = lazy(() => import("./PdfViewer"));
const SheetEditor = lazy(() => import("./UniverSheetEditor").then((module) => ({ default: module.SheetEditor })));
const UniverDocumentViewer = lazy(() => import("./UniverDocumentViewer").then((module) => ({ default: module.UniverDocumentViewer })));

type Kind = "pdf" | "docx" | "legacy" | "sheet";

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
  const pdfBytes = useMemo(() => (kind === "pdf" && file && !file.tooLarge ? new Uint8Array(base64ToArrayBuffer(file.base64)) : null), [kind, file]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [docxHtml, setDocxHtml] = useState("");
  const [docxWarnings, setDocxWarnings] = useState<string[]>([]);
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
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


  async function savePdf(bytes: Uint8Array) {
    if (!bridge?.writeData || !file) return;
    const base64 = bytesToBase64(bytes);
    const written = await bridge.writeData(rootKey, path, base64, file.mtime);
    setFile({ ...file, base64, size: written.size, mtime: written.mtime });
    tabs.pin(tabKey);
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
            {kind === "docx" && <button type="button" onClick={find.openFind} title="Найти в документе" aria-label="Найти в документе"><Search size={14} /></button>}
            <button type="button" onClick={() => void load()} title="Перечитать с диска" aria-label="Перечитать с диска"><RefreshCw size={14} /></button>
            <button type="button" onClick={() => void bridge.reveal(rootKey, path)} title="Показать в проводнике" aria-label="Показать в проводнике"><FolderOpen size={14} /></button>
            <button type="button" onClick={() => void bridge.openDefault(rootKey, path)} title="Открыть в программе по умолчанию"><ExternalLink size={14} /> Открыть</button>
            {kind === "sheet" && <button type="button" className="is-primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? "Сохраняю…" : "Сохранить"}</button>}
          </div>
        </>
      )}
    >
      {find.bar}
      {error && <div className="wb-banner is-error" role="alert">{error}</div>}
      {loading ? <div className="wb-doc-missing" role="status" aria-live="polite">Открываю {path}…</div>
        : file?.tooLarge ? <div className="wb-doc-missing">Файл {formatBytes(file.size)} — слишком большой для встроенного просмотра.</div>
          : kind === "pdf" && pdfBytes ? (
            <Suspense fallback={<OctopusSpinner />}>
              <PdfViewer source={{ bytes: pdfBytes }} version={file?.mtime} name={path.split("/").pop() || path} memoryKey={`${rootKey}:${path}`} onSave={bridge.writeData ? savePdf : undefined} />
            </Suspense>
          ) : kind === "legacy" ? (
            <div className="wb-doc-missing">Старый формат {ext} открывается установленной программой. Для работы внутри MBOX сохраните файл как {ext === ".doc" ? ".docx" : ".xlsx"}.<button type="button" className="wb-inline-btn" onClick={() => void bridge.openDefault(rootKey, path)}>Открыть файл</button></div>
          ) : kind === "docx" ? (
            <div className="wb-office-scroll">
              <article ref={previewRef} className="wb-docx-page is-univer-document"><Suspense fallback={<OctopusSpinner />}><UniverDocumentViewer html={docxHtml} title={path.split("/").pop() || path} /></Suspense></article>
              {!!docxWarnings.length && <details className="wb-office-warnings"><summary>Особенности преобразования · {docxWarnings.length}</summary>{docxWarnings.map((message, index) => <p key={index}>{message}</p>)}</details>}
            </div>
          ) : book && sheetName ? (
            <Suspense fallback={<OctopusSpinner />}><SheetEditor book={book} sheetName={sheetName} onSheetName={setSheetName} onChange={() => setDirty(true)} visible={visible} /></Suspense>
          ) : <div className="wb-doc-missing">Не удалось прочитать документ.</div>}
    </DocShell>
  );
}
