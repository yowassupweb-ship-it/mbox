import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { Code2, Copy, Download, ExternalLink, Eye, FilePlus2, FileText, FolderInput, FolderPlus, Monitor, Pencil, RefreshCw, Save, Smartphone, Trash2, Upload, X } from "lucide-react";
import type { MboxData } from "../../hooks/useMboxData";
import { fetchJson } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import type { Artifact } from "../../types";
import { MetaStrip } from "./docLayout";
import { renderDocument } from "./MemoryDocument";
import { usePersistentState, type TabsApi } from "./tabs";
import { hasDraft, useDraft } from "./uiMemory";
import { CodeEditor } from "./CodeEditor";
import { highlightCode, languageOf, type CodeLanguage } from "./codeHighlight";
import { MarkdownToolbar, markdownShortcut } from "./MarkdownToolbar";
import { FileTypeIcon, FolderIcon } from "./FileTypeIcon";
import { askConfirm, askText, showNotice } from "../../ui/askText";
import { WbMenu } from "./WbMenu";
import { Crumbs, reveal } from "./Crumbs";
import { pressable } from "../../ui/pressable";
import { patchNow, removeNow } from "../../lib/optimistic";
import { companyLogo, initials, isCompanyHome } from "./projects/projectFields";

const PROJECT_ICONS = "/assets/icons/project";
const FILE_ICONS = "/assets/icons/files";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Язык подсветки артефакта: по расширению имени, иначе по виду содержимого. */
function codeLanguage(kind: FileKind, name: string): CodeLanguage {
  const byName = languageOf(name || "");
  if (byName !== "plain") return byName;
  return kind === "html" ? "html" : kind === "markdown" ? "markdown" : kind === "json" ? "json" : "plain";
}

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

export function fileIcon(kind: FileKind, name = "") {
  const ext = extensionOf(name);
  if (/^(png|jpe?g|gif|webp|bmp|ico|avif|svg|tiff?)$/.test(ext)) return `${FILE_ICONS}/image-file.png`;
  if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(ext)) return `${FILE_ICONS}/archive-file.png`;
  if (/^(url|webloc|lnk)$/.test(ext)) return `${FILE_ICONS}/link-file.png`;
  if (/^(csv|tsv|xls|xlsx|ods)$/.test(ext)) return `${FILE_ICONS}/table-file.png`;
  if (/^(ppt|pptx|key|odp)$/.test(ext)) return `${FILE_ICONS}/presentation-file.png`;
  if (ext === "pdf") return `${FILE_ICONS}/pdf-file.png`;
  if (/^(eml|msg|mbox)$/.test(ext)) return `${FILE_ICONS}/email-file.png`;
  if (/^(html?|mhtml)$/.test(ext) || kind === "html") return `${FILE_ICONS}/browser-file.png`;
  if (kind === "code" || kind === "json") return `${FILE_ICONS}/code-file.png`;
  return `${PROJECT_ICONS}/documents.png`;
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

/** Меню по правой кнопке в дереве артефактов: у файла, у категории (папки) и у проекта — свои действия. */
type FilesMenu =
  | { kind: "file"; file: Artifact; x: number; y: number }
  | { kind: "category"; group: Group; name: string; files: Artifact[]; x: number; y: number };

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function FilesView({ data, tabs }: { data: MboxData; tabs: TabsApi }) {
  const [filter, setFilter] = usePersistentState("mbox.files.filter", "");
  const [collapsed, setCollapsed] = usePersistentState<string[]>("mbox.files.collapsed", []);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const needle = filter.trim().toLowerCase();
  const [menu, setMenu] = useState<FilesMenu | null>(null);
  const [dragged, setDragged] = useState<Artifact | null>(null);
  const [dropKey, setDropKey] = useState("");

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

  /** Перенос файла: в проект (null — без проекта) и/или в категорию. Проект шлём всегда явно. */
  async function moveFile(file: Artifact, target: { projectId: string | null; category?: string }) {
    const sameProject = (file.project_id ?? null) === target.projectId;
    if (sameProject && (!target.category || target.category === file.category)) return;
    await patchNow(data, "artifacts", file.id, { project_id: target.projectId, ...(target.category ? { category: target.category } : {}) });
  }

  async function renameFile(file: Artifact) {
    const name = (await askText({ title: "Имя файла", value: file.name, confirmLabel: "Переименовать" }))?.trim();
    if (!name || name === file.name) return;
    await patchNow(data, "artifacts", file.id, { name });
  }

  async function duplicateFile(file: Artifact) {
    const dot = file.name.lastIndexOf(".");
    const name = dot > 0 ? `${file.name.slice(0, dot)} (копия)${file.name.slice(dot)}` : `${file.name} (копия)`;
    const { artifact } = await fetchJson<{ artifact: { id: string } }>("/api/mbox/artifacts", json("POST", { name, category: file.category, version: file.version, status: file.status, content: file.content, access_level: "agents", project_id: file.project_id ?? null }));
    data.reload();
    tabs.open(`file:${artifact.id}`, true);
  }

  function downloadFile(file: Artifact) {
    const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name || `file-${file.id}.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function removeFiles(files: Artifact[], title: string) {
    if (!(await askConfirm({ title, message: files.length > 1 ? `Файлов: ${files.length}. Вернуть их будет нельзя.` : "Вернуть файл будет нельзя.", confirmLabel: "Удалить", danger: true }))) return;
    files.forEach((file) => tabs.close(`file:${file.id}`));
    await removeNow(data, "artifacts", files.map((file) => file.id));
  }

  async function renameCategory(group: Group, name: string, files: Artifact[]) {
    const next = (await askText({ title: "Название папки", value: name, confirmLabel: "Переименовать" }))?.trim();
    if (!next || next === name) return;
    if (!group) return;
    await Promise.all(files.map((file) => patchNow(data, "artifacts", file.id, { category: next })));
  }

  async function newCategoryFor(file: Artifact) {
    const name = (await askText({ title: "Новая папка", placeholder: "Название папки", confirmLabel: "Переместить" }))?.trim();
    if (name) await moveFile(file, { projectId: file.project_id ?? null, category: name });
  }

  async function moveMany(files: Artifact[], projectId: string | null) {
    await Promise.all(files.map((file) => patchNow(data, "artifacts", file.id, { project_id: projectId })));
  }

  /** Перетаскивание файла в дереве: на папку — в эту папку этого проекта, на проект — в проект с той же папкой. */
  function dropProps(key: string, target: { projectId: string | null; category?: string }) {
    return {
      onDragOver: (event: DragEvent) => { if (dragged) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropKey(key); } },
      onDragLeave: () => setDropKey((current) => (current === key ? "" : current)),
      onDrop: (event: DragEvent) => {
        if (!dragged) return;
        event.preventDefault();
        event.stopPropagation();
        setDropKey("");
        const file = dragged;
        setDragged(null);
        void moveFile(file, target);
      },
    };
  }

  const countOf = (group: Group) => group.categories.reduce((sum, category) => sum + category.files.length, 0);

  // Компании и их проекты: проект-хранилище компании («записи компании») — сразу папками под компанией.
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const companySections = [...data.companies]
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map((company) => {
      const owned = data.projects.filter((project) => project.company_id === company.id);
      const homeProject = owned.find((project) => isCompanyHome(project));
      return {
        company,
        home: homeProject ? byKey.get(homeProject.id) ?? null : null,
        projects: owned.filter((project) => project !== homeProject).map((project) => byKey.get(project.id)).filter((group): group is Group => Boolean(group)),
      };
    })
    .filter((section) => section.home || section.projects.length);
  const placed = new Set(companySections.flatMap((section) => [section.home?.key, ...section.projects.map((group) => group.key)]).filter(Boolean));
  const looseGroups = groups.filter((group) => !placed.has(group.key));

  function renderFile(file: Artifact, depth: number) {
    const tabKey = `file:${file.id}`;
    return (
      <li key={file.id}>
        <div
          className={`wb-tree-row${tabs.active === tabKey ? " is-active" : ""}${dragged?.id === file.id ? " is-dragging" : ""}`}
          style={{ ["--depth" as string]: depth }}
          onClick={() => tabs.open(tabKey)}
          onDoubleClick={() => tabs.open(tabKey, true)}
          onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "file", file, x: event.clientX, y: event.clientY }); }}
          draggable
          onDragStart={(event) => { setDragged(file); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", file.name); }}
          onDragEnd={() => { setDragged(null); setDropKey(""); }}
          title={`${file.name || "Без имени"} · ${file.version} · ${file.status} · ПКМ — действия, перетащите в другую папку или проект`}
        >
          <FileTypeIcon name={file.name} />
          <span className="wb-tree-label">{file.name || `Без имени #${file.id}`}</span>
          <span className="wb-tree-hint">{formatBytes(file.memory_bytes)}</span>
        </div>
      </li>
    );
  }

  function renderCategories(group: Group, depth: number) {
    return group.categories.map((category) => {
      const key = `${group.key}/${category.name}`;
      const open = Boolean(needle) || !collapsed.includes(key);
      return (
        <li key={key}>
          <div
            className={`wb-tree-row${dropKey === key ? " is-drop-target" : ""}`}
            style={{ ["--depth" as string]: depth }}
            {...pressable(() => toggle(key), open)}
            {...dropProps(key, { projectId: group.key === "none" ? null : group.key, category: category.name })}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "category", group, name: category.name, files: category.files, x: event.clientX, y: event.clientY }); }}
          >
            <span className={open ? "wb-caret is-open" : "wb-caret"}>›</span>
            <FolderIcon open={open} />
            <span className="wb-tree-label">{category.name}</span>
            <span className="wb-tree-count">{category.files.length}</span>
          </div>
          {open && <ul className="wb-tree-children">{category.files.map((file) => renderFile(file, depth + 1))}</ul>}
        </li>
      );
    });
  }

  function renderGroup(group: Group, depth: number) {
    const open = Boolean(needle) || !collapsed.includes(group.key);
    return (
      <li key={group.key}>
        <div className={`wb-tree-row wb-tree-project${dropKey === group.key ? " is-drop-target" : ""}`} style={{ ["--project-color" as string]: group.color || "var(--state-off)", ["--depth" as string]: depth }} {...pressable(() => toggle(group.key), open)} {...dropProps(group.key, { projectId: group.key === "none" ? null : group.key })}>
          <span className={open ? "wb-caret is-open" : "wb-caret"}>›</span>
          <span className="wb-project-dot" />
          <span className="wb-tree-label">{group.label}</span>
          <span className="wb-tree-count">{countOf(group)}</span>
        </div>
        {open && <ul className="wb-tree-children">{renderCategories(group, depth + 1)}</ul>}
      </li>
    );
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
          <button type="button" onClick={data.reload} title="Обновить" aria-label="Обновить"><RefreshCw size={13} /></button>
        </div>
        <input ref={inputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) void upload(event.target.files); event.target.value = ""; }} />
      </header>
      <div className="wb-filter">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Имя, категория или текст внутри" onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }} />
        {filter && <button type="button" onClick={() => setFilter("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      {(notice || uploading) && <div className="wb-files-notice">{uploading ? "Загружаю…" : notice}<button type="button" onClick={() => setNotice("")} aria-label="Скрыть"><X size={12} /></button></div>}
      <div className="wb-view-body">
        {/* Та же структура, что в «Проектах»: компании → записи компании и её проекты → папки → файлы. */}
        {companySections.length > 0 && <h3 className="wb-tree-group-label">Компании</h3>}
        {companySections.map(({ company, home, projects: projectGroups }) => {
          const key = `company:${company.id}`;
          const open = Boolean(needle) || !collapsed.includes(key);
          const count = [home, ...projectGroups].reduce((sum, group) => sum + (group ? countOf(group) : 0), 0);
          const logo = companyLogo(company);
          return (
            <ul className="wb-tree" key={key}>
              <li>
                <div
                  className={`wb-tree-row wb-tree-company${dropKey === key ? " is-drop-target" : ""}`}
                  style={{ ["--company-color" as string]: company.color && company.color !== "#2c2c2e" ? company.color : "var(--text-muted)", ["--depth" as string]: 0 }}
                  {...pressable(() => toggle(key), open)}
                  {...(home ? dropProps(key, { projectId: home.key }) : {})}
                >
                  <span className={open ? "wb-caret is-open" : "wb-caret"}>›</span>
                  <span className={`wb-company-mark${logo ? " has-logo" : ""}`} aria-hidden="true">{logo ? <img src={logo} alt="" /> : initials(company.name)}</span>
                  <span className="wb-tree-label">{company.name}</span>
                  <span className="wb-tree-count">{count}</span>
                </div>
                {open && (
                  <ul className="wb-tree-children">
                    {home && renderCategories(home, 1)}
                    {projectGroups.map((group) => renderGroup(group, 1))}
                  </ul>
                )}
              </li>
            </ul>
          );
        })}
        {looseGroups.length > 0 && companySections.length > 0 && <h3 className="wb-tree-group-label">Без компании</h3>}
        {looseGroups.map((group) => <ul className="wb-tree" key={group.key}>{renderGroup(group, 0)}</ul>)}
        {!groups.length && <p className="wb-empty">{needle ? "Ничего не найдено" : "Файлов пока нет — создай или перетащи сюда с диска"}</p>}
      </div>
      {dragOver && <div className="wb-drop-hint"><Upload size={22} />Отпусти, чтобы загрузить</div>}
      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu wb-tree-ctx" onClick={() => setMenu(null)}>
            {menu.kind === "file" ? (() => {
              const file = menu.file;
              const projectId = file.project_id ?? null;
              const siblings = [...new Set(data.artifacts.filter((item) => (item.project_id ?? null) === projectId).map((item) => item.category || "Other"))].filter((name) => name !== file.category).sort();
              return (
                <>
                  <div className="wb-note-menu-label">{file.name || `Файл #${file.id}`}</div>
                  <button type="button" role="menuitem" onClick={() => tabs.open(`file:${file.id}`, true)}><ExternalLink size={15} aria-hidden="true" />Открыть</button>
                  <button type="button" role="menuitem" onClick={() => void renameFile(file)}><Pencil size={15} aria-hidden="true" />Переименовать</button>
                  <button type="button" role="menuitem" onClick={() => void duplicateFile(file)}><Copy size={15} aria-hidden="true" />Дублировать</button>
                  <button type="button" role="menuitem" onClick={() => downloadFile(file)}><Download size={15} aria-hidden="true" />Скачать</button>
                  <div className="wb-menu-sep" role="separator" />
                  <div className="wb-note-menu-label">Переместить в папку</div>
                  {siblings.slice(0, 8).map((name) => (
                    <button key={name} type="button" role="menuitem" onClick={() => void moveFile(file, { projectId, category: name })}><FolderInput size={15} aria-hidden="true" />{name}</button>
                  ))}
                  <button type="button" role="menuitem" onClick={() => void newCategoryFor(file)}><FolderPlus size={15} aria-hidden="true" />Новая папка…</button>
                  <div className="wb-menu-sep" role="separator" />
                  <div className="wb-note-menu-label">Переместить в проект</div>
                  {data.projects.filter((project) => project.id !== projectId && project.status !== "archived").map((project) => (
                    <button key={project.id} type="button" role="menuitem" onClick={() => void moveFile(file, { projectId: project.id })}><span className="wb-project-dot" style={{ ["--project-color" as string]: project.color || "var(--state-off)" }} aria-hidden="true" />{project.name}</button>
                  ))}
                  {projectId && <button type="button" role="menuitem" onClick={() => void moveFile(file, { projectId: null })}><FolderInput size={15} aria-hidden="true" />Без проекта</button>}
                  <div className="wb-menu-sep" role="separator" />
                  <button type="button" role="menuitem" className="is-danger" onClick={() => void removeFiles([file], `Удалить «${file.name || `файл #${file.id}`}»?`)}><Trash2 size={15} aria-hidden="true" />Удалить</button>
                </>
              );
            })() : (
              <>
                <div className="wb-note-menu-label">{menu.name} · {menu.files.length}</div>
                <button type="button" role="menuitem" onClick={() => void renameCategory(menu.group, menu.name, menu.files)}><Pencil size={15} aria-hidden="true" />Переименовать папку</button>
                <div className="wb-menu-sep" role="separator" />
                <div className="wb-note-menu-label">Переместить папку в проект</div>
                {data.projects.filter((project) => project.id !== menu.group.key && project.status !== "archived").map((project) => (
                  <button key={project.id} type="button" role="menuitem" onClick={() => void moveMany(menu.files, project.id)}><span className="wb-project-dot" style={{ ["--project-color" as string]: project.color || "var(--state-off)" }} aria-hidden="true" />{project.name}</button>
                ))}
                <div className="wb-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="is-danger" onClick={() => void removeFiles(menu.files, `Удалить папку «${menu.name}» вместе с файлами?`)}><Trash2 size={15} aria-hidden="true" />Удалить папку</button>
              </>
            )}
          </div>
        </WbMenu>
      )}
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
  const [wordState, setWordState] = useState<"idle" | "loading" | "error">("idle");
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

  async function cancelEdit() {
    if (dirty && !(await askConfirm({ title: "Отменить несохранённые правки?", confirmLabel: "Отменить правки", danger: true }))) return;
    discardDraft();
    if (isNew) return tabs.close(tabKey);
    setEditing(false);
  }

  async function save() {
    if (saveState === "saving") return;
    if (!draft.name.trim()) { showNotice("Нужно имя файла"); return; }
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
    if (!file || !(await askConfirm({ title: `Удалить файл «${file.name || `#${file.id}`}»?`, confirmLabel: "Удалить", danger: true }))) return;
    tabs.close(tabKey);
    await removeNow(data, "artifacts", file.id);
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

  /**
   * Word-версию собирает сервер (server/docx.mjs): конвертер один и тот же и для этой кнопки, и для
   * навыков, которые кладут свой результат в артефакты — документ в MBOX и документ у человека на
   * диске получаются одинаковыми.
   */
  async function downloadWord() {
    if (!file) return;
    setWordState("loading");
    try {
      const response = await fetch(`/api/mbox/artifacts/${file.id}/docx`);
      if (!response.ok) throw new Error(`request_failed:${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${file.name.replace(/\.[a-z0-9]+$/i, "") || `file-${file.id}`}.docx`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setWordState("idle");
    } catch {
      setWordState("error");
    }
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

  if (!isNew && !file) return <div className="wb-doc-missing">{data.loading ? <OctopusSpinner /> : `Файл #${fileId} не найден — возможно, его удалили.`}</div>;

  const project = data.projects.find((item) => item.id === (editing ? draft.projectId : file?.project_id));
  const shownContent = kind === "json" ? prettyJson(file?.content ?? "") : file?.content ?? "";
  const lines = shownContent.split("\n");
  const previewable = kind === "html" || kind === "markdown";

  return (
    <div className="wb-file">
      <div className="wb-doc-bar">
        <Crumbs items={[
          { label: "Артефакты", onClick: () => reveal("files") },
          project ? { label: project.name, onClick: () => reveal("explorer", project.id), title: "Показать проект в дереве" } : { label: "Без проекта", onClick: () => reveal("files") },
          { label: (editing ? draft.category : file?.category) || "…", onClick: () => reveal("files") },
          { label: <b>{editing ? draft.name || "новый файл" : file?.name || `#${fileId}`}</b> },
        ]} />
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
              <button type="button" onClick={download} title="Скачать" aria-label="Скачать"><Download size={14} /></button>
              <button type="button" onClick={() => void downloadWord()} disabled={wordState === "loading"} title="Скачать в Word (.docx)"><FileText size={14} /> {wordState === "error" ? "Не вышло" : "Word"}</button>
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
          <>
          {kind === "markdown" && <MarkdownToolbar targetRef={textareaRef} />}
          <CodeEditor textareaRef={textareaRef} value={draft.content} onChange={(content) => setDraft({ ...draft, content })} language={codeLanguage(kind, draft.name)} onKeyDown={(event) => { if (kind === "markdown" && markdownShortcut(event)) return; onEditorKey(event); }} placeholder="Содержимое файла" autoFocus={!isNew} />
          </>
        ) : mode === "preview" && kind === "html" ? (
          <div className={viewport === "mobile" ? "wb-html-preview is-mobile" : "wb-html-preview"}>
            <iframe title={file?.name || "Предпросмотр"} sandbox="allow-scripts" srcDoc={file?.content} />
          </div>
        ) : mode === "preview" && kind === "markdown" ? (
          <div className="wb-reading"><div className="wb-memory-body" onDoubleClick={startEdit}>{renderDocument(file?.content ?? "")}</div></div>
        ) : file?.content ? (
          <div className="wb-code-view" onDoubleClick={startEdit}>
            <div className="wb-code-gutter" aria-hidden="true">{lines.map((_, index) => <span key={index}>{index + 1}</span>)}</div>
            <pre dangerouslySetInnerHTML={{ __html: highlightCode(shownContent, codeLanguage(kind, file.name)) }} />
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
