import { StrictMode, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  BookOpen,
  Clock3,
  Database,
  Flag,
  Eye,
  EyeOff,
  FolderKanban,
  GitBranch,
  History,
  KeyRound,
  LockKeyhole,
  Plus,
  Server,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { BottomNav } from "./components/BottomNav";
import { FolderTree, type FolderTreeNode } from "./components/FolderTree";
import { TopBar, type AgentRosterEntry } from "./components/TopBar";
import { AgentAvatar } from "./components/AgentAvatar";
import { RUN_STALE_MS, agentFamily, effectiveStatus, isAgentWorking, liveRunOf } from "./lib/agents";
import { fetchJson, saveEntity } from "./lib/api";
import { formatBytes, formatDateTime, formatSince, plural } from "./lib/format";
import { agentStatusLabels, auditNotice, projectName, todoPriorityLabel, todoPriorityLabels, todoStatusHint, todoStatusLabel, todoStatusLabels } from "./lib/labels";
import { findNodeByRouteKey, nodeFromLocation, nodeRouteKey, queryFromLocation, routeFor, sectionFromLocation } from "./lib/routing";
import { filterTree, formatProps, parseProps, projectToTree, rollupBytes, sortTodos } from "./lib/tree";
import { sections } from "./app/sections";
import { OfflineBanner, ShellLoading } from "./app/ShellStates";
import { LoginScreen } from "./pages/LoginScreen";
import { Overview } from "./pages/Overview";
import { MemoryBoard } from "./pages/Memories";
import { ArtifactsBoard } from "./pages/Artifacts";
import { EntityPreview, TreeContextMenu, type TreeMenuState } from "./features/tree/TreeContextMenu";
import { ProjectsBoard } from "./pages/Projects";
import { AgentChat } from "./features/agents/AgentChat";
import { AddTodoForm, TodoCardGrid } from "./features/projects/TodoCards";
import { ProjectEntityView } from "./features/projects/EntityPanels";
import type { ProjectEntityKind } from "./features/tree/entityKinds";
import { EmptyState, ManualForm, Panel } from "./ui";
import { bootstrapSeen, countUnseen, loadSeen, onSeenChange } from "./lib/seen";
import { useMboxData } from "./hooks/useMboxData";
import { useRealtime } from "./hooks/useRealtime";
import type {
  AgentActivity, AgentInboxItem, AgentRun, Artifact, AuditEvent, DecisionEntry, FolderRow,
  GraphEdge, GroqUsage, Me, Memory, Project,
  SecretSummary, SectionKey, ServerMetrics, Todo,
} from "./types";
import "./styles.css";

function App() {
  const [me, setMe] = useState<Me>({ user: null });
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    fetchJson<Me>("/api/mbox/auth/me")
      .then(setMe)
      .catch(() => setMe({ user: null }))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) return <ShellLoading />;
  if (!me.user) return <LoginScreen onLogin={setMe} />;
  return <Workspace user={me.user} onLogout={() => setMe({ user: null })} />;
}
function Workspace({ user, onLogout }: { user: { username: string; role: string }; onLogout: () => void }) {
  const [section, setSectionState] = useState<SectionKey>(() => sectionFromLocation());
  const [query, setQueryState] = useState(() => queryFromLocation());
  const [selectedNodeKey, setSelectedNodeKeyState] = useState(() => nodeFromLocation());
  const data = useMboxData(query, onLogout);
  const realtime = useRealtime(data.reload);
  const agentNotices = useMemo(
    () => [...realtime.notices, ...data.auditEvents.slice(0, 12).map(auditNotice)].slice(0, 12),
    [realtime.notices, data.auditEvents],
  );
  // Текст и цвет пилюли раньше считались двумя независимыми useMemo с разными приоритетами:
  // текст мог кричать «4 заблокировано» (статичный бэклог), пока цвет красился в спокойный
  // «connected», потому что не знал о блокировках вовсе — статус жил своей жизнью отдельно
  // от происходящего. Теперь один расчёт: живое сейчас (кто-то реально работает) стоит выше
  // статичных счётчиков бэклога, а counted-состояния получают свой тревожный цвет пилюли.
  const headerStatus = useMemo(() => {
    if (realtime.state === "offline") return { state: "offline" as const, label: "Нет связи с сервером" };
    if (realtime.state === "connecting") return { state: "connecting" as const, label: realtime.label };

    // Пилюля в шапке — про постоянных агентов (Джарвис/Claude/Codex), не про человека (Admin
    // тоже "на связи", пока открыт сайт) и не про разовые debug/smoke-сессии.
    const knownAgents = data.agents.filter((agent) => agentFamily(agent.name));
    const working = knownAgents.filter((agent) => isAgentWorking(agent, data.runs));
    const needsHuman = data.inbox.filter((item) => item.requires_human && item.status !== "done");
    const onReview = data.projects.reduce((sum, project) => sum + project.todos.filter((todo) => todo.status === "review").length, 0);
    const blocked = data.projects.reduce((sum, project) => sum + project.todos.filter((todo) => todo.status === "blocked").length, 0);
    const leased = data.projects.flatMap((project) => project.todos).filter((todo) => todo.claimed_by && todo.claimed_until && new Date(todo.claimed_until) > new Date());
    // Упавшая сессия интересна, пока свежая: недельной давности падение — это уже история, а не статус.
    const failedRun = data.runs.find((run) => run.status === "failed" && Date.now() - Date.parse(run.heartbeat_at || run.started_at) < RUN_STALE_MS);

    if (needsHuman.length) return { state: "attention" as const, label: `Нужен ты: ${needsHuman[0].title}` };
    if (failedRun) return { state: "attention" as const, label: `${failedRun.agent_name}: сессия упала` };

    // Живое важнее статичного бэклога: пока кто-то реально работает, пилюля показывает это,
    // а не число заблокированных задач, которое никуда не денется само по себе.
    if (working.length === 1) {
      const goal = liveRunOf(data.runs, working[0].name)?.goal;
      return { state: "working" as const, label: goal ? `${working[0].name}: ${goal}` : `${working[0].name} в работе` };
    }
    if (working.length > 1) return { state: "working" as const, label: `${working.length} агента в работе: ${working.map((agent) => agent.name).join(", ")}` };

    if (blocked) return { state: "attention" as const, label: `${blocked} ${plural(blocked, "задача заблокирована", "задачи заблокированы", "задач заблокировано")}` };
    if (onReview) return { state: "attention" as const, label: `${onReview} ${plural(onReview, "задача ждёт", "задачи ждут", "задач ждут")} проверки` };
    if (leased.length) return { state: "connected" as const, label: `${leased[0].claimed_by} держит «${leased[0].title}»` };

    // Кто просто "на связи" / "тишина" — это состав, не событие: место ему в консоли (заголовок
    // чата), не в шапке страницы. Раньше пилюля в шапке дублировала ростер консоли тем же текстом
    // ("2 агента на связи: Claude, Джарвис") — теперь шапка молчит, если сказать нечего.
    return { state: "connected" as const, label: "MBOX" };
  }, [realtime.state, realtime.label, data.agents, data.inbox, data.projects, data.runs]);
  const agentLabel = headerStatus.label;
  const headerState = headerStatus.state;
  // Раньше пилюля просто кричала «N заблокировано» без единого способа что-то с этим сделать —
  // «вижу и ничего не могу». Список конкретных задач с переходом закрывает это: клик ведёт прямо
  // в кабан нужного проекта, где карточку можно перетащить в другую колонку.
  const attentionTodos = useMemo(
    () => data.projects.flatMap((project) => project.todos
      .filter((todo) => todo.status === "blocked" || todo.status === "review")
      .map((todo) => ({ id: todo.id, title: todo.title, status: todo.status, projectId: project.id, projectName: project.name }))),
    [data.projects],
  );
  const agentRoster = useMemo<AgentRosterEntry[]>(() => data.agents.map((agent) => {
    const status = effectiveStatus(agent);
    const live = liveRunOf(data.runs, agent.name);
    return {
      id: agent.id,
      name: agent.name,
      status,
      live: Boolean(live),
      statusLabel: agentStatusLabels[status] || status,
      detail: live?.goal,
      since: formatSince(agent.last_seen),
    };
  }), [data.agents, data.runs]);

  const [seenTick, setSeenTick] = useState(0);
  useEffect(() => onSeenChange(() => setSeenTick((value) => value + 1)), []);

  const todoMarks = useMemo(
    () => data.projects.flatMap((project) => project.todos.map((todo) => ({ key: `todo:${todo.id}`, bytes: todo.memory_bytes }))),
    [data.projects],
  );

  // Сначала тянем отметки из базы, и только потом решаем, что считать новым.
  useEffect(() => { void loadSeen(); }, []);

  useEffect(() => {
    if (todoMarks.length) bootstrapSeen(todoMarks);
  }, [todoMarks, seenTick]);

  const [projectMenu, setProjectMenu] = useState<TreeMenuState | null>(null);
  useEffect(() => onSeenChange(() => setSeenTick((value) => value + 1)), []);
  const unseenTodos = useMemo(() => countUnseen(todoMarks), [todoMarks, seenTick]);

  const setRoute = useCallback((nextSection: SectionKey, nextQuery = query, nextNodeKey = selectedNodeKey, mode: "push" | "replace" = "push") => {
    setSectionState(nextSection);
    setQueryState(nextQuery);
    setSelectedNodeKeyState(nextNodeKey);
    const nextUrl = routeFor(nextSection, nextQuery, nextNodeKey);
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", nextUrl);
    }
  }, [query, selectedNodeKey]);

  const setSection = useCallback((nextSection: SectionKey) => setRoute(nextSection, query, "", "push"), [query, setRoute]);
  const setQuery = useCallback((nextQuery: string) => setRoute(section, nextQuery, selectedNodeKey, "replace"), [section, selectedNodeKey, setRoute]);
  const setSelectedNodeKey = useCallback((nextNodeKey: string) => setRoute(section, query, nextNodeKey, "replace"), [section, query, setRoute]);

  useEffect(() => {
    function syncFromLocation() {
      setSectionState(sectionFromLocation());
      setQueryState(queryFromLocation());
      setSelectedNodeKeyState(nodeFromLocation());
    }
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, []);

  const currentProjectName = section === "projects" && selectedNodeKey
    ? data.projects.find((project) => project.id === selectedNodeKey.split(":")[0])?.name
    : undefined;

  return (
    <div className="app dark">
      <main className="workspace">
        <TopBar
          query={query}
          onQueryChange={setQuery}
          realtimeState={headerState}
          realtimeLabel={agentLabel}
          notice={realtime.notice}
          notices={agentNotices}
          roster={agentRoster}
          attentionTodos={attentionTodos}
          onOpenTodo={(projectId) => setRoute("projects", query, `${projectId}:todo`, "push")}
          busy={data.loading || headerState === "working"}
        />
        {data.offline && <OfflineBanner onRetry={data.reload} />}
        {data.loading && <p className="muted empty-state">Загрузка данных</p>}
        {section === "overview" && <Overview data={data} onOpenProject={(projectId) => setRoute("projects", query, `${projectId}:todo`, "push")} />}
        {section === "memories" && <MemoryBoard memories={data.memories} projects={data.projects} decisions={data.decisions} onSaved={data.reload} />}
        {section === "artifacts" && <ArtifactsBoard artifacts={data.artifacts} folders={data.folders} projects={data.projects} query={query} selectedNodeKey={selectedNodeKey} onSelectedNodeKey={setSelectedNodeKey} onSaved={data.reload} />}
        {section === "projects" && <ProjectsBoard projects={data.projects} companies={data.companies} folders={data.folders} memories={data.memories} decisions={data.decisions} query={query} selectedNodeKey={selectedNodeKey} onSelectedNodeKey={setSelectedNodeKey} onSaved={data.reload} renderEntity={(project, kind: ProjectEntityKind) => <ProjectEntityView project={project} projects={data.projects} memories={data.memories} kind={kind} onSaved={data.reload} />} renderTodoForm={(project) => <AddTodoForm project={project} onSaved={data.reload} />} onProjectContext={(project, position) => setProjectMenu({ node: { id: project.id, type: "project", name: project.name, color: project.color }, position })} />}
        {section === "history" && <HistoryBoard events={data.auditEvents} />}
        {section === "settings" && (
          <SettingsBoard
            server={<ServerBoard pulse={realtime.pulse} />}
            access={<AccessBoard user={user} secrets={data.secrets} agents={data.agents} projects={data.projects} inbox={data.inbox} runs={data.runs} decisions={data.decisions} onSaved={data.reload} onLogout={onLogout} />}
          />
        )}
      </main>
      <AgentChat inbox={data.inbox} agents={data.agents} runs={data.runs} projects={data.projects} artifacts={data.artifacts} projectId={data.projects.find((project) => project.name === "MBOX")?.id} currentProjectName={currentProjectName} onSaved={data.reload} />
      {projectMenu && <TreeContextMenu state={projectMenu} projects={data.projects} onClose={() => setProjectMenu(null)} onSaved={data.reload} />}
      <BottomNav sections={sections} activeSection={section} onSelect={setSection} hrefFor={(key) => routeFor(key, key === section ? query : "")} badges={{ projects: unseenTodos }} />
    </div>
  );
}
function ProjectInspector({ node, projects, fallbackProject, onColorChange, onSaved }: { node: FolderTreeNode | null; projects: Project[]; fallbackProject?: Project; onColorChange: (projectId: string, color: string) => void; onSaved: () => void }) {
  if (node?.type === "project_entity" && node.id && node.entityKind) {
    const project = projects.find((item) => item.id === node.id);
    if (project) return <ProjectEntityView project={project} projects={projects} memories={[]} kind={node.entityKind} onSaved={onSaved} />;
  }

  if (node?.type === "todo" && node.id) {
    const project = projects.find((item) => item.todos.some((todo) => todo.id === node.id));
    const todo = project?.todos.find((item) => item.id === node.id);
    if (project && todo) return <TodoNote project={project} todo={todo} onSaved={onSaved} />;
  }

  if (node?.type === "todo_group" && node.id) {
    const project = projects.find((item) => item.id === node.id);
    if (project) return <ProjectTodoCards project={project} onSaved={onSaved} />;
  }

  if (node?.type === "project" && node.id) {
    const project = projects.find((item) => item.id === node.id);
    if (project) return <ProjectTodoNotes project={project} projects={projects} onColorChange={onColorChange} onSaved={onSaved} />;
  }

  if (node) return <EntityPreview node={node} />;
  return <ProjectTodoNotes project={fallbackProject} projects={projects} onColorChange={onColorChange} onSaved={onSaved} />;
}
function ProjectTodoNotes({ project, projects, onColorChange, onSaved }: { project?: Project; projects: Project[]; onColorChange: (projectId: string, color: string) => void; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setNote(project?.todos[0]?.note ?? "");
    setSaveState("idle");
  }, [project]);

  if (!project) return <EmptyState text="Выбери проект или todo в дереве" />;

  return (
    <div className="note-editor">
      <div className="entity-line">
        <strong>{project.name}</strong>
        <span>{formatBytes(project.memory_bytes)}</span>
      </div>
      <label className="color-control">
        <span>Фон проекта</span>
        <input type="color" value={project.color || "#2c2c2e"} onChange={(event) => onColorChange(project.id, event.target.value)} />
      </label>
      <ProjectRelationForm project={project} projects={projects} onSaved={onSaved} />
      <ProjectPropsEditor project={project} onSaved={onSaved} />
      <TodoForm projects={[project]} onSaved={onSaved} />
      <TodoStatusGuide />
      <textarea className="project-notes" value={note} onChange={(event) => {
        setNote(event.target.value);
        setSaveState("idle");
      }} placeholder="Заметка проекта" />
      <button className="primary-action compact-submit" type="button" disabled={saveState === "saving"} onClick={async () => {
        const todo = project.todos[0];
        if (!todo) return;
        setSaveState("saving");
        try {
          await fetchJson(`/api/mbox/todos/${todo.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note }),
          });
          setSaveState("saved");
          onSaved();
        } catch {
          setSaveState("error");
        }
      }}>{saveState === "saving" ? "Сохраняю" : saveState === "saved" ? "Сохранено" : saveState === "error" ? "Ошибка" : "Сохранить заметку"}</button>
    </div>
  );
}
function ProjectTodoCards({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const activeCount = project.todos.filter((todo) => !["done", "archived"].includes(todo.status)).length;

  return (
    <div className="todo-card-board">
      <div className="entity-line">
        <strong>Todo · {project.name}</strong>
        <span>{activeCount} активно · {project.todos.length} всего</span>
      </div>
      <TodoForm projects={[project]} onSaved={onSaved} />
      <TodoCardGrid project={project} onSaved={onSaved} />
    </div>
  );
}
function ProjectRelationForm({ project, projects, onSaved }: { project: Project; projects: Project[]; onSaved: () => void }) {
  const available = projects.filter((item) => item.id !== project.id);
  const [targetId, setTargetId] = useState(available[0]?.id ?? "");
  const [edgeType, setEdgeType] = useState("related");
  const [groupEntity, setGroupEntity] = useState("");
  const [owner, setOwner] = useState("");
  const [strength, setStrength] = useState(1);
  const [description, setDescription] = useState("");

  useEffect(() => {
    setTargetId(available[0]?.id ?? "");
  }, [project.id, projects]);

  async function addRelation() {
    if (!targetId) return;
    await fetchJson("/api/mbox/graph/edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_id: project.id, to_id: targetId, edge_type: edgeType, group_entity: groupEntity, owner, strength, description }),
    });
    setDescription("");
    onSaved();
  }

  async function removeRelation(id: string) {
    await fetchJson(`/api/mbox/graph/edges/${id}`, { method: "DELETE" });
    onSaved();
  }

  return (
    <div className="project-relations">
      <div className="relation-form">
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          {available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <input value={edgeType} onChange={(event) => setEdgeType(event.target.value)} placeholder="Связь или большая сущность" />
        <input value={groupEntity} onChange={(event) => setGroupEntity(event.target.value)} placeholder="Группа" />
        <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Владелец" />
        <input value={String(strength)} onChange={(event) => setStrength(Number(event.target.value) || 1)} placeholder="Сила" />
        <button className="primary-action compact-submit" type="button" onClick={addRelation}>Связать</button>
      </div>
      <textarea className="relation-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Почему эти проекты связаны" />
      {project.relations.length ? (
        <div className="relation-list">
          {project.relations.map((relation) => {
            const other = relation.from_project_id === project.id ? relation.to_project_name : relation.from_project_name;
            return (
              <div className="relation-chip" key={relation.id}>
                <span>{relation.edge_type} · {other}{relation.group_entity ? ` · ${relation.group_entity}` : ""}{relation.owner ? ` · ${relation.owner}` : ""}</span>
                <button type="button" onClick={() => removeRelation(relation.id)}>Удалить</button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
function ProjectPropsEditor({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [propsText, setPropsText] = useState(formatProps(project.props || {}));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setPropsText(formatProps(project.props || {}));
    setSaveState("idle");
  }, [project]);

  return (
    <div className="project-props-editor">
      <textarea value={propsText} onChange={(event) => {
        setPropsText(event.target.value);
        setSaveState("idle");
      }} placeholder={"Свойства проекта\nкомпания: Вокруг света\nтип: рабочий\nроль: клиентский проект"} />
      <button className="primary-action compact-submit" type="button" disabled={saveState === "saving"} onClick={async () => {
        setSaveState("saving");
        try {
          await fetchJson(`/api/mbox/projects/${project.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ props: parseProps(propsText) }),
          });
          setSaveState("saved");
          onSaved();
        } catch {
          setSaveState("error");
        }
      }}>{saveState === "saving" ? "Сохраняю" : saveState === "saved" ? "Сохранено" : saveState === "error" ? "Ошибка" : "Сохранить свойства"}</button>
    </div>
  );
}
function TodoNote({ project, todo, onSaved }: { project: Project; todo: Todo; onSaved: () => void }) {
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note);
  const [status, setStatus] = useState(todo.status);
  const [priority, setPriority] = useState(todo.priority);
  const [propsText, setPropsText] = useState(formatProps(todo.props || {}));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setTitle(todo.title);
    setNote(todo.note);
    setStatus(todo.status);
    setPriority(todo.priority);
    setPropsText(formatProps(todo.props || {}));
    setSaveState("idle");
  }, [todo]);

  async function saveTodo() {
    setSaveState("saving");
    try {
      await fetchJson(`/api/mbox/todos/${todo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, note, status, priority, props: parseProps(propsText) }),
      });
      setSaveState("saved");
      onSaved();
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="iphone-note">
      <div className="note-project-pill">{project.name} · {formatBytes(todo.memory_bytes)}</div>
      <input className="note-title-input" value={title} onChange={(event) => {
        setTitle(event.target.value);
        setSaveState("idle");
      }} />
      <div className="note-controls">
        <select value={status} onChange={(event) => {
          setStatus(event.target.value);
          setSaveState("idle");
        }}>
          {Object.entries(todoStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={priority} onChange={(event) => {
          setPriority(event.target.value);
          setSaveState("idle");
        }}>
          {Object.entries(todoPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <textarea className="todo-props-field" value={propsText} onChange={(event) => {
        setPropsText(event.target.value);
        setSaveState("idle");
      }} placeholder={"Свойства todo\nконтекст: интерфейс\nкритерий: удобно с телефона и ПК\nзависит от: доступ к базе"} />
      <textarea className="project-notes iphone-note-body" value={note} onChange={(event) => {
        setNote(event.target.value);
        setSaveState("idle");
      }} placeholder="Заметка todo" />
      <button className="primary-action compact-submit sticky-save" type="button" disabled={saveState === "saving"} onClick={saveTodo}>{saveState === "saving" ? "Сохраняю" : saveState === "saved" ? "Сохранено" : saveState === "error" ? "Ошибка" : "Сохранить заметку"}</button>
    </div>
  );
}
function TodoStatusGuide() {
  return (
    <div className="todo-guide" title="Машинные коды сохранены в API: open, next, doing, blocked, review, done, archived; priority: low, normal, high, urgent">
      <span><Clock3 size={14} /> Новая</span>
      <span><Flag size={14} /> Следующая</span>
      <span><GitBranch size={14} /> В работе</span>
      <span><LockKeyhole size={14} /> Заблокирована</span>
      <span><Eye size={14} /> На проверке</span>
      <span><ShieldCheck size={14} /> Готово</span>
      <span>Низкий</span>
      <span>Обычный</span>
      <span>Высокий</span>
      <span>Срочно</span>
    </div>
  );
}
function RelationsBoard({ edges, projects, onSaved }: { edges: GraphEdge[]; projects: Project[]; onSaved: () => void }) {
  const [fromId, setFromId] = useState(projects[0]?.id ?? "");
  const [toId, setToId] = useState(projects.find((project) => project.id !== fromId)?.id ?? "");
  const [edgeType, setEdgeType] = useState("related");

  useEffect(() => {
    setFromId(projects[0]?.id ?? "");
  }, [projects]);

  useEffect(() => {
    setToId(projects.find((project) => project.id !== fromId)?.id ?? "");
  }, [fromId, projects]);

  async function createEdge() {
    if (!fromId || !toId || fromId === toId) return;
    await fetchJson("/api/mbox/graph/edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_id: fromId, to_id: toId, edge_type: edgeType }),
    });
    onSaved();
  }

  async function deleteEdge(id: string) {
    await fetchJson(`/api/mbox/graph/edges/${id}`, { method: "DELETE" });
    onSaved();
  }

  return (
    <div className="content-grid relations-page">
      <Panel title="Связи" icon={GitBranch}>
        <div className="relation-entity-form">
          <select value={fromId} onChange={(event) => setFromId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select value={toId} onChange={(event) => setToId(event.target.value)}>
            {projects.filter((project) => project.id !== fromId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <input value={edgeType} onChange={(event) => setEdgeType(event.target.value)} placeholder="тип или большая сущность" />
          <button className="primary-action compact-submit" type="button" onClick={createEdge}>Создать связь</button>
        </div>
        <div className="agent-contract">
          <strong>Контракт агента</strong>
          <p>Перед работой агент читает структуру, контекст проекта, связи, todo и историю. Новые решения, связи и выполненные шаги он записывает обратно в MBOX без напоминаний.</p>
          <code>describe_structure → list_project_context → get_next_task → set_task_status</code>
        </div>
      </Panel>
      <Panel title="Карта связей" icon={GitBranch}>
        {edges.length ? (
          <div className="relation-rows">
            {edges.map((edge) => (
              <div className="relation-row" key={edge.id}>
                <div>
                  <strong>{edge.from_label} → {edge.to_label}</strong>
                  <span>{edge.edge_type}</span>
                </div>
                <button type="button" onClick={() => deleteEdge(edge.id)}>Удалить</button>
              </div>
            ))}
          </div>
        ) : <EmptyState text="Связей пока нет" />}
      </Panel>
    </div>
  );
}
function consoleTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function HistoryBoard({ events }: { events: AuditEvent[] }) {
  return (
    <Panel title="История" icon={History} className="panel-bare">
      <div className="console" role="log" aria-label="Журнал аудита">
        <div className="console-bar">
          <span className="console-title">mbox — журнал аудита</span>
          <span className="console-count">{events.length} {plural(events.length, "событие", "события", "событий")}</span>
        </div>
        <div className="console-body">
          {events.length ? events.map((event) => (
            <div className={`console-line act-${(event.action || "").toLowerCase()}`} key={event.id}>
              <span className="console-line-top">
                <span className="c-time">{consoleTime(event.created_at)}</span>
                <span className="c-actor">{event.actor || "system"}</span>
                <span className="c-act">{event.action}</span>
              </span>
              <span className="c-entity">{event.entity_type}{event.entity_id ? `#${event.entity_id}` : ""}</span>
              <span className="c-msg">{event.summary || "—"}</span>
            </div>
          )) : <div className="console-line muted"><span className="c-msg">— журнал пуст —</span></div>}
        </div>
      </div>
    </Panel>
  );
}
/** Сервер и Доступ раньше были двумя кнопками нижнего меню — сведены в одну «Настройки» с
 * внутренним переключателем, задача стояла с самого начала переверстки и не отменялась. */
function SettingsBoard({ server, access }: { server: ReactNode; access: ReactNode }) {
  const [tab, setTab] = useState<"server" | "access">("server");
  return (
    <div className="settings-board">
      <div className="settings-tabs" role="tablist" aria-label="Настройки">
        <button role="tab" aria-selected={tab === "server"} className={tab === "server" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("server")}>
          <Server size={16} /> Сервер
        </button>
        <button role="tab" aria-selected={tab === "access"} className={tab === "access" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("access")}>
          <ShieldCheck size={16} /> Доступ
        </button>
      </div>
      {tab === "server" ? server : access}
    </div>
  );
}

function ServerBoard({ pulse }: { pulse: number }) {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [usage, setUsage] = useState<GroqUsage | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      const data = await fetchJson<{ metrics: ServerMetrics | null }>("/api/mbox/server");
      if (alive) setMetrics(data.metrics);
      const groq = await fetchJson<GroqUsage>("/api/mbox/agent/groq-usage");
      if (alive) setUsage(groq);
    }
    load();
    return () => {
      alive = false;
    };
  }, [pulse]);

  const usagePanel = usage && (
    <Panel title="Джарвис / Groq" icon={Zap}>
      <div className="entity-list">
        <EntityLine title="Токенов сегодня" value={Number(usage.tokens_today).toLocaleString("ru-RU")} />
        <EntityLine title="Токенов за 24ч" value={Number(usage.tokens_24h).toLocaleString("ru-RU")} />
        <EntityLine title="Токенов всего" value={Number(usage.total_tokens).toLocaleString("ru-RU")} />
        <EntityLine title="Вызовов за 24ч" value={String(usage.calls_24h)} />
        <EntityLine title="Вызовов всего" value={String(usage.calls_total)} />
        <EntityLine title="Последний вызов" value={usage.last_call_at ? formatDateTime(usage.last_call_at) : "ещё не было"} />
      </div>
    </Panel>
  );

  if (!metrics) {
    return (
      <div className="content-grid server-grid">
        <Panel title="Сервер" icon={Server}>
          <EmptyState text="Ожидание метрик сервера" />
        </Panel>
        {usagePanel}
      </div>
    );
  }

  return (
    <div className="content-grid server-grid">
      <Panel title="Сервер" icon={Server}>
        <div className="entity-list">
          <EntityLine title="Хост" value={metrics.hostname} />
          <EntityLine title="Load" value={String(metrics.load_1)} />
          <EntityLine title="CPU" value={`${Number(metrics.cpu_percent).toFixed(0)}%`} />
          <EntityLine title="RAM" value={`${metrics.memory_used_mb} / ${metrics.memory_total_mb} MB`} />
          <EntityLine title="Диск" value={`${metrics.disk_used_mb} / ${metrics.disk_total_mb} MB`} />
          <EntityLine title="Обновлено" value={formatDateTime(metrics.captured_at)} />
        </div>
      </Panel>
      <Panel title="Контейнеры" icon={Database}>
        <div className="entity-list">
          {metrics.docker_containers.map((container) => (
            <EntityLine key={container.ID ?? container.Names} title={container.Names ?? "container"} value={container.Status ?? "unknown"} />
          ))}
        </div>
      </Panel>
      {usagePanel}
    </div>
  );
}
function ProjectForm({ onSaved }: { onSaved: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [stack, setStack] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [deployProvider, setDeployProvider] = useState("Docker");
  const [deployTarget, setDeployTarget] = useState("");
  const [props, setProps] = useState("");
  const [color, setColor] = useState("#2c2c2e");

  return (
    <ManualForm title="Добавить или править проект" onSubmit={async () => {
      await saveEntity("/api/mbox/projects", id, {
        name,
        stack: stack.split(",").map((item) => item.trim()).filter(Boolean),
        git_url: gitUrl,
        deploy_provider: deployProvider,
        deploy_target: deployTarget,
        props: parseProps(props),
        color,
        status: "active",
        access_level: "private",
      });
      setId("");
      setName("");
      setProps("");
      onSaved();
    }}>
      <input value={id} onChange={(event) => setId(event.target.value)} placeholder="ID для правки" />
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Название" />
      <input value={stack} onChange={(event) => setStack(event.target.value)} placeholder="Стек через запятую" />
      <input value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} placeholder="Git" />
      <input value={deployProvider} onChange={(event) => setDeployProvider(event.target.value)} placeholder="Деплой" />
      <input value={deployTarget} onChange={(event) => setDeployTarget(event.target.value)} placeholder="Сервер или Vercel" />
      <textarea value={props} onChange={(event) => setProps(event.target.value)} placeholder={"Свойства\nкомпания: Вокруг света\nтип: рабочий\nроль: клиентский проект"} />
      <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
    </ManualForm>
  );
}
function TodoForm({ projects, onSaved }: { projects: Project[]; onSaved: () => void }) {
  const [id, setId] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [props, setProps] = useState("");
  const [status, setStatus] = useState("open");
  const [priority, setPriority] = useState("normal");

  useEffect(() => {
    setProjectId(projects[0]?.id ?? "");
  }, [projects]);

  return (
    <ManualForm title="Добавить или править todo" onSubmit={async () => {
      await saveEntity("/api/mbox/todos", id, { project_id: projectId, title, note, props: parseProps(props), status, priority, access_level: "private" });
      setId("");
      setTitle("");
      setNote("");
      setProps("");
      onSaved();
    }}>
      <input value={id} onChange={(event) => setId(event.target.value)} placeholder="ID для правки" />
      <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Todo" />
      <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Заметка" />
      <textarea value={props} onChange={(event) => setProps(event.target.value)} placeholder={"Свойства todo\nконтекст: интерфейс\nкритерий: удобно с телефона и ПК"} />
      <select value={status} onChange={(event) => setStatus(event.target.value)}>
        {Object.entries(todoStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <select value={priority} onChange={(event) => setPriority(event.target.value)}>
        {Object.entries(todoPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </ManualForm>
  );
}
function AccessBoard({ user, secrets, agents, projects, inbox, runs, decisions, onSaved, onLogout }: { user: { username: string; role: string }; secrets: SecretSummary[]; agents: AgentActivity[]; projects: Project[]; inbox: AgentInboxItem[]; runs: AgentRun[]; decisions: DecisionEntry[]; onSaved: () => void; onLogout: () => void }) {
  const [items, setItems] = useState(secrets);
  const [formOpen, setFormOpen] = useState(false);
  const [editingSecret, setEditingSecret] = useState<SecretSummary | null>(null);

  useEffect(() => {
    setItems(secrets);
  }, [secrets]);

  async function addSecret(secret: NewSecret) {
    const response = await fetchJson<{ secret: SecretSummary }>("/api/mbox/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(secret),
    });
    setItems((current) => [response.secret, ...current]);
    setFormOpen(false);
    onSaved();
  }

  async function editSecret(secretId: string, secret: NewSecret) {
    await fetchJson<{ secret: SecretSummary }>(`/api/mbox/secrets/${secretId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(secret),
    });
    setEditingSecret(null);
    onSaved();
  }

  async function setAgentAccess(secretId: string, approved: boolean) {
    const approvedUntil = new Date(Date.now() + 1000 * 60 * 60 * 6).toISOString();
    await fetchJson(`/api/mbox/secrets/${secretId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_share_state: approved ? "approved" : "locked", approved_until: approved ? approvedUntil : null }),
    });
    onSaved();
  }

  return (
    <div className="content-grid settings-grid">
      <Panel title="Аккаунтинг" icon={ShieldCheck}>
        <div className="entity-list">
          <EntityLine title="Пользователь" value={`${user.username} · ${user.role}`} />
          <EntityLine title="Регистрация" value="отключена" />
          <EntityLine title="Права" value="private / agents / public" />
          <button className="primary-action" onClick={async () => {
            await fetch("/api/mbox/auth/logout", { method: "POST" });
            onLogout();
          }}>Выйти</button>
        </div>
      </Panel>
      <Panel title="Агенты" icon={GitBranch}>
        <div className="entity-list">
          {agents.length ? agents.map((agent) => {
            const status = effectiveStatus(agent);
            const working = isAgentWorking(agent, runs);
            return (
              <div className="agent-row" key={agent.id}>
                <div className="agent-row-id">
                  <AgentAvatar name={agent.name} status={status} live={working} size={40} />
                  <div>
                    <strong>{agent.name}</strong>
                    <span>{agent.kind}{agent.client ? ` · ${agent.client}` : ""} · {agent.scope}</span>
                  </div>
                </div>
                <div className="agent-status">
                  <span className={`agent-state ${working ? "working" : status}`}>{working ? "в работе" : agentStatusLabels[status] || status}</span>
                  <small>{agent.active_sessions} сессий · {agent.events} действий · {formatSince(agent.last_seen)}</small>
                </div>
              </div>
            );
          }) : <EmptyState text="Агенты пока не подключались" />}
        </div>
      </Panel>
      <Panel title="Inbox агента" icon={BookOpen}>
        <div className="agent-entity-list">
          {inbox.length ? inbox.slice(0, 8).map((item) => (
            <div className={item.requires_human ? "agent-entity-row needs-human" : "agent-entity-row"} key={item.id}>
              <strong>{item.title}</strong>
              <span>{item.agent_name} · {item.item_type} · {item.status} · {item.priority} · {formatBytes(item.memory_bytes)}</span>
              {item.body && <p>{item.body}</p>}
            </div>
          )) : <EmptyState text="Inbox агента пуст" />}
        </div>
      </Panel>
      <Panel title="Agent run log" icon={History}>
        <div className="agent-entity-list">
          {runs.length ? runs.slice(0, 8).map((run) => (
            <div className="agent-entity-row" key={run.id}>
              <strong>{run.goal || `Run #${run.id}`}</strong>
              <span>{run.agent_name} · {run.status} · файлов: {Array.isArray(run.touched_files) ? run.touched_files.length : 0} · {formatBytes(run.memory_bytes)}</span>
              {run.result && <p>{run.result}</p>}
            </div>
          )) : <EmptyState text="Run log пуст" />}
        </div>
      </Panel>
      <Panel title="Decision log" icon={Flag}>
        <div className="agent-entity-list">
          {decisions.length ? decisions.slice(0, 8).map((decision) => (
            <div className="agent-entity-row" key={decision.id}>
              <strong>{decision.title}</strong>
              <span>{decision.actor} · {formatBytes(decision.memory_bytes)}</span>
              <p>{decision.decision || decision.rationale}</p>
            </div>
          )) : <EmptyState text="Решений пока нет" />}
        </div>
      </Panel>
      <Panel title="Инструкция AI" icon={BookOpen}>
        <div className="agent-guide">
          <div>
            <strong>Перед работой</strong>
            <span>/api/mbox/agent/structure, затем /api/mbox/projects, затем /api/mbox/history</span>
          </div>
          <div>
            <strong>Задачи</strong>
            <span>Todo MBOX хранятся в проекте MBOX. Активная задача обновляется через PATCH /api/mbox/todos/:id.</span>
          </div>
          <div>
            <strong>Связи</strong>
            <span>Связанные проекты фиксируются отдельной сущностью graph_edges, а не только текстом в заметке.</span>
          </div>
          <div>
            <strong>Контекст</strong>
            <span>Короткая мысль идет в note, машинные факты идут в props: контекст, критерий, зависимость, экран, владелец.</span>
          </div>
          <div>
            <strong>Доступы</strong>
            <span>Логины и пароли агент читает только после одобрения через защищенную часть.</span>
          </div>
        </div>
      </Panel>
      <Panel title="Защищенное" icon={LockKeyhole}>
        <div className="entity-list">
          <button className="primary-action add-secret-action" onClick={() => {
            setFormOpen((value) => !value);
            setEditingSecret(null);
          }} type="button">
            <Plus size={18} />
            <span>Добавить доступ</span>
          </button>
          {formOpen && <SecretForm projects={projects} onSubmit={addSecret} />}
          {items.length ? items.map((secret) => (
            <div className="secret-row" key={secret.id}>
              <div>
                <strong>{secret.title}</strong>
                <span>{secret.login || "логин скрыт"} · {projectName(projects, secret.project_id)} · {formatBytes(secret.memory_bytes)}</span>
              </div>
              <div className="secret-actions">
                <span>{secret.agent_share_state === "approved" ? "выдано" : "закрыто"}</span>
                <button type="button" onClick={() => setEditingSecret((current) => current?.id === secret.id ? null : secret)}>Править</button>
                <button type="button" onClick={() => setAgentAccess(secret.id, secret.agent_share_state !== "approved")}>{secret.agent_share_state === "approved" ? "Закрыть" : "Дать агенту"}</button>
              </div>
              {editingSecret?.id === secret.id && (
                <SecretForm
                  projects={projects}
                  initial={secret}
                  submitLabel="Сохранить правки"
                  onSubmit={(value) => editSecret(secret.id, value)}
                />
              )}
            </div>
          )) : <EmptyState text="Логины и пароли пока не добавлены" />}
          <div className="secret-policy">Пароли не показываются в списке. Агент получает доступ только после отдельного одобрения, а список агентов показывает, кому именно можно выдавать доступ.</div>
        </div>
      </Panel>
    </div>
  );
}
type NewSecret = {
  project_id: string | null;
  title: string;
  login: string;
  password: string;
  url: string;
};
function SecretForm({ projects, onSubmit, initial, submitLabel = "Сохранить" }: { projects: Project[]; onSubmit: (secret: NewSecret) => Promise<void>; initial?: SecretSummary; submitLabel?: string }) {
  const [projectId, setProjectId] = useState(initial?.project_id ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [login, setLogin] = useState(initial?.login ?? "");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setProjectId(initial?.project_id ?? projects[0]?.id ?? "");
    setTitle(initial?.title ?? "");
    setLogin(initial?.login ?? "");
    setUrl(initial?.url ?? "");
    setPassword("");
  }, [initial, projects]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || (!initial && !password.trim())) {
      setError(initial ? "Нужно название" : "Нужно название и пароль");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit({ project_id: projectId || null, title: title.trim(), login: login.trim(), password, url: url.trim() });
      if (!initial) {
        setTitle("");
        setLogin("");
        setPassword("");
        setUrl("");
      }
    } catch {
      setError("Не удалось сохранить доступ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="secret-form" onSubmit={submit}>
      <div className="secret-form-title">
        <KeyRound size={18} />
        <strong>{initial ? "Правка логина и пароля" : "Новый логин и пароль"}</strong>
      </div>
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Название" />
      <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        <option value="">Без проекта</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <input value={login} onChange={(event) => setLogin(event.target.value)} placeholder="Логин" />
      <label className="password-field">
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder={initial ? "Новый пароль, если меняем" : "Пароль"} type={showPassword ? "text" : "password"} />
        <button aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"} type="button" onClick={() => setShowPassword((value) => !value)}>
          {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </label>
      <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="URL" />
      {error && <p className="error-text">{error}</p>}
      <button className="primary-action" disabled={saving} type="submit">{saving ? "Сохраняю" : submitLabel}</button>
    </form>
  );
}
function EntityLine({ title, value }: { title: string; value: string }) {
  return (
    <div className="entity-line">
      <strong>{title}</strong>
      <span>{value}</span>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
