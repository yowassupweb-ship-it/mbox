import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, FileText, Link2, Pin, PinOff, Plus, RefreshCw, Share2, Trash2, Upload, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatBytes, formatSince } from "../../lib/format";
import { serverOrigin } from "../../lib/serverOrigin";
import { askConfirm, askText } from "../../ui/askText";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { base64ToArrayBuffer } from "./officeFormat";
import type { TabsApi } from "./tabs";
import { WbMenu } from "./WbMenu";
import { DocShell } from "./docLayout";

const UniverDocumentEditor = lazy(() => import("./UniverDocumentEditor").then((module) => ({ default: module.UniverDocumentEditor })));
const UNIVER_DOCUMENT_MIME = "application/vnd.mbox.univer-doc+json";

export type MboxDocument = {
  id: string;
  title: string;
  content: string;
  mime_type: string;
  pinned: boolean;
  project_id: string | null;
  updated_at: string;
  size_bytes: number;
};

const documentStore = { list: [] as MboxDocument[], query: "", loading: true, failed: false, listeners: new Set<() => void>() };
const emit = () => documentStore.listeners.forEach((listener) => listener());

async function refreshDocuments() {
  const query = documentStore.query.trim();
  if (query || !documentStore.list.length) { documentStore.loading = true; emit(); }
  try {
    documentStore.list = (await fetchJson<{ documents: MboxDocument[] }>(`/api/mbox/documents${query ? `?q=${encodeURIComponent(query)}` : ""}`)).documents;
    documentStore.failed = false;
  } catch { documentStore.failed = true; }
  documentStore.loading = false;
  emit();
}

function updateStored(document: MboxDocument) {
  const index = documentStore.list.findIndex((item) => item.id === document.id);
  if (index < 0) documentStore.list.unshift(document);
  else documentStore.list[index] = { ...documentStore.list[index], ...document };
  documentStore.list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
  emit();
}

export function documentTitle(key: string) {
  return documentStore.list.find((item) => key === `document:${item.id}`)?.title || "Документ";
}

export async function createDocumentAndOpen(tabs: TabsApi, projectId: string | null = null) {
  const { document } = await fetchJson<{ document: MboxDocument }>("/api/mbox/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Новый документ", project_id: projectId }),
  });
  updateStored(document);
  tabs.open(`document:${document.id}`, true);
}

export function DocumentsView({ tabs, defaultProjectId = null, onOpen, switcher }: { tabs: TabsApi; defaultProjectId?: string | null; onOpen?: () => void; switcher?: ReactNode }) {
  const [, setTick] = useState(0);
  const [query, setQuery] = useState(documentStore.query);
  const [importing, setImporting] = useState(false);
  const [context, setContext] = useState<{ item: MboxDocument; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { const redraw = () => setTick((value) => value + 1); documentStore.listeners.add(redraw); return () => { documentStore.listeners.delete(redraw); }; }, []);
  useEffect(() => { documentStore.query = query; const timer = window.setTimeout(() => void refreshDocuments(), query ? 250 : 0); return () => window.clearTimeout(timer); }, [query]);

  async function importDocument(file: File) {
    if (!/\.docx$/i.test(file.name)) return;
    setImporting(true);
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^,]+,/, "")); reader.onerror = () => reject(new Error("file_read_failed")); reader.readAsDataURL(file); });
      const { document } = await fetchJson<{ document: MboxDocument }>("/api/mbox/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: file.name.replace(/\.docx$/i, "") || "Документ", content: data, mime_type: file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document", project_id: defaultProjectId }) });
      updateStored(document);
      tabs.open(`document:${document.id}`, true);
      onOpen?.();
    } finally { setImporting(false); }
  }

  async function rename(item: MboxDocument) {
    const title = await askText({ title: "Название документа", value: item.title, confirmLabel: "Переименовать" });
    if (!title?.trim() || title.trim() === item.title) return;
    updateStored((await fetchJson<{ document: MboxDocument }>(`/api/mbox/documents/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: title.trim().slice(0, 200) }) })).document);
  }

  async function togglePin(item: MboxDocument) {
    updateStored((await fetchJson<{ document: MboxDocument }>(`/api/mbox/documents/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: !item.pinned }) })).document);
  }

  async function remove(item: MboxDocument) {
    if (!(await askConfirm({ title: `Удалить документ «${item.title}»?`, confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/documents/${item.id}`, { method: "DELETE" });
    documentStore.list = documentStore.list.filter((entry) => entry.id !== item.id);
    emit();
    tabs.close(`document:${item.id}`);
  }

  const renderItem = (item: MboxDocument) => {
    const key = `document:${item.id}`;
    return <div key={item.id} className={tabs.active === key ? "wb-table-item is-active" : "wb-table-item"} onContextMenu={(event) => { event.preventDefault(); setContext({ item, x: event.clientX, y: event.clientY }); }}>
      <button type="button" className="wb-table-open" onClick={() => { tabs.open(key); onOpen?.(); }} onDoubleClick={() => { tabs.open(key, true); onOpen?.(); }}>
        <span className="wb-table-glyph"><FileText size={16} /></span><span className="wb-table-copy"><span className="wb-table-title">{item.title}</span><span className="wb-table-details"><span>{formatSince(item.updated_at)}</span><span aria-hidden="true">·</span><span>{formatBytes(item.size_bytes || 0)}</span></span></span>
      </button>
      <button type="button" className={item.pinned ? "wb-table-pin is-on" : "wb-table-pin"} onClick={() => void togglePin(item)} title={item.pinned ? "Открепить" : "Закрепить сверху"}>{item.pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>
    </div>;
  };
  const pinned = documentStore.list.filter((item) => item.pinned);
  const rest = documentStore.list.filter((item) => !item.pinned);

  return <div className="wb-view wb-tables-view">
    <header className={switcher ? "wb-view-head wb-office-toolbar" : "wb-view-head"}>{switcher ? <span aria-hidden="true" /> : <span className="wb-tables-heading"><FileText size={14} /> Документы</span>}{switcher}<div className="wb-view-actions"><button type="button" disabled={importing} onClick={() => inputRef.current?.click()} title="Импорт Word (.docx)"><Upload size={14} /></button><button type="button" onClick={() => { void createDocumentAndOpen(tabs, defaultProjectId); onOpen?.(); }} title="Новый документ"><Plus size={14} /></button><input ref={inputRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importDocument(file); event.target.value = ""; }} /></div></header>
    <div className="wb-filter"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в документах" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить"><X size={13} /></button>}</div>
    <div className="wb-view-body">
      {pinned.length > 0 && <div className="wb-menu-group-head is-static">Закреплённые</div>}{pinned.map(renderItem)}
      {pinned.length > 0 && rest.length > 0 && <div className="wb-menu-group-head is-static">Остальные</div>}{rest.map(renderItem)}
      {documentStore.loading && !documentStore.list.length && <OctopusSpinner label="Загружаю документы…" />}
      {!documentStore.loading && documentStore.failed && <div className="wb-session-empty"><p>Не удалось загрузить документы.</p><button type="button" onClick={() => void refreshDocuments()}><RefreshCw size={13} /> Повторить</button></div>}
      {!documentStore.loading && !documentStore.failed && !documentStore.list.length && <div className="wb-session-empty"><p>{query ? "Ничего не найдено." : "Создайте документ или загрузите Word-файл .docx."}</p><button type="button" onClick={() => { void createDocumentAndOpen(tabs, defaultProjectId); onOpen?.(); }}><Plus size={13} /> Новый документ</button></div>}
    </div>
    {context && <WbMenu x={context.x} y={context.y} onClose={() => setContext(null)}><div className="wb-note-menu"><button type="button" role="menuitem" onClick={() => { tabs.open(`document:${context.item.id}`, true); setContext(null); }}><span><FileText size={14} />Открыть</span></button><button type="button" role="menuitem" onClick={() => { const item = context.item; setContext(null); void rename(item); }}><span>Переименовать</span></button><button type="button" role="menuitem" onClick={() => { const item = context.item; setContext(null); void togglePin(item); }}><span>{context.item.pinned ? "Открепить" : "Закрепить сверху"}</span></button><div className="wb-menu-sep" /><button type="button" role="menuitem" className="is-danger" onClick={() => { const item = context.item; setContext(null); void remove(item); }}><span><Trash2 size={14} />Удалить</span></button></div></WbMenu>}
  </div>;
}

type DocumentShare = { token: string; mode: "view" | "edit"; last_used_at?: string | null };

function DocumentShareButton({ documentId, onSharedChange }: { documentId: string; onSharedChange: (shared: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<DocumentShare[]>([]);
  const [busy, setBusy] = useState<"" | "view" | "edit">("");
  const [copied, setCopied] = useState<"" | "view" | "edit">("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const load = useCallback(async () => {
    const next = (await fetchJson<{ shares: DocumentShare[] }>(`/api/mbox/documents/${documentId}/shares`)).shares;
    setShares(next);
    onSharedChange(next.length > 0);
  }, [documentId, onSharedChange]);
  useEffect(() => { void load().catch(() => { setShares([]); onSharedChange(false); }); }, [load, onSharedChange]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const linkOf = (share: DocumentShare) => `${serverOrigin()}/d/${share.token}`;
  async function copy(share: DocumentShare) {
    try { await navigator.clipboard.writeText(linkOf(share)); } catch { /* ссылка остаётся в поле */ }
    setCopied(share.mode);
    window.setTimeout(() => setCopied(""), 1600);
  }
  async function create(mode: "view" | "edit", regenerate = false) {
    setBusy(mode);
    try {
      const { share } = await fetchJson<{ share: DocumentShare }>(`/api/mbox/documents/${documentId}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, regenerate }) });
      await load();
      await copy(share);
    } finally { setBusy(""); }
  }
  async function revoke(mode: "view" | "edit") {
    if (!(await askConfirm({ title: mode === "edit" ? "Отозвать ссылку на правку?" : "Отозвать ссылку на просмотр?", confirmLabel: "Отозвать", danger: true }))) return;
    setBusy(mode);
    try { await fetchJson(`/api/mbox/documents/${documentId}/shares/${mode}`, { method: "DELETE" }); await load(); } finally { setBusy(""); }
  }
  const rows: Array<{ mode: "view" | "edit"; label: string; hint: string }> = [
    { mode: "view", label: "Просмотр", hint: "Открыть без входа в MBOX" },
    { mode: "edit", label: "Редактирование", hint: "Править без входа в MBOX" },
  ];
  return <div className="wb-share" ref={boxRef}>
    <button type="button" className={shares.length ? "is-on" : undefined} onClick={() => setOpen((value) => !value)} title="Поделиться ссылкой" aria-expanded={open}><Share2 size={14} /></button>
    {open && <div className="wb-share-panel" role="dialog" aria-label="Ссылки на документ">{rows.map((row) => {
      const share = shares.find((item) => item.mode === row.mode);
      return <div key={row.mode} className="wb-share-row"><div className="wb-share-head"><b>{row.label}</b><span>{row.hint}</span></div>
        {share ? <><div className="wb-share-link"><input readOnly value={linkOf(share)} onFocus={(event) => event.currentTarget.select()} aria-label={`Ссылка: ${row.label}`} /><button type="button" onClick={() => void copy(share)} title="Скопировать">{copied === row.mode ? <Check size={13} /> : <Copy size={13} />}</button></div><div className="wb-share-actions"><span>{share.last_used_at ? `открывали ${formatSince(share.last_used_at)}` : "ещё не открывали"}</span><button type="button" disabled={busy === row.mode} onClick={() => void create(row.mode, true)}><RefreshCw size={12} /> Перевыпустить</button><button type="button" className="is-danger" disabled={busy === row.mode} onClick={() => void revoke(row.mode)}><X size={12} /> Отозвать</button></div></> : <button type="button" className="wb-share-create" disabled={busy === row.mode} onClick={() => void create(row.mode)}><Link2 size={13} /> Создать ссылку</button>}
      </div>;
    })}</div>}
  </div>;
}

export function DocumentDocument({ documentId }: { documentId: string }) {
  const [item, setItem] = useState<MboxDocument | null>(null);
  const [source, setSource] = useState<{ text: string; snapshot: Record<string, unknown> | null }>({ text: "", snapshot: null });
  const [error, setError] = useState("");
  const [shared, setShared] = useState(false);
  const saving = useRef(0);
  useEffect(() => {
    let alive = true;
    void fetchJson<{ document: MboxDocument }>(`/api/mbox/documents/${documentId}`).then(async ({ document }) => {
      if (document.mime_type === UNIVER_DOCUMENT_MIME) {
        let snapshot: Record<string, unknown> | null = null;
        try { snapshot = JSON.parse(document.content) as Record<string, unknown>; } catch { /* документ будет открыт как пустой */ }
        if (alive) { setItem(document); setSource({ text: "", snapshot }); }
        return;
      }
      if (document.mime_type === "text/html" || document.mime_type === "text/plain") {
        const text = document.mime_type === "text/html"
          ? new DOMParser().parseFromString(document.content, "text/html").body.innerText
          : document.content;
        if (alive) { setItem(document); setSource({ text, snapshot: null }); }
        return;
      }
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml({ arrayBuffer: base64ToArrayBuffer(document.content) });
      const text = new DOMParser().parseFromString(result.value, "text/html").body.innerText;
      if (alive) { setItem(document); setSource({ text, snapshot: null }); }
    }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [documentId]);
  const save = useCallback((snapshot: Record<string, unknown>) => {
    if (!item) return;
    const revision = ++saving.current;
    void fetchJson<{ document: MboxDocument }>(`/api/mbox/documents/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(snapshot), mime_type: UNIVER_DOCUMENT_MIME }),
    }).then(({ document }) => {
      if (revision !== saving.current) return;
      setItem(document);
      updateStored(document);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [item]);
  if (error) return <div className="wb-doc-missing">Не удалось открыть документ: {error}</div>;
  if (!item) return <OctopusSpinner label="Открываю документ…" />;
  return <DocShell toolbar={<><span className="wb-note-status">{error ? "Не удалось сохранить" : "Форматирование и текст сохраняются автоматически"}{shared && <span className="wb-note-flag" title="Есть ссылка для доступа без входа"><Link2 size={11} aria-hidden="true" /> По ссылке</span>}</span><div className="wb-note-tools"><DocumentShareButton documentId={documentId} onSharedChange={setShared} /></div></>}><div className="wb-document-editor"><Suspense fallback={<OctopusSpinner label="Открываю редактор…" />}><UniverDocumentEditor title={item.title} text={source.text} snapshot={source.snapshot} onChange={save} /></Suspense></div></DocShell>;
}

export function downloadDocument(content: string, title: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([base64ToArrayBuffer(content)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  link.download = `${title || "Документ"}.docx`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
