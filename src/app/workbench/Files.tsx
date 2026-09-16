import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Code2, Copy, Download, Eye, FilePlus2, Monitor, Pencil, RefreshCw, Save, Smartphone, Trash2, Upload, X } from "lucide-react";
import type { MboxData } from "../../hooks/useMboxData";
import { fetchJson } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import type { Artifact } from "../../types";
import { MetaStrip } from "./docLayout";
import { renderDocument } from "./MemoryDocument";
import { usePersistentState, type TabsApi } from "./tabs";
import { hasDraft, useDraft } from "./uiMemory";

const ICONS = "/assets/icons/icons";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type FileKind = "html" | "markdown" | "json" | "code" | "text";

const EXTENSIONS: Record<FileKind, string> = { html: "html", markdown: "md", json: "json", code: "txt", text: "txt" };
const CODE_EXTENSIONS = ["css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh", "ps1", "sql", "yml", "yaml", "toml", "xml", "svg"];

function extensionOf(name: string) {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

export function fileKind(artifact: Pick<Artifact, "name" | "content" | "category">): FileKind {
  const ext = extensionOf(artifact.name);
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json") return "json";
  if (CODE_EXTENSIONS.includes(ext)) return "code";
  const head = artifact.content.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<!--") || /^<(div|section|header|footer|style|table|body)\b/.test(head)) return "html";
  if (head.startsWith("{") || head.startsWith("[")) {
    try { JSON.parse(artifact.content); return "json"; } catch { /* не JSON */ }
  }
  if (/^#{1,3}\s/m.test(artifact.content)) return "markdown";
  return "text";
}

const kindLabel: Record<FileKind, string> = { html: "HTML", markdown: "Markdown", json: "JSON", code: "Код", text: "Текст" };

export function fileIcon(kind: FileKind) {
  return kind === "markdown" || kind === "text" ? `${ICONS}/документы.png` : `${ICONS}/стек.png`;
}

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_UPLOAD_BYTES) return reject(new Error(`«${file.name}» больше 5 МБ`));
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      if (text.includes("\u0000")) reject(new Error(`«${file.name}» — бинарный файл, сюда кладутся только текстовые`));
      else resolve(text);
    };
    reader.onerror = () => reject(new Error(`Не удалось прочитать «${file.name}»`));
    reader.readAsText(file);
  });
}

function categoryForUpload(name: string) {
  const ext = extensionOf(name);
  if (ext === "html" || ext === "htm" || ext === "css") return "Design";
  if (ext === "md" || ext === "txt") return "Docs";
  if (ext === "json" || ext === "yml" || ext === "yaml" || ext === "toml") return "config";
  return ext ? "Code" : "Other";
}

type Group = { key: string; label: string; color?: string; categories: Array<{ name: string; files: Artifact[] }> };

export function FilesView({ data, tabs }: { data: MboxData; tabs: TabsApi }) {
  const [filter, setFilter] = usePersistentState("mbox.files.filter", "");
  const [collapsed, setCollapsed] = usePersistentState<string[]>("mbox.files.collapsed", []);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const needle = filter.trim().toLowerCase();

  const groups = useMemo<Group[]>(() => {
    const visible = data.artifacts.filter((file) => !needle
      || file.name.toLowerCase().includes(needle)
      || file.category.toLowerCase().includes(needle)
      || (needle.length >= 3 && file.content.toLowerCase().includes(needle)));
    const byProject = new Map<string, Artifact[]>();
    for (const file of visible) byProject.set(file.project_id ?? "", [...(byProject.get(file.project_id ?? "") ?? []), file]);
    return [...byProject.entries()]
      .map(([projectId, files]) => {
        const project = data.projects.find((item) => item.id === projectId);
        const categories = new Map<string, Artifact[]>();
        for (const file of files) categories.set(file.category || "Other", [...(categories.get(file.category || "Other") ?? []), file]);
        return {
          key: projectId || "none",
          label: project?.name ?? "Без проекта",
          color: project?.color,
          categories: [...categories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => ({ name, files: list.sort((a, b) => (a.name || "").localeCompare(b.name || "")) })),
        };
      })
      .sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.label.localeCompare(b.label)));
  }, [data.artifacts, data.projects, needle]);

  function toggle(key: string) {
    setCollapsed((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setUploading(true);
    setNotice("");
    const failed: string[] = [];
    let lastId = "";
    for (const file of list) {
      try {
        const content = await readTextFile(file);
        const response = await fetchJson<{ artifact: { id: string } }>("/api/mbox/artifacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: file.name, category: categoryForUpload(file.name), version: "v1", status: "uploaded", content, access_level: "agents", project_id: null }),
        });
        lastId = response.artifact.id;
      } catch (cause) {
        failed.push(cause instanceof Error ? cause.message : file.name);
      }
    }
    setUploading(false);
    data.reload();
    if (failed.length) setNotice(failed.join("; "));
    else setNotice(`Загружено: ${list.length}`);
    if (lastId && list.length === 1) tabs.open(`file:${lastId}`, true);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
  }

  return (
    <div
      className={dragOver ? "wb-view is-drop" : "wb-view"}
      onDragOver={(event) => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDragOver(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }}
      onDrop={onDrop}
    >
      <header className="wb-view-head">
        <span>Артефакты</span>
        <div className="wb-view-actions">
          <button type="button" onClick={() => tabs.open("file:new", true)} title="Новый файл"><FilePlus2 size={14} /></button>
          <button type="button" onClick={() => inputRef.current?.click()} title="Загрузить с диска (или перетащи файлы сюда)" disabled={uploading}><Upload size={14} /></button>
          <button type="button" onClick={data.reload} title="Обновить"><RefreshCw size={13} /></button>
        </div>
        <input ref={inputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) void upload(event.target.files); event.target.value = ""; }} />
      </header>
      <div className="wb-filter">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Имя, категория или текст внутри" onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }} />
        {filter && <button type="button" onClick={() => setFilter("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      {(notice || uploading) && <div className="wb-files-notice">{uploading ? "Загружаю…" : notice}<button type="button" onClick={() => setNotice("")} aria-label="Скрыть"><X size={12} /></button></div>}
      <div className="wb-view-body">
        {groups.map((group) => {
          const groupOpen = Boolean(needle) || !collapsed.includes(group.key);
          return (
            <ul className="wb-tree" key={group.key}>
              <li>
                <div className="wb-tree-row wb-tree-project" style={{ ["--project-color" as string]: group.color || "#5b6b66", ["--depth" as string]: 0 }} onClick={() => toggle(group.key)}>
                  <span className={groupOpen ? "wb-caret is-open" : "wb-caret"}>›</span>
                  <span className="wb-project-dot" />
                  <span className="wb-tree-label">{group.label}</span>
                  <span className="wb-tree-count">{group.categories.reduce((sum, category) => sum + category.files.length, 0)}</span>
                </div>
                {groupOpen && (
                  <ul className="wb-tree-children">
                    {group.categories.map((category) => {
                      const key = `${group.key}/${category.name}`;
                      const open = Boolean(needle) || !collapsed.includes(key);
                      return (
                        <li key={category.name}>
                          <div className="wb-tree-row" style={{ ["--depth" as string]: 1 }} onClick={() => toggle(key)}>
                            <span className={open ? "wb-caret is-open" : "wb-caret"}>›</span>
                            <img src={`${ICONS}/папка.png`} width={16} height={16} alt="" />
                            <span className="wb-tree-label">{category.name}</span>
                            <span className="wb-tree-count">{category.files.length}</span>
                          </div>
                          {open && (
                            <ul className="wb-tree-children">
                              {category.files.map((file) => {
                                const tabKey = `file:${file.id}`;
                                return (
                                  <li key={file.id}>
                                    <div
                                      className={tabs.active === tabKey ? "wb-tree-row is-active" : "wb-tree-row"}
                                      style={{ ["--depth" as string]: 2 }}
                                      onClick={() => tabs.open(tabKey)}
                                      onDoubleClick={() => tabs.open(tabKey, true)}
                                      title={`${file.name || "Без имени"} · ${file.version} · ${file.status}`}
                                    >
                                      <img src={fileIcon(fileKind(file))} width={16} height={16} alt="" />
                                      <span className="wb-tree-label">{file.name || `Без имени #${file.id}`}</span>
                                      <span className="wb-tree-hint">{formatBytes(file.memory_bytes)}</span>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            </ul>
          );
        })}
        {!groups.length && <p className="wb-empty">{needle ? "Ничего не найдено" : "Файлов пока нет — создай или перетащи сюда с диска"}</p>}
      </div>
      {dragOver && <div className="wb-drop-hint"><Upload size={22} />Отпусти, чтобы загрузить</div>}
    </div>
  );
}

type Draft = { name: string; category: string; version: string; status: string; projectId: string; content: string };
const EMPTY_DRAFT: Draft = { name: "", category: "Docs", version: "v1", status: "created", projectId: "", content: "" };

function draftOf(file: Artifact): Draft {
  return { name: file.name, category: file.category, version: file.version, status: file.status, projectId: file.project_id ?? "", content: file.content };
}

export function FileDocument({ fileId, data, tabs, tabKey, visible, onDirty }: {
  fileId: string;
  data: MboxData;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const isNew = fileId === "new";
  const file = data.artifacts.find((item) => item.id === fileId);
  const draftKey = `file:${fileId}`;
  const [editing, setEditing] = useState(() => isNew || hasDraft(draftKey));
  const [draft, setDraft, discardDraft] = useDraft<Draft>(draftKey, file ? draftOf(file) : EMPTY_DRAFT);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const kind = file ? fileKind(file) : fileKind({ name: draft.name, content: draft.content, category: draft.category });
  const [mode, setMode] = usePersistentState<"preview" | "code">(`mbox.file.mode.${kind}`, kind === "html" || kind === "markdown" ? "preview" : "code");
  const [viewport, setViewport] = usePersistentState<"desktop" | "mobile">("mbox.file.viewport", "desktop");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = useMemo(() => {
    if (!editing) return false;
    const base = file ? draftOf(file) : EMPTY_DRAFT;
    return (Object.keys(base) as Array<keyof Draft>).some((field) => base[field] !== draft[field]);
  }, [editing, file, draft]);

  useEffect(() => { onDirty(tabKey, dirty); }, [dirty, tabKey, onDirty]);
  useEffect(() => () => onDirty(tabKey, false), [tabKey, onDirty]);

  const startEdit = useCallback(() => {
    setDraft(file ? draftOf(file) : EMPTY_DRAFT);
    setEditing(true);
    tabs.pin(tabKey);
  }, [file, tabs, tabKey]);

  function cancelEdit() {
    if (dirty && !window.confirm("Отменить несохранённые правки?")) return;
    discardDraft();
    if (isNew) return tabs.close(tabKey);
    setEditing(false);
  }

  async function save() {
    if (saveState === "saving") return;
    if (!draft.name.trim()) { window.alert("Нужно имя файла"); return; }
    setSaveState("saving");
    const body = {
      name: draft.name.trim(),
      category: draft.category.trim() || "Other",
      version: draft.version.trim() || "v1",
      status: draft.status.trim() || "created",
      content: draft.content,
      project_id: draft.projectId || null,
      folder_id: file?.folder_id ?? null,
      access_level: file?.access_level ?? "agents",
    };
    try {
      if (isNew) {
        const response = await fetchJson<{ artifact: { id: string } }>("/api/mbox/artifacts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        discardDraft();
        onDirty(tabKey, false);
        data.reload();
        tabs.replace(tabKey, `file:${response.artifact.id}`);
        return;
      }
      await fetchJson(`/api/mbox/artifacts/${fileId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      discardDraft();
      setSaveState("idle");
      setEditing(false);
      data.reload();
    } catch {
      setSaveState("error");
    }
  }

  async function remove() {
    if (!file || !window.confirm(`Удалить файл «${file.name || `#${file.id}`}»?`)) return;
    await fetchJson(`/api/mbox/artifacts/${file.id}`, { method: "DELETE" });
    data.reload();
    tabs.close(tabKey);
  }

  function download() {
    if (!file) return;
    const name = extensionOf(file.name) ? file.name : `${file.name || `file-${file.id}`}.${EXTENSIONS[kind]}`;
    const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyContent() {
    if (!file) return;
    await navigator.clipboard.writeText(file.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function onEditorKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const target = event.currentTarget;
    const { selectionStart, selectionEnd, value } = target;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    setDraft((current) => ({ ...current, content: next }));
    window.requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = selectionStart + 2; });
  }

  useEffect(() => {
    if (!visible || !editing) return;
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!isNew && !file) return <div className="wb-doc-missing">{data.loading ? "Загрузка…" : `Файл #${fileId} не найден — возможно, его удалили.`}</div>;

  const project = data.projects.find((item) => item.id === (editing ? draft.projectId : file?.project_id));
  const shownContent = kind === "json" ? prettyJson(file?.content ?? "") : file?.content ?? "";
  const lines = shownContent.split("\n");
  const previewable = kind === "html" || kind === "markdown";

  return (
    <div className="wb-file">
      <div className="wb-doc-bar">
        <span className="wb-doc-crumbs">
          Файлы › {project?.name ?? "Без проекта"} › {editing ? draft.category || "…" : file?.category} › <b>{editing ? draft.name || "новый файл" : file?.name || `#${fileId}`}</b>
        </span>
        <div className="wb-doc-actions">
          {/* Переключатель есть и при правке: черновик HTML/markdown можно посмотреть, не сохраняя.
              Раньше он прятался на время правки — а незаконченная правка теперь открывается сразу. */}
          {previewable && (
            <div className="wb-segmented">
              <button type="button" className={mode === "preview" ? "is-on" : undefined} onClick={() => setMode("preview")}><Eye size={13} /> Просмотр</button>
              <button type="button" className={mode === "code" ? "is-on" : undefined} onClick={() => setMode("code")}>{editing ? <><Pencil size={13} /> Правка</> : <><Code2 size={13} /> Код</>}</button>
            </div>
          )}
          {kind === "html" && mode === "preview" && (
            <div className="wb-segmented">
              <button type="button" className={viewport === "desktop" ? "is-on" : undefined} onClick={() => setViewport("desktop")} title="Ширина ПК"><Monitor size={13} /></button>
              <button type="button" className={viewport === "mobile" ? "is-on" : undefined} onClick={() => setViewport("mobile")} title="Ширина телефона"><Smartphone size={13} /></button>
            </div>
          )}
          {editing ? (
            <>
              {saveState === "error" && <span className="wb-error">Не сохранилось</span>}
              <button type="button" onClick={cancelEdit}><X size={14} /> Отмена</button>
              <button type="button" className="is-primary" onClick={() => void save()} disabled={saveState === "saving"}><Save size={14} /> {saveState === "saving" ? "Сохраняю…" : "Сохранить"}</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => void copyContent()} title="Скопировать содержимое"><Copy size={14} />{copied ? " Скопировано" : ""}</button>
              <button type="button" onClick={download} title="Скачать"><Download size={14} /></button>
              <button type="button" onClick={startEdit}><Pencil size={14} /> Править</button>
              <button type="button" className="is-danger" onClick={() => void remove()} title="Удалить файл"><Trash2 size={14} /></button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div className="wb-inline-props is-bar">
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="имя файла, например header.html" autoFocus={isNew} title="Имя" />
          <select value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })} title="Проект">
            <option value="">без проекта</option>
            {data.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} list="wb-file-categories" placeholder="категория" title="Категория" />
          <datalist id="wb-file-categories">{[...new Set(data.artifacts.map((item) => item.category))].map((item) => <option key={item} value={item} />)}</datalist>
          <input value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} placeholder="версия" title="Версия" className="is-short" />
          <input value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })} placeholder="статус" title="Статус" className="is-short" />
        </div>
      ) : file && (
        <MetaStrip items={[
          kindLabel[kind],
          project ? <button type="button" className="wb-meta-link" onClick={() => tabs.open(`todos:${project.id}`, true)}>{project.name}</button> : "без проекта",
          file.category,
          `${file.version} · ${file.status}`,
          `${lines.length.toLocaleString("ru-RU")} строк`,
          formatBytes(file.memory_bytes),
        ]} />
      )}
      <div className="wb-file-main">
        {editing && previewable && mode === "preview" ? (
          kind === "html" ? (
            <div className={viewport === "mobile" ? "wb-html-preview is-mobile" : "wb-html-preview"}>
              <iframe title={draft.name || "Предпросмотр"} sandbox="allow-scripts" srcDoc={draft.content} />
            </div>
          ) : (
            <div className="wb-reading"><div className="wb-memory-body" onDoubleClick={() => setMode("code")}>{renderDocument(draft.content)}</div></div>
          )
        ) : editing ? (
          <textarea ref={textareaRef} className="wb-code-editor" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} onKeyDown={onEditorKey} spellCheck={false} placeholder="Содержимое файла" autoFocus={!isNew} />
        ) : mode === "preview" && kind === "html" ? (
          <div className={viewport === "mobile" ? "wb-html-preview is-mobile" : "wb-html-preview"}>
            <iframe title={file?.name || "Предпросмотр"} sandbox="allow-scripts" srcDoc={file?.content} />
          </div>
        ) : mode === "preview" && kind === "markdown" ? (
          <div className="wb-reading"><div className="wb-memory-body" onDoubleClick={startEdit}>{renderDocument(file?.content ?? "")}</div></div>
        ) : file?.content ? (
          <div className="wb-code-view" onDoubleClick={startEdit}>
            <div className="wb-code-gutter" aria-hidden="true">{lines.map((_, index) => <span key={index}>{index + 1}</span>)}</div>
            <pre>{shownContent}</pre>
          </div>
        ) : <div className="wb-doc-missing">Файл пустой. Двойной клик или «Править» — начать писать.</div>}
      </div>
    </div>
  );
}

function prettyJson(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
