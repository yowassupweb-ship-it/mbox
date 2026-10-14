import { Check, FileText, NotebookPen, Presentation, Table2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { fetchJson } from "../../lib/api";
import { bytesToBase64, parseDelimited } from "./officeFormat";
import { SLIDES_TAB } from "./presentationsStore";
import type { TabsApi } from "./tabs";

/**
 * «Добавить в MBOX»: файл, открытый просмотром (локальная папка или облако S3), одним нажатием становится документом,
 * заметкой, таблицей или презентацией MBOX — с поиском, совместной правкой и доступом агентам. Полоска стоит над
 * просмотром и предлагает только то, во что этот тип файла переводится без потерь смысла. Закрытая — не появляется
 * для этого файла снова.
 */

type Target = "doc" | "note" | "table" | "slides";
const TARGETS: Record<Target, { label: string; icon: ReactNode; tab: (id: string) => string }> = {
  doc: { label: "Документ", icon: <FileText size={14} aria-hidden="true" />, tab: (id) => `doc:${id}` },
  note: { label: "Заметку", icon: <NotebookPen size={14} aria-hidden="true" />, tab: (id) => `note:${id}` },
  table: { label: "Таблицу", icon: <Table2 size={14} aria-hidden="true" />, tab: (id) => `table:${id}` },
  slides: { label: "Презентацию", icon: <Presentation size={14} aria-hidden="true" />, tab: (id) => `${SLIDES_TAB}${id}` },
};

const ext = (name: string) => (name.match(/\.([^./\\]+)$/)?.[1] || "").toLowerCase();

export function importTargets(name: string): Target[] {
  switch (ext(name)) {
    case "docx": return ["doc", "note"];
    case "md": case "markdown": case "txt": return ["note", "doc"];
    case "xlsx": case "xlsm": case "csv": case "tsv": return ["table"];
    case "pdf": return ["slides"];
    default: return [];
  }
}

const DISMISSED = "mbox.importOffer.dismissed";
function dismissedSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED) || "[]")); } catch { return new Set(); }
}
function dismiss(id: string) {
  const set = dismissedSet();
  set.add(id);
  try { localStorage.setItem(DISMISSED, JSON.stringify([...set].slice(-500))); } catch { /* не запомнится — не страшно */ }
}

const titleOf = (name: string) => name.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "").trim().slice(0, 200) || "Без названия";

async function toBase64(blob: Blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** CSV/TSV → xlsx: таблицы MBOX хранят книгу Excel. */
async function delimitedToXlsx(text: string, delimiter: string) {
  const { Workbook } = await import("exceljs");
  const book = new Workbook();
  const sheet = book.addWorksheet("Лист1");
  for (const row of parseDelimited(text, delimiter)) sheet.addRow(row);
  return bytesToBase64(new Uint8Array(await book.xlsx.writeBuffer() as ArrayBuffer));
}

async function runImport(target: Target, name: string, blob: Blob, projectId: string | null, onProgress: (text: string) => void): Promise<string> {
  const title = titleOf(name);
  const kind = ext(name);
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (target === "doc") {
    if (kind === "docx") return (await fetchJson<{ document: { id: string } }>("/api/mbox/documents/import-docx", json({ name, data: await toBase64(blob), project_id: projectId }))).document.id;
    return (await fetchJson<{ document: { id: string } }>("/api/mbox/documents", json({ title, markdown: await blob.text(), project_id: projectId }))).document.id;
  }
  if (target === "note") {
    if (kind === "docx") return (await fetchJson<{ note: { id: string } }>("/api/mbox/notes/import-docx", json({ name, data: `data:application/octet-stream;base64,${await toBase64(blob)}`, project_id: projectId }))).note.id;
    return (await fetchJson<{ note: { id: string } }>("/api/mbox/notes", json({ title, content: await blob.text(), project_id: projectId }))).note.id;
  }
  if (target === "table") {
    const content = kind === "csv" || kind === "tsv" ? await delimitedToXlsx(await blob.text(), kind === "tsv" ? "\t" : ",") : await toBase64(blob);
    return (await fetchJson<{ table: { id: string } }>("/api/mbox/tables", json({ title, content, project_id: projectId }))).table.id;
  }
  // PDF → презентация: страницы становятся слайдами (тот же разбор, что у импорта в разделе «Презентации»).
  const { pdfToDeck } = await import("./slides/importPdf");
  const { presentation: created } = await fetchJson<{ presentation: { id: string } }>("/api/mbox/presentations", json({ title, project_id: projectId }));
  const upload = async (dataUrl: string) => (await fetchJson<{ url: string }>(`/api/mbox/presentations/${created.id}/assets`, json({ data_url: dataUrl }))).url;
  const file = new File([blob], name, { type: "application/pdf" });
  const deck = await pdfToDeck(file, upload, (done, total) => onProgress(`Страница ${done} из ${total}…`));
  await fetchJson(`/api/mbox/presentations/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: JSON.stringify(deck), title }) });
  return created.id;
}

/** Проект по ключу облака: файлы проекта лежат в projects/<id>/. */
export function projectOfStorageKey(key: string) {
  return key.match(/^projects\/([^/]+)\//)?.[1] ?? null;
}

export function ImportOffer({ id, name, load, tabs, projectId = null }: {
  /** Устойчивый ключ файла (ключ вкладки) — по нему запоминается «больше не предлагать». */
  id: string;
  name: string;
  load: () => Promise<Blob>;
  tabs: TabsApi;
  projectId?: string | null;
}) {
  const targets = importTargets(name);
  const [hidden, setHidden] = useState(() => dismissedSet().has(id));
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<{ target: Target; id: string } | null>(null);
  const [error, setError] = useState("");
  if (!targets.length || hidden) return null;

  async function start(target: Target) {
    setBusy(target === "slides" ? "Читаю PDF…" : "Добавляю…");
    setError("");
    try {
      const created = await runImport(target, name, await load(), projectId, setBusy);
      setDone({ target, id: created });
      tabs.open(TARGETS[target].tab(created), true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className={`wb-import-offer${done ? " is-done" : ""}`} role="region" aria-label="Добавить файл в MBOX">
      {done ? (
        <>
          <Check size={14} aria-hidden="true" />
          <span>Добавлено как {TARGETS[done.target].label.toLowerCase()}</span>
          <button type="button" onClick={() => tabs.open(TARGETS[done.target].tab(done.id), true)}>Открыть</button>
        </>
      ) : (
        <>
          <span className="wb-import-offer-text">{busy || error || "Добавить в MBOX как"}</span>
          {!busy && targets.map((target) => (
            <button type="button" key={target} onClick={() => void start(target)} title={`Создать ${TARGETS[target].label.toLowerCase()} из этого файла: поиск, совместная правка, доступ агентам`}>
              {TARGETS[target].icon}{TARGETS[target].label}
            </button>
          ))}
        </>
      )}
      <button type="button" className="wb-import-offer-close" onClick={() => { dismiss(id); setHidden(true); }} aria-label="Больше не предлагать для этого файла" title="Больше не предлагать для этого файла"><X size={13} /></button>
    </div>
  );
}
