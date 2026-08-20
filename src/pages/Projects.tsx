import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FolderPlus, Folder, ListTodo, Sliders, Trash2 } from "lucide-react";
import { TodoCardGrid } from "../features/projects/TodoCards";
import { FolderBoard } from "../features/projects/FolderBoard";
import { entityKindMeta, projectEntityKinds, type ProjectEntityKind } from "../features/tree/entityKinds";
import { formatBytes } from "../lib/format";
import { fetchJson } from "../lib/api";
import { projectMemoryMatches } from "../lib/memory";
import { countUnseen, onSeenChange } from "../lib/seen";
import { useWheelToHorizontal } from "../lib/useWheelToHorizontal";
import { positionBetween, projectPosition } from "../lib/tree";
import type { Company, DecisionEntry, FolderRow, Memory, Project } from "../types";
import { EmptyState } from "../ui";

// Кроме постоянных сущностей у проекта могут быть свои папки: folder:<id>.
type View = "todo" | ProjectEntityKind | `folder:${string}`;

// У ЛЮБОГО проекта обязательны только три вещи: живой контекст (память), факты (свойства) и связи
// с другими сущностями. Всё остальное — Git, Figma, Стек, Философия, Деплой, Доступ — раньше было
// жёстко зашито и висело у каждого проекта, даже пустое. Теперь это опциональные разделы, которые
// подключаются через «Добавить папку», как и любая произвольная папка (см. #159 — посты/документы
// туда же, обычными папками, без отдельной сущности под каждый тип).
const MANDATORY_ENTITIES: ProjectEntityKind[] = ["memories", "properties", "relations"];
const OPTIONAL_ENTITIES: ProjectEntityKind[] = ["git", "figma", "stack", "philosophy", "deploy", "access", "sources"];
const entityOrder: ProjectEntityKind[] = [...MANDATORY_ENTITIES, ...OPTIONAL_ENTITIES];

/** Проекты, заведённые до этой правки, не имеют props.enabled_entities — без этого у них молча
 * исчезли бы уже заполненные Git/Стек/Деплой и т.п. Пока список явно не сохранён, считаем
 * подключённым всё, где реально есть данные, а не только то, что отмечено вручную. */
function autoDetectEnabled(project: Project): string[] {
  const detected: string[] = [];
  if (project.git_url) detected.push("git");
  if (project.props?.figma_url) detected.push("figma");
  if (project.stack.length > 0) detected.push("stack");
  if (project.props?.philosophy || project.props?.principles) detected.push("philosophy");
  if (project.deploy_provider || project.deploy_target) detected.push("deploy");
  if (project.access_level && project.access_level !== "private") detected.push("access");
  return detected;
}

function searchValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(searchValue).join(" ");
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).map(searchValue).join(" ");
  return String(value);
}

function projectSearchText(project: Project, memories: Memory[], decisions: DecisionEntry[]) {
  const todoIds = new Set(project.todos.map((todo) => todo.id));
  const projectMemories = memories.filter((memory) => projectMemoryMatches(memory, project, todoIds));
  const projectDecisions = decisions.filter((decision) => decision.project_id === project.id);
  return [
    project.name,
    project.status,
    project.git_url,
    project.deploy_provider,
    project.deploy_target,
    project.access_level,
    project.stack.join(" "),
    searchValue(project.props),
    project.relations.map(searchValue).join(" "),
    project.todos.map((todo) => [todo.title, todo.note, todo.status, todo.priority, searchValue(todo.props)].join(" ")).join(" "),
    projectMemories.map((memory) => [memory.title, memory.content, memory.entity_type, memory.tags.join(" "), searchValue(memory.metadata)].join(" ")).join(" "),
    projectDecisions.map((decision) => [decision.title, decision.decision, decision.rationale, decision.impact, decision.actor].join(" ")).join(" "),
  ].join(" ").toLowerCase();
}

/** Ключ маршрута этой страницы: <projectId>:<view>. Держит выбор в URL, как и раньше делало дерево. */
function parseRoute(key: string): { projectId?: string; view: View } {
  const [projectId, view, folderId] = key.split(":");
  if (view === "folder" && folderId) return { projectId: projectId || undefined, view: `folder:${folderId}` };
  const known: View[] = ["todo", ...entityOrder];
  return { projectId: projectId || undefined, view: (known as string[]).includes(view) ? (view as View) : "todo" };
}

export function ProjectsBoard({ projects, companies, query, selectedNodeKey, onSelectedNodeKey, onSaved, renderEntity, renderTodoForm, onProjectContext, folders, memories, decisions }: {
  projects: Project[];
  companies: Company[];
  query: string;
  selectedNodeKey: string;
  onSelectedNodeKey: (key: string) => void;
  onSaved: () => void;
  renderEntity: (project: Project, kind: ProjectEntityKind) => ReactNode;
  renderTodoForm: (project: Project) => ReactNode;
  folders: FolderRow[];
  memories: Memory[];
  decisions: DecisionEntry[];
  onProjectContext?: (project: Project, position: { x: number; y: number }) => void;
}) {
  const railRef = useWheelToHorizontal<HTMLDivElement>();
  const route = parseRoute(selectedNodeKey);

  // Раньше все проекты шли одним нерасчленённым рядом, и «Вокруг света» (компания-контейнер)
  // выглядела строкой того же уровня, что и её собственные vs-works/shar-messenger — хотя по факту
  // это владелец, а не соседний проект. company->project связи уже есть (graph_edges edge_type=owns),
  // просто фронт их не читал. Карта project_id -> имя владеющей компании, чтобы подписать пилюлю.
  const companyByProjectId = useMemo(() => {
    const map = new Map<string, string>();
    for (const company of companies) {
      for (const link of company.projects) {
        if (link.edge_type === "owns") map.set(link.project_id, company.name);
      }
    }
    return map;
  }, [companies]);

  const visible = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = tokens.length
      ? projects.filter((project) => {
        const haystack = projectSearchText(project, memories, decisions);
        return tokens.every((token) => haystack.includes(token));
      })
      : projects;
    return [...filtered].sort((a, b) => projectPosition(a, projects.indexOf(a)) - projectPosition(b, projects.indexOf(b)));
  }, [projects, query, memories, decisions]);

  // Позиция (position) — свободный порядок для драга, ничего не знает про компании: проекты одной
  // компании вполне могли оказаться вперемешку с личными. Стабильная сортировка (Array.sort гарантированно
  // стабилен с ES2019) добавляет группировку поверх уже отсортированного по позиции списка, не ломая
  // порядок внутри каждой группы — просто собирает разбросанные группы вместе.
  const groupedVisible = useMemo(() => {
    return [...visible].sort((a, b) => (companyByProjectId.get(a.id) || "").localeCompare(companyByProjectId.get(b.id) || ""));
  }, [visible, companyByProjectId]);

  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // Бейдж непрочитанного на пилюле проекта — используем тот же учёт «просмотрено», что и на
  // карточках todo (lib/seen), поэтому подписываемся на его изменения, а не считаем один раз.
  const [seenTick, setSeenTick] = useState(0);
  useEffect(() => onSeenChange(() => setSeenTick((value) => value + 1)), []);
  const unseenByProject = useMemo(() => {
    void seenTick;
    const map = new Map<string, number>();
    for (const item of visible) {
      const marks = item.todos.map((todo) => ({ key: `todo:${todo.id}`, bytes: todo.memory_bytes }));
      map.set(item.id, countUnseen(marks));
    }
    return map;
  }, [visible, seenTick]);

  async function reorderProject(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const rest = visible.filter((item) => item.id !== draggedId);
    const targetIndex = rest.findIndex((item) => item.id === targetId);
    if (targetIndex === -1) return;
    const before = rest[targetIndex - 1];
    const after = rest[targetIndex];
    const newPosition = positionBetween(
      before ? projectPosition(before, projects.indexOf(before)) : undefined,
      after ? projectPosition(after, projects.indexOf(after)) : undefined,
    );
    const dragged = visible.find((item) => item.id === draggedId);
    if (!dragged) return;
    await fetchJson(`/api/mbox/projects/${draggedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ props: { ...dragged.props, position: newPosition } }),
    });
    onSaved();
  }

  const [projectId, setProjectId] = useState(route.projectId || visible[0]?.id);
  const view = route.view;

  useEffect(() => {
    if (!projectId && visible[0]) setProjectId(visible[0].id);
  }, [visible, projectId]);

  const project = visible.find((item) => item.id === projectId) || visible[0];

  function go(nextProjectId: string, nextView: View) {
    setProjectId(nextProjectId);
    onSelectedNodeKey(`${nextProjectId}:${nextView}`);
  }

  if (!project) return <EmptyState text="Проектов в базе пока нет" />;

  const activeTodos = project.todos.filter((todo) => !["done", "archived"].includes(todo.status)).length;
  const projectFolders = folders.filter((folder) => folder.project_id === project.id);
  const openFolder = view.startsWith("folder:") ? projectFolders.find((folder) => folder.id === view.slice(7)) : undefined;
  const enabledOptional = Array.isArray(project.props?.enabled_entities) ? project.props.enabled_entities as string[] : autoDetectEnabled(project);
  const visibleEntityOrder = [...MANDATORY_ENTITIES, ...OPTIONAL_ENTITIES.filter((kind) => enabledOptional.includes(kind))];
  const addableEntities = OPTIONAL_ENTITIES.filter((kind) => !enabledOptional.includes(kind));

  /** Папку, созданную здесь же, здесь же надо и удалять: контекстное меню дерева до неё не достаёт. */
  async function deleteFolder(folder: FolderRow) {
    if (!window.confirm(`Удалить папку «${folder.name}»? Сама папка исчезнет, содержимое проекта останется.`)) return;
    await fetchJson(`/api/mbox/folders/${folder.id}`, { method: "DELETE" });
    go(project.id, "todo");
    onSaved();
  }

  async function createFolder(presetName?: string) {
    const name = presetName || window.prompt("Название новой папки проекта");
    if (!name?.trim()) return;
    await fetchJson("/api/mbox/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), entity_type: "project", access_level: "private", project_id: project.id, color: project.color || "#2c2c2e" }),
    });
    setAddMenuOpen(false);
    onSaved();
  }

  /** Подключить опциональную сущность (Git/Figma/Стек/...) проекту — данные и так уже есть в
   * project (git_url, props.stack и т.п.), просто раньше вкладка всегда показывалась, даже пустой. */
  async function enableEntity(kind: ProjectEntityKind) {
    await fetchJson(`/api/mbox/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ props: { ...project.props, enabled_entities: [...enabledOptional, kind] } }),
    });
    setAddMenuOpen(false);
    onSaved();
  }

  return (
    <div className="control-panel">
      <div className="project-rail" ref={railRef} role="tablist" aria-label="Проекты">
        {groupedVisible.map((item, index) => {
          const companyLabel = companyByProjectId.get(item.id);
          // Разрыв группы: подпись перед первым проектом компании и перед первым «моим» после
          // компаний (или наоборот) — ровно там, где сосед в отсортированном порядке сменился.
          const prevLabel = index > 0 ? (companyByProjectId.get(groupedVisible[index - 1].id) || null) : undefined;
          const showDivider = index === 0 || (companyLabel || null) !== prevLabel;
          return (
            <div className="project-rail-item" key={item.id}>
              {showDivider && (
                <span className="project-rail-divider">{companyLabel || "Мои"}</span>
              )}
              <button
                role="tab"
                aria-selected={item.id === project.id}
                className={[
                  item.id === project.id ? "project-pill is-active" : "project-pill",
                  draggedProjectId === item.id ? "is-dragging" : "",
                  dropTargetId === item.id && draggedProjectId && draggedProjectId !== item.id ? "is-drop-target" : "",
                ].filter(Boolean).join(" ")}
                style={{ ["--project-color" as string]: item.color || "#2c2c2e" }}
                onClick={() => go(item.id, view)}
                onContextMenu={(event) => { if (onProjectContext) { event.preventDefault(); onProjectContext(item, { x: event.clientX, y: event.clientY }); } }}
                draggable
                onDragStart={(event) => { setDraggedProjectId(item.id); event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(event) => { if (draggedProjectId && draggedProjectId !== item.id) { event.preventDefault(); setDropTargetId(item.id); } }}
                onDragLeave={() => setDropTargetId((current) => (current === item.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedId = event.dataTransfer.getData("text/plain") || draggedProjectId;
                  setDropTargetId(null);
                  if (draggedId) reorderProject(draggedId, item.id);
                }}
                onDragEnd={() => { setDraggedProjectId(null); setDropTargetId(null); }}
              >
                {unseenByProject.get(item.id)! > 0 && (
                  <span className="project-pill-unread" title={`${unseenByProject.get(item.id)} непрочитанных`}>{unseenByProject.get(item.id)}</span>
                )}
                <span className="project-pill-name">{item.name}</span>
                <span className="project-pill-meta">
                  <span className="project-pill-count">{item.todos.filter((todo) => !["done", "archived"].includes(todo.status)).length}</span>
                  <span className="project-pill-props" title="Ключей в props">
                    <Sliders size={10} />{Object.keys(item.props || {}).length}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="entity-strip" role="tablist" aria-label="Разделы проекта">
        <button
          role="tab"
          aria-selected={view === "todo"}
          className={view === "todo" ? "entity-tile is-active" : "entity-tile"}
          style={{ ["--kind-accent" as string]: "#8ab4ff" }}
          onClick={() => go(project.id, "todo")}
        >
          <ListTodo size={17} />
          <b>Todo</b>
          <small>{activeTodos} активно</small>
        </button>
        {visibleEntityOrder.map((kind) => {
          const meta = projectEntityKinds[kind];
          const Icon = meta.icon;
          return (
            <button
              key={kind}
              role="tab"
              aria-selected={view === kind}
              className={view === kind ? "entity-tile is-active" : "entity-tile"}
              style={{ ["--kind-accent" as string]: meta.accent }}
              onClick={() => go(project.id, kind)}
            >
              <Icon size={17} />
              <b>{meta.label}</b>
              <small>{entitySummary(project, kind, memories)}</small>
            </button>
          );
        })}

        {projectFolders.map((folder) => (
          <button
            key={folder.id}
            role="tab"
            aria-selected={view === `folder:${folder.id}`}
            className={view === `folder:${folder.id}` ? "entity-tile is-active" : "entity-tile"}
            style={{ ["--kind-accent" as string]: folder.color || "#9aa5b7" }}
            onClick={() => go(project.id, `folder:${folder.id}` as View)}
          >
            <Folder size={17} />
            <b>{folder.name}</b>
            <small>папка</small>
          </button>
        ))}

        <div className="entity-add-wrap">
          <button className="entity-tile is-add" type="button" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((value) => !value)}>
            <FolderPlus size={17} />
            <b>Папка</b>
            <small>добавить</small>
          </button>
          {addMenuOpen && (
            <div className="entity-add-menu" role="menu">
              {addableEntities.length > 0 && (
                <div className="entity-add-group">
                  <strong>Разделы проекта</strong>
                  {addableEntities.map((kind) => {
                    const meta = projectEntityKinds[kind];
                    const Icon = meta.icon;
                    return (
                      <button key={kind} type="button" role="menuitem" onClick={() => void enableEntity(kind)}>
                        <Icon size={15} style={{ color: meta.accent }} />
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="entity-add-group">
                <strong>Быстрые папки</strong>
                <button type="button" role="menuitem" onClick={() => void createFolder("Посты")}>
                  <Folder size={15} /> Посты
                </button>
                <button type="button" role="menuitem" onClick={() => void createFolder("Документы")}>
                  <Folder size={15} /> Документы
                </button>
              </div>
              <div className="entity-add-group">
                <button type="button" role="menuitem" onClick={() => void createFolder()}>
                  <FolderPlus size={15} /> Своя папка…
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <section className="control-body">
        <header className="control-body-head">
          {/* view может указывать на папку, которой уже нет (переключили проект, папку удалили
              из другой вкладки) — тогда openFolder не находится, но view всё ещё "folder:123", а
              не имя сущности. Раньше это падало в projectEntityKinds[view].label на undefined. */}
          <h2>{view === "todo" ? "Todo" : openFolder ? openFolder.name : (entityKindMeta(view)?.label ?? "Раздел")}<span className="muted"> · {project.name}</span></h2>
          <span className="muted">
            {view === "todo" ? `${activeTodos} активно · ${project.todos.length} всего` : openFolder ? formatBytes(openFolder.memory_bytes) : formatBytes(project.memory_bytes)}
          </span>
          {openFolder && (
            <button className="ghost-action danger-text" type="button" onClick={() => void deleteFolder(openFolder)}>
              <Trash2 size={15} />
              <span>Удалить папку</span>
            </button>
          )}
        </header>
        <div className="project-workspace-main">
          {view === "todo" ? (
            <>
              {renderTodoForm(project)}
              <TodoCardGrid project={project} onSaved={onSaved} />
            </>
          ) : openFolder ? (
            <FolderBoard folder={openFolder} project={project} memories={memories} onSaved={onSaved} />
          ) : view.startsWith("folder:") ? (
            // Ссылка на папку, которой у ЭТОГО проекта уже нет (удалили, переключили проект) —
            // не пытаемся притвориться, что view — это имя сущности, иначе AccessPanel рисуется
            // молча вместо честного «такой папки нет».
            <EmptyState text="Эта папка не найдена — возможно, её удалили или вы смотрите другой проект." />
          ) : renderEntity(project, view as ProjectEntityKind)}
        </div>
      </section>
    </div>
  );
}

function entitySummary(project: Project, kind: ProjectEntityKind, memories: Memory[]) {
  if (kind === "git") return project.git_url ? "указан" : "не указан";
  if (kind === "figma") return project.props?.figma_url ? "указана" : "не указана";
  if (kind === "stack") return `${project.stack.length}`;
  if (kind === "properties") return `${Object.keys(project.props || {}).length}`;
  if (kind === "relations") return `${project.relations.length}`;
  if (kind === "philosophy") return project.props?.philosophy ? "задана" : "пусто";
  if (kind === "deploy") return project.deploy_provider || "не указан";
  if (kind === "memories") {
    const todoIds = new Set(project.todos.map((todo) => todo.id));
    return `${memories.filter((memory) => projectMemoryMatches(memory, project, todoIds)).length}`;
  }
  return project.access_level;
}
