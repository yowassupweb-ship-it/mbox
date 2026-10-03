import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, ChevronDown, Copy, Download, FolderClosed, Globe2, Link2, Lock, MoreHorizontal, Pencil, Pin, PinOff, Plus, RefreshCw, Save, Share2, Table2, Trash2, Upload, Users, X } from "lucide-react";
import type { Workbook } from "exceljs";
import type { MboxData } from "../../hooks/useMboxData";
import { fetchJson } from "../../lib/api";
import { formatBytes, formatDateTime, formatSince } from "../../lib/format";
import { serverOrigin } from "../../lib/serverOrigin";
import { askConfirm, askText } from "../../ui/askText";
import { DocShell } from "./docLayout";
import { bytesToBase64, base64ToArrayBuffer } from "./officeFormat";
import { WbMenu } from "./WbMenu";
import type { TabsApi } from "./tabs";
import { OctopusSpinner } from "../../components/OctopusSpinner";

const SheetEditor = lazy(() => import("./UniverSheetEditor").then((module) => ({ default: module.SheetEditor })));

export type TableDoc = {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  project_id: string | null;
  author: string;
  owner_user_id?: string | null;
  access_level?: "private" | "project" | "all";
  created_at: string;
  updated_at: string;
  size_bytes: number;
};

type TableAccess = "private" | "project" | "all";
const TABLE_ACCESS: Array<{ value: TableAccess; label: string; hint: string }> = [
  { value: "private", label: "Только я", hint: "видите только вы и агенты от вашего имени" },
  { value: "project", label: "Участники проекта", hint: "видят участники проекта таблицы" },
  { value: "all", label: "Все в MBOX", hint: "видят все пользователи MBOX" },
];

const tablesStore = {
  list: [] as TableDoc[],
  query: "",
  loading: true,
  failed: false,
  listeners: new Set<() => void>(),
};

function emitTables() {
  tablesStore.listeners.forEach((listener) => listener());
}

async function refreshTables() {
  const q = tablesStore.query.trim();
  if (q || !tablesStore.list.length) { tablesStore.loading = true; emitTables(); }
  try {
    tablesStore.list = (await fetchJson<{ tables: TableDoc[] }>(`/api/mbox/tables${q ? `?q=${encodeURIComponent(q)}` : ""}`)).tables;
    tablesStore.failed = false;
  } catch {
    tablesStore.failed = true;
  }
  tablesStore.loading = false;
  emitTables();
}

function patchListed(table: TableDoc) {
  const index = tablesStore.list.findIndex((item) => item.id === table.id);
  if (index >= 0) tablesStore.list[index] = { ...tablesStore.list[index], ...table };
  else tablesStore.list.unshift(table);
  tablesStore.list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
  emitTables();
}

export function tableTitle(key: string) {
  const table = tablesStore.list.find((item) => `table:${item.id}` === key);
  return table ? table.title || "Таблица" : "";
}

async function emptyWorkbookBase64() {
  const { Workbook: ExcelWorkbook } = await import("exceljs");
  const workbook = new ExcelWorkbook();
  const sheet = workbook.addWorksheet("Лист 1");
  sheet.getCell("A1").value = "";
  return bytesToBase64(await workbook.xlsx.writeBuffer());
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

function dataUrlBase64(dataUrl: string) {
  return dataUrl.replace(/^data:[^,]+,/, "");
}

export async function createTableAndOpen(tabs: TabsApi, projectId: string | null = null) {
  const { table } = await fetchJson<{ table: TableDoc }>("/api/mbox/tables", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Новая таблица", content: await emptyWorkbookBase64(), project_id: projectId }),
  });
  patchListed(table);
  tabs.open(`table:${table.id}`, true);
}

export function TablesView({ tabs, defaultProjectId = null, onOpen, switcher }: { tabs: TabsApi; defaultProjectId?: string | null; onOpen?: () => void; switcher?: ReactNode }) {
  const [, setTick] = useState(0);
  const [query, setQuery] = useState(tablesStore.query);
  const [importing, setImporting] = useState(false);
  const [context, setContext] = useState<{ table: TableDoc; x: number; y: number } | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const canCreate = defaultProjectId !== undefined;

  useEffect(() => {
    const rerender = () => setTick((value) => value + 1);
    tablesStore.listeners.add(rerender);
    return () => { tablesStore.listeners.delete(rerender); };
  }, []);

  useEffect(() => {
    tablesStore.query = query;
    const timer = window.setTimeout(() => void refreshTables(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function importTable(file: File) {
    if (!/\.(xlsx|xlsm)$/i.test(file.name)) return;
    setImporting(true);
    try {
      const base = file.name.replace(/\.[a-z0-9]+$/i, "") || "Таблица";
      const { table } = await fetchJson<{ table: TableDoc }>("/api/mbox/tables", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: base, content: dataUrlBase64(await readFileDataUrl(file)), project_id: defaultProjectId ?? null }),
      });
      patchListed(table);
      tabs.open(`table:${table.id}`, true);
      onOpen?.();
    } finally {
      setImporting(false);
    }
  }

  async function togglePin(table: TableDoc) {
    const { table: updated } = await fetchJson<{ table: TableDoc }>(`/api/mbox/tables/${table.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: !table.pinned }) });
    patchListed(updated);
  }

  async function rename(table: TableDoc) {
    const title = await askText({ title: "Название таблицы", value: table.title, confirmLabel: "Переименовать" });
    const nextTitle = title?.trim().slice(0, 200);
    if (!nextTitle || nextTitle === table.title) return;
    const { table: updated } = await fetchJson<{ table: TableDoc }>(`/api/mbox/tables/${table.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle }) });
    patchListed(updated);
  }

  async function removeFromList(table: TableDoc) {
    if (!(await askConfirm({ title: `Удалить таблицу «${table.title || "Таблица"}»?`, confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/tables/${table.id}`, { method: "DELETE" });
    tablesStore.list = tablesStore.list.filter((item) => item.id !== table.id);
    emitTables();
    tabs.close(`table:${table.id}`);
  }

  const pinned = tablesStore.list.filter((table) => table.pinned);
  const rest = tablesStore.list.filter((table) => !table.pinned);

  function renderItem(table: TableDoc) {
    const key = `table:${table.id}`;
    return (
      <div key={table.id} className={tabs.active === key ? "wb-table-item is-active" : "wb-table-item"} onContextMenu={(event) => { event.preventDefault(); setContext({ table, x: event.clientX, y: event.clientY }); }}>
        <button type="button" className="wb-table-open" onClick={() => { tabs.open(key); onOpen?.(); }} onDoubleClick={() => { tabs.open(key, true); onOpen?.(); }} title={`Открыть таблицу «${table.title || "Таблица"}»`}>
          <span className="wb-table-glyph" aria-hidden="true"><Table2 size={16} /></span>
          <span className="wb-table-copy">
            <span className="wb-table-title">{table.title || "Таблица"}</span>
            <span className="wb-table-details"><span>{formatSince(table.updated_at)}</span><span aria-hidden="true">·</span><span>{formatBytes(table.size_bytes || 0)}</span></span>
          </span>
        </button>
        <button type="button" className={table.pinned ? "wb-table-pin is-on" : "wb-table-pin"} onClick={() => void togglePin(table)} aria-label={table.pinned ? "Открепить таблицу" : "Закрепить таблицу сверху"} title={table.pinned ? "Открепить" : "Закрепить сверху"}>
          {table.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
      </div>
    );
  }

  return (
    <div className="wb-view wb-tables-view">
      <header className={switcher ? "wb-view-head wb-office-toolbar" : "wb-view-head"}>
        {switcher ? <span aria-hidden="true" /> : <span className="wb-tables-heading"><Table2 size={14} aria-hidden="true" /> Таблицы</span>}
        {switcher}
        <div className="wb-view-actions">
          <button type="button" disabled={!canCreate || importing} onClick={() => importRef.current?.click()} title={canCreate ? "Импорт Excel (.xlsx)" : "Нет доступных проектов для таблиц"}><Upload size={14} /></button>
          <button type="button" disabled={!canCreate} onClick={() => { void createTableAndOpen(tabs, defaultProjectId ?? null); onOpen?.(); }} title={canCreate ? "Новая таблица" : "Нет доступных проектов для таблиц"}><Plus size={14} /></button>
          <input ref={importRef} type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importTable(file); event.target.value = ""; }} />
        </div>
      </header>
      <div className="wb-filter">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в таблицах" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      <div className="wb-view-body">
        {pinned.length > 0 && <div className="wb-menu-group-head is-static">Закреплённые</div>}
        {pinned.map(renderItem)}
        {pinned.length > 0 && rest.length > 0 && <div className="wb-menu-group-head is-static">Остальные</div>}
        {rest.map(renderItem)}
        {tablesStore.loading && !tablesStore.list.length && <OctopusSpinner label={query ? "Ищу в таблицах…" : "Загружаю таблицы…"} />}
        {!tablesStore.loading && tablesStore.failed && !tablesStore.list.length && (
          <div className="wb-session-empty">
            <p>Не удалось загрузить таблицы.</p>
            <button type="button" onClick={() => void refreshTables()}><RefreshCw size={13} /> Повторить</button>
          </div>
        )}
        {!tablesStore.loading && !tablesStore.failed && !tablesStore.list.length && (
          <div className="wb-session-empty">
            <p>{query ? "Ничего не нашлось." : "Таблиц пока нет."}</p>
            {!query && <button type="button" disabled={!canCreate} onClick={() => { void createTableAndOpen(tabs, defaultProjectId ?? null); onOpen?.(); }}><Plus size={13} /> Новая таблица</button>}
          </div>
        )}
      </div>
      {context && (
        <WbMenu x={context.x} y={context.y} onClose={() => setContext(null)}>
          <div className="wb-note-menu">
            <button type="button" role="menuitem" onClick={() => { tabs.open(`table:${context.table.id}`, true); onOpen?.(); setContext(null); }}><span><Table2 size={14} />Открыть</span></button>
            <button type="button" role="menuitem" onClick={() => { const selected = context.table; setContext(null); void rename(selected); }}><span><Pencil size={14} />Переименовать</span></button>
            <button type="button" role="menuitem" onClick={() => { const selected = context.table; setContext(null); void togglePin(selected); }}><span>{context.table.pinned ? <PinOff size={14} /> : <Pin size={14} />}{context.table.pinned ? "Открепить" : "Закрепить сверху"}</span></button>
            <div className="wb-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="is-danger" onClick={() => { const selected = context.table; setContext(null); void removeFromList(selected); }}><span><Trash2 size={14} />Удалить таблицу</span></button>
          </div>
        </WbMenu>
      )}
    </div>
  );
}

type TableShare = { token: string; mode: "view" | "edit"; last_used_at?: string | null };

function TableShareButton({ tableId, onSharedChange }: { tableId: string; onSharedChange: (shared: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<TableShare[]>([]);
  const [busy, setBusy] = useState<"" | "view" | "edit">("");
  const [copied, setCopied] = useState<"" | "view" | "edit">("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const load = useCallback(async () => {
    const next = (await fetchJson<{ shares: TableShare[] }>(`/api/mbox/tables/${tableId}/shares`)).shares;
    setShares(next);
    onSharedChange(next.length > 0);
  }, [onSharedChange, tableId]);

  useEffect(() => { void load().catch(() => { setShares([]); onSharedChange(false); }); }, [load, onSharedChange]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const linkOf = (share: TableShare) => `${serverOrigin()}/t/${share.token}`;
  async function copy(share: TableShare) {
    try { await navigator.clipboard.writeText(linkOf(share)); } catch { /* ссылка остаётся в поле */ }
    setCopied(share.mode);
    window.setTimeout(() => setCopied(""), 1600);
  }
  async function create(mode: "view" | "edit", regenerate = false) {
    setBusy(mode);
    try {
      const { share } = await fetchJson<{ share: TableShare }>(`/api/mbox/tables/${tableId}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, regenerate }) });
      await load();
      await copy(share);
    } finally { setBusy(""); }
  }
  async function revoke(mode: "view" | "edit") {
    if (!(await askConfirm({ title: mode === "edit" ? "Отозвать ссылку на правку?" : "Отозвать ссылку на просмотр?", confirmLabel: "Отозвать", danger: true }))) return;
    setBusy(mode);
    try { await fetchJson(`/api/mbox/tables/${tableId}/shares/${mode}`, { method: "DELETE" }); await load(); } finally { setBusy(""); }
  }
  const rows: Array<{ mode: "view" | "edit"; label: string; hint: string }> = [
    { mode: "view", label: "Просмотр", hint: "Открыть без входа в MBOX" },
    { mode: "edit", label: "Редактирование", hint: "Менять ячейки без входа" },
  ];
  return <div className="wb-share" ref={boxRef}>
    <button type="button" className={shares.length ? "is-on" : undefined} onClick={() => setOpen((value) => !value)} title="Поделиться ссылкой" aria-expanded={open}><Share2 size={14} /></button>
    {open && <div className="wb-share-panel" role="dialog" aria-label="Ссылки на таблицу">
      {rows.map((row) => {
        const share = shares.find((item) => item.mode === row.mode);
        return <div key={row.mode} className="wb-share-row">
          <div className="wb-share-head"><b>{row.label}</b><span>{row.hint}</span></div>
          {share ? <>
            <div className="wb-share-link"><input readOnly value={linkOf(share)} onFocus={(event) => event.currentTarget.select()} aria-label={`Ссылка: ${row.label}`} /><button type="button" onClick={() => void copy(share)} title="Скопировать">{copied === row.mode ? <Check size={13} /> : <Copy size={13} />}</button></div>
            <div className="wb-share-actions"><span>{share.last_used_at ? `открывали ${formatSince(share.last_used_at)}` : "ещё не открывали"}</span><button type="button" disabled={busy === row.mode} onClick={() => void create(row.mode, true)}><RefreshCw size={12} /> Перевыпустить</button><button type="button" className="is-danger" disabled={busy === row.mode} onClick={() => void revoke(row.mode)}><X size={12} /> Отозвать</button></div>
          </> : <button type="button" className="wb-share-create" disabled={busy === row.mode} onClick={() => void create(row.mode)}><Link2 size={13} /> Создать ссылку</button>}
        </div>;
      })}
    </div>}
  </div>;
}

export function TableDocument({ tableId, data, tabs, tabKey, visible, onDirty }: {
  tableId: string;
  data: MboxData;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const cached = tablesStore.list.find((item) => item.id === tableId);
  const [table, setTable] = useState<TableDoc | null>(cached ?? null);
  const [book, setBook] = useState<Workbook | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [changeRevision, setChangeRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [shared, setShared] = useState(false);
  const importRef = useRef<HTMLInputElement | null>(null);

  const loadWorkbook = useCallback(async (source: TableDoc) => {
    const { Workbook: ExcelWorkbook } = await import("exceljs");
    const workbook = new ExcelWorkbook();
    if (source.content) await workbook.xlsx.load(base64ToArrayBuffer(source.content));
    else workbook.addWorksheet("Лист 1");
    setBook(workbook);
    setSheetName(workbook.worksheets[0]?.name ?? "");
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { table: loaded } = await fetchJson<{ table: TableDoc }>(`/api/mbox/tables/${tableId}`);
      setTable(loaded);
      patchListed(loaded);
      await loadWorkbook(loaded);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [loadWorkbook, tableId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, onDirty, tabKey]);
  useEffect(() => () => onDirty(tabKey, false), [onDirty, tabKey]);

  async function save() {
    if (!book || !table || saving) return;
    setSaving(true);
    setError("");
    try {
      const content = bytesToBase64(await book.xlsx.writeBuffer());
      const title = table.title || sheetName || "Таблица";
      const { table: updated } = await fetchJson<{ table: TableDoc }>(`/api/mbox/tables/${tableId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      setTable(updated);
      patchListed(updated);
      setDirty(false);
      tabs.pin(tabKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  // Таблица ведёт себя как заметка: после короткой паузы сохраняем снимок книги. Кнопка и Ctrl+S
  // остаются для немедленной записи, но закрытие/переключение вкладки больше не теряет правки.
  useEffect(() => {
    if (!dirty || !book || saving) return;
    const timer = window.setTimeout(() => { void save(); }, 800);
    return () => window.clearTimeout(timer);
  }, [changeRevision, dirty, book, saving]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function update(patch: Partial<TableDoc>) {
    if (!table) return;
    const { table: updated } = await fetchJson<{ table: TableDoc }>(`/api/mbox/tables/${tableId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    setTable(updated);
    patchListed(updated);
  }

  async function rename() {
    const title = await askText({ title: "Название таблицы", value: table?.title || "", confirmLabel: "Переименовать" });
    const nextTitle = title?.trim().slice(0, 200);
    if (!nextTitle || nextTitle === table?.title) return;
    await update({ title: nextTitle });
  }

  async function remove() {
    if (!(await askConfirm({ title: "Удалить таблицу?", confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/tables/${tableId}`, { method: "DELETE" });
    tablesStore.list = tablesStore.list.filter((item) => item.id !== tableId);
    emitTables();
    onDirty(tabKey, false);
    tabs.close(tabKey);
  }

  async function downloadExcel() {
    if (!book || !table) return;
    const blob = new Blob([await book.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(table.title || `table-${tableId}`).replace(/\.[a-z0-9]+$/i, "")}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importExcel(file: File) {
    if (!/\.(xlsx|xlsm)$/i.test(file.name)) return;
    if (dirty && !(await askConfirm({ title: "Заменить несохранённые правки импортом?", confirmLabel: "Импортировать" }))) return;
    const { Workbook: ExcelWorkbook } = await import("exceljs");
    const workbook = new ExcelWorkbook();
    await workbook.xlsx.load(base64ToArrayBuffer(dataUrlBase64(await readFileDataUrl(file))));
    setBook(workbook);
    setSheetName(workbook.worksheets[0]?.name ?? "");
    setTable((current) => current ? { ...current, title: file.name.replace(/\.[a-z0-9]+$/i, "") || current.title } : current);
    setDirty(true);
  }

  if (loading) return <div className="wb-doc-missing">Открываю таблицу…</div>;
  if (!table) return <div className="wb-doc-missing">Таблица не найдена.</div>;

  const projectName = data.projects.find((project) => project.id === table.project_id)?.name;
  const access = TABLE_ACCESS.find((item) => item.value === (table.access_level || "private")) ?? TABLE_ACCESS[0];
  const AccessIcon = access.value === "all" ? Globe2 : access.value === "project" ? Users : Lock;

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-note-status" title={`Изменено ${formatDateTime(table.updated_at)}`}>
            {error ? (
              <span className="wb-note-save is-error" role="alert"><AlertCircle size={13} aria-hidden="true" /> {error}</span>
            ) : saving ? (
              <span className="wb-note-save is-busy"><span className="wb-note-spinner" aria-hidden="true" /> Сохраняю…</span>
            ) : dirty ? (
              <span className="wb-note-save is-busy">Есть несохранённые правки</span>
            ) : (
              <span className="wb-note-save"><Check size={13} aria-hidden="true" /> Изменено {formatSince(table.updated_at)}</span>
            )}
            {table.pinned && <span className="wb-note-flag" title="Закреплена сверху списка"><Pin size={11} aria-hidden="true" /> Закреплена</span>}
            {shared && <span className="wb-note-flag" title="Есть ссылка для доступа без входа"><Link2 size={11} aria-hidden="true" /> По ссылке</span>}
          </span>
          <div className="wb-note-tools">
            <label className="wb-note-popup" title={`Кто видит: ${access.hint}`}>
              <AccessIcon size={13} aria-hidden="true" />
              <span>{access.label}</span>
              <ChevronDown size={12} aria-hidden="true" />
              <select value={access.value} onChange={(event) => void update({ access_level: event.target.value as TableAccess })} aria-label="Кто видит таблицу">
                {TABLE_ACCESS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="wb-note-popup" title="Проект таблицы">
              <FolderClosed size={13} aria-hidden="true" />
              <span className={projectName ? undefined : "is-muted"}>{projectName ?? "Без проекта"}</span>
              <ChevronDown size={12} aria-hidden="true" />
              <select value={table.project_id ?? ""} onChange={(event) => void update({ project_id: event.target.value || null })} aria-label="Проект таблицы">
                <option value="">Без проекта</option>
                {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <button type="button" className="wb-note-icon" disabled={!dirty || saving} onClick={() => void save()} title="Сохранить" aria-label="Сохранить"><Save size={14} /></button>
            <button type="button" className="wb-note-icon" onClick={() => void downloadExcel()} title="Экспорт в Excel (.xlsx)" aria-label="Экспорт в Excel"><Download size={14} /></button>
            <button type="button" className="wb-note-icon" onClick={() => importRef.current?.click()} title="Импорт из Excel (.xlsx)" aria-label="Импорт из Excel"><Upload size={14} /></button>
            <input ref={importRef} type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importExcel(file); event.target.value = ""; }} />
            <TableShareButton tableId={tableId} onSharedChange={setShared} />
            <button type="button" className={`wb-note-icon${menu ? " is-on" : ""}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.right - 220, y: rect.bottom + 4 }); }} aria-haspopup="menu" aria-expanded={Boolean(menu)} title="Ещё" aria-label="Ещё действия"><MoreHorizontal size={15} /></button>
          </div>
          {menu && (
            <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
              <div className="wb-note-menu">
                <button type="button" role="menuitem" onClick={() => { setMenu(null); void update({ pinned: !table.pinned }); }}>
                  <span>{table.pinned ? <PinOff size={14} /> : <Pin size={14} />}{table.pinned ? "Открепить" : "Закрепить сверху"}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenu(null); void rename(); }}>
                  <span><Pencil size={14} />Переименовать</span>
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenu(null); void load(); }}>
                  <span><RefreshCw size={14} />Перечитать с сервера</span>
                </button>
                <div className="wb-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); void remove(); }}>
                  <span><Trash2 size={14} />Удалить таблицу</span>
                </button>
              </div>
            </WbMenu>
          )}
        </>
      )}
    >
      {book && sheetName ? <Suspense fallback={<OctopusSpinner />}><SheetEditor book={book} sheetName={sheetName} onSheetName={setSheetName} onChange={() => { setDirty(true); setChangeRevision((value) => value + 1); }} visible={visible} /></Suspense> : <div className="wb-doc-missing">В книге нет листов.</div>}
    </DocShell>
  );
}
