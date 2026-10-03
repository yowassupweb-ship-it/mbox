import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Check, Contrast, Download, Lock, Pencil, Save } from "lucide-react";
import type { Workbook } from "exceljs";
import { OctopusSpinner } from "../components/OctopusSpinner";
import { base64ToArrayBuffer, bytesToBase64 } from "../app/workbench/officeFormat";

const SheetEditor = lazy(() => import("../app/workbench/UniverSheetEditor").then((module) => ({ default: module.SheetEditor })));

type SharedTable = { id: string; title: string; content: string; updated_at: string };
type Status = "loading" | "saved" | "dirty" | "saving" | "error" | "missing";
type ViewerTheme = "light" | "graphite" | "black";

const SHARED_TABLE_THEME_KEY = "mbox.shared-table-theme";
const THEME_ORDER: ViewerTheme[] = ["light", "graphite", "black"];
const THEME_LABEL: Record<ViewerTheme, string> = { light: "Светлая", graphite: "Графитовая", black: "Чёрная" };

/** Таблица по ссылке (/t/<токен>): тот же XLSX и Univer, но без входа в MBOX. */
export function SharedTablePage({ token }: { token: string }) {
  const api = `/api/share/tables/${token}`;
  const [table, setTable] = useState<SharedTable | null>(null);
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [status, setStatus] = useState<Status>("loading");
  const [notice, setNotice] = useState("");
  const [viewerTheme, setViewerTheme] = useState<ViewerTheme>(() => {
    const current = document.documentElement.dataset.theme;
    return current === "light" || current === "black" ? current : "graphite";
  });
  const baseUpdatedAt = useRef("");
  const saving = useRef(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(SHARED_TABLE_THEME_KEY);
    if (stored === "light" || stored === "graphite" || stored === "black") setViewerTheme(stored);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = viewerTheme;
    document.documentElement.style.colorScheme = viewerTheme === "light" ? "light" : "dark";
  }, [viewerTheme]);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await fetch(api);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось открыть таблицу");
      const { Workbook: ExcelWorkbook } = await import("exceljs");
      const nextBook = new ExcelWorkbook();
      await nextBook.xlsx.load(base64ToArrayBuffer(data.table.content));
      if (!nextBook.worksheets.length) nextBook.addWorksheet("Лист 1");
      setBook(nextBook);
      setTable(data.table);
      setSheetName(nextBook.worksheets[0].name);
      setMode(data.mode);
      baseUpdatedAt.current = data.table.updated_at;
      document.title = data.table.title || "Таблица";
      setStatus("saved");
    } catch (error) {
      setStatus("missing");
      setNotice(error instanceof Error ? error.message : "Не удалось открыть таблицу");
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => { if (status === "dirty" || status === "saving") event.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [status]);

  const save = useCallback(async () => {
    if (!book || !table || mode !== "edit" || saving.current) return;
    saving.current = true;
    setStatus("saving");
    try {
      const content = bytesToBase64(await book.xlsx.writeBuffer());
      const response = await fetch(api, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: table.title, content, base_updated_at: baseUpdatedAt.current }) });
      const data = await response.json();
      if (response.status === 409) { setNotice("Таблицу изменили в другом окне. Перезагрузите страницу, чтобы не потерять правки."); setStatus("dirty"); return; }
      if (!response.ok) throw new Error(data.error || "Не удалось сохранить таблицу");
      setTable(data.table);
      baseUpdatedAt.current = data.table.updated_at;
      setStatus("saved");
    } catch (error) {
      setStatus("error");
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить таблицу");
    } finally { saving.current = false; }
  }, [api, book, mode, table]);

  async function download() {
    if (!book || !table) return;
    const blob = new Blob([await book.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${table.title || "Таблица"}.xlsx`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(viewerTheme) + 1) % THEME_ORDER.length];
    setViewerTheme(next);
    window.localStorage.setItem(SHARED_TABLE_THEME_KEY, next);
  }

  if (status === "loading") return <main className="share-page share-sheet-page"><OctopusSpinner label="Открываю таблицу…" /></main>;
  if (status === "missing" || !table || !book) return <main className="share-page share-sheet-page"><section className="share-sheet-error"><Lock size={20} /><h1>Таблица недоступна</h1><p>{notice || "Ссылка может быть отозвана."}</p></section></main>;

  const editable = mode === "edit";
  const stateLabel = status === "saving" ? "Сохраняю…" : status === "dirty" ? "Есть несохранённые правки" : status === "error" ? "Не сохранилось" : "Все изменения сохранены";
  return <main className="share-page share-sheet-page">
    <header className="share-sheet-bar">
      <div><span className="share-sheet-kicker">MBOX · Таблица по ссылке</span><h1>{table.title || "Таблица"}</h1></div>
      <div className="share-sheet-actions">
        <span className={status === "error" ? "is-error" : undefined} role="status">{status === "saved" ? <Check size={13} /> : null}{stateLabel}</span>
        <button type="button" onClick={() => void download()} title="Скачать Excel"><Download size={15} /> Скачать</button>
        <button
          type="button"
          className={`share-theme-button doc-theme-button is-${viewerTheme}`}
          onClick={cycleTheme}
          aria-label={`Сменить тему. Сейчас ${THEME_LABEL[viewerTheme].toLowerCase()}`}
          title="Сменить тему"
        >
          <Contrast size={15} aria-hidden="true" />
        </button>
        {editable ? <button type="button" className="primary-action" disabled={status !== "dirty" && status !== "error"} onClick={() => void save()}><Save size={15} /> Сохранить</button> : <span className="share-sheet-mode"><Lock size={14} /> Только просмотр</span>}
      </div>
    </header>
    {notice && <p className="share-sheet-notice" role="alert">{notice}</p>}
    <section className={`share-sheet-editor${editable ? "" : " is-readonly"}`} aria-label={editable ? "Редактирование таблицы" : "Просмотр таблицы"}>
      <Suspense fallback={<OctopusSpinner label="Загружаю редактор…" />}><SheetEditor book={book} sheetName={sheetName} onSheetName={setSheetName} onChange={() => setStatus("dirty")} visible readOnly={!editable} /></Suspense>
      {!editable && <div className="share-sheet-readonly" aria-hidden="true"><Lock size={14} /> Только просмотр</div>}
    </section>
  </main>;
}
