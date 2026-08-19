import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FolderPlus, Folder, ListTodo, Trash2 } from "lucide-react";
import { TodoCardGrid } from "../features/projects/TodoCards";
import { FolderBoard } from "../features/projects/FolderBoard";
import { projectEntityKinds, type ProjectEntityKind } from "../features/tree/entityKinds";
import { formatBytes } from "../lib/format";
import { fetchJson } from "../lib/api";
import { projectMemoryMatches } from "../lib/memory";
import { useWheelToHorizontal } from "../lib/useWheelToHorizontal";
import type { DecisionEntry, FolderRow, Memory, Project } from "../types";
import { EmptyState } from "../ui";

// Кроме восьми постоянных сущностей у проекта могут быть свои папки: folder:<id>.
type View = "todo" | ProjectEntityKind | `folder:${string}`;

const entityOrder: ProjectEntityKind[] = ["git", "figma", "stack", "properties", "relations", "philosophy", "deploy", "access"];

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

export function ProjectsBoard({ projects, query, selectedNodeKey, onSelectedNodeKey, onSaved, renderEntity, renderTodoForm, onProjectContext, folders, memories, decisions }: {
  projects: Project[];
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
  const visible = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.length
      ? projects.filter((project) => {
        const haystack = projectSearchText(project, memories, decisions);
        return tokens.every((token) => haystack.includes(token));
      })
      : projects;
  }, [projects, query, memories, decisions]);

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

  /** Папку, созданную здесь же, здесь же надо и удалять: контекстное меню дерева до неё не достаёт. */
  async function deleteFolder(folder: FolderRow) {
    if (!window.confirm(`Удалить папку «${folder.name}»? Сама папка исчезнет, содержимое проекта останется.`)) return;
    await fetchJson(`/api/mbox/folders/${folder.id}`, { method: "DELETE" });
    go(project.id, "todo");
    onSaved();
  }

  async function createFolder() {
    const name = window.prompt("Название новой папки проекта");
    if (!name?.trim()) return;
    await fetchJson("/api/mbox/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), entity_type: "project", access_level: "private", project_id: project.id, color: project.color || "#2c2c2e" }),
    });
    onSaved();
  }

  return (
    <div className="control-panel">
      <div className="project-rail" ref={railRef} role="tablist" aria-label="Проекты">
        {visible.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={item.id === project.id}
            className={item.id === project.id ? "project-pill is-active" : "project-pill"}
            style={{ ["--project-color" as string]: item.color || "#2c2c2e" }}
            onClick={() => go(item.id, view)}
            onContextMenu={(event) => { if (onProjectContext) { event.preventDefault(); onProjectContext(item, { x: event.clientX, y: event.clientY }); } }}
          >
            <span className="project-pill-dot" />
            <span className="project-pill-name">{item.name}</span>
            <span className="project-pill-count">{item.todos.filter((todo) => !["done", "archived"].includes(todo.status)).length}</span>
          </button>
        ))}
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
        {entityOrder.map((kind) => {
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
              <small>{entitySummary(project, kind)}</small>
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

        <button className="entity-tile is-add" type="button" onClick={createFolder}>
          <FolderPlus size={17} />
          <b>Папка</b>
          <small>создать</small>
        </button>
      </div>

      <section className="control-body">
        <header className="control-body-head">
          <h2>{view === "todo" ? "Todo" : openFolder ? openFolder.name : projectEntityKinds[view as ProjectEntityKind].label}<span className="muted"> · {project.name}</span></h2>
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
          ) : renderEntity(project, view as ProjectEntityKind)}
        </div>
      </section>
    </div>
  );
}

function entitySummary(project: Project, kind: ProjectEntityKind) {
  if (kind === "git") return project.git_url ? "указан" : "не указан";
  if (kind === "figma") return project.props?.figma_url ? "указана" : "не указана";
  if (kind === "stack") return `${project.stack.length}`;
  if (kind === "properties") return `${Object.keys(project.props || {}).length}`;
  if (kind === "relations") return `${project.relations.length}`;
  if (kind === "philosophy") return project.props?.philosophy ? "задана" : "пусто";
  if (kind === "deploy") return project.deploy_provider || "не указан";
  return project.access_level;
}
