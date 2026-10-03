import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Download, FolderClosed, Globe2, Lock, MoreHorizontal, Pencil, Pin, PinOff, RefreshCw, Trash2, Upload, Users } from "lucide-react";
import type { IDocumentData } from "@univerjs/presets";
import type { MboxData } from "../../hooks/useMboxData";
import { ENTITY_CHANGED_EVENT } from "../../hooks/useRealtime";
import { fetchJson } from "../../lib/api";
import { formatDateTime, formatSince } from "../../lib/format";
import { askConfirm, askText } from "../../ui/askText";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { DocShell } from "./docLayout";
import { WbMenu } from "./WbMenu";
import type { TabsApi } from "./tabs";
import { docsStore, emitDocs, importDocx, patchDoc, type DocRecord } from "./docsStore";

const DocEditor = lazy(() => import("./UniverDocEditor").then((module) => ({ default: module.DocEditor })));

type Access = "private" | "project" | "all";
const ACCESS: Array<{ value: Access; label: string; hint: string }> = [
  { value: "private", label: "Только я", hint: "видите только вы и агенты от вашего имени" },
  { value: "project", label: "Участники проекта", hint: "видят участники проекта документа" },
  { value: "all", label: "Все в MBOX", hint: "видят все пользователи MBOX" },
];

/** Отпечаток содержимого: текст, разметка и поля страницы. Служебные поля Univer (id абзацев) в него не входят. */
function fingerprint(snapshot: IDocumentData | null) {
  if (!snapshot) return "";
  const body = snapshot.body;
  return JSON.stringify([body?.dataStream, body?.textRuns, body?.paragraphs?.map((item) => [item.startIndex, item.paragraphStyle]), body?.tables, snapshot.documentStyle]);
}

function parseSnapshot(content: string | undefined): IDocumentData | null {
  try { return content ? (JSON.parse(content) as IDocumentData) : null; } catch { return null; }
}

export function DocDocument({ docId, data, tabs, tabKey, visible, onDirty }: {
  docId: string;
  data: MboxData;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const cached = docsStore.list.find((item) => item.id === docId);
  const [doc, setDoc] = useState<DocRecord | null>(cached ?? null);
  const [snapshot, setSnapshot] = useState<IDocumentData | null>(null);
  const [loadKey, setLoadKey] = useState("0");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [state, setState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const pendingRef = useRef<IDocumentData | null>(null);
  const savedPrintRef = useRef("");
  const savingRef = useRef(false);
  const updatedAtRef = useRef("");
  const importRef = useRef<HTMLInputElement | null>(null);

  const open = useCallback((loaded: DocRecord, reload: boolean) => {
    const next = parseSnapshot(loaded.content);
    setDoc(loaded);
    updatedAtRef.current = loaded.updated_at;
    patchDoc(loaded);
    if (!next) { setError("Не удалось прочитать содержимое документа"); return; }
    savedPrintRef.current = fingerprint(next);
    pendingRef.current = null;
    setConflict(false);
    setSnapshot(next);
    setState("saved");
    if (reload) setLoadKey((key) => String(Number(key) + 1));
  }, []);

  const load = useCallback(async (reload = false) => {
    setError("");
    try {
      const { document } = await fetchJson<{ document: DocRecord }>(`/api/mbox/documents/${docId}`);
      open(document, reload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [docId, open]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    const next = pendingRef.current;
    if (!next || savingRef.current) return;
    savingRef.current = true;
    setState("saving");
    try {
      const { document } = await fetchJson<{ document: DocRecord }>(`/api/mbox/documents/${docId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: next, base_updated_at: updatedAtRef.current || undefined }),
      });
      savedPrintRef.current = fingerprint(next);
      updatedAtRef.current = document.updated_at;
      setDoc((current) => (current ? { ...current, ...document, content: undefined } : current));
      patchDoc(document);
      if (pendingRef.current === next) pendingRef.current = null;
      setState(pendingRef.current ? "pending" : "saved");
      tabs.pin(tabKey);
    } catch (cause) {
      // 409: пока человек печатал, агент или коллега записали новую версию — решает человек.
      if (cause instanceof Error && cause.message === "request_failed:409") { setConflict(true); setState("pending"); }
      else { setError(cause instanceof Error ? cause.message : String(cause)); setState("error"); }
    } finally {
      savingRef.current = false;
    }
  }, [docId, tabKey, tabs]);

  const onChange = useCallback((next: IDocumentData) => {
    // Мутации без реальной разницы (фокус, выделение) не должны ни пачкать документ, ни будить сервер.
    if (fingerprint(next) === savedPrintRef.current) return;
    pendingRef.current = next;
    setError("");
    setState("pending");
  }, []);

  // Автосохранение: документ пишется на ходу; Ctrl+S и закрытие вкладки сохраняют сразу.
  useEffect(() => {
    if (state !== "pending" || conflict) return;
    const timer = window.setTimeout(() => void save(), 900);
    return () => window.clearTimeout(timer);
  }, [state, save, conflict]);

  useEffect(() => { onDirty(tabKey, state !== "saved"); }, [state, tabKey, onDirty]);
  useEffect(() => () => onDirty(tabKey, false), [tabKey, onDirty]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, save]);

  // Закрыли вкладку или окно с несохранённой правкой — отдаём её серверу, пока страница жива.
  useEffect(() => {
    const flush = () => { if (pendingRef.current) void save(); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [save]);

  // Агент или коллега переписал документ: если у нас нет несохранённого, перечитываем и пересобираем редактор.
  const pullRemote = useCallback(async () => {
    if (pendingRef.current || savingRef.current) return;
    try {
      const { document } = await fetchJson<{ document: DocRecord }>(`/api/mbox/documents/${docId}`);
      if (pendingRef.current || savingRef.current || document.updated_at === updatedAtRef.current) return;
      const incoming = parseSnapshot(document.content);
      if (!incoming || fingerprint(incoming) === savedPrintRef.current) { updatedAtRef.current = document.updated_at; setDoc((current) => (current ? { ...current, ...document, content: undefined } : current)); return; }
      open(document, true);
    } catch { /* сеть моргнула — следующий сигнал догонит */ }
  }, [docId, open]);

  useEffect(() => {
    const onEntity = (event: Event) => {
      const entity = (event as CustomEvent<string>).detail;
      if (!entity || entity === "documents") void pullRemote();
    };
    window.addEventListener(ENTITY_CHANGED_EVENT, onEntity);
    window.addEventListener("focus", pullRemote);
    return () => { window.removeEventListener(ENTITY_CHANGED_EVENT, onEntity); window.removeEventListener("focus", pullRemote); };
  }, [pullRemote]);

  /** Выбор при конфликте: версия с сервера (свои правки отбрасываются) или своя поверх. */
  async function resolveConflict(keepMine: boolean) {
    if (!keepMine) { pendingRef.current = null; await load(true); return; }
    try {
      const { document: latest } = await fetchJson<{ document: DocRecord }>(`/api/mbox/documents/${docId}`);
      updatedAtRef.current = latest.updated_at;
      setConflict(false);
      await save();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function update(patch: Partial<DocRecord>) {
    const { document } = await fetchJson<{ document: DocRecord }>(`/api/mbox/documents/${docId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    setDoc((current) => (current ? { ...current, ...document, content: undefined } : current));
    patchDoc(document);
  }

  async function rename() {
    const title = await askText({ title: "Название документа", value: doc?.title || "", confirmLabel: "Переименовать" });
    const next = title?.trim().slice(0, 200);
    if (!next || next === doc?.title) return;
    await update({ title: next });
  }

  async function remove() {
    if (!(await askConfirm({ title: "Удалить документ?", confirmLabel: "Удалить", danger: true }))) return;
    pendingRef.current = null;
    await fetchJson(`/api/mbox/documents/${docId}`, { method: "DELETE" });
    docsStore.list = docsStore.list.filter((item) => item.id !== docId);
    emitDocs();
    onDirty(tabKey, false);
    tabs.close(tabKey);
  }

  async function downloadWord() {
    await save();
    const response = await fetch(`/api/mbox/documents/${docId}/docx`);
    if (!response.ok) { setError("Не удалось собрать .docx"); return; }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(doc?.title || `document-${docId}`).replace(/\.[a-z0-9]+$/i, "")}.docx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importWord(file: File) {
    if (!/\.docx$/i.test(file.name)) { setError("Нужен файл .docx"); return; }
    if (state !== "saved" && !(await askConfirm({ title: "Открыть Word в новом документе? Несохранённые правки останутся здесь.", confirmLabel: "Открыть" }))) return;
    try {
      const created = await importDocx(file, doc?.project_id ?? null);
      tabs.open(`doc:${created.id}`, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (loading) return <div className="wb-doc-missing" role="status">Открываю документ…</div>;
  if (!doc || !snapshot) return <div className="wb-doc-missing" role="alert">{error || "Документ не найден."}</div>;

  const projectName = data.projects.find((project) => project.id === doc.project_id)?.name;
  const access = ACCESS.find((item) => item.value === (doc.access_level || "private")) ?? ACCESS[0];
  const AccessIcon = access.value === "all" ? Globe2 : access.value === "project" ? Users : Lock;

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-note-status" title={`Изменено ${formatDateTime(doc.updated_at)}`}>
            {state === "error" ? (
              <span className="wb-note-save is-error" role="alert"><AlertCircle size={13} aria-hidden="true" /> {error || "Не сохранилось"} — Ctrl+S</span>
            ) : state === "saving" ? (
              <span className="wb-note-save is-busy"><span className="wb-note-spinner" aria-hidden="true" /> Сохраняю…</span>
            ) : state === "pending" ? (
              <span className="wb-note-save is-busy">Есть несохранённые правки</span>
            ) : (
              <span className="wb-note-save"><Check size={13} aria-hidden="true" /> Изменено {formatSince(doc.updated_at)}</span>
            )}
            {doc.pinned && <span className="wb-note-flag" title="Закреплён сверху списка"><Pin size={11} aria-hidden="true" /> Закреплён</span>}
          </span>
          <div className="wb-note-tools">
            <label className="wb-note-popup" title={`Кто видит: ${access.hint}`}>
              <AccessIcon size={13} aria-hidden="true" />
              <span>{access.label}</span>
              <ChevronDown size={12} aria-hidden="true" />
              <select value={access.value} onChange={(event) => void update({ access_level: event.target.value as Access })} aria-label="Кто видит документ">
                {ACCESS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="wb-note-popup" title="Проект документа">
              <FolderClosed size={13} aria-hidden="true" />
              <span className={projectName ? undefined : "is-muted"}>{projectName ?? "Без проекта"}</span>
              <ChevronDown size={12} aria-hidden="true" />
              <select value={doc.project_id ?? ""} onChange={(event) => void update({ project_id: event.target.value || null })} aria-label="Проект документа">
                <option value="">Без проекта</option>
                {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <span className="wb-note-divider" aria-hidden="true" />
            <button type="button" className="wb-note-icon" onClick={() => void downloadWord()} title="Скачать в Word (.docx)" aria-label="Скачать в Word"><Download size={14} /></button>
            <button type="button" className="wb-note-icon" onClick={() => importRef.current?.click()} title="Открыть Word (.docx) новым документом" aria-label="Открыть Word"><Upload size={14} /></button>
            <input ref={importRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importWord(file); event.target.value = ""; }} />
            <button type="button" className={`wb-note-icon${menu ? " is-on" : ""}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.right - 220, y: rect.bottom + 4 }); }} aria-haspopup="menu" aria-expanded={Boolean(menu)} title="Ещё" aria-label="Ещё действия"><MoreHorizontal size={15} /></button>
          </div>
          {menu && (
            <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
              <div className="wb-note-menu">
                <button type="button" role="menuitem" onClick={() => { setMenu(null); void update({ pinned: !doc.pinned }); }}>
                  <span>{doc.pinned ? <PinOff size={14} /> : <Pin size={14} />}{doc.pinned ? "Открепить" : "Закрепить сверху"}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenu(null); void rename(); }}><span><Pencil size={14} />Переименовать</span></button>
                <button type="button" role="menuitem" onClick={() => { setMenu(null); void load(true); }}><span><RefreshCw size={14} />Перечитать с сервера</span></button>
                <div className="wb-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); void remove(); }}><span><Trash2 size={14} />Удалить документ</span></button>
              </div>
            </WbMenu>
          )}
        </>
      )}
    >
      {conflict && (
        <div className="wb-banner is-error" role="alert">
          Документ изменил агент или коллега, пока вы печатали.
          <button type="button" onClick={() => void resolveConflict(false)}>Взять версию с сервера</button>
          <button type="button" onClick={() => void resolveConflict(true)}>Сохранить мою</button>
        </div>
      )}
      <Suspense fallback={<OctopusSpinner />}>
        <DocEditor snapshot={snapshot} loadKey={loadKey} onChange={onChange} visible={visible} />
      </Suspense>
    </DocShell>
  );
}
