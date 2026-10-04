import { useEffect, useRef, useState } from "react";
import { FileText, Pencil, Pin, PinOff, Plus, RefreshCw, Table2, Trash2, Upload, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatBytes, formatSince } from "../../lib/format";
import { askConfirm, askText } from "../../ui/askText";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { WbMenu } from "./WbMenu";
import type { TabsApi } from "./tabs";
import { createDocAndOpen, docsStore, emitDocs, importDocx, patchDoc, refreshDocs, type DocRecord } from "./docsStore";

export type SheetsDocsMode = "tables" | "docs";

/** Переключатель «Таблицы | Документы» в шапке боковой панели. Только значки: подпись — в подсказке. */
export function SheetsDocsSwitch({ mode, onMode }: { mode: SheetsDocsMode; onMode: (mode: SheetsDocsMode) => void }) {
  return (
    <div className="wb-mode-switch" role="radiogroup" aria-label="Раздел">
      <button type="button" role="radio" aria-checked={mode === "tables"} className={mode === "tables" ? "is-on" : undefined} onClick={() => onMode("tables")} title="Таблицы" aria-label="Таблицы"><Table2 size={15} aria-hidden="true" /></button>
      <button type="button" role="radio" aria-checked={mode === "docs"} className={mode === "docs" ? "is-on" : undefined} onClick={() => onMode("docs")} title="Документы" aria-label="Документы"><FileText size={15} aria-hidden="true" /></button>
    </div>
  );
}

export function DocumentsView({ tabs, defaultProjectId = null, onOpen, mode, onMode }: { tabs: TabsApi; defaultProjectId?: string | null; onOpen?: () => void; mode: SheetsDocsMode; onMode: (mode: SheetsDocsMode) => void }) {
  const [, setTick] = useState(0);
  const [query, setQuery] = useState(docsStore.query);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [context, setContext] = useState<{ doc: DocRecord; x: number; y: number } | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const canCreate = defaultProjectId !== undefined;

  useEffect(() => {
    const rerender = () => setTick((value) => value + 1);
    docsStore.listeners.add(rerender);
    return () => { docsStore.listeners.delete(rerender); };
  }, []);

  useEffect(() => {
    docsStore.query = query;
    const timer = window.setTimeout(() => void refreshDocs(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function create() {
    try { await createDocAndOpen(tabs, defaultProjectId ?? null); onOpen?.(); } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function importWord(file: File) {
    if (!/\.docx$/i.test(file.name)) { setNotice("Нужен файл .docx"); return; }
    setImporting(true);
    setNotice("");
    try {
      const doc = await importDocx(file, defaultProjectId ?? null);
      tabs.open(`doc:${doc.id}`, true);
      onOpen?.();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  }

  async function togglePin(doc: DocRecord) {
    const { document } = await fetchJson<{ document: DocRecord }>(`/api/mbox/documents/${doc.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: !doc.pinned }) });
    patchDoc(document);
  }

  async function rename(doc: DocRecord) {
    const title = await askText({ title: "Название документа", value: doc.title, confirmLabel: "Переименовать" });
    const next = title?.trim().slice(0, 200);
    if (!next || next === doc.title) return;
    const { document } = await fetchJson<{ document: DocRecord }>(`/api/mbox/documents/${doc.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: next }) });
    patchDoc(document);
  }

  async function remove(doc: DocRecord) {
    if (!(await askConfirm({ title: `Удалить документ «${doc.title || "Документ"}»?`, confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/documents/${doc.id}`, { method: "DELETE" });
    docsStore.list = docsStore.list.filter((item) => item.id !== doc.id);
    emitDocs();
    tabs.close(`doc:${doc.id}`);
  }

  const pinned = docsStore.list.filter((doc) => doc.pinned);
  const rest = docsStore.list.filter((doc) => !doc.pinned);

  function renderItem(doc: DocRecord) {
    const key = `doc:${doc.id}`;
    return (
      <div key={doc.id} className={tabs.active === key ? "wb-table-item is-active" : "wb-table-item"} onContextMenu={(event) => { event.preventDefault(); setContext({ doc, x: event.clientX, y: event.clientY }); }}>
        <button type="button" className="wb-table-open" onClick={() => { tabs.open(key); onOpen?.(); }} onDoubleClick={() => { tabs.open(key, true); onOpen?.(); }} title={`Открыть документ «${doc.title || "Документ"}»`}>
          <span className="wb-table-glyph" aria-hidden="true"><FileText size={16} /></span>
          <span className="wb-table-copy">
            <span className="wb-table-title">{doc.title || "Документ"}</span>
            <span className="wb-table-details"><span>{formatSince(doc.updated_at)}</span><span aria-hidden="true">·</span><span>{formatBytes(doc.size_bytes || 0)}</span></span>
            {query && doc.snippet && <span className="wb-table-snippet">{doc.snippet}</span>}
          </span>
        </button>
        <button type="button" className={doc.pinned ? "wb-table-pin is-on" : "wb-table-pin"} onClick={() => void togglePin(doc)} aria-label={doc.pinned ? "Открепить документ" : "Закрепить документ сверху"} title={doc.pinned ? "Открепить" : "Закрепить сверху"}>
          {doc.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
      </div>
    );
  }

  return (
    <div className="wb-view wb-tables-view">
      <header className="wb-view-head">
        <SheetsDocsSwitch mode={mode} onMode={onMode} />
        <div className="wb-view-actions">
          <button type="button" disabled={!canCreate || importing} onClick={() => importRef.current?.click()} title={canCreate ? "Импорт Word (.docx)" : "Нет доступных проектов"} aria-label="Импорт Word"><Upload size={14} /></button>
          <button type="button" disabled={!canCreate} onClick={() => void create()} title={canCreate ? "Новый документ" : "Нет доступных проектов"} aria-label="Новый документ"><Plus size={14} /></button>
          <input ref={importRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importWord(file); event.target.value = ""; }} />
        </div>
      </header>
      <div className="wb-filter">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в документах" aria-label="Найти в документах" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      {notice && <div className="wb-files-notice" role="alert">{notice}<button type="button" onClick={() => setNotice("")} aria-label="Скрыть"><X size={12} /></button></div>}
      <div className="wb-view-body">
        {pinned.length > 0 && <div className="wb-menu-group-head is-static">Закреплённые</div>}
        {pinned.map(renderItem)}
        {pinned.length > 0 && rest.length > 0 && <div className="wb-menu-group-head is-static">Остальные</div>}
        {rest.map(renderItem)}
        {docsStore.loading && !docsStore.list.length && <OctopusSpinner label={query ? "Ищу в документах…" : "Загружаю документы…"} />}
        {!docsStore.loading && docsStore.failed && !docsStore.list.length && (
          <div className="wb-session-empty">
            <p>Не удалось загрузить документы.</p>
            <button type="button" onClick={() => void refreshDocs()}><RefreshCw size={13} /> Повторить</button>
          </div>
        )}
        {!docsStore.loading && !docsStore.failed && !docsStore.list.length && (
          <div className="wb-session-empty">
            <p>{query ? "Ничего не нашлось." : "Документов пока нет."}</p>
            {!query && <button type="button" disabled={!canCreate} onClick={() => void create()}><Plus size={13} /> Новый документ</button>}
          </div>
        )}
      </div>
      {context && (
        <WbMenu x={context.x} y={context.y} onClose={() => setContext(null)}>
          <div className="wb-note-menu">
            <button type="button" role="menuitem" onClick={() => { tabs.open(`doc:${context.doc.id}`, true); onOpen?.(); setContext(null); }}><span><FileText size={14} />Открыть</span></button>
            <button type="button" role="menuitem" onClick={() => { const selected = context.doc; setContext(null); void rename(selected); }}><span><Pencil size={14} />Переименовать</span></button>
            <button type="button" role="menuitem" onClick={() => { const selected = context.doc; setContext(null); void togglePin(selected); }}><span>{context.doc.pinned ? <PinOff size={14} /> : <Pin size={14} />}{context.doc.pinned ? "Открепить" : "Закрепить сверху"}</span></button>
            <div className="wb-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="is-danger" onClick={() => { const selected = context.doc; setContext(null); void remove(selected); }}><span><Trash2 size={14} />Удалить документ</span></button>
          </div>
        </WbMenu>
      )}
    </div>
  );
}
