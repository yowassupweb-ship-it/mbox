import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import type { Workbook } from "exceljs";
import { fetchJson } from "../../lib/api";
import { uploadToStorage } from "../../lib/storageUpload";
import { DocShell } from "./docLayout";
import { delimitedContent, parseDelimited } from "./officeFormat";
import { SheetEditor } from "./SheetEditor";
import type { TabsApi } from "./tabs";

export const STORAGE_SHEET_TAB = "s3sheet:";
export const isSheetFile = (name: string) => /\.(xlsx|xlsm|csv|tsv)$/i.test(name);

const TYPES: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
};

/**
 * Таблица из хранилища S3 — тот же редактор, что для локальных файлов. Читается по временной подписанной
 * ссылке, сохраняется обратно в тот же ключ обычной загрузкой (участнику — только в папках его проектов).
 */
export function StorageSheetDocument({ storageKey, tabs, tabKey, visible, onDirty }: {
  storageKey: string;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const ext = (storageKey.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const delimiter = ext === "tsv" ? "\t" : ",";
  const delimited = ext === "csv" || ext === "tsv";
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, onDirty, tabKey]);
  useEffect(() => () => onDirty(tabKey, false), [onDirty, tabKey]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { url } = await fetchJson<{ url: string }>(`/api/mbox/storage/link?key=${encodeURIComponent(storageKey)}&expires=600`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Хранилище ответило ${response.status}`);
      const buffer = await response.arrayBuffer();
      const { Workbook: ExcelWorkbook } = await import("exceljs");
      const workbook = new ExcelWorkbook();
      if (delimited) workbook.addWorksheet("Лист 1").addRows(parseDelimited(new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, ""), delimiter));
      else await workbook.xlsx.load(buffer);
      setBook(workbook);
      setSheetName(workbook.worksheets[0]?.name ?? "");
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [delimited, delimiter, storageKey]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!book || saving) return;
    setSaving(true);
    setError("");
    try {
      const sheet = book.getWorksheet(sheetName) ?? book.worksheets[0];
      const body: BlobPart = delimited ? `﻿${delimitedContent(sheet, delimiter)}` : await book.xlsx.writeBuffer();
      await uploadToStorage(storageKey, new Blob([body], { type: TYPES[ext] || "application/octet-stream" }));
      setDirty(false);
      tabs.pin(tabKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-doc-crumbs">Хранилище › {storageKey.split("/").join(" › ")}{dirty && <b className="wb-dirty-mark"> ●</b>}</span>
          <div className="wb-doc-actions">
            <button type="button" onClick={() => { if (!dirty || window.confirm("Отбросить несохранённые правки и перечитать файл?")) void load(); }} title="Перечитать из хранилища"><RefreshCw size={14} /></button>
            <button type="button" className="is-primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? "Сохраняю…" : "Сохранить"}</button>
          </div>
        </>
      )}
    >
      {error && <div className="wb-banner is-error">{error}</div>}
      {loading ? <div className="wb-doc-missing">Открываю {storageKey.split("/").pop()}…</div>
        : book && sheetName ? <SheetEditor book={book} sheetName={sheetName} onSheetName={setSheetName} onChange={() => setDirty(true)} visible={visible} />
          : !error && <div className="wb-doc-missing">Не удалось прочитать таблицу.</div>}
    </DocShell>
  );
}
