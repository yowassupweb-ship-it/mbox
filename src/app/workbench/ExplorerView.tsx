import { useMemo, useState, type DragEvent, type MouseEvent, useEffect } from "react";
import { Building2, ChevronRight, ChevronsDownUp, ExternalLink, FolderPlus, ListChecks, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { projectEntityKinds, type ProjectEntityKind } from "../../features/tree/entityKinds";
import type { MboxData } from "../../hooks/useMboxData";
import { isLeaseLive } from "../../lib/agents";
import { fetchJson } from "../../lib/api";
import { askConfirm, askText, showNotice } from "../../ui/askText";
import { todoPriorityLabel, todoStatusLabel } from "../../lib/labels";
import { projectMemoryMatches } from "../../lib/memory";
import { positionBetween, projectPosition, sortTodos } from "../../lib/tree";
import { autoDetectEnabled, entitySummary, MANDATORY_ENTITIES, OPTIONAL_ENTITIES } from "../../pages/Projects";
import type { Company, Project } from "../../types";
import { FileTypeIcon } from "./FileTypeIcon";
import { usePersistentState, type TabsApi } from "./tabs";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { folderGlyph, TreeGlyph } from "./TreeGlyph";
import { REVEAL_EVENT, type RevealDetail } from "./Crumbs";
import { pressable } from "../../ui/pressable";
import { WbMenu } from "./WbMenu";
import { companyLogo, initials, isCompanyHome, projectStats } from "./projects/projectFields";
import { patchNow, removeNow } from "../../lib/optimistic";

const CLOSED_STATUSES = ["done", "archived"];
const TODO_STATUSES = ["open", "next", "doing", "review", "blocked", "done"];

type Props = {
  data: MboxData;
  tabs: TabsApi;
  isOwner: boolean;
  onProjectContext: (project: Project, position: { x: number; y: number }) => void;
};

/** Что под правой кнопкой: у каждой строки дерева своё меню (раньше было только у проекта, остальное не удалялось). */
type RowMenu =
  | { kind: "company"; company: Company; x: number; y: number }
  | { kind: "todo"; id: string; title: string; status: string; x: number; y: number }
  | { kind: "entity"; project: Project; entity: ProjectEntityKind; x: number; y: number }
  | { kind: "file"; id: string; name: string; x: number; y: number }
  | { kind: "folder"; project: Project; id: string; name: string; x: number; y: number }
  | { kind: "add"; x: number; y: number };

/**
 * Дерево «Проекты»: компании → проекты → задачи и разделы. Компания — отдельный узел со своей карточкой
 * (company:<id>), проект — со своей страницей (project:<id>). Проекты без компании идут отдельной группой,
 * архивные — свёрнутым «Архивом» внизу. Проект перетаскивается на компанию — переезжает в неё.
 */
export function ExplorerView({ data, tabs, isOwner, onProjectContext }: Props) {
  const [filter, setFilter] = usePersistentState("mbox.explorer.filter", "");
  const [expanded, setExpanded] = usePersistentState<string[]>("mbox.explorer.expanded", []);
  const [showDone, setShowDone] = usePersistentState("mbox.explorer.showDone", false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);

  const ordered = useMemo(
    () => [...data.projects].sort((a, b) => projectPosition(a, data.projects.indexOf(a)) - projectPosition(b, data.projects.indexOf(b))),
    [data.projects],
  );

  const needle = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return null;
    const result = new Map<string, Set<string>>();
    for (const project of ordered) {
      const company = data.companies.find((item) => item.id === project.company_id);
      const todoHits = new Set(project.todos.filter((todo) => todo.title.toLowerCase().includes(needle) || todo.id === needle.replace("#", "")).map((todo) => todo.id));
      if (project.name.toLowerCase().includes(needle) || company?.name.toLowerCase().includes(needle) || todoHits.size) result.set(project.id, todoHits);
    }
    return result;
  }, [needle, ordered, data.companies]);

  const visible = matches ? ordered.filter((project) => matches.has(project.id)) : ordered;
  // Записи компании — не проект: они показываются под узлом своей компании, а не в списках и не в архиве.
  const live = visible.filter((project) => project.status !== "archived" && !isCompanyHome(project));
  const archived = visible.filter((project) => project.status === "archived" && !isCompanyHome(project));
  const companies = useMemo(() => [...data.companies].sort((a, b) => a.name.localeCompare(b.name, "ru")), [data.companies]);
  const companyIds = new Set(companies.map((company) => company.id));
  const loose = live.filter((project) => !project.company_id || !companyIds.has(project.company_id));
  const shownCompanies = companies.filter((company) => !matches || company.name.toLowerCase().includes(needle) || visible.some((project) => project.company_id === company.id && (project.status !== "archived" || isCompanyHome(project))));

  useEffect(() => {
    const listener = (event: Event) => {
      const projectId = (event as CustomEvent<RevealDetail>).detail.projectId;
      if (!projectId) return;
      const project = data.projects.find((item) => item.id === projectId);
      const keys = [`project:${projectId}`, ...(project?.company_id ? [`company:${project.company_id}`] : [])];
      setExpanded((current) => [...current, ...keys.filter((key) => !current.includes(key))]);
      window.setTimeout(() => document.querySelector(`[data-project-row="${projectId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    };
    window.addEventListener(REVEAL_EVENT, listener);
    return () => window.removeEventListener(REVEAL_EVENT, listener);
  }, [setExpanded, data.projects]);

  const isOpen = (key: string) => Boolean(matches) || expandedSet.has(key);
  const toggle = (key: string) => setExpanded((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  const expand = (key: string) => setExpanded((current) => (current.includes(key) ? current : [...current, key]));
  const json = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  async function reorder(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const rest = ordered.filter((item) => item.id !== draggedId);
    const index = rest.findIndex((item) => item.id === targetId);
    const project = ordered.find((item) => item.id === draggedId);
    const target = ordered.find((item) => item.id === targetId);
    if (index < 0 || !project || !target) return;
    const before = rest[index - 1];
    const after = rest[index];
    const position = positionBetween(
      before ? projectPosition(before, data.projects.indexOf(before)) : undefined,
      after ? projectPosition(after, data.projects.indexOf(after)) : undefined,
    );
    // Перетащили к проекту другой компании — проект переезжает туда же (это может только владелец).
    const moveCompany = isOwner && (project.company_id || null) !== (target.company_id || null);
    await fetchJson(`/api/mbox/projects/${draggedId}`, json("PATCH", { props: { ...project.props, position }, ...(moveCompany ? { company_id: target.company_id || null } : {}) }));
    data.reload();
  }

  async function moveToCompany(projectId: string, companyId: string | null) {
    const project = data.projects.find((item) => item.id === projectId);
    if (!project || (project.company_id || null) === companyId) return;
    if (companyId) expand(`company:${companyId}`);
    await patchNow(data, "projects", projectId, { company_id: companyId });
  }

  async function createProject(companyId: string | null = null) {
    const company = companyId ? data.companies.find((item) => item.id === companyId) : null;
    const name = (await askText({ title: company ? `Новый проект в «${company.name}»` : "Новый проект", placeholder: "Название проекта", confirmLabel: "Создать" }))?.trim().slice(0, 120);
    if (!name) return;
    try {
      const { project } = await fetchJson<{ project: { id: string } }>("/api/mbox/projects", json("POST", { name, status: "active", access_level: "private", ...(companyId ? { company_id: companyId, color: company?.color } : {}) }));
      await Promise.resolve(data.reload());
      if (companyId) expand(`company:${companyId}`);
      tabs.open(`project:${project.id}`, true);
    } catch (error) {
      const conflict = error instanceof Error && /:(409|500)$/.test(error.message);
      showNotice("Проект не создан", conflict ? "Проект с таким названием уже есть. Выберите другое название." : "Не удалось создать проект. Попробуйте ещё раз.");
    }
  }

  async function createCompany() {
    const name = (await askText({ title: "Новая компания", placeholder: "Название компании", confirmLabel: "Создать" }))?.trim().slice(0, 200);
    if (!name) return;
    try {
      const { company } = await fetchJson<{ company: { id: string } }>("/api/mbox/companies", json("POST", { name }));
      await Promise.resolve(data.reload());
      expand(`company:${company.id}`);
      tabs.open(`company:${company.id}`, true);
    } catch (error) {
      const conflict = error instanceof Error && /:409$/.test(error.message);
      showNotice("Компания не создана", conflict ? "Компания с таким названием уже есть." : "Создавать компании может только владелец MBOX.");
    }
  }

  async function removeCompany(company: Company) {
    const count = data.projects.filter((project) => project.company_id === company.id).length;
    if (!(await askConfirm({ title: `Удалить компанию «${company.name}»?`, message: count ? `Её проекты (${count}) останутся — без компании.` : undefined, confirmLabel: "Удалить", danger: true }))) return;
    tabs.close(`company:${company.id}`);
    // Проекты удалённой компании остаются — на экране сразу «без компании».
    data.projects.filter((project) => project.company_id === company.id).forEach((project) => data.patchLocal("projects", project.id, { company_id: null }));
    await removeNow(data, "companies", company.id);
  }

  async function renameCompany(company: Company) {
    const name = (await askText({ title: "Название компании", value: company.name, confirmLabel: "Сохранить" }))?.trim().slice(0, 200);
    if (!name || name === company.name) return;
    await fetchJson(`/api/mbox/companies/${company.id}`, json("PATCH", { name })).catch(() => showNotice("Не переименована", "Компания с таким названием уже есть."));
    data.reload();
  }

  async function removeTodo(id: string, title: string) {
    if (!(await askConfirm({ title: `Удалить задачу «${title}»?`, confirmLabel: "Удалить", danger: true }))) return;
    tabs.close(`todo:${id}`);
    await removeNow(data, "todos", id);
  }

  async function setTodoStatus(id: string, status: string) {
    await patchNow(data, "todos", id, { status });
  }

  async function hideSection(project: Project, entity: ProjectEntityKind) {
    const enabled = Array.isArray(project.props?.enabled_entities) ? (project.props.enabled_entities as unknown as string[]) : autoDetectEnabled(project);
    await fetchJson(`/api/mbox/projects/${project.id}`, json("PATCH", { props: { ...project.props, enabled_entities: enabled.filter((kind) => kind !== entity) } }));
    tabs.close(`entity:${project.id}:${entity}`);
    data.reload();
  }

  async function removeFile(id: string, name: string) {
    if (!(await askConfirm({ title: `Удалить файл «${name}»?`, confirmLabel: "Удалить", danger: true }))) return;
    tabs.close(`file:${id}`);
    await removeNow(data, "artifacts", id);
  }

  async function renameFolder(id: string, current: string) {
    const name = (await askText({ title: "Название папки", value: current, confirmLabel: "Сохранить" }))?.trim();
    if (!name || name === current) return;
    await patchNow(data, "folders", id, { name });
  }

  async function removeFolder(project: Project, id: string, name: string) {
    if (!(await askConfirm({ title: `Удалить папку «${name}»?`, message: "Сама папка исчезнет, содержимое проекта останется.", confirmLabel: "Удалить", danger: true }))) return;
    tabs.close(`folder:${project.id}:${id}`);
    await removeNow(data, "folders", id);
  }

  const at = (event: MouseEvent) => ({ x: event.clientX, y: event.clientY });

  function row(key: string, pinOnOpen = false) {
    return {
      className: tabs.active === key ? "wb-tree-row is-active" : "wb-tree-row",
      onClick: () => tabs.open(key, pinOnOpen),
      onDoubleClick: () => tabs.open(key, true),
    };
  }

  function renderProject(project: Project, depth: number, home: Company | null = null) {
    const projectKey = `project:${project.id}`;
    const todosKey = `todos:${project.id}`;
    const open = isOpen(projectKey);
    const stats = projectStats(project);
    const todoHits = matches?.get(project.id);
    const shownTodos = sortTodos(project.todos.filter((todo) => (showDone || !CLOSED_STATUSES.includes(todo.status)) && (!todoHits?.size || todoHits.has(todo.id))));
    const enabled = Array.isArray(project.props?.enabled_entities) ? (project.props.enabled_entities as unknown as string[]) : autoDetectEnabled(project);
    const entities = [...MANDATORY_ENTITIES, ...OPTIONAL_ENTITIES.filter((kind) => enabled.includes(kind))];
    const folders = data.folders.filter((folder) => folder.project_id === project.id);
    const todoIds = new Set(project.todos.map((todo) => todo.id));
    const memoryCount = data.memories.filter((memory) => projectMemoryMatches(memory, project, todoIds)).length;
    const files = data.artifacts.filter((file) => file.project_id === project.id).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const attention = stats.review + stats.blocked;

    return (
      <li key={project.id} className={dropTarget === project.id && dragged !== project.id ? "is-drop-target" : undefined}>
        <div
          className={`wb-tree-row wb-tree-project${home ? " is-company-home" : ""}${tabs.active === projectKey ? " is-active" : ""}${project.status === "archived" && !home ? " is-archived" : ""}`}
          data-project-row={project.id}
          style={{ ["--project-color" as string]: project.color && project.color !== "transparent" ? project.color : "var(--state-off)", ["--depth" as string]: depth }}
          onClick={() => { if (home) toggle(projectKey); else { tabs.open(projectKey); expand(projectKey); } }}
          onDoubleClick={() => tabs.open(home ? `company:${home.id}` : projectKey, true)}
          onContextMenu={(event: MouseEvent) => { event.preventDefault(); if (!home) onProjectContext(project, at(event)); }}
          draggable={!home}
          onDragStart={(event: DragEvent) => { setDragged(project.id); event.dataTransfer.setData("text/plain", project.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(event: DragEvent) => { if (dragged && dragged !== project.id) { event.preventDefault(); setDropTarget(project.id); } }}
          onDragLeave={() => setDropTarget((current) => (current === project.id ? null : current))}
          onDrop={(event: DragEvent) => { event.preventDefault(); setDropTarget(null); if (dragged) void reorder(dragged, project.id); }}
          onDragEnd={() => { setDragged(null); setDropTarget(null); }}
          title={home ? `Память, решения, файлы и папки компании «${home.name}»` : "Открыть страницу проекта · ПКМ — действия · перетащите на компанию, чтобы перенести"}
        >
          <ChevronRight className={open ? "wb-chevron is-open" : "wb-chevron"} size={14} onClick={(event) => { event.stopPropagation(); toggle(projectKey); }} />
          {home ? <TreeGlyph kind="company" /> : <span className="wb-project-dot" />}
          <span className="wb-tree-label">{home ? "Записи компании" : project.name}</span>
          {attention > 0 && <span className="wb-badge is-warn" title="На проверке или заблокировано">{attention}</span>}
          <span className="wb-tree-count" title="Открытых задач">{stats.open}</span>
        </div>
        {open && (
          <ul className="wb-tree-children">
            <li>
              <div {...row(todosKey)} style={{ ["--depth" as string]: depth + 1 }}>
                <ChevronRight className={isOpen(`${todosKey}:list`) ? "wb-chevron is-open" : "wb-chevron"} size={14} onClick={(event) => { event.stopPropagation(); toggle(`${todosKey}:list`); }} />
                <TreeGlyph kind="todos" />
                <span className="wb-tree-label">Задачи</span>
                <span className="wb-tree-count">{stats.open}</span>
              </div>
              {isOpen(`${todosKey}:list`) && (
                <ul className="wb-tree-children">
                  {shownTodos.length ? shownTodos.map((todo) => (
                    <li key={todo.id}>
                      <div {...row(`todo:${todo.id}`)} onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "todo", id: todo.id, title: todo.title, status: todo.status, ...at(event) }); }} style={{ ["--depth" as string]: depth + 2 }} title={`#${todo.id} · ${todoStatusLabel(todo.status)} · ${todoPriorityLabel(todo.priority)}${isLeaseLive(todo) ? ` · держит ${todo.claimed_by}` : ""}`}>
                        <span className={`wb-status-dot status-${todo.status}`} />
                        <span className={`wb-tree-label${CLOSED_STATUSES.includes(todo.status) ? " is-muted" : ""}`}>{todo.title}</span>
                        {(todo.priority === "urgent" || todo.priority === "high") && <span className={`wb-priority priority-${todo.priority}`}>!</span>}
                        {isLeaseLive(todo) && <span className="wb-tree-hint">{todo.claimed_by}</span>}
                      </div>
                    </li>
                  )) : <li className="wb-tree-empty" style={{ ["--depth" as string]: depth + 2 }}>Нет задач</li>}
                </ul>
              )}
            </li>
            {entities.map((kind) => {
              const meta = projectEntityKinds[kind];
              const key = `entity:${project.id}:${kind}`;
              return (
                <li key={kind}>
                  <div {...row(key)} onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "entity", project, entity: kind, ...at(event) }); }} style={{ ["--depth" as string]: depth + 1 }}>
                    <span className="wb-chevron-space" />
                    <TreeGlyph kind={kind} />
                    <span className="wb-tree-label">{meta.label}</span>
                    {(() => { const hint = kind === "memories" ? String(memoryCount) : String(entitySummary(project, kind, data.memories)); return /^\d+$/.test(hint) && hint !== "0" ? <span className="wb-tree-count">{hint}</span> : null; })()}
                  </div>
                </li>
              );
            })}
            {files.length > 0 && (
              <li>
                <div className="wb-tree-row" style={{ ["--depth" as string]: depth + 1 }} {...pressable(() => toggle(`files:${project.id}`), isOpen(`files:${project.id}`))}>
                  <ChevronRight className={isOpen(`files:${project.id}`) ? "wb-chevron is-open" : "wb-chevron"} size={14} />
                  <TreeGlyph kind="files" />
                  <span className="wb-tree-label">Файлы</span>
                  <span className="wb-tree-count">{files.length}</span>
                </div>
                {isOpen(`files:${project.id}`) && (
                  <ul className="wb-tree-children">
                    {files.map((file) => (
                      <li key={file.id}>
                        <div {...row(`file:${file.id}`)} onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "file", id: file.id, name: file.name || `Файл #${file.id}`, ...at(event) }); }} style={{ ["--depth" as string]: depth + 2 }} title={`${file.category} · ${file.version} · ${file.status}`}>
                          <FileTypeIcon name={file.name} />
                          <span className="wb-tree-label">{file.name || `Без имени #${file.id}`}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )}
            {folders.map((folder) => (
              <li key={folder.id}>
                <div {...row(`folder:${project.id}:${folder.id}`)} onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "folder", project, id: folder.id, name: folder.name, ...at(event) }); }} style={{ ["--depth" as string]: depth + 1 }}>
                  <span className="wb-chevron-space" />
                  <TreeGlyph kind={folderGlyph(folder.name)} />
                  <span className="wb-tree-label">{folder.name}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  function renderCompany(company: Company) {
    const key = `company:${company.id}`;
    const projects = live.filter((project) => project.company_id === company.id);
    const home = data.projects.find((project) => project.company_id === company.id && isCompanyHome(project)) ?? null;
    const open = isOpen(key);
    const openTodos = [...projects, ...(home ? [home] : [])].reduce((sum, project) => sum + projectStats(project).open, 0);
    return (
      <li key={company.id} className={dropTarget === key ? "is-drop-target" : undefined}>
        <div
          className={`wb-tree-row wb-tree-company${tabs.active === key ? " is-active" : ""}`}
          style={{ ["--company-color" as string]: company.color && company.color !== "#2c2c2e" ? company.color : "var(--text-muted)", ["--depth" as string]: 0 }}
          onClick={() => { tabs.open(key); expand(key); }}
          onDoubleClick={() => tabs.open(key, true)}
          onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "company", company, ...at(event) }); }}
          onDragOver={(event) => { if (dragged && isOwner) { event.preventDefault(); setDropTarget(key); } }}
          onDragLeave={() => setDropTarget((current) => (current === key ? null : current))}
          onDrop={(event) => { event.preventDefault(); setDropTarget(null); if (dragged) void moveToCompany(dragged, company.id); }}
          title="Открыть карточку компании · ПКМ — действия"
        >
          <ChevronRight className={open ? "wb-chevron is-open" : "wb-chevron"} size={14} onClick={(event) => { event.stopPropagation(); toggle(key); }} />
          <span className={`wb-company-mark${companyLogo(company) ? " has-logo" : ""}`} aria-hidden="true">{companyLogo(company) ? <img src={companyLogo(company)} alt="" /> : initials(company.name)}</span>
          <span className="wb-tree-label">{company.name}</span>
          <span className="wb-tree-count" title="Открытых задач во всех проектах">{openTodos || ""}</span>
        </div>
        {open && (
          <ul className="wb-tree-children">
            {home && renderProject(home, 1, company)}
            {projects.length ? projects.map((project) => renderProject(project, 1)) : home ? null : (
              <li className="wb-tree-empty" style={{ ["--depth" as string]: 1 }}>
                {isOwner ? <button type="button" className="wb-empty-action" onClick={() => void createProject(company.id)}>Создать проект</button> : "Нет проектов"}
              </li>
            )}
          </ul>
        )}
      </li>
    );
  }

  const nothing = !shownCompanies.length && !loose.length && !archived.length;

  return (
    <div className="wb-view wb-projects-tree">
      <header className="wb-view-head">
        <span>Проекты</span>
        <div className="wb-view-actions">
          <button type="button" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "add", x: rect.left, y: rect.bottom + 4 }); }} title="Создать проект или компанию" aria-label="Создать"><Plus size={14} /></button>
          <button type="button" className={showDone ? "is-on" : undefined} onClick={() => setShowDone((value) => !value)} title={showDone ? "Скрыть готовые задачи" : "Показать готовые задачи"}>
            <ListChecks size={14} />
          </button>
          <button type="button" onClick={() => setExpanded([])} title="Свернуть всё"><ChevronsDownUp size={14} /></button>
          <button type="button" onClick={data.reload} title="Обновить" aria-label="Обновить"><RefreshCw size={13} /></button>
        </div>
      </header>
      <div className="wb-filter">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Фильтр: компания, проект, задача, #id" onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }} />
        {filter && <button type="button" onClick={() => setFilter("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      <div className="wb-view-body">
        {nothing ? (data.loading ? <OctopusSpinner label="Загружаю проекты…" /> : (
          <p className="wb-empty">{needle ? "Ничего не найдено" : <>Проектов пока нет. <button type="button" className="wb-empty-action" onClick={() => void createProject()}>Создать проект</button>{isOwner && <> или <button type="button" className="wb-empty-action" onClick={() => void createCompany()}>компанию</button></>}</>}</p>
        )) : (
          <>
            {shownCompanies.length > 0 && (
              <section className="wb-tree-group">
                <h3 className="wb-tree-group-label">Компании</h3>
                <ul className="wb-tree">{shownCompanies.map(renderCompany)}</ul>
              </section>
            )}
            {loose.length > 0 && (
              <section
                className={`wb-tree-group${dropTarget === "loose" ? " is-drop-target" : ""}`}
                onDragOver={(event) => { if (dragged && isOwner && data.projects.find((item) => item.id === dragged)?.company_id) { event.preventDefault(); setDropTarget("loose"); } }}
                onDragLeave={() => setDropTarget((current) => (current === "loose" ? null : current))}
                onDrop={(event) => { if (dropTarget !== "loose") return; event.preventDefault(); setDropTarget(null); if (dragged) void moveToCompany(dragged, null); }}
              >
                {shownCompanies.length > 0 && <h3 className="wb-tree-group-label">Без компании</h3>}
                <ul className="wb-tree">{loose.map((project) => renderProject(project, 0))}</ul>
              </section>
            )}
            {archived.length > 0 && (
              <section className="wb-tree-group">
                <button type="button" className="wb-tree-group-label is-toggle" onClick={() => toggle("archive")} aria-expanded={isOpen("archive")}>
                  <ChevronRight className={isOpen("archive") ? "wb-chevron is-open" : "wb-chevron"} size={12} /> Архив · {archived.length}
                </button>
                {isOpen("archive") && <ul className="wb-tree">{archived.map((project) => renderProject(project, 0))}</ul>}
              </section>
            )}
          </>
        )}
      </div>

      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu wb-tree-ctx" onClick={() => setMenu(null)}>
            {menu.kind === "add" && (
              <>
                <button type="button" role="menuitem" onClick={() => void createProject()}><FolderPlus size={15} aria-hidden="true" />Новый проект</button>
                {isOwner && <button type="button" role="menuitem" onClick={() => void createCompany()}><Building2 size={15} aria-hidden="true" />Новая компания</button>}
              </>
            )}
            {menu.kind === "company" && (
              <>
                <div className="wb-note-menu-label">{menu.company.name}</div>
                <button type="button" role="menuitem" onClick={() => tabs.open(`company:${menu.company.id}`, true)}><ExternalLink size={15} aria-hidden="true" />Открыть карточку</button>
                {isOwner && <button type="button" role="menuitem" onClick={() => void createProject(menu.company.id)}><FolderPlus size={15} aria-hidden="true" />Новый проект в компании</button>}
                {isOwner && <button type="button" role="menuitem" onClick={() => void renameCompany(menu.company)}><Pencil size={15} aria-hidden="true" />Переименовать</button>}
                {isOwner && <div className="wb-menu-sep" role="separator" />}
                {isOwner && <button type="button" role="menuitem" className="is-danger" onClick={() => void removeCompany(menu.company)}><Trash2 size={15} aria-hidden="true" />Удалить компанию</button>}
              </>
            )}
            {menu.kind === "todo" && (
              <>
                <div className="wb-note-menu-label">#{menu.id} · {menu.title}</div>
                <button type="button" role="menuitem" onClick={() => tabs.open(`todo:${menu.id}`, true)}><ExternalLink size={15} aria-hidden="true" />Открыть</button>
                <div className="wb-menu-sep" role="separator" />
                {TODO_STATUSES.filter((status) => status !== menu.status).map((status) => (
                  <button key={status} type="button" role="menuitem" onClick={() => void setTodoStatus(menu.id, status)}><span className={`wb-status-dot status-${status}`} aria-hidden="true" />{todoStatusLabel(status)}</button>
                ))}
                <div className="wb-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="is-danger" onClick={() => void removeTodo(menu.id, menu.title)}><Trash2 size={15} aria-hidden="true" />Удалить задачу</button>
              </>
            )}
            {menu.kind === "entity" && (
              <>
                <div className="wb-note-menu-label">{projectEntityKinds[menu.entity].label} · {menu.project.name}</div>
                <button type="button" role="menuitem" onClick={() => tabs.open(`entity:${menu.project.id}:${menu.entity}`, true)}><ExternalLink size={15} aria-hidden="true" />Открыть</button>
                {OPTIONAL_ENTITIES.includes(menu.entity)
                  ? <button type="button" role="menuitem" className="is-danger" onClick={() => void hideSection(menu.project, menu.entity)}><Trash2 size={15} aria-hidden="true" />Убрать раздел</button>
                  : <div className="wb-note-menu-label">Обязательный раздел — убрать нельзя</div>}
              </>
            )}
            {menu.kind === "file" && (
              <>
                <div className="wb-note-menu-label">{menu.name}</div>
                <button type="button" role="menuitem" onClick={() => tabs.open(`file:${menu.id}`, true)}><ExternalLink size={15} aria-hidden="true" />Открыть</button>
                <button type="button" role="menuitem" className="is-danger" onClick={() => void removeFile(menu.id, menu.name)}><Trash2 size={15} aria-hidden="true" />Удалить файл</button>
              </>
            )}
            {menu.kind === "folder" && (
              <>
                <div className="wb-note-menu-label">{menu.name}</div>
                <button type="button" role="menuitem" onClick={() => tabs.open(`folder:${menu.project.id}:${menu.id}`, true)}><ExternalLink size={15} aria-hidden="true" />Открыть</button>
                <button type="button" role="menuitem" onClick={() => void renameFolder(menu.id, menu.name)}><Pencil size={15} aria-hidden="true" />Переименовать</button>
                <button type="button" role="menuitem" className="is-danger" onClick={() => void removeFolder(menu.project, menu.id, menu.name)}><Trash2 size={15} aria-hidden="true" />Удалить папку</button>
              </>
            )}
          </div>
        </WbMenu>
      )}
    </div>
  );
}
