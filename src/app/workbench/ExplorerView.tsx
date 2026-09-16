import { useMemo, useState, type DragEvent, type MouseEvent } from "react";
import { ChevronRight, ChevronsDownUp, RefreshCw, X } from "lucide-react";
import { projectEntityKinds } from "../../features/tree/entityKinds";
import type { MboxData } from "../../hooks/useMboxData";
import { fetchJson } from "../../lib/api";
import { todoPriorityLabel, todoStatusLabel } from "../../lib/labels";
import { projectMemoryMatches } from "../../lib/memory";
import { positionBetween, projectPosition, sortTodos } from "../../lib/tree";
import { autoDetectEnabled, entitySummary, MANDATORY_ENTITIES, OPTIONAL_ENTITIES } from "../../pages/Projects";
import type { Project } from "../../types";
import { fileIcon, fileKind } from "./Files";
import { folderIcon } from "./tabMeta";
import { usePersistentState, type TabsApi } from "./tabs";

const ICONS = "/assets/icons/icons";
const CLOSED_STATUSES = ["done", "archived"];

type Props = {
  data: MboxData;
  tabs: TabsApi;
  onProjectContext: (project: Project, position: { x: number; y: number }) => void;
};

export function ExplorerView({ data, tabs, onProjectContext }: Props) {
  const [filter, setFilter] = usePersistentState("mbox.explorer.filter", "");
  const [expanded, setExpanded] = usePersistentState<string[]>("mbox.explorer.expanded", []);
  const [showDone, setShowDone] = usePersistentState("mbox.explorer.showDone", false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);

  const companyByProject = useMemo(() => {
    const map = new Map<string, string>();
    for (const company of data.companies) {
      for (const link of company.projects) if (link.edge_type === "owns") map.set(link.project_id, company.name);
    }
    return map;
  }, [data.companies]);

  const ordered = useMemo(
    () => [...data.projects].sort((a, b) => projectPosition(a, data.projects.indexOf(a)) - projectPosition(b, data.projects.indexOf(b))),
    [data.projects],
  );

  const needle = filter.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return null;
    const result = new Map<string, Set<string>>();
    for (const project of ordered) {
      const todoHits = new Set(project.todos.filter((todo) => todo.title.toLowerCase().includes(needle) || todo.id === needle.replace("#", "")).map((todo) => todo.id));
      if (project.name.toLowerCase().includes(needle) || todoHits.size) result.set(project.id, todoHits);
    }
    return result;
  }, [needle, ordered]);

  const groups = useMemo(() => {
    const visible = matches ? ordered.filter((project) => matches.has(project.id)) : ordered;
    const personal = visible.filter((project) => !companyByProject.has(project.id));
    const byCompany = new Map<string, Project[]>();
    for (const project of visible) {
      const company = companyByProject.get(project.id);
      if (company) byCompany.set(company, [...(byCompany.get(company) ?? []), project]);
    }
    return [{ label: "", projects: personal }, ...[...byCompany.entries()].map(([label, projects]) => ({ label, projects }))].filter((group) => group.projects.length);
  }, [matches, ordered, companyByProject]);

  function isOpen(key: string) {
    return Boolean(matches) || expandedSet.has(key);
  }

  function toggle(key: string) {
    setExpanded((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  async function reorder(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const rest = ordered.filter((item) => item.id !== draggedId);
    const index = rest.findIndex((item) => item.id === targetId);
    const project = ordered.find((item) => item.id === draggedId);
    if (index < 0 || !project) return;
    const before = rest[index - 1];
    const after = rest[index];
    const position = positionBetween(
      before ? projectPosition(before, data.projects.indexOf(before)) : undefined,
      after ? projectPosition(after, data.projects.indexOf(after)) : undefined,
    );
    await fetchJson(`/api/mbox/projects/${draggedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ props: { ...project.props, position } }),
    });
    data.reload();
  }

  function row(key: string, pinOnOpen = false) {
    return {
      className: tabs.active === key ? "wb-tree-row is-active" : "wb-tree-row",
      onClick: () => tabs.open(key, pinOnOpen),
      onDoubleClick: () => tabs.open(key, true),
    };
  }

  function renderProject(project: Project) {
    const projectKey = `project:${project.id}`;
    const todosKey = `todos:${project.id}`;
    const open = isOpen(projectKey);
    const active = project.todos.filter((todo) => !CLOSED_STATUSES.includes(todo.status));
    const todoHits = matches?.get(project.id);
    const shownTodos = sortTodos(project.todos.filter((todo) => (showDone || !CLOSED_STATUSES.includes(todo.status)) && (!todoHits?.size || todoHits.has(todo.id))));
    const enabled = Array.isArray(project.props?.enabled_entities) ? (project.props.enabled_entities as unknown as string[]) : autoDetectEnabled(project);
    const entities = [...MANDATORY_ENTITIES, ...OPTIONAL_ENTITIES.filter((kind) => enabled.includes(kind))];
    const folders = data.folders.filter((folder) => folder.project_id === project.id);
    const todoIds = new Set(project.todos.map((todo) => todo.id));
    const memoryCount = data.memories.filter((memory) => projectMemoryMatches(memory, project, todoIds)).length;
    const files = data.artifacts.filter((file) => file.project_id === project.id).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const attention = project.todos.filter((todo) => todo.status === "review" || todo.status === "blocked").length;

    return (
      <li key={project.id} className={dropTarget === project.id && dragged !== project.id ? "is-drop-target" : undefined}>
        <div
          className="wb-tree-row wb-tree-project"
          style={{ ["--project-color" as string]: project.color || "#5b6b66", ["--depth" as string]: 0 }}
          onClick={() => toggle(projectKey)}
          onContextMenu={(event: MouseEvent) => { event.preventDefault(); onProjectContext(project, { x: event.clientX, y: event.clientY }); }}
          draggable
          onDragStart={(event: DragEvent) => { setDragged(project.id); event.dataTransfer.setData("text/plain", project.id); }}
          onDragOver={(event: DragEvent) => { if (dragged && dragged !== project.id) { event.preventDefault(); setDropTarget(project.id); } }}
          onDragLeave={() => setDropTarget((current) => (current === project.id ? null : current))}
          onDrop={(event: DragEvent) => { event.preventDefault(); setDropTarget(null); if (dragged) void reorder(dragged, project.id); }}
          onDragEnd={() => { setDragged(null); setDropTarget(null); }}
          title="ПКМ — действия с проектом, перетаскивание — порядок"
        >
          <ChevronRight className={open ? "wb-chevron is-open" : "wb-chevron"} size={14} />
          <span className="wb-project-dot" />
          <span className="wb-tree-label">{project.name}</span>
          {attention > 0 && <span className="wb-badge is-warn" title="На проверке или заблокировано">{attention}</span>}
          <span className="wb-tree-count" title="Активных todo">{active.length}</span>
        </div>
        {open && (
          <ul className="wb-tree-children">
            <li>
              <div {...row(todosKey)} style={{ ["--depth" as string]: 1 }}>
                <ChevronRight
                  className={isOpen(`${todosKey}:list`) ? "wb-chevron is-open" : "wb-chevron"}
                  size={14}
                  onClick={(event) => { event.stopPropagation(); toggle(`${todosKey}:list`); }}
                />
                <img src={`${ICONS}/todo.png`} width={16} height={16} alt="" />
                <span className="wb-tree-label">Todo</span>
                <span className="wb-tree-count">{active.length}</span>
              </div>
              {isOpen(`${todosKey}:list`) && (
                <ul className="wb-tree-children">
                  {shownTodos.length ? shownTodos.map((todo) => (
                    <li key={todo.id}>
                      <div {...row(`todo:${todo.id}`)} style={{ ["--depth" as string]: 2 }} title={`#${todo.id} · ${todoStatusLabel(todo.status)} · ${todoPriorityLabel(todo.priority)}${todo.claimed_by ? ` · держит ${todo.claimed_by}` : ""}`}>
                        <span className={`wb-status-dot status-${todo.status}`} />
                        <span className={`wb-tree-label${CLOSED_STATUSES.includes(todo.status) ? " is-muted" : ""}`}>{todo.title}</span>
                        {(todo.priority === "urgent" || todo.priority === "high") && <span className={`wb-priority priority-${todo.priority}`}>!</span>}
                        {todo.claimed_by && <span className="wb-tree-hint">{todo.claimed_by}</span>}
                      </div>
                    </li>
                  )) : <li className="wb-tree-empty" style={{ ["--depth" as string]: 2 }}>Нет задач</li>}
                </ul>
              )}
            </li>
            {entities.map((kind) => {
              const meta = projectEntityKinds[kind];
              const key = `entity:${project.id}:${kind}`;
              return (
                <li key={kind}>
                  <div {...row(key)} style={{ ["--depth" as string]: 1 }}>
                    <span className="wb-chevron-space" />
                    <img src={meta.image} width={16} height={16} alt="" />
                    <span className="wb-tree-label">{meta.label}</span>
                    {/* Только числа: «указан», «задана», «agents» ничего не сообщали, а шумели в каждой строке. */}
                    {(() => { const hint = kind === "memories" ? String(memoryCount) : String(entitySummary(project, kind, data.memories)); return /^\d+$/.test(hint) && hint !== "0" ? <span className="wb-tree-count">{hint}</span> : null; })()}
                  </div>
                </li>
              );
            })}
            {files.length > 0 && (
              <li>
                <div className="wb-tree-row" style={{ ["--depth" as string]: 1 }} onClick={() => toggle(`files:${project.id}`)}>
                  <ChevronRight className={isOpen(`files:${project.id}`) ? "wb-chevron is-open" : "wb-chevron"} size={14} />
                  <img src={`${ICONS}/документы.png`} width={16} height={16} alt="" />
                  <span className="wb-tree-label">Файлы</span>
                  <span className="wb-tree-count">{files.length}</span>
                </div>
                {isOpen(`files:${project.id}`) && (
                  <ul className="wb-tree-children">
                    {files.map((file) => (
                      <li key={file.id}>
                        <div {...row(`file:${file.id}`)} style={{ ["--depth" as string]: 2 }} title={`${file.category} · ${file.version} · ${file.status}`}>
                          <img src={fileIcon(fileKind(file))} width={16} height={16} alt="" />
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
                <div {...row(`folder:${project.id}:${folder.id}`)} style={{ ["--depth" as string]: 1 }}>
                  <span className="wb-chevron-space" />
                  <img src={folderIcon(folder.name)} width={16} height={16} alt="" />
                  <span className="wb-tree-label">{folder.name}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="wb-view">
      <header className="wb-view-head">
        <span>Проводник</span>
        <div className="wb-view-actions">
          <button type="button" className={showDone ? "is-on" : undefined} onClick={() => setShowDone((value) => !value)} title={showDone ? "Скрыть готовые todo" : "Показать готовые todo"}>
            <img src={`${ICONS}/галочка.png`} width={13} height={13} alt="" />
          </button>
          <button type="button" onClick={() => setExpanded([])} title="Свернуть всё"><ChevronsDownUp size={14} /></button>
          <button type="button" onClick={data.reload} title="Обновить"><RefreshCw size={13} /></button>
        </div>
      </header>
      <div className="wb-filter">
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Фильтр: проект, todo, #id" onKeyDown={(event) => { if (event.key === "Escape") setFilter(""); }} />
        {filter && <button type="button" onClick={() => setFilter("")} aria-label="Очистить"><X size={13} /></button>}
      </div>
      <div className="wb-view-body">
        {groups.length ? groups.map((group) => (
          <section key={group.label || "personal"} className="wb-tree-group">
            {group.label && <h3 className="wb-tree-group-label">{group.label}</h3>}
            <ul className="wb-tree">{group.projects.map(renderProject)}</ul>
          </section>
        )) : <p className="wb-empty">{data.loading ? "Загрузка…" : needle ? "Ничего не найдено" : "Проектов пока нет"}</p>}
      </div>
    </div>
  );
}
