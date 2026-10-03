import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronRight, FolderPlus, LayoutList, RefreshCw, Upload, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { uploadToStorage } from "../../lib/storageUpload";
import { askConfirm, askText } from "../../ui/askText";
import { FileTypeIcon, FolderIcon } from "./FileTypeIcon";
import { STORAGE_SHEET_TAB, isSheetFile } from "./StorageSheetDocument";
import { WbMenu } from "./WbMenu";
import { usePersistentState, type TabsApi } from "./tabs";
import {
  STORAGE_CHANGED_EVENT, createStorageFolder, deleteStorageObject, listStorage, notifyStorageChanged, openSheetTab, parentPrefix, storageLink, uploadLabel,
  type Listing, type StorageConfig, type UploadItem,
} from "./storageApi";

/**
 * Хранилище S3 деревом в боковой панели — так же, как «Папки»: корень-бакет, папки раскрываются на месте,
 * содержимое подгружается по требованию. Таблица с размером и датой и настройки подключения остались
 * во вкладке «Хранилище» (StorageDocument): дерево нужно, чтобы ходить по файлам, таблица — чтобы управлять.
 */

type Listed = { folders: string[]; objects: Listing["objects"]; next: string | null };
type Target = { type: "root" | "dir" | "file"; key: string };
type Row = Target & { depth: number };
type Menu = { x: number; y: number; target: Target };

const keyName = (key: string) => key.replace(/\/$/, "").split("/").pop() || key;

function cleanError(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function StorageView({ tabs }: { tabs: TabsApi }) {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [expanded, setExpanded] = usePersistentState<string[]>("mbox.storage.expanded", [""]);
  const [nodes, setNodes] = useState<Record<string, Listed>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Target | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [notice, setNotice] = useState("");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const uploading = uploads.some((item) => !item.done && !item.error);

  useEffect(() => {
    if (!uploading) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [uploading]);

  useEffect(() => {
    fetchJson<{ config: StorageConfig }>("/api/mbox/storage/config").then(({ config: loaded }) => setConfig(loaded)).catch(() => setNotice("Не удалось прочитать настройки хранилища"));
  }, []);

  const load = useCallback(async (prefix: string, more = false) => {
    try {
      const token = more ? nodesRef.current[prefix]?.next ?? undefined : undefined;
      const listing = await listStorage(prefix, token || undefined);
      setNodes((current) => {
        const previous = more ? current[prefix] : undefined;
        return { ...current, [prefix]: { folders: [...(previous?.folders ?? []), ...listing.folders], objects: [...(previous?.objects ?? []), ...listing.objects], next: listing.next_token } };
      });
      if (listing.labels) setLabels((current) => ({ ...current, ...listing.labels }));
      setErrors((current) => { const next = { ...current }; delete next[prefix]; return next; });
    } catch (cause) {
      setErrors((current) => ({ ...current, [prefix]: cleanError(cause) }));
    }
  }, []);

  const configured = Boolean(config?.configured);
  useEffect(() => {
    if (!configured) return;
    for (const prefix of expanded) if (!nodes[prefix] && !errors[prefix]) void load(prefix);
  }, [configured, expanded, nodes, errors, load]);

  // Таблица во вкладке или загрузка из другого места изменили хранилище — перечитываем раскрытые папки.
  useEffect(() => {
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "tree" || !configured) return;
      for (const prefix of expandedRef.current) void load(prefix);
    };
    window.addEventListener(STORAGE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(STORAGE_CHANGED_EVENT, onChanged);
  }, [configured, load]);

  const member = Boolean(config?.member);
  const folderLabel = (folder: string, parent: string) => labels[folder] || folder.slice(parent.length).replace(/\/$/, "");

  function toggle(prefix: string) {
    setExpanded((current) => (current.includes(prefix) ? current.filter((item) => item !== prefix) : [...current, prefix]));
  }

  function expand(prefix: string) {
    if (!expandedRef.current.includes(prefix)) setExpanded((current) => [...current, prefix]);
  }

  /** Куда класть новое: в выбранную папку, рядом с выбранным файлом или в корень. */
  function targetPrefix(target: Target | null) {
    if (!target || target.type === "root") return "";
    return target.type === "dir" ? target.key : target.key.slice(0, target.key.lastIndexOf("/") + 1);
  }

  const rootLocked = (prefix: string) => member && !prefix;

  async function refreshAround(prefix: string) {
    await load(prefix);
    notifyStorageChanged("tree");
  }

  async function uploadFiles(prefix: string, files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    if (rootLocked(prefix)) { setNotice("Откройте папку проекта — в корень участник файлы не загружает"); return; }
    expand(prefix);
    const offset = uploads.length;
    setUploads((current) => [...current, ...list.map((file) => ({ name: file.name, loaded: 0, total: file.size }))]);
    const patch = (index: number, change: Partial<UploadItem>) => setUploads((current) => current.map((item, position) => (position === offset + index ? { ...item, ...change } : item)));
    for (const [index, file] of list.entries()) {
      try {
        await uploadToStorage(`${prefix}${file.name}`, file, (loaded, mode) => setUploads((current) => current.map((item, position) => (position === offset + index ? { ...item, loaded, mode, startedAt: item.startedAt ?? Date.now() } : item))));
        patch(index, { loaded: file.size, done: true });
      } catch (cause) {
        patch(index, { error: cleanError(cause) });
      }
    }
    await refreshAround(prefix);
    window.setTimeout(() => setUploads((current) => current.filter((item) => item.error)), 2500);
  }

  async function createFolder(prefix: string) {
    setMenu(null);
    if (rootLocked(prefix)) { setNotice("Откройте папку проекта — в корне участник папки не создаёт"); return; }
    const name = await askText({ title: "Имя папки", confirmLabel: "Создать", validate: (value) => (/[\\:*?"<>|]/.test(value) ? "Нельзя использовать символы \\ : * ? \" < > |" : "") });
    if (!name?.trim()) return;
    try {
      await createStorageFolder(`${prefix}${name.trim().replace(/^\/+|\/+$/g, "")}`);
      expand(prefix);
      await refreshAround(prefix);
    } catch (cause) {
      setNotice(cleanError(cause));
    }
  }

  async function remove(target: Target) {
    setMenu(null);
    if (target.type === "root") return;
    const folder = target.type === "dir";
    if (!(await askConfirm({ title: folder ? `Удалить папку «${keyName(target.key)}» со всем содержимым?` : `Удалить «${keyName(target.key)}»?`, confirmLabel: "Удалить", danger: true }))) return;
    try {
      await deleteStorageObject(target.key);
      for (const tab of tabs.tabs) {
        const key = `${STORAGE_SHEET_TAB}${target.key}`;
        if (tab.key === key || (folder && tab.key.startsWith(key))) tabs.close(tab.key);
      }
      setSelected(null);
      if (folder) setExpanded((current) => current.filter((item) => !item.startsWith(target.key)));
      await refreshAround(folder ? parentPrefix(target.key) : target.key.slice(0, target.key.lastIndexOf("/") + 1));
    } catch (cause) {
      setNotice(cleanError(cause));
    }
  }

  async function openFile(key: string, download = false) {
    setMenu(null);
    if (!download && isSheetFile(key)) { openSheetTab(key); return; }
    try {
      const url = await storageLink(key, download);
      window.open(url, "_blank", "noopener");
    } catch (cause) {
      setNotice(cleanError(cause));
    }
  }

  async function copyLink(key: string, expires: number) {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(await storageLink(key, false, expires));
      setNotice(`Ссылка скопирована, действует ${expires >= 86400 ? `${expires / 86400} дн.` : `${expires / 3600} ч`}`);
    } catch (cause) {
      setNotice(cleanError(cause));
    }
  }

  function refresh() {
    for (const prefix of expandedRef.current) void load(prefix);
  }

  // Строки в том порядке, в каком они на экране, — для стрелок.
  function visibleRows(prefix: string, depth: number): Row[] {
    const node = nodes[prefix];
    if (!node) return [];
    const rows: Row[] = [];
    for (const folder of node.folders) {
      rows.push({ type: "dir", key: folder, depth });
      if (expanded.includes(folder)) rows.push(...visibleRows(folder, depth + 1));
    }
    for (const object of node.objects) rows.push({ type: "file", key: object.key, depth });
    return rows;
  }

  function onKey(event: KeyboardEvent) {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    const rows: Row[] = [{ type: "root", key: "", depth: 0 }, ...(expanded.includes("") ? visibleRows("", 1) : [])];
    const index = Math.max(0, rows.findIndex((row) => selected && row.type === selected.type && row.key === selected.key));
    const current = selected ? rows[index] : null;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1) * (selected ? 1 : 0)))];
      setSelected({ type: next.type, key: next.key });
    } else if (event.key === "ArrowRight" && current && current.type !== "file") {
      event.preventDefault();
      expand(current.key);
    } else if (event.key === "ArrowLeft" && current && current.type !== "file") {
      event.preventDefault();
      if (expanded.includes(current.key)) toggle(current.key);
      else if (current.type === "dir") setSelected({ type: parentPrefix(current.key) ? "dir" : "root", key: parentPrefix(current.key) });
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      if (current.type === "file") void openFile(current.key);
      else toggle(current.key);
    } else if (event.key === "Delete" && current && current.type !== "root") {
      event.preventDefault();
      void remove(current);
    }
  }

  function dragOver(event: DragEvent, prefix: string) {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = rootLocked(prefix) ? "none" : "copy";
    setDropTarget(prefix);
  }

  function drop(event: DragEvent, prefix: string) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    void uploadFiles(prefix, event.dataTransfer.files);
  }

  function rowClass(target: Target, extra = "") {
    return ["wb-tree-row", extra, selected && selected.type === target.type && selected.key === target.key ? "is-selected" : ""].filter(Boolean).join(" ");
  }

  function openMenu(event: MouseEvent, target: Target) {
    event.preventDefault();
    setSelected(target);
    setMenu({ x: event.clientX, y: event.clientY, target });
  }

  function renderNode(prefix: string, depth: number) {
    const style = { ["--depth" as string]: depth };
    if (errors[prefix]) return <li className="wb-tree-empty" style={style} role="alert">{errors[prefix]}</li>;
    const node = nodes[prefix];
    if (!node) return <li className="wb-tree-empty" style={style} role="status">…</li>;
    if (!node.folders.length && !node.objects.length) return <li className="wb-tree-empty" style={style}>пусто</li>;
    return (
      <>
        {node.folders.map((folder) => {
          const open = expanded.includes(folder);
          const target: Target = { type: "dir", key: folder };
          return (
            <li key={folder} className={dropTarget === folder ? "is-drop-target" : undefined} role="treeitem" aria-expanded={open} aria-selected={selected?.key === folder && selected.type === "dir"}>
              <div
                className={rowClass(target)}
                style={style}
                title={folder}
                onClick={() => { setSelected(target); toggle(folder); }}
                onContextMenu={(event) => openMenu(event, target)}
                onDragOver={(event) => dragOver(event, folder)}
                onDragLeave={() => setDropTarget((current) => (current === folder ? null : current))}
                onDrop={(event) => drop(event, folder)}
              >
                <ChevronRight className={open ? "wb-chevron is-open" : "wb-chevron"} size={14} aria-hidden="true" />
                <FolderIcon open={open} />
                <span className="wb-tree-label">{folderLabel(folder, prefix)}</span>
              </div>
              {open && <ul className="wb-tree-children" role="group">{renderNode(folder, depth + 1)}</ul>}
            </li>
          );
        })}
        {node.objects.map((object) => {
          const target: Target = { type: "file", key: object.key };
          const sheet = isSheetFile(object.key);
          return (
            <li key={object.key} role="treeitem" aria-selected={selected?.key === object.key && selected.type === "file"}>
              <div
                className={rowClass(target, tabs.active === `${STORAGE_SHEET_TAB}${object.key}` ? "is-active" : "")}
                style={style}
                title={`${object.key}\n${formatBytes(object.size)}${sheet ? "" : "\nДвойной щелчок — открыть"}`}
                onClick={() => { setSelected(target); if (sheet) openSheetTab(object.key); }}
                onDoubleClick={() => void openFile(object.key)}
                onContextMenu={(event) => openMenu(event, target)}
              >
                <span className="wb-chevron-space" />
                <FileTypeIcon name={object.key} />
                <span className="wb-tree-label">{keyName(object.key)}</span>
                <span className="wb-tree-hint">{formatBytes(object.size)}</span>
              </div>
            </li>
          );
        })}
        {node.next && (
          <li className="wb-tree-more" style={style}>
            <button type="button" onClick={() => void load(prefix, true)}>Показать ещё</button>
          </li>
        )}
      </>
    );
  }

  const header = (
    <header className="wb-view-head">
      <span>Хранилище S3</span>
      <div className="wb-view-actions">
        {configured && (
          <>
            <button type="button" onClick={() => inputRef.current?.click()} disabled={rootLocked(targetPrefix(selected))} title={rootLocked(targetPrefix(selected)) ? "Откройте папку проекта" : "Загрузить файлы"} aria-label="Загрузить файлы"><Upload size={14} /></button>
            <button type="button" onClick={() => void createFolder(targetPrefix(selected))} disabled={rootLocked(targetPrefix(selected))} title={rootLocked(targetPrefix(selected)) ? "Откройте папку проекта" : "Новая папка"} aria-label="Новая папка"><FolderPlus size={14} /></button>
            <button type="button" onClick={refresh} title="Обновить" aria-label="Обновить"><RefreshCw size={13} /></button>
          </>
        )}
        <button type="button" onClick={() => tabs.open("storage", true)} title="Таблица и настройки подключения" aria-label="Таблица и настройки подключения"><LayoutList size={14} /></button>
      </div>
    </header>
  );

  if (!config) {
    return <div className="wb-view">{header}<div className="wb-view-body"><p className="wb-empty" role="status">{notice || "Загрузка…"}</p></div></div>;
  }
  if (!config.configured) {
    return (
      <div className="wb-view">
        {header}
        <div className="wb-view-body">
          <div className="wb-session-empty">
            <p>{config.member ? "Хранилище ещё не подключено — это делает владелец MBOX." : "Подключите бакет Yandex Object Storage — файлы появятся здесь деревом."}</p>
            {!config.member && <button type="button" onClick={() => tabs.open("storage", true)}>Подключить хранилище</button>}
          </div>
        </div>
      </div>
    );
  }

  const rootOpen = expanded.includes("");
  const rootTarget: Target = { type: "root", key: "" };

  return (
    <div className="wb-view">
      {header}
      {notice && <div className="wb-files-notice" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="Скрыть"><X size={12} /></button></div>}
      {uploads.length > 0 && (
        <div className="wb-uploads">
          {uploads.map((item, index) => (
            <div key={index} className={["wb-upload", item.error ? "is-error" : "", item.mode === "proxy" && !item.done ? "is-indeterminate" : "", item.done ? "is-done" : ""].filter(Boolean).join(" ")}>
              <span>{item.name}</span>
              <i style={{ width: `${item.total ? Math.round((item.loaded / item.total) * 100) : 100}%` }} />
              <em>{uploadLabel(item)}</em>
            </div>
          ))}
        </div>
      )}
      <div
        className="wb-view-body"
        tabIndex={0}
        role="tree"
        aria-label={`Хранилище ${config.bucket}`}
        onKeyDown={onKey}
        onDragOver={(event) => dragOver(event, targetPrefix(selected))}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null); }}
        onDrop={(event) => drop(event, targetPrefix(selected))}
      >
        <ul className="wb-tree">
          <li className={dropTarget === "" ? "is-drop-target" : undefined} role="treeitem" aria-expanded={rootOpen} aria-selected={selected?.type === "root"}>
            <div
              className={rowClass(rootTarget, "wb-tree-project wb-root-row")}
              style={{ ["--depth" as string]: 0 }}
              title={config.bucket}
              onClick={() => { setSelected(rootTarget); toggle(""); }}
              onContextMenu={(event) => openMenu(event, rootTarget)}
              onDragOver={(event) => dragOver(event, "")}
              onDragLeave={() => setDropTarget((current) => (current === "" ? null : current))}
              onDrop={(event) => drop(event, "")}
            >
              <ChevronRight className={rootOpen ? "wb-chevron is-open" : "wb-chevron"} size={14} aria-hidden="true" />
              <span className="wb-tree-label">{config.bucket}</span>
            </div>
            {rootOpen && <ul className="wb-tree-children" role="group">{renderNode("", 1)}</ul>}
          </li>
        </ul>
      </div>
      <input ref={inputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) void uploadFiles(targetPrefix(selected), event.target.files); event.target.value = ""; }} />
      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.target.type !== "file" && (
            <>
              <button type="button" disabled={rootLocked(menu.target.key)} onClick={() => { setMenu(null); void createFolder(menu.target.key); }}>Новая папка</button>
              <button type="button" disabled={rootLocked(menu.target.key)} onClick={() => { setMenu(null); window.setTimeout(() => inputRef.current?.click(), 0); }}>Загрузить сюда…</button>
              <button type="button" onClick={() => { setMenu(null); void load(menu.target.key); }}>Обновить</button>
            </>
          )}
          {menu.target.type === "file" && (
            <>
              <button type="button" onClick={() => void openFile(menu.target.key)}>{isSheetFile(menu.target.key) ? "Открыть таблицу в редакторе" : "Открыть в новом окне"}</button>
              <button type="button" onClick={() => void openFile(menu.target.key, true)}>Скачать</button>
              <div className="wb-menu-sep" />
              <button type="button" onClick={() => void copyLink(menu.target.key, 3600)}>Копировать ссылку на 1 час</button>
              <button type="button" onClick={() => void copyLink(menu.target.key, 7 * 86400)}>Копировать ссылку на 7 дней</button>
            </>
          )}
          {menu.target.type !== "root" && (
            <>
              <div className="wb-menu-sep" />
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(menu.target.key); setMenu(null); }}>Копировать путь</button>
              <button type="button" className="is-danger" onClick={() => void remove(menu.target)}>Удалить<kbd>Del</kbd></button>
            </>
          )}
        </WbMenu>
      )}
    </div>
  );
}
