import { StrictMode, Suspense, lazy, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
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
  Sun,
  Moon,
  Contrast,
  Zap,
} from "lucide-react";
import { FolderTree, type FolderTreeNode } from "./components/FolderTree";
import { TopBar, type AgentRosterEntry } from "./components/TopBar";
import { AgentAvatar } from "./components/AgentAvatar";
import { RUN_STALE_MS, agentFamily, effectiveStatus, isAgentWorking, isLeaseLive, liveRunOf } from "./lib/agents";
import { fetchJson, saveEntity } from "./lib/api";
import { formatBytes, formatDateTime, formatSince, plural } from "./lib/format";
import { agentStatusLabels, auditNotice, projectName, todoPriorityLabel, todoPriorityLabels, todoStatusHint, todoStatusLabel, todoStatusLabels } from "./lib/labels";
import { filterTree, formatProps, parseProps, projectToTree, rollupBytes, sortTodos } from "./lib/tree";
import { OfflineBanner, ShellLoading } from "./app/ShellStates";
import { LoginScreen } from "./pages/LoginScreen";
import { EntityPreview, TreeContextMenu, type TreeMenuState } from "./features/tree/TreeContextMenu";
import { TodoCardGrid } from "./features/projects/TodoCards";
import { ProjectEntityView } from "./features/projects/EntityPanels";
import { EmptyState, ManualForm, Panel } from "./ui";
import { bootstrapSeen, loadSeen } from "./lib/seen";
import { useMboxData } from "./hooks/useMboxData";
import { useRealtime } from "./hooks/useRealtime";
import { Workbench } from "./app/workbench/Workbench";
import { RAIL_GROUPS, setRailHidden, useRailHidden, type RailItemId } from "./app/workbench/rail";
import type {
  AgentActivity, AgentInboxItem, AgentRun, Artifact, AuditEvent, DecisionEntry, FolderRow,
  GraphEdge, GroqUsage, Me, Memory, Project,
  SecretSummary, SectionKey, ServerMetrics, Todo,
} from "./types";
import "./styles.css";

type AppTheme = "light" | "graphite" | "black";

const THEME_STORAGE_KEY = "mbox.theme";

function readTheme(): AppTheme {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return saved === "light" || saved === "black" || saved === "graphite" ? saved : "graphite";
}

function App() {
  const [me, setMe] = useState<Me>({ user: null });
  const [authChecked, setAuthChecked] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    fetchJson<Me>("/api/mbox/auth/me")
      .then(setMe)
      .catch(() => setMe({ user: null }))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) return <ShellLoading />;
  if (!me.user) return <LoginScreen onLogin={setMe} />;
  return <Workspace user={me.user} onLogout={() => setMe({ user: null })} theme={theme} onThemeChange={setTheme} />;
}
function Workspace({ user, onLogout, theme, onThemeChange }: { user: { username: string; role: string }; onLogout: () => void; theme: AppTheme; onThemeChange: (theme: AppTheme) => void }) {
  // Общая строка поиска в шапке перезапрашивала все 12 ручек на каждую букву — поиск теперь живёт
  // в своей вкладке рабочего места (Workbench/SearchView), данные грузятся без фильтра.
  const data = useMboxData("", onLogout);
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
    const leased = data.projects.flatMap((project) => project.todos).filter(isLeaseLive);
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

  const [projectMenu, setProjectMenu] = useState<TreeMenuState | null>(null);

  // Сначала тянем отметки «просмотрено» из базы, и только потом решаем, что считать новым.
  const todoMarks = useMemo(
    () => data.projects.flatMap((project) => project.todos.map((todo) => ({ key: `todo:${todo.id}`, bytes: todo.memory_bytes }))),
    [data.projects],
  );
  useEffect(() => { void loadSeen(); }, []);
  useEffect(() => { if (todoMarks.length) bootstrapSeen(todoMarks); }, [todoMarks]);

  return (
    <div className={`app app-workbench theme-${theme}${theme === "light" ? "" : " dark"}`} data-theme={theme}>
      {data.offline && <OfflineBanner onRetry={data.reload} />}
      <Workbench
        data={data}
        user={user}
        realtime={realtime}
        status={{ state: headerState, label: agentLabel }}
        onProjectContext={(project, position) => setProjectMenu({ node: { id: project.id, type: "project", name: project.name, color: project.color }, position })}
        titleBar={({ openSearch, openTodo, toggleSidebar, toggleConsole, activeTab }) => (
          <TopBar
            onOpenSearch={openSearch}
            onToggleSidebar={toggleSidebar}
            onToggleConsole={toggleConsole}
            activeTitle={activeTab.title}
            activeHint={activeTab.hint}
            activeIcon={activeTab.icon}
            activeDirty={activeTab.dirty}
            tabCount={activeTab.tabs}
            realtimeState={headerState}
            realtimeLabel={agentLabel}
            notice={realtime.notice}
            notices={agentNotices}
            roster={agentRoster}
            attentionTodos={attentionTodos}
            onOpenTodo={openTodo}
            onResolveTodo={async (todoId) => {
              await saveEntity("/api/mbox/todos", todoId, { status: "done" });
              data.reload();
            }}
            onLogout={async () => {
              await fetch("/api/mbox/auth/logout", { method: "POST" });
              onLogout();
            }}
            busy={data.loading || headerState === "working"}
          />
        )}
        renderers={{
          history: () => <HistoryBoard events={data.auditEvents} />,
          settings: () => (
            <SettingsBoard
              theme={theme}
              onThemeChange={onThemeChange}
              server={<ServerBoard pulse={realtime.pulse} />}
              access={<AccessBoard user={user} onLogout={onLogout} />}
              team={<TeamBoard user={user} projects={data.projects} />}
              passwords={<PasswordsBoard secrets={data.secrets} projects={data.projects} onSaved={data.reload} />}
              logs={<LogsBoard runs={data.runs} decisions={data.decisions} />}
            />
          ),
          todo: (project, todo) => <TodoNote project={project} todo={todo} onSaved={data.reload} />,
        }}
      />
      {projectMenu && <TreeContextMenu state={projectMenu} projects={data.projects} onClose={() => setProjectMenu(null)} onSaved={data.reload} />}
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
    <Panel title="История" className="panel-bare">
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
type SettingsTab = "appearance" | "server" | "access" | "team" | "passwords" | "logs";

function SettingsBoard({ server, access, team, passwords, logs, theme, onThemeChange }: { server: ReactNode; access: ReactNode; team: ReactNode; passwords: ReactNode; logs: ReactNode; theme: AppTheme; onThemeChange: (theme: AppTheme) => void }) {
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const content: Record<SettingsTab, ReactNode> = {
    appearance: <AppearanceSettings theme={theme} onChange={onThemeChange} />,
    server,
    access,
    team,
    passwords,
    logs,
  };
  return (
    <div className="settings-board">
      <div className="settings-tabs" role="tablist" aria-label="Настройки">
        <button role="tab" aria-selected={tab === "appearance"} className={tab === "appearance" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("appearance")}>
          <Contrast size={16} /> Интерфейс
        </button>
        <button role="tab" aria-selected={tab === "server"} className={tab === "server" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("server")}>
          <Server size={16} /> Сервер
        </button>
        <button role="tab" aria-selected={tab === "access"} className={tab === "access" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("access")}>
          <ShieldCheck size={16} /> Доступ
        </button>
        <button role="tab" aria-selected={tab === "team"} className={tab === "team" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("team")}>
          <GitBranch size={16} /> Команда
        </button>
        <button role="tab" aria-selected={tab === "passwords"} className={tab === "passwords" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("passwords")}>
          <LockKeyhole size={16} /> Пароли
        </button>
        <button role="tab" aria-selected={tab === "logs"} className={tab === "logs" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("logs")}>
          <History size={16} /> Логи
        </button>
      </div>
      {content[tab]}
    </div>
  );
}

const THEME_OPTIONS: Array<{ id: AppTheme; title: string; description: string; icon: typeof Sun }> = [
  { id: "light", title: "Светлая", description: "Чистая спокойная поверхность для дневной работы", icon: Sun },
  { id: "graphite", title: "Графитовая", description: "Мягкий тёмно-серый фон с умеренным контрастом", icon: Contrast },
  { id: "black", title: "Тёмная", description: "Глубокий чёрный фон для работы вечером", icon: Moon },
];

function AppearanceSettings({ theme, onChange }: { theme: AppTheme; onChange: (theme: AppTheme) => void }) {
  return (
    <section className="appearance-settings" aria-labelledby="appearance-title">
      <header className="appearance-heading">
        <div>
          <p>Внешний вид</p>
          <h2 id="appearance-title">Тема MBOX</h2>
        </div>
        <span>Сохраняется на этом устройстве</span>
      </header>
      <div className="theme-options" role="radiogroup" aria-label="Тема интерфейса">
        {THEME_OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = theme === option.id;
          return (
            <button
              key={option.id}
              type="button"
              className={selected ? "theme-option is-selected" : "theme-option"}
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.id)}
            >
              <span className={`theme-preview is-${option.id}`} aria-hidden="true">
                <span className="theme-preview-rail" />
                <span className="theme-preview-body"><i /><i /><i /></span>
              </span>
              <span className="theme-option-copy">
                <strong><Icon size={16} />{option.title}</strong>
                <span>{option.description}</span>
              </span>
              <span className="theme-choice" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <p className="appearance-note">Inter используется для интерфейса и документов. Моноширинный шрифт остаётся только в коде, терминале и технических данных.</p>
      <RailSettings />
    </section>
  );
}

/** Какие разделы показывать в левой полосе. Состав и порядок — в app/workbench/rail.ts. */
function RailSettings() {
  const hidden = useRailHidden();
  const toggle = (id: RailItemId, show: boolean) =>
    setRailHidden(show ? hidden.filter((item) => item !== id) : [...hidden.filter((item) => item !== id), id]);
  return (
    <section className="rail-settings" aria-labelledby="rail-title">
      <header className="appearance-heading">
        <div>
          <p>Боковые вкладки</p>
          <h2 id="rail-title">Разделы в левой полосе</h2>
        </div>
        <span>Сохраняется на этом устройстве</span>
      </header>
      <div className="rail-groups">
        {RAIL_GROUPS.map((group) => (
          <div className="rail-group" key={group.id}>
            <h3>{group.title}</h3>
            {group.items.map((item) => {
              const shown = !hidden.includes(item.id);
              return (
                <label className="rail-option" key={item.id}>
                  <input
                    type="checkbox"
                    checked={shown}
                    disabled={item.required}
                    onChange={(event) => toggle(item.id, event.target.checked)}
                  />
                  <img src={item.icon} alt="" width={20} height={20} />
                  <span>{item.label.replace(/\s*\([^)]*\)$/, "")}</span>
                  {item.required && <small>всегда виден</small>}
                  {item.desktopOnly && <small>только в приложении</small>}
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </section>
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
    <Panel title="Джарвис / расход токенов" icon={Zap}>
      <div className="entity-list">
        <EntityLine title="Токенов сегодня (все модели)" value={Number(usage.tokens_today).toLocaleString("ru-RU")} />
        <EntityLine title="Токенов за 24ч (все модели)" value={Number(usage.tokens_24h).toLocaleString("ru-RU")} />
        <EntityLine title="Токенов всего (все модели)" value={Number(usage.total_tokens).toLocaleString("ru-RU")} />
        <EntityLine title="Вызовов за 24ч" value={String(usage.calls_24h)} />
        <EntityLine title="Вызовов всего" value={String(usage.calls_total)} />
        <EntityLine title="Последний вызов" value={usage.last_call_at ? formatDateTime(usage.last_call_at) : "ещё не было"} />
      </div>
      {/* Джарвис говорит и на Gemini, и на Groq (два резервных под-агента) — оба логируются в один
          счётчик groq_usage, название таблицы историческое. Без разбивки по модели цифры выше
          читались так, будто расход весь на Groq, хотя основная нагрузка обычно на Gemini. */}
      {usage.by_model && usage.by_model.length > 0 && (
        <div className="entity-list" style={{ marginTop: 10 }}>
          {usage.by_model.map((row) => (
            <EntityLine
              key={row.model}
              title={row.model}
              value={`${Number(row.total_tokens).toLocaleString("ru-RU")} всего · ${Number(row.tokens_today).toLocaleString("ru-RU")} сегодня · ${row.calls_total} вызовов`}
            />
          ))}
        </div>
      )}
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
        {/* Сборщик метрик на хосте может молча остановиться — старые цифры не должны выглядеть текущими. */}
        {Date.now() - Date.parse(metrics.captured_at) > 10 * 60 * 1000 && (
          <p className="error-text">Метрики устарели: последний снимок {formatDateTime(metrics.captured_at)}. На сервере не работает scripts/server_metrics_collector.sh.</p>
        )}
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
function AccessBoard({ user, onLogout }: { user: { username: string; role: string }; onLogout: () => void }) {
  return (
    <div className="content-grid settings-grid">
      <Panel title="Аккаунт" icon={ShieldCheck}>
        <div className="entity-list">
          <EntityLine title="Пользователь" value={`${user.username} · ${user.role}`} />
          <EntityLine title="Новые аккаунты" value={user.role === "owner" ? "создаёт владелец" : "управляет владелец"} />
          <EntityLine title="Права" value="private / agents / public" />
          <button className="primary-action" onClick={async () => {
            await fetch("/api/mbox/auth/logout", { method: "POST" });
            onLogout();
          }}>Выйти</button>
        </div>
      </Panel>
    </div>
  );
}

function TeamBoard({ user, projects }: { user: { username: string; role: string }; projects: Project[] }) {
  return (
    <div className="content-grid settings-single-grid">
      {user.role === "owner"
        ? <AccountManager projects={projects} />
        : <Panel title="Команда" icon={GitBranch}><EmptyState text="Состав команды и общие проекты настраивает владелец" /></Panel>}
      <ResponderAccess username={user.username} />
    </div>
  );
}

type AccountToken = { id: string; label: string; created_at: string; last_used_at: string | null };

function ResponderAccess({ username }: { username: string }) {
  const [tokens, setTokens] = useState<AccountToken[]>([]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => fetchJson<{ tokens: AccountToken[] }>("/api/mbox/account/tokens").then((result) => setTokens(result.tokens)), []);
  useEffect(() => { void load(); }, [load]);
  const agentName = `ChatGPT-${username.replace(/\s+/g, "-")}`;
  const command = token ? [
    `$env:MBOX_URL='https://mbox.shar-os.ru'`,
    `$env:MBOX_USERNAME='${username.replace(/'/g, "''")}'`,
    `$env:MBOX_TOKEN='${token}'`,
    `$env:MBOX_AGENT_NAME='${agentName.replace(/'/g, "''")}'`,
    `node scripts/codex-chat-watcher.mjs`,
  ].join("\n") : "";

  async function createToken() {
    setBusy(true);
    try {
      const result = await fetchJson<{ token: string }>("/api/mbox/account/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: `${username} · VS Code` }),
      });
      setToken(result.token);
      await load();
    } finally { setBusy(false); }
  }

  return (
    <Panel title="Responder в VS Code" icon={Zap}>
      <div className="responder-access">
        <p>Персональный ключ подключает ChatGPT/Claude и MBOX MCP к вашему аккаунту. Он видит только ваши сообщения и назначенные проекты.</p>
        <button className="primary-action" type="button" disabled={busy} onClick={() => void createToken()}><KeyRound size={16} />{busy ? "Создаю…" : "Создать ключ VS Code"}</button>
        {token && (
          <div className="responder-token">
            <strong>Скопируйте сейчас — повторно ключ не показывается</strong>
            <textarea value={command} readOnly rows={6} aria-label="Команды подключения responder" />
            <button type="button" onClick={() => void navigator.clipboard.writeText(command)}>Скопировать команды</button>
          </div>
        )}
        <div className="account-list">
          {tokens.map((item) => (
            <div className="account-row responder-key-row" key={item.id}>
              <div className="account-identity"><strong>{item.label}</strong><span>Создан {formatDateTime(item.created_at)}{item.last_used_at ? ` · использован ${formatSince(item.last_used_at)}` : " · ещё не использован"}</span></div>
              <button type="button" onClick={async () => { await fetchJson(`/api/mbox/account/tokens/${item.id}`, { method: "DELETE" }); await load(); }}>Отозвать</button>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function LogsBoard({ runs, decisions }: { runs: AgentRun[]; decisions: DecisionEntry[] }) {
  return (
    <div className="content-grid settings-grid">
      <Panel title="Agent run log" icon={History}>
        <div className="agent-entity-list">
          {runs.length ? runs.slice(0, 50).map((run) => (
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
          {decisions.length ? decisions.slice(0, 50).map((decision) => (
            <div className="agent-entity-row" key={decision.id}>
              <strong>{decision.title}</strong>
              <span>{decision.actor} · {formatBytes(decision.memory_bytes)}</span>
              <p>{decision.decision || decision.rationale}</p>
            </div>
          )) : <EmptyState text="Решений пока нет" />}
        </div>
      </Panel>
    </div>
  );
}

function PasswordsBoard({ secrets, projects, onSaved }: { secrets: SecretSummary[]; projects: Project[]; onSaved: () => void }) {
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
    <div className="content-grid settings-single-grid">
      <Panel title="Пароли" icon={LockKeyhole}>
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
          <div className="secret-policy">Пароли не показываются в списке. Агент получает доступ только после отдельного одобрения.</div>
        </div>
      </Panel>
    </div>
  );
}

type AccountUser = {
  id: string;
  email: string;
  username: string;
  role: "owner" | "member";
  projects: Array<{ project_id: string; project_name: string; role: string }>;
};

function ProjectAccessPicker({ projects, selected, onChange, disabled = false }: { projects: Project[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  return (
    <div className="account-projects" aria-label="Доступные проекты">
      {projects.map((project) => {
        const checked = selected.includes(project.id);
        return (
          <label className={checked ? "account-project is-selected" : "account-project"} key={project.id}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(checked ? selected.filter((id) => id !== project.id) : [...selected, project.id])}
            />
            <span>{project.name}</span>
          </label>
        );
      })}
    </div>
  );
}

function AccountManager({ projects }: { projects: Project[] }) {
  const [accounts, setAccounts] = useState<AccountUser[]>([]);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [draftProjects, setDraftProjects] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const result = await fetchJson<{ users: AccountUser[] }>("/api/mbox/admin/users");
    setAccounts(result.users);
    setDraftProjects(Object.fromEntries(result.users.map((account) => [account.id, account.projects.map((project) => project.project_id)])));
  }, []);

  useEffect(() => { load().catch((cause) => setError(cause instanceof Error ? cause.message : "Не удалось загрузить аккаунты")); }, [load]);

  async function createAccount(event: FormEvent) {
    event.preventDefault();
    setBusy("new");
    setError("");
    try {
      await fetchJson("/api/mbox/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, email, password, project_ids: projectIds }),
      });
      setUsername(""); setEmail(""); setPassword(""); setProjectIds([]);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать аккаунт");
    } finally {
      setBusy("");
    }
  }

  async function saveAccess(account: AccountUser) {
    setBusy(account.id);
    setError("");
    try {
      await fetchJson(`/api/mbox/admin/users/${account.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_ids: draftProjects[account.id] || [] }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить доступы");
    } finally {
      setBusy("");
    }
  }

  return (
    <Panel title="Команда и общие проекты" icon={KeyRound}>
      <div className="account-manager">
        <form className="account-create" onSubmit={createAccount}>
          <div className="account-create-fields">
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Имя аккаунта" minLength={2} required />
            <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email (необязательно)" type="email" />
            <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Пароль, минимум 8 знаков" type="password" minLength={8} required />
          </div>
          <ProjectAccessPicker projects={projects} selected={projectIds} onChange={setProjectIds} />
          <button className="primary-action" disabled={busy === "new"} type="submit"><Plus size={16} />{busy === "new" ? "Создаю…" : "Создать аккаунт"}</button>
        </form>
        {error && <div className="account-error" role="alert">{error}</div>}
        <div className="account-list">
          {accounts.map((account) => {
            const selected = draftProjects[account.id] || [];
            const persisted = account.projects.map((project) => project.project_id);
            const changed = [...selected].sort().join(",") !== [...persisted].sort().join(",");
            return (
              <div className="account-row" key={account.id}>
                <div className="account-identity">
                  <strong>{account.username}</strong>
                  <span>{account.email} · {account.role === "owner" ? "владелец" : "участник"}</span>
                </div>
                {account.role === "owner" ? (
                  <span className="account-owner-note">Все проекты и личный Jarvis</span>
                ) : (
                  <>
                    <ProjectAccessPicker projects={projects} selected={selected} onChange={(ids) => setDraftProjects((current) => ({ ...current, [account.id]: ids }))} />
                    <button className="account-save" type="button" disabled={!changed || busy === account.id} onClick={() => saveAccess(account)}>{busy === account.id ? "Сохраняю…" : "Сохранить доступ"}</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
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
// Заметка по ссылке (/n/<токен>) открывается без входа в MBOX — отдельная страница, грузится своим чанком.
const SharedNotePage = lazy(() => import("./pages/SharedNotePage").then((module) => ({ default: module.SharedNotePage })));
const sharedNoteToken = window.location.pathname.match(/^\/n\/([A-Za-z0-9_-]{24,64})\/?$/)?.[1];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {sharedNoteToken ? (
      <Suspense fallback={null}>
        <SharedNotePage token={sharedNoteToken} />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
