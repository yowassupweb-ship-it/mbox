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
  Zap,
} from "lucide-react";
import { FolderTree, type FolderTreeNode } from "./components/FolderTree";
import { TopBar, type AgentRosterEntry } from "./components/TopBar";
import { AgentAvatar } from "./components/AgentAvatar";
import { RUN_STALE_MS, agentFamily, effectiveStatus, isAgentWorking, isLeaseLive, liveRunOf } from "./lib/agents";
import { fetchJson, saveEntity } from "./lib/api";
import { formatBytes, formatDateTime, formatSince, plural } from "./lib/format";
import { agentStatusLabels, auditIsNoise, auditNotice, projectName, todoPriorityLabel, todoPriorityLabels, todoStatusHint, todoStatusLabel, todoStatusLabels } from "./lib/labels";
import { filterTree, formatProps, parseProps, projectToTree, rollupBytes, sortTodos } from "./lib/tree";
import { OfflineBanner, ShellLoading } from "./app/ShellStates";
import { LoginScreen } from "./pages/LoginScreen";
import { notifyDesktopSignedIn, notifyDesktopSignedOut } from "./lib/desktopAccount";
import { InviteScreen } from "./pages/InviteScreen";
import { accountErrorText } from "./features/accounts/accountErrors";
import { EntityPreview, TreeContextMenu, type TreeMenuState } from "./features/tree/TreeContextMenu";
import { TodoCardGrid } from "./features/projects/TodoCards";
import { ProjectEntityView } from "./features/projects/EntityPanels";
import { EmptyState, ManualForm, Panel } from "./ui";
import { askConfirm } from "./ui/askText";
import { bootstrapSeen, loadSeen } from "./lib/seen";
import { useMboxData } from "./hooks/useMboxData";
import { useRealtime } from "./hooks/useRealtime";
import { HistoryDocument } from "./app/workbench/HistoryDocument";
import { Workbench } from "./app/workbench/Workbench";
import type {
  AgentActivity, AgentInboxItem, AgentRun, Artifact, AuditEvent, Company, DecisionEntry, FolderRow,
  GraphEdge, GroqUsage, Me, Memory, Project,
  SecretSummary, SectionKey, ServerMetrics, Todo,
} from "./types";
import "./styles.css";
import { installLayoutIndependentShortcuts } from "./lib/keyboard";
import { GlobalTooltip } from "./components/GlobalTooltip";
import { removeNow } from "./lib/optimistic";
import { SettingsPage } from "./features/settings/SettingsPage";

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

  // Смена темы из главного поиска и других мест, где нет доступа к состоянию приложения.
  useEffect(() => {
    const onTheme = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (next === "light" || next === "black" || next === "graphite") setTheme(next);
    };
    window.addEventListener("mbox:set-theme", onTheme);
    return () => window.removeEventListener("mbox:set-theme", onTheme);
  }, []);

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

  const signedInUser = me.user?.id;
  useEffect(() => { if (signedInUser) notifyDesktopSignedIn(); }, [signedInUser]);

  const inviteToken = window.location.pathname.match(/^\/invite\/(mbox_invite_[A-Za-z0-9_-]+)\/?$/)?.[1];
  if (inviteToken && !me.user) return <InviteScreen token={inviteToken} onJoined={setMe} />;
  if (!authChecked) return <ShellLoading />;
  if (!me.user) return <LoginScreen onLogin={setMe} />;
  return <Workspace user={me.user} onLogout={() => setMe({ user: null })} theme={theme} onThemeChange={setTheme} />;
}
function Workspace({ user, onLogout, theme, onThemeChange }: { user: { username: string; role: string; jarvis_enabled?: boolean; jarvis_autoreply?: boolean }; onLogout: () => void; theme: AppTheme; onThemeChange: (theme: AppTheme) => void }) {
  // Общая строка поиска в шапке перезапрашивала все 12 ручек на каждую букву — поиск теперь живёт
  // в своей вкладке рабочего места (Workbench/SearchView), данные грузятся без фильтра.
  const data = useMboxData("", onLogout, user.role);
  const realtime = useRealtime(data.reload);
  const agentNotices = useMemo(
    () => [...realtime.notices, ...data.auditEvents.filter((event) => !auditIsNoise(event)).slice(0, 12).map(auditNotice)].slice(0, 12),
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
    if (working.length > 1) {
      // Одна строка итога для футера. Агенты с одним именем (несколько сессий) считаются один раз; кто именно и что делает — в списке агентов.
      const names = new Set(working.map((agent) => agent.name));
      return { state: "working" as const, label: names.size > 1 ? `${names.size} ${plural(names.size, "агент", "агента", "агентов")} в работе` : `${working[0].name} в работе (${working.length} ${plural(working.length, "сессия", "сессии", "сессий")})` };
    }

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
            activeGlyph={activeTab.glyph}
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
              await notifyDesktopSignedOut();
              await fetch("/api/mbox/auth/logout", { method: "POST" });
              onLogout();
            }}
            busy={data.loading || headerState === "working"}
          />
        )}
        renderers={{
          history: (where) => <HistoryDocument where={where} />,
          settings: () => (
            <SettingsPage
              user={user}
              theme={theme}
              onThemeChange={onThemeChange}
              onLogout={onLogout}
              projects={data.projects}
              companies={data.companies}
              runs={data.runs}
              decisions={data.decisions}
              pulse={realtime.pulse}
              onReload={data.reload}
            />
          ),
          todo: (project, todo) => <TodoNote project={project} todo={todo} onSaved={data.reload} />,
        }}
      />
      {projectMenu && <TreeContextMenu state={projectMenu} projects={data.projects} onClose={() => setProjectMenu(null)} onSaved={data.reload} onDeleted={(kind, id) => removeNow(data, kind, id)} />}
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
        <select aria-label="Связанный проект" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
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
      <input aria-label="Название заметки" className="note-title-input" value={title} onChange={(event) => {
        setTitle(event.target.value);
        setSaveState("idle");
      }} />
      <div className="note-controls">
        <select aria-label="Статус" value={status} onChange={(event) => {
          setStatus(event.target.value);
          setSaveState("idle");
        }}>
          {Object.entries(todoStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="Приоритет" value={priority} onChange={(event) => {
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
          <select aria-label="От проекта" value={fromId} onChange={(event) => setFromId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select aria-label="К проекту" value={toId} onChange={(event) => setToId(event.target.value)}>
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
      <input aria-label="Цвет" type="color" value={color} onChange={(event) => setColor(event.target.value)} />
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
      <select aria-label="Проект" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Todo" />
      <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Заметка" />
      <textarea value={props} onChange={(event) => setProps(event.target.value)} placeholder={"Свойства todo\nконтекст: интерфейс\nкритерий: удобно с телефона и ПК"} />
      <select aria-label="Статус" value={status} onChange={(event) => setStatus(event.target.value)}>
        {Object.entries(todoStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <select aria-label="Приоритет" value={priority} onChange={(event) => setPriority(event.target.value)}>
        {Object.entries(todoPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </ManualForm>
  );
}
// Заметка по ссылке (/n/<токен>) открывается без входа в MBOX — отдельная страница, грузится своим чанком.
const SharedNotePage = lazy(() => import("./pages/SharedNotePage").then((module) => ({ default: module.SharedNotePage })));
const sharedNoteToken = window.location.pathname.match(/^\/n\/([A-Za-z0-9_-]{24,64})\/?$/)?.[1];
const SharedTablePage = lazy(() => import("./pages/SharedTablePage").then((module) => ({ default: module.SharedTablePage })));
const sharedTableToken = window.location.pathname.match(/^\/t\/([A-Za-z0-9_-]{24,64})\/?$/)?.[1];
// SEO Wizard по ссылке (/s/<токен>) и по логину с паролем (/seo-access): без входа в MBOX, только SEO Wizard.
const SharedSeoPage = lazy(() => import("./pages/SharedSeoPage").then((module) => ({ default: module.SharedSeoPage })));
const sharedSeoToken = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]{24,64})\/?$/)?.[1];
const sharedSeoLogin = /^\/seo-access\/?$/.test(window.location.pathname);
const SharedDocumentPage = lazy(() => import("./pages/SharedDocumentPage").then((module) => ({ default: module.SharedDocumentPage })));
const sharedDocumentToken = window.location.pathname.match(/^\/d\/([A-Za-z0-9_-]{24,64})\/?$/)?.[1];
// Окно заметки на рабочем столе (MBOX Desktop, ?sticky=<id> или ?sticky=list): только заметка, без всего приложения.
const StickyApp = lazy(() => import("./pages/StickyApp").then((module) => ({ default: module.StickyApp })));
const stickyTarget = new URLSearchParams(window.location.search).get("sticky");
// Слой всплывающих окон над страницей встроенного браузера (MBOX Desktop, ?overlay=1): только само окно, прозрачный фон.
const OverlayApp = lazy(() => import("./pages/OverlayApp").then((module) => ({ default: module.OverlayApp })));
const overlayMode = new URLSearchParams(window.location.search).get("overlay") === "1";

installLayoutIndependentShortcuts();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {overlayMode ? (
      <Suspense fallback={null}>
        <OverlayApp />
      </Suspense>
    ) : stickyTarget && /^(list|\d+)$/.test(stickyTarget) ? (
      <Suspense fallback={null}>
        <StickyApp target={stickyTarget} />
      </Suspense>
    ) : sharedNoteToken ? (
      <Suspense fallback={null}>
        <SharedNotePage token={sharedNoteToken} />
      </Suspense>
    ) : sharedTableToken ? (
      <Suspense fallback={null}>
        <SharedTablePage token={sharedTableToken} />
      </Suspense>
    ) : sharedSeoToken || sharedSeoLogin ? (
      <Suspense fallback={null}>
        <SharedSeoPage token={sharedSeoToken ?? null} />
      </Suspense>
    ) : sharedDocumentToken ? (
      <Suspense fallback={null}>
        <SharedDocumentPage token={sharedDocumentToken} />
      </Suspense>
    ) : (
      <App />
    )}
    <GlobalTooltip />
  </StrictMode>,
);
