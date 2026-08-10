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
  FileCode2,
  FolderKanban,
  GitBranch,
  History,
  KeyRound,
  Library,
  LockKeyhole,
  Plus,
  Server,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { BottomNav } from "./components/BottomNav";
import { FolderTree, type FolderTreeNode } from "./components/FolderTree";
import { TopBar } from "./components/TopBar";
import type { SectionKey } from "./types";
import "./styles.css";

type Memory = {
  id: string;
  title: string;
  content: string;
  entity_type: string;
  access_level: string;
  tags: string[];
  metadata: Record<string, unknown>;
  memory_bytes: number;
  created_at: string;
  updated_at: string;
};

type Artifact = {
  id: string;
  folder_id: string | null;
  name: string;
  category: string;
  version: string;
  status: string;
  content: string;
  access_level: string;
  memory_bytes: number;
};

type Project = {
  id: string;
  name: string;
  status: string;
  stack: string[];
  git_url: string;
  deploy_target: string;
  deploy_provider: string;
  props: Record<string, string>;
  relations: ProjectRelation[];
  color: string;
  access_level: string;
  memory_bytes: number;
  todos: Todo[];
};

type ProjectRelation = {
  id: string;
  from_project_id: string;
  from_project_name: string;
  to_project_id: string;
  to_project_name: string;
  edge_type: string;
  title?: string;
  description?: string;
  owner?: string;
  group_entity?: string;
  strength?: number;
  valid_until?: string | null;
};

type GraphEdge = {
  id: string;
  from_entity: string;
  from_id: string;
  from_label: string;
  to_entity: string;
  to_id: string;
  to_label: string;
  edge_type: string;
  title: string;
  description: string;
  owner: string;
  group_entity: string;
  strength: number;
  valid_until: string | null;
};

type GraphNode = {
  id: string;
  label: string;
  group: string;
  x: number;
  y: number;
  color: string;
  projectId?: string;
};

type GraphVisualEdge = {
  key: string;
  from: GraphNode;
  to: GraphNode;
  edge_type: string;
  relation: boolean;
};

type Todo = {
  id: string;
  project_id: string;
  title: string;
  note: string;
  status: string;
  priority: string;
  props: Record<string, string>;
  claimed_by: string;
  claimed_until: string | null;
  heartbeat_at: string | null;
  memory_bytes: number;
};

type FolderRow = {
  id: string;
  parent_id: string | null;
  name: string;
  entity_type: string;
  access_level: string;
  color: string;
  memory_bytes: number;
};

type ServerMetrics = {
  hostname: string;
  load_1: number;
  cpu_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  disk_used_mb: number;
  disk_total_mb: number;
  docker_containers: Array<Record<string, string>>;
  captured_at: string;
};

type SecretSummary = {
  id: string;
  project_id: string | null;
  title: string;
  login: string;
  url: string;
  access_level: string;
  agent_share_state: string;
  memory_bytes: number;
  approved_until: string | null;
  updated_at: string;
};

type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  memory_bytes: number;
  created_at: string;
};

type AgentActivity = {
  id: string;
  name: string;
  kind: string;
  status: string;
  scope: string;
  active_sessions: number;
  live_connections: number;
  last_seen: string;
};

type AgentInboxItem = {
  id: string;
  project_id: string | null;
  agent_name: string;
  item_type: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  requires_human: boolean;
  props: Record<string, unknown>;
  memory_bytes: number;
  created_at: string;
  updated_at: string;
};

type AgentRun = {
  id: string;
  project_id: string | null;
  todo_id: string | null;
  agent_name: string;
  status: string;
  goal: string;
  read_context: unknown[];
  commands: unknown[];
  touched_files: unknown[];
  result: string;
  memory_bytes: number;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
};

type DecisionEntry = {
  id: string;
  project_id: string | null;
  agent_run_id: string | null;
  actor: string;
  title: string;
  decision: string;
  rationale: string;
  impact: string;
  memory_bytes: number;
  created_at: string;
};

type Me = {
  user: { id: string; username: string; role: string } | null;
};

const sections: Array<{ key: SectionKey; label: string; icon: LucideIcon }> = [
  { key: "overview", label: "Обзор", icon: Library },
  { key: "memories", label: "Память", icon: BookOpen },
  { key: "artifacts", label: "Артефакты", icon: FileCode2 },
  { key: "projects", label: "Проекты", icon: FolderKanban },
  { key: "graph", label: "Граф", icon: GitBranch },
  { key: "history", label: "История", icon: History },
  { key: "server", label: "Сервер", icon: Server },
  { key: "settings", label: "Доступ", icon: ShieldCheck },
];

const sectionKeys = new Set<SectionKey>(sections.map((section) => section.key));

function sectionFromLocation(): SectionKey {
  const raw = window.location.pathname.split("/").filter(Boolean)[0] as SectionKey | undefined;
  return raw && sectionKeys.has(raw) ? raw : "overview";
}

function queryFromLocation() {
  return new URLSearchParams(window.location.search).get("q") ?? "";
}

function nodeFromLocation() {
  return new URLSearchParams(window.location.search).get("node") ?? "";
}

function nodeRouteKey(node: FolderTreeNode | null) {
  if (!node) return "";
  return `${node.type ?? "node"}:${node.entityKind ?? ""}:${node.id ?? node.name}`;
}

function findNodeByRouteKey(nodes: FolderTreeNode[], key: string): FolderTreeNode | null {
  for (const node of nodes) {
    if (nodeRouteKey(node) === key) return node;
    const child = node.children ? findNodeByRouteKey(node.children, key) : null;
    if (child) return child;
  }
  return null;
}

function routeFor(section: SectionKey, query = "", nodeKey = "") {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (nodeKey) params.set("node", nodeKey);
  const search = params.toString();
  return `/${section}${search ? `?${search}` : ""}`;
}

const todoStatusLabels: Record<string, string> = {
  open: "Новая",
  next: "Следующая",
  doing: "В работе",
  blocked: "Заблокирована",
  review: "На проверке",
  done: "Готово",
  archived: "Архив",
};

const todoPriorityLabels: Record<string, string> = {
  low: "Низкий",
  normal: "Обычный",
  high: "Высокий",
  urgent: "Срочно",
};

const todoStatusHint: Record<string, string> = {
  open: "можно брать, но не первая в очереди",
  next: "следующая задача для агента",
  doing: "сейчас в работе",
  blocked: "нужен ответ или внешний доступ",
  review: "готово к проверке человеком",
  done: "завершено, не брать в работу",
  archived: "историческая запись",
};

function todoStatusLabel(value: string) {
  return todoStatusLabels[value] ?? value;
}

function todoPriorityLabel(value: string) {
  return todoPriorityLabels[value] ?? value;
}

function parseProps(value: string) {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
        if (separator === -1) return [line, ""] as const;
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
      })
      .filter(([key]) => key),
  );
}

function formatProps(props: Record<string, string>) {
  return Object.entries(props || {}).map(([key, value]) => `${key}: ${value}`).join("\n");
}

function sortTodos(todos: Todo[]) {
  const statusWeight: Record<string, number> = { doing: 0, next: 1, open: 2, blocked: 3, review: 4, done: 8, archived: 9 };
  const priorityWeight: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...todos].sort((a, b) => (statusWeight[a.status] ?? 5) - (statusWeight[b.status] ?? 5) || (priorityWeight[a.priority] ?? 2) - (priorityWeight[b.priority] ?? 2));
}

function App() {
  const [me, setMe] = useState<Me>({ user: null });
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    fetchJson<Me>("/api/mbox/auth/me")
      .then(setMe)
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
  const data = useMboxData(query);
  const realtime = useRealtime(data.reload);

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

  return (
    <div className={section === "graph" ? "app dark graph-app" : "app dark"}>
      <main className={section === "graph" ? "workspace graph-mode" : "workspace"}>
        <TopBar query={query} onQueryChange={setQuery} realtimeState={realtime.state} realtimeLabel={realtime.label} notice={realtime.notice} />
        {section === "overview" && <Overview data={data} />}
        {section === "memories" && <MemoryBoard memories={data.memories} onSaved={data.reload} />}
        {section === "artifacts" && <ArtifactsBoard artifacts={data.artifacts} folders={data.folders} query={query} selectedNodeKey={selectedNodeKey} onSelectedNodeKey={setSelectedNodeKey} onSaved={data.reload} />}
        {section === "projects" && <ProjectsBoard projects={data.projects} query={query} selectedNodeKey={selectedNodeKey} onSelectedNodeKey={setSelectedNodeKey} onSaved={data.reload} />}
        {section === "graph" && <GraphBoard folders={data.folders} memories={data.memories} projects={data.projects} edges={data.graphEdges} onSaved={data.reload} />}
        {section === "history" && <HistoryBoard events={data.auditEvents} />}
        {section === "server" && <ServerBoard pulse={realtime.pulse} />}
        {section === "settings" && <AccessBoard user={user} secrets={data.secrets} agents={data.agents} projects={data.projects} inbox={data.inbox} runs={data.runs} decisions={data.decisions} onSaved={data.reload} onLogout={onLogout} />}
      </main>
      <RealtimeToasts notices={realtime.notices} />
      <BottomNav sections={sections} activeSection={section} onSelect={setSection} hrefFor={(key) => routeFor(key, key === section ? query : "")} />
    </div>
  );
}

function useMboxData(query: string) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [agents, setAgents] = useState<AgentActivity[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [inbox, setInbox] = useState<AgentInboxItem[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";

    Promise.all([
      fetchJson<{ memories: Memory[] }>(`/api/mbox/memories${qs}`),
      fetchJson<{ artifacts: Artifact[] }>(`/api/mbox/artifacts${qs}`),
      fetchJson<{ projects: Project[] }>(`/api/mbox/projects${qs}`),
      fetchJson<{ folders: FolderRow[] }>(`/api/mbox/folders${qs}`),
      fetchJson<{ secrets: SecretSummary[] }>("/api/mbox/secrets"),
      fetchJson<{ events: AuditEvent[] }>("/api/mbox/history"),
      fetchJson<{ agents: AgentActivity[] }>("/api/mbox/agents"),
      fetchJson<{ edges: GraphEdge[] }>("/api/mbox/graph/edges"),
      fetchJson<{ inbox: AgentInboxItem[] }>("/api/mbox/agent/inbox"),
      fetchJson<{ runs: AgentRun[] }>("/api/mbox/agent/runs"),
      fetchJson<{ decisions: DecisionEntry[] }>("/api/mbox/decisions"),
    ]).then(([memoryData, artifactData, projectData, folderData, secretData, historyData, agentData, edgeData, inboxData, runsData, decisionData]) => {
      if (!alive) return;
      setMemories(memoryData.memories);
      setArtifacts(artifactData.artifacts);
      setProjects(projectData.projects);
      setFolders(folderData.folders);
      setSecrets(secretData.secrets);
      setAuditEvents(historyData.events);
      setAgents(agentData.agents);
      setGraphEdges(edgeData.edges);
      setInbox(inboxData.inbox);
      setRuns(runsData.runs);
      setDecisions(decisionData.decisions);
    });

    return () => {
      alive = false;
    };
  }, [query, revision]);

  return { memories, artifacts, projects, folders, secrets, auditEvents, agents, graphEdges, inbox, runs, decisions, reload };
}

function useRealtime(onEntityChanged: () => void) {
  const [pulse, setPulse] = useState(0);
  const [state, setState] = useState<"connecting" | "connected" | "thinking" | "working" | "offline">("connecting");
  const [label, setLabel] = useState("Агент подключается");
  const [notice, setNotice] = useState("");
  const [notices, setNotices] = useState<Array<{ id: string; text: string }>>([]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer = 0;
    let noticeTimer = 0;
    let closed = false;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/mbox/realtime`);

      socket.onopen = () => {
        setState("connected");
        setLabel("Агент подключен");
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; entity?: string; notification?: string; actor?: string; detail?: string };
          if (message.type === "entity_changed") {
            onEntityChanged();
            setState("working");
            setLabel("Агент делает");
            const toast = message.notification || `Агент ${message.actor || "Agent"} изменил ${message.detail || message.entity || "MBOX"}`;
            setNotice(toast);
            setNotices((current) => [{ id: `${Date.now()}-${Math.random()}`, text: toast }, ...current].slice(0, 4));
            window.clearTimeout(noticeTimer);
            noticeTimer = window.setTimeout(() => setNotice(""), 5000);
          }
          if (message.type === "server_tick") {
            setPulse((value) => value + 1);
            setState((current) => current === "working" ? "working" : "thinking");
            setLabel((current) => current === "Агент делает" ? current : "Агент думает");
          }
        } catch {
          setPulse((value) => value + 1);
        }
      };

      socket.onclose = () => {
        if (!closed) {
          setState("offline");
          setLabel("Агент отключен");
          reconnectTimer = window.setTimeout(connect, 3000);
        }
      };
    }

    connect();

    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(noticeTimer);
      socket?.close();
    };
  }, [onEntityChanged]);

  return { pulse, state, label, notice, notices };
}

function RealtimeToasts({ notices }: { notices: Array<{ id: string; text: string }> }) {
  if (!notices.length) return null;
  return (
    <div className="toast-stack">
      {notices.map((notice) => <div className="browser-toast" key={notice.id}>{notice.text}</div>)}
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState("Admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const me = await fetchJson<Me>("/api/mbox/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      onLogin(me);
    } catch {
      setError("Неверный логин или пароль");
    }
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <div className="panel-title">
          <LockKeyhole size={18} />
          <h2>Вход</h2>
        </div>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Логин" />
        <label className="password-field">
          <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Пароль" type={showPassword ? "text" : "password"} />
          <button aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"} type="button" onClick={() => setShowPassword((value) => !value)}>
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary-action login-action" type="submit">Войти</button>
      </form>
    </main>
  );
}

function Overview({ data }: { data: ReturnType<typeof useMboxData> }) {
  const totalBytes = sumBytes([
    ...data.memories.map((item) => item.memory_bytes),
    ...data.artifacts.map((item) => item.memory_bytes),
    ...data.projects.map((item) => item.memory_bytes),
    ...data.secrets.map((item) => item.memory_bytes),
  ]);

  return (
    <>
      <section className="metrics-grid">
        <Metric title="Память" value={data.memories.length} subtitle={formatBytes(totalBytes)} icon={BookOpen} />
        <Metric title="Артефакты" value={data.artifacts.length} subtitle={formatBytes(sumBytes(data.artifacts.map((item) => item.memory_bytes)))} icon={Archive} />
        <Metric title="Проекты" value={data.projects.length} subtitle={formatBytes(sumBytes(data.projects.map((item) => item.memory_bytes)))} icon={FolderKanban} />
        <Metric title="Секреты" value={data.secrets.length} subtitle={formatBytes(sumBytes(data.secrets.map((item) => item.memory_bytes)))} icon={ShieldCheck} />
      </section>
      <div className="content-grid overview-grid">
        <Panel title="Последние сущности" icon={BookOpen}>
          <EntityFeed memories={data.memories} projects={data.projects} artifacts={data.artifacts} />
        </Panel>
        <Panel title="Проекты" icon={FolderKanban}>
          <ProjectList projects={data.projects.slice(0, 5)} />
        </Panel>
      </div>
      <AgentWorkBoard agents={data.agents} runs={data.runs} inbox={data.inbox} decisions={data.decisions} />
    </>
  );
}

function MemoryBoard({ memories, onSaved }: { memories: Memory[]; onSaved: () => void }) {
  return (
    <Panel title="Память" icon={BookOpen}>
      <MemoryForm onSaved={onSaved} />
      <MemoryTable memories={memories} />
    </Panel>
  );
}

function AgentWorkBoard({ agents, runs, inbox, decisions }: { agents: AgentActivity[]; runs: AgentRun[]; inbox: AgentInboxItem[]; decisions: DecisionEntry[] }) {
  const activeRuns = runs.filter((run) => ["running", "doing"].includes(run.status)).slice(0, 4);
  const visibleRuns = activeRuns.length ? activeRuns : runs.slice(0, 4);

  return (
    <section className="agent-work-board" aria-label="Работа агентов">
      <div className="agent-work-column">
        <h3>Агенты</h3>
        {agents.length ? agents.slice(0, 6).map((agent) => (
          <div className="agent-work-row" key={agent.id}>
            <span className={`agent-dot ${agent.status}`} />
            <strong>{agent.name}</strong>
            <small>{agent.status} · {agent.active_sessions} сессий</small>
          </div>
        )) : <EmptyState text="Агенты пока не подключены" />}
      </div>
      <div className="agent-work-column">
        <h3>Сессии</h3>
        {visibleRuns.length ? visibleRuns.map((run) => (
          <div className="agent-work-row" key={run.id}>
            <span className={`agent-dot ${run.status}`} />
            <strong>{run.agent_name}</strong>
            <small>{run.goal}</small>
          </div>
        )) : <EmptyState text="Сессий пока нет" />}
      </div>
      <div className="agent-work-column">
        <h3>Inbox</h3>
        {inbox.slice(0, 4).map((item) => (
          <div className={item.requires_human ? "agent-work-row needs-human" : "agent-work-row"} key={item.id}>
            <span className="agent-dot inbox" />
            <strong>{item.agent_name}</strong>
            <small>{item.title}</small>
          </div>
        ))}
        {!inbox.length && <EmptyState text="Входящие пусты" />}
      </div>
      <div className="agent-work-column">
        <h3>Решения</h3>
        {decisions.slice(0, 4).map((decision) => (
          <div className="agent-work-row" key={decision.id}>
            <span className="agent-dot decision" />
            <strong>{decision.actor}</strong>
            <small>{decision.title}</small>
          </div>
        ))}
        {!decisions.length && <EmptyState text="Решений пока нет" />}
      </div>
    </section>
  );
}

function ArtifactsBoard({ artifacts, folders, query, selectedNodeKey, onSelectedNodeKey, onSaved }: { artifacts: Artifact[]; folders: FolderRow[]; query: string; selectedNodeKey: string; onSelectedNodeKey: (key: string) => void; onSaved: () => void }) {
  const roots = useMemo(() => filterTree(buildArtifactTree(artifacts, folders), query), [artifacts, folders, query]);
  const [menu, setMenu] = useState<TreeMenuState | null>(null);
  const [selectedNode, setSelectedNode] = useState<FolderTreeNode | null>(null);

  useEffect(() => {
    if (!selectedNodeKey) return;
    const node = findNodeByRouteKey(roots, selectedNodeKey);
    if (node) setSelectedNode(node);
  }, [roots, selectedNodeKey]);

  function selectNode(node: FolderTreeNode) {
    setSelectedNode(node);
    onSelectedNodeKey(nodeRouteKey(node));
  }
  return (
    <div className="content-grid settings-grid">
      <Panel title="Папки" icon={FolderKanban}>
        <FolderForm folders={folders} onSaved={onSaved} />
        {roots.length ? <FolderTree key={query} defaultOpen={query ? roots.map((node) => node.name) : []} roots={roots} onSelect={selectNode} onContext={(node, position) => setMenu({ node, position })} /> : <EmptyState text="Артефактов в базе пока нет" />}
      </Panel>
      <Panel title="Просмотр" icon={Archive}>
        <ArtifactForm folders={folders} onSaved={onSaved} />
        {selectedNode ? <EntityPreview node={selectedNode} /> : <EmptyState text="Выбери папку или артефакт в дереве" />}
      </Panel>
      {menu && <TreeContextMenu state={menu} projects={[]} onClose={() => setMenu(null)} onSaved={onSaved} />}
    </div>
  );
}

function ProjectsBoard({ projects, query, selectedNodeKey, onSelectedNodeKey, onSaved }: { projects: Project[]; query: string; selectedNodeKey: string; onSelectedNodeKey: (key: string) => void; onSaved: () => void }) {
  const [items, setItems] = useState(projects);
  const [menu, setMenu] = useState<TreeMenuState | null>(null);
  const [selectedNode, setSelectedNode] = useState<FolderTreeNode | null>(null);
  const roots = useMemo(() => filterTree(items.map(projectToTree), query), [items, query]);

  useEffect(() => {
    setItems(projects);
  }, [projects]);

  useEffect(() => {
    if (!selectedNodeKey) return;
    const node = findNodeByRouteKey(roots, selectedNodeKey);
    if (node) setSelectedNode(node);
  }, [roots, selectedNodeKey]);

  function selectNode(node: FolderTreeNode) {
    setSelectedNode(node);
    onSelectedNodeKey(nodeRouteKey(node));
  }

  async function updateProjectColor(projectId: string, color: string) {
    setItems((current) => current.map((project) => project.id === projectId ? { ...project, color } : project));
    await fetchJson(`/api/mbox/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color }),
    });
    onSaved();
  }

  return (
    <div className="project-workspace">
      <Panel title="Проекты" icon={FolderKanban}>
        <ProjectForm onSaved={onSaved} />
        {roots.length ? <FolderTree key={query} defaultOpen={query ? roots.map((node) => node.name) : []} roots={roots} onSelect={selectNode} onContext={(node, position) => setMenu({ node, position })} /> : <EmptyState text="Проектов в базе пока нет" />}
      </Panel>
      <Panel title="Просмотр" icon={BookOpen}>
        <ProjectInspector node={selectedNode} projects={items} fallbackProject={items[0]} onColorChange={updateProjectColor} onSaved={onSaved} />
      </Panel>
      {menu && <TreeContextMenu state={menu} projects={items} onClose={() => setMenu(null)} onSaved={onSaved} />}
    </div>
  );
}

function ProjectInspector({ node, projects, fallbackProject, onColorChange, onSaved }: { node: FolderTreeNode | null; projects: Project[]; fallbackProject?: Project; onColorChange: (projectId: string, color: string) => void; onSaved: () => void }) {
  if (node?.type === "project_entity" && node.id && node.entityKind) {
    const project = projects.find((item) => item.id === node.id);
    if (project) return <ProjectEntityEditor project={project} projects={projects} kind={node.entityKind} onSaved={onSaved} />;
  }

  if (node?.type === "todo" && node.id) {
    const project = projects.find((item) => item.todos.some((todo) => todo.id === node.id));
    const todo = project?.todos.find((item) => item.id === node.id);
    if (project && todo) return <TodoNote project={project} todo={todo} onSaved={onSaved} />;
  }

  if (node?.type === "todo_group" && node.id) {
    const project = projects.find((item) => item.id === node.id);
    if (project) return <ProjectTodoCards project={project} />;
  }

  if (node?.type === "project" && node.id) {
    const project = projects.find((item) => item.id === node.id);
    if (project) return <ProjectTodoNotes project={project} projects={projects} onColorChange={onColorChange} onSaved={onSaved} />;
  }

  if (node) return <EntityPreview node={node} />;
  return <ProjectTodoNotes project={fallbackProject} projects={projects} onColorChange={onColorChange} onSaved={onSaved} />;
}

function ProjectEntityEditor({ project, projects, kind, onSaved }: { project: Project; projects: Project[]; kind: NonNullable<FolderTreeNode["entityKind"]>; onSaved: () => void }) {
  const [stack, setStack] = useState(project.stack.join("\n"));
  const [gitUrl, setGitUrl] = useState(project.git_url || "");
  const [deployProvider, setDeployProvider] = useState(project.deploy_provider || "");
  const [deployTarget, setDeployTarget] = useState(project.deploy_target || "");
  const [accessLevel, setAccessLevel] = useState(project.access_level || "private");
  const [propsText, setPropsText] = useState(formatProps(project.props || {}));
  const [philosophy, setPhilosophy] = useState(project.props?.philosophy || "");
  const [principles, setPrinciples] = useState(project.props?.principles || "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setStack(project.stack.join("\n"));
    setGitUrl(project.git_url || "");
    setDeployProvider(project.deploy_provider || "");
    setDeployTarget(project.deploy_target || "");
    setAccessLevel(project.access_level || "private");
    setPropsText(formatProps(project.props || {}));
    setPhilosophy(project.props?.philosophy || "");
    setPrinciples(project.props?.principles || "");
    setSaveState("idle");
  }, [project, kind]);

  const titles: Record<NonNullable<FolderTreeNode["entityKind"]>, string> = {
    relations: "Связи",
    properties: "Свойства",
    philosophy: "Философия",
    deploy: "Деплой",
    stack: "Стек",
    access: "Доступ",
    git: "Git",
  };

  async function saveProject(payload: Partial<Project>) {
    setSaveState("saving");
    try {
      await fetchJson(`/api/mbox/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSaveState("saved");
      onSaved();
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="project-entity-editor">
      <div className="entity-line">
        <strong>{titles[kind]} · {project.name}</strong>
        <span>{formatBytes(project.memory_bytes)}</span>
      </div>
      {kind === "relations" && <ProjectRelationForm project={project} projects={projects} onSaved={onSaved} />}
      {kind === "properties" && (
        <>
          <textarea value={propsText} onChange={(event) => {
            setPropsText(event.target.value);
            setSaveState("idle");
          }} placeholder={"ключ: значение\nкомпания: Вокруг света\nтип: рабочий"} />
          <button className="primary-action compact-submit" type="button" disabled={saveState === "saving"} onClick={() => saveProject({ props: parseProps(propsText) } as Partial<Project>)}>{saveLabel(saveState, "Сохранить свойства")}</button>
        </>
      )}
      {kind === "philosophy" && (
        <>
          <textarea value={philosophy} onChange={(event) => {
            setPhilosophy(event.target.value);
            setSaveState("idle");
          }} placeholder="Зачем существует проект, какой вкус решений, что важно не потерять" />
          <textarea value={principles} onChange={(event) => {
            setPrinciples(event.target.value);
            setSaveState("idle");
          }} placeholder="Принципы через строки или короткие пункты" />
          <button className="primary-action compact-submit" type="button" disabled={saveState === "saving"} onClick={() => saveProject({ props: { ...(project.props || {}), philosophy, principles } } as Partial<Project>)}>{saveLabel(saveState, "Сохранить философию")}</button>
        </>
      )}
      {kind === "stack" && (
        <>
          <textarea value={stack} onChange={(event) => {
            setStack(event.target.value);
            setSaveState("idle");
          }} placeholder={"React\nPostgreSQL\nDocker"} />
          <button className="primary-action compact-submit" type="button" disabled={saveState === "saving"} onClick={() => saveProject({ stack: stack.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean) } as Partial<Project>)}>{saveLabel(saveState, "Сохранить стек")}</button>
        </>
      )}
      {kind === "git" && (
        <>
          <input value={gitUrl} onChange={(event) => {
            setGitUrl(event.target.value);
            setSaveState("idle");
          }} placeholder="Git URL" />
          <button className="primary-action compact-submit" type="button" disabled={saveState === "saving"} onClick={() => saveProject({ git_url: gitUrl } as Partial<Project>)}>{saveLabel(saveState, "Сохранить Git")}</button>
        </>
      )}
      {kind === "deploy" && (
        <>
          <input value={deployProvider} onChange={(event) => {
            setDeployProvider(event.target.value);
            setSaveState("idle");
          }} placeholder="Docker, Vercel, bare metal" />
          <input value={deployTarget} onChange={(event) => {
            setDeployTarget(event.target.value);
            setSaveState("idle");
          }} placeholder="Сервер, домен или окружение" />
          <button className="primary-action compact-submit" type="button" disabled={saveState === "saving"} onClick={() => saveProject({ deploy_provider: deployProvider, deploy_target: deployTarget } as Partial<Project>)}>{saveLabel(saveState, "Сохранить деплой")}</button>
        </>
      )}
      {kind === "access" && (
        <>
          <select value={accessLevel} onChange={(event) => {
            setAccessLevel(event.target.value);
            setSaveState("idle");
          }}>
            <option value="private">private</option>
            <option value="agents">agents</option>
            <option value="public">public</option>
          </select>
          <button className="primary-action compact-submit" type="button" disabled={saveState === "saving"} onClick={() => saveProject({ access_level: accessLevel } as Partial<Project>)}>{saveLabel(saveState, "Сохранить доступ")}</button>
        </>
      )}
    </div>
  );
}

function saveLabel(state: "idle" | "saving" | "saved" | "error", idle: string) {
  if (state === "saving") return "Сохраняю";
  if (state === "saved") return "Сохранено";
  if (state === "error") return "Ошибка";
  return idle;
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

function ProjectTodoCards({ project }: { project: Project }) {
  const todos = sortTodos(project.todos);
  const activeCount = todos.filter((todo) => !["done", "archived"].includes(todo.status)).length;

  return (
    <div className="todo-card-board">
      <div className="entity-line">
        <strong>Todo · {project.name}</strong>
        <span>{activeCount} активно · {todos.length} всего</span>
      </div>
      {todos.length ? (
        <div className="todo-note-grid">
          {todos.map((todo) => (
            <article className={["todo-note-card", ["done", "archived"].includes(todo.status) ? "is-done" : "", todo.status === "doing" ? "is-doing" : ""].filter(Boolean).join(" ")} key={todo.id}>
              <div className="todo-note-card-head">
                {todo.status === "doing" && <span className="todo-spinner" aria-label="В работе" />}
                <strong>{todo.title}</strong>
              </div>
              {todo.note && <p>{todo.note}</p>}
              <div className="todo-note-card-meta">
                <span>{todoStatusLabel(todo.status)}</span>
                <span>{todoPriorityLabel(todo.priority)}</span>
                {todo.claimed_by && <span>{todo.claimed_by}</span>}
                <span>{formatBytes(todo.memory_bytes)}</span>
              </div>
            </article>
          ))}
        </div>
      ) : <EmptyState text="Todo пока нет" />}
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

function EntityPreview({ node }: { node: FolderTreeNode }) {
  return (
    <div className="entity-preview">
      <strong>{node.name}</strong>
      {node.meta && <span>{node.meta}</span>}
      <p>{node.note || "Выбрана сущность дерева. ПКМ открывает действия: цвет, создание, удаление."}</p>
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

function GraphBoard({ folders, memories, projects, edges, onSaved }: { folders: FolderRow[]; memories: Memory[]; projects: Project[]; edges: GraphEdge[]; onSaved: () => void }) {
  const [selected, setSelected] = useState<{ id: string; label: string; group: string; projectId?: string } | null>(null);
  const [linkSource, setLinkSource] = useState<{ id: string; label: string } | null>(null);
  const [linkCursor, setLinkCursor] = useState<{ x: number; y: number } | null>(null);
  const [linkType, setLinkType] = useState("related");
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const projectNames = new Set(projects.map((project) => project.name.toLowerCase()));
  const visibleMemories = memories.filter((memory) => !projectNames.has(memory.title.replace(/^Проект\s+/i, "").toLowerCase()));
  const nodes: GraphNode[] = [
    ...projects.map((project, index) => ({ id: `project-${project.id}`, projectId: project.id, label: project.name, group: "Проект", x: 50, y: 32 + index * 15, color: project.color })),
    ...folders.slice(0, 18).map((folder, index) => ({ id: `folder-${folder.id}`, label: folder.name, group: "Папка", x: 22 + (index % 4) * 19, y: 54 + Math.floor(index / 4) * 14, color: folder.color })),
    ...visibleMemories.slice(0, 16).map((memory, index) => ({ id: `memory-${memory.id}`, label: memory.title, group: "Память", x: 72 + (index % 3) * 10, y: 36 + Math.floor(index / 3) * 11, color: "#5a7f5b" })),
  ];
  const projectNodeById = new Map(nodes.filter((node) => node.projectId).map((node) => [node.projectId!, node]));
  const autoEdges: GraphVisualEdge[] = nodes.slice(1).map((node, index) => ({ key: `auto-${node.id}`, from: nodes[index % Math.max(1, projects.length)] ?? nodes[0], to: node, edge_type: "context", relation: false }));
  const relationEdges = edges
    .filter((edge) => edge.from_entity === "project" && edge.to_entity === "project")
    .map((edge) => ({ key: `edge-${edge.id}`, from: projectNodeById.get(edge.from_id), to: projectNodeById.get(edge.to_id), edge_type: edge.edge_type, relation: true }))
    .filter((edge): edge is GraphVisualEdge => Boolean(edge.from && edge.to));
  const graphThreads = [...autoEdges, ...relationEdges];

  async function selectNode(node: GraphNode) {
    setSelected(node);
    if (!node.projectId) return;
    if (!linkSource) {
      setLinkSource({ id: node.projectId, label: node.label });
      return;
    }
    if (linkSource.id === node.projectId) {
      setLinkSource(null);
      return;
    }
    await fetchJson("/api/mbox/graph/edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_id: linkSource.id, to_id: node.projectId, edge_type: linkType }),
    });
    setLinkSource(null);
    setLinkCursor(null);
    onSaved();
  }

  function updateLinkCursor(event: PointerEvent<HTMLDivElement>) {
    if (!linkSource) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setLinkCursor({
      x: Math.min(100, Math.max(0, ((event.clientX - rect.left - view.x) / view.scale / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - rect.top - view.y) / view.scale / rect.height) * 100)),
    });
  }

  return (
    <section className="graph-fullscreen" aria-label="Карта графа MBOX">
      <div className="graph-link-tools">
        <input value={linkType} onChange={(event) => setLinkType(event.target.value)} placeholder="тип связи" />
        {linkSource && <span>нить от: {linkSource.label}</span>}
        {linkSource && <button type="button" onClick={() => {
          setLinkSource(null);
          setLinkCursor(null);
        }}>Сбросить</button>}
      </div>
      <div
        className={linkSource ? "graph-canvas linking-mode" : "graph-canvas"}
        onWheel={(event) => {
          event.preventDefault();
          setView((current) => ({ ...current, scale: Math.min(1.9, Math.max(.72, current.scale - event.deltaY * .001)) }));
        }}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          if (event.target instanceof HTMLElement && event.target.closest(".graph-card")) return;
          setDrag({ x: event.clientX - view.x, y: event.clientY - view.y });
        }}
        onPointerMove={(event) => {
          updateLinkCursor(event);
          if (drag) setView((current) => ({ ...current, x: event.clientX - drag.x, y: event.clientY - drag.y }));
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        <div className="graph-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {graphThreads.map((edge) => {
              const midX = (edge.from.x + edge.to.x) / 2;
              const midY = (edge.from.y + edge.to.y) / 2;
              const curve = Math.max(4, Math.min(16, Math.abs(edge.to.x - edge.from.x) * .18 + Math.abs(edge.to.y - edge.from.y) * .1));
              const d = `M ${edge.from.x} ${edge.from.y} C ${midX} ${edge.from.y - curve}, ${midX} ${edge.to.y + curve}, ${edge.to.x} ${edge.to.y}`;
              return (
                <g className={edge.relation ? "graph-thread relation-edge" : "graph-thread"} key={edge.key}>
                  <path d={d} />
                  {edge.relation && <text x={midX} y={midY}>{edge.edge_type}</text>}
                </g>
              );
            })}
            {linkSource && linkCursor && (() => {
              const sourceNode = projectNodeById.get(linkSource.id);
              if (!sourceNode) return null;
              const midX = (sourceNode.x + linkCursor.x) / 2;
              const d = `M ${sourceNode.x} ${sourceNode.y} C ${midX} ${sourceNode.y - 8}, ${midX} ${linkCursor.y + 8}, ${linkCursor.x} ${linkCursor.y}`;
              return <path className="graph-thread-preview" d={d} />;
            })()}
          </svg>
          {nodes.map((node) => (
            <button className={linkSource?.id === node.projectId ? "graph-card linking" : "graph-card"} key={node.id} style={{ left: `${node.x}%`, top: `${node.y}%`, "--node-color": node.color } as CSSProperties} onClick={() => selectNode(node)} type="button">
              <span>{node.group}</span>
              <strong>{node.label}</strong>
            </button>
          ))}
        </div>
        {selected && <div className="graph-inspector"><strong>{selected.label}</strong><span>{selected.group}</span></div>}
      </div>
    </section>
  );
}

function HistoryBoard({ events }: { events: AuditEvent[] }) {
  return (
    <Panel title="История" icon={History}>
      {events.length ? (
        <div className="timeline-list">
          {events.map((event) => (
            <article className="timeline-item" key={event.id}>
              <div>
                <strong>{event.summary || `${event.entity_type} #${event.entity_id ?? ""}`}</strong>
                <span>{event.actor || "system"} · {event.action} · {event.entity_type}{event.entity_id ? ` #${event.entity_id}` : ""} · {formatBytes(event.memory_bytes)}</span>
              </div>
              <time>{formatDateTime(event.created_at)}</time>
            </article>
          ))}
        </div>
      ) : <EmptyState text="История пока пуста" />}
    </Panel>
  );
}

function ServerBoard({ pulse }: { pulse: number }) {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      const data = await fetchJson<{ metrics: ServerMetrics | null }>("/api/mbox/server");
      if (alive) setMetrics(data.metrics);
    }
    load();
    return () => {
      alive = false;
    };
  }, [pulse]);

  if (!metrics) {
    return (
      <Panel title="Сервер" icon={Server}>
        <EmptyState text="Ожидание метрик сервера" />
      </Panel>
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
    </div>
  );
}

function MemoryForm({ onSaved }: { onSaved: () => void }) {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [accessLevel, setAccessLevel] = useState("private");

  return (
    <ManualForm title="Добавить или править память" onSubmit={async () => {
      await saveEntity("/api/mbox/memories", id, { title, content, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), access_level: accessLevel });
      setId("");
      setTitle("");
      setContent("");
      setTags("");
      onSaved();
    }}>
      <input value={id} onChange={(event) => setId(event.target.value)} placeholder="ID для правки" />
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Название" />
      <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Содержимое" />
      <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Теги через запятую" />
      <select value={accessLevel} onChange={(event) => setAccessLevel(event.target.value)}>
        <option value="private">private</option>
        <option value="agents">agents</option>
        <option value="public">public</option>
      </select>
    </ManualForm>
  );
}

function FolderForm({ folders, onSaved }: { folders: FolderRow[]; onSaved: () => void }) {
  const [id, setId] = useState("");
  const [parentId, setParentId] = useState("");
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState("artifact");
  const [accessLevel, setAccessLevel] = useState("agents");
  const [color, setColor] = useState("#2c2c2e");

  return (
    <ManualForm title="Добавить или править папку" onSubmit={async () => {
      await saveEntity("/api/mbox/folders", id, { parent_id: parentId || null, name, entity_type: entityType, access_level: accessLevel, color });
      setId("");
      setName("");
      onSaved();
    }}>
      <input value={id} onChange={(event) => setId(event.target.value)} placeholder="ID для правки" />
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Название папки" />
      <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
        <option value="">Без родителя</option>
        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select>
      <select value={entityType} onChange={(event) => setEntityType(event.target.value)}>
        <option value="artifact">artifact</option>
        <option value="project">project</option>
        <option value="memory">memory</option>
        <option value="todo">todo</option>
        <option value="script">script</option>
        <option value="agent_scope">agent_scope</option>
      </select>
      <select value={accessLevel} onChange={(event) => setAccessLevel(event.target.value)}>
        <option value="private">private</option>
        <option value="agents">agents</option>
        <option value="public">public</option>
      </select>
      <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
    </ManualForm>
  );
}

function ArtifactForm({ folders, onSaved }: { folders: FolderRow[]; onSaved: () => void }) {
  const [id, setId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Code");
  const [version, setVersion] = useState("v1");
  const [status, setStatus] = useState("created");
  const [content, setContent] = useState("");

  return (
    <ManualForm title="Добавить или править артефакт" onSubmit={async () => {
      await saveEntity("/api/mbox/artifacts", id, { folder_id: folderId || null, name, category, version, status, content, access_level: "agents" });
      setId("");
      setName("");
      setContent("");
      onSaved();
    }}>
      <input value={id} onChange={(event) => setId(event.target.value)} placeholder="ID для правки" />
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Название" />
      <input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Категория" />
      <input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="Версия" />
      <input value={status} onChange={(event) => setStatus(event.target.value)} placeholder="Статус" />
      <select value={folderId} onChange={(event) => setFolderId(event.target.value)}>
        <option value="">Без папки</option>
        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select>
      <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Содержимое" />
    </ManualForm>
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

function ManualForm({ title, children, onSubmit }: { title: string; children: ReactNode; onSubmit: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSubmit();
      setOpen(false);
    } catch {
      setError("Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="manual-box">
      <button className="primary-action add-secret-action" type="button" onClick={() => setOpen((value) => !value)}>
        <Plus size={18} />
        <span>{title}</span>
      </button>
      {open && (
        <form className="manual-form" onSubmit={submit}>
          {children}
          {error && <p className="error-text">{error}</p>}
          <button className="primary-action compact-submit" disabled={saving} type="submit">{saving ? "Сохраняю" : "Сохранить"}</button>
        </form>
      )}
    </div>
  );
}

type TreeMenuState = {
  node: FolderTreeNode;
  position: { x: number; y: number };
};

function TreeContextMenu({ state, projects, onClose, onSaved }: { state: TreeMenuState; projects: Project[]; onClose: () => void; onSaved: () => void }) {
  const { node, position } = state;
  const canColor = Boolean(node.id && (node.type === "folder" || node.type === "project"));
  const canDelete = Boolean(node.id && node.type && node.type !== "meta");
  const canCreateFolder = node.type === "folder";
  const canCreateTodo = node.type === "project";

  async function colorNode() {
    const color = window.prompt("Цвет в формате #RRGGBB", node.color || "#2c2c2e");
    if (!color) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return window.alert("Нужен цвет вида #2c2c2e");
    await fetchJson(node.type === "project" ? `/api/mbox/projects/${node.id}` : `/api/mbox/folders/${node.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color }),
    });
    onSaved();
    onClose();
  }

  async function createFolder() {
    const name = window.prompt("Название новой папки");
    if (!name?.trim()) return;
    await fetchJson("/api/mbox/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent_id: node.id, name: name.trim(), entity_type: "artifact", access_level: "agents", color: node.color || "#2c2c2e" }),
    });
    onSaved();
    onClose();
  }

  async function createTodo() {
    const project = projects.find((item) => item.id === node.id);
    const title = window.prompt("Название todo");
    if (!project || !title?.trim()) return;
    await fetchJson("/api/mbox/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: project.id, title: title.trim(), status: "open", priority: "normal", access_level: "private" }),
    });
    onSaved();
    onClose();
  }

  async function deleteNode() {
    if (!node.id || !node.type) return;
    if (!window.confirm(`Удалить "${node.name}"?`)) return;
    const paths: Record<string, string> = {
      folder: "folders",
      project: "projects",
      todo: "todos",
      artifact: "artifacts",
      memory: "memories",
    };
    const path = paths[node.type];
    if (!path) return;
    await fetchJson(`/api/mbox/${path}/${node.id}`, { method: "DELETE" });
    onSaved();
    onClose();
  }

  return (
    <div className="tree-menu-scrim" onClick={onClose}>
      <div className="tree-menu" style={{ left: Math.min(position.x, window.innerWidth - 236), top: Math.min(position.y, window.innerHeight - 240) }} onClick={(event) => event.stopPropagation()}>
        <strong>{node.name}</strong>
        {canColor && <button onClick={colorNode} type="button">Покрасить</button>}
        {canCreateFolder && <button onClick={createFolder} type="button">Создать папку</button>}
        {canCreateTodo && <button onClick={createTodo} type="button">Создать todo</button>}
        {canDelete && <button className="danger-action" onClick={deleteNode} type="button">Удалить</button>}
      </div>
    </div>
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
          {agents.map((agent) => (
            <div className="agent-row" key={agent.id}>
              <div>
                <strong>{agent.name}</strong>
                <span>{agent.kind} · {agent.scope}</span>
              </div>
              <div className="agent-status">
                <span>{agent.status === "active" ? "активен" : "ожидает"}</span>
                <small>{agent.live_connections} подключений · {agent.active_sessions} сессий</small>
              </div>
            </div>
          ))}
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

function Metric({ title, value, subtitle, icon: Icon }: { title: string; value: number; subtitle: string; icon: LucideIcon }) {
  return (
    <article className="metric-card">
      <div className="metric-icon"><Icon size={20} /></div>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{subtitle}</small>
    </article>
  );
}

function Panel({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-title">
        <Icon size={18} />
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function MemoryList({ memories }: { memories: Memory[] }) {
  if (!memories.length) return <EmptyState text="Память в базе пока пустая" />;
  return (
    <div className="context-list">
      {memories.map((memory) => (
        <article className="memory-row" key={memory.id}>
          <div className="row-id">#{memory.id}</div>
          <div>
            <strong>{memory.title}</strong>
            <p>{memory.content}</p>
            <span className="muted">{formatBytes(memory.memory_bytes)}</span>
          </div>
          <time>{formatDate(memory.updated_at)}</time>
        </article>
      ))}
    </div>
  );
}

function EntityFeed({ memories, projects, artifacts }: { memories: Memory[]; projects: Project[]; artifacts: Artifact[] }) {
  const projectNames = new Set(projects.map((project) => project.name.toLowerCase()));
  const seen = new Set<string>();
  const rows = [
    ...memories
      .filter((item) => !projectNames.has(item.title.replace(/^Проект\s+/i, "").toLowerCase()))
      .map((item) => ({ key: `memory-${item.id}`, title: item.title, text: item.content, bytes: item.memory_bytes, kind: "Память" })),
    ...projects.map((item) => ({ key: `project-${item.id}`, title: item.name, text: item.stack.join(", ") || "Стек не указан", bytes: item.memory_bytes, kind: "Проект" })),
    ...artifacts.map((item) => ({ key: `artifact-${item.id}`, title: item.name, text: `${item.category} · ${item.version}`, bytes: item.memory_bytes, kind: "Артефакт" })),
  ].filter((row) => {
    const signature = `${row.kind}:${row.title}:${row.text}`.toLowerCase();
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  }).slice(0, 8);
  if (!rows.length) return <EmptyState text="База пока пустая" />;
  return (
    <div className="context-list">
      {rows.map((row) => (
        <article className="memory-row" key={row.key}>
          <div className="row-id">{row.kind}</div>
          <div>
            <strong>{row.title}</strong>
            <p>{row.text}</p>
            <span className="muted">{formatBytes(row.bytes)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function MemoryTable({ memories }: { memories: Memory[] }) {
  if (!memories.length) return <EmptyState text="Память в базе пока пустая" />;
  return (
    <div className="memory-table-wrap">
      <table className="memory-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Название</th>
            <th>Тип</th>
            <th>Теги</th>
            <th>Доступ</th>
            <th>Размер</th>
            <th>Обновлено</th>
          </tr>
        </thead>
        <tbody>
          {memories.map((memory) => (
            <tr key={memory.id}>
              <td>#{memory.id}</td>
              <td>{memory.title}</td>
              <td>{memory.entity_type}</td>
              <td>{memory.tags.join(", ") || "none"}</td>
              <td>{memory.access_level}</td>
              <td>{formatBytes(memory.memory_bytes)}</td>
              <td>{formatDate(memory.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectList({ projects }: { projects: Project[] }) {
  if (!projects.length) return <EmptyState text="Проектов в базе пока нет" />;
  return (
    <div className="project-list">
      {projects.map((project) => (
        <article className="project-card" key={project.id} style={{ "--project-color": project.color || "#2c2c2e" } as CSSProperties}>
          <div>
            <strong>{project.name}</strong>
            <p>{project.stack.join(", ") || "Стек не указан"}</p>
          </div>
          <span>{formatBytes(project.memory_bytes)}</span>
        </article>
      ))}
    </div>
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

function EmptyState({ text }: { text: string }) {
  return <p className="muted empty-state">{text}</p>;
}

function buildArtifactTree(artifacts: Artifact[], folders: FolderRow[]): FolderTreeNode[] {
  const baseFolders = folders
    .filter((folder) => folder.entity_type === "artifact")
    .map((folder) => ({ id: folder.id, type: "folder" as const, name: folder.name, meta: formatBytes(folder.memory_bytes), color: folder.color, children: [] as FolderTreeNode[] }));

  const byCategory = new Map<string, FolderTreeNode>();
  for (const folder of baseFolders) byCategory.set(folder.name, folder);
  for (const artifact of artifacts) {
    const category = artifact.category || "Other";
    if (!byCategory.has(category)) byCategory.set(category, { name: category, children: [] });
    byCategory.get(category)!.children!.push({
      id: artifact.id,
      type: "artifact",
      name: artifact.name,
      note: artifact.content,
      meta: `${artifact.version} · ${artifact.status} · ${formatBytes(artifact.memory_bytes)}`,
    });
  }
  return Array.from(byCategory.values());
}

function projectToTree(project: Project): FolderTreeNode {
  const sortedTodos = sortTodos(project.todos);
  const openTodos = sortedTodos.filter((todo) => !["done", "archived"].includes(todo.status)).length;
  const relatedNames = project.relations.map((relation) => relation.from_project_id === project.id ? relation.to_project_name : relation.from_project_name);
  return {
    id: project.id,
    type: "project",
    name: project.name,
    meta: `${project.status} · ${formatBytes(project.memory_bytes)}`,
    color: project.color,
    children: [
      { id: project.id, type: "todo_group", name: `Todo (${openTodos})`, meta: "заметки задач", color: "#28466d", children: sortedTodos.map((todo) => ({ id: todo.id, type: "todo" as const, name: todo.title, note: todo.note, status: todo.status, priority: todo.priority, meta: `${todoStatusLabel(todo.status)} · ${todoPriorityLabel(todo.priority)}${todo.claimed_by ? ` · ${todo.claimed_by}` : ""} · ${formatBytes(todo.memory_bytes)}` })) },
      { id: project.id, type: "project_entity", entityKind: "git", name: "Git", meta: project.git_url ? "репозиторий" : "не указан", color: "#2e4a3a", children: [{ type: "meta", name: project.git_url || "Git не указан" }] },
      { id: project.id, type: "project_entity", entityKind: "relations", name: "Связи", meta: `${relatedNames.length}`, children: relatedNames.length ? relatedNames.map((name) => ({ type: "meta", name })) : [{ type: "meta", name: "Связей нет" }] },
      { id: project.id, type: "project_entity", entityKind: "properties", name: "Свойства", meta: `${Object.keys(project.props || {}).length}`, children: Object.entries(project.props || {}).map(([key, value]) => ({ type: "meta", name: `${key}: ${value}` })) },
      { id: project.id, type: "project_entity", entityKind: "philosophy", name: "Философия", meta: project.props?.philosophy ? "задана" : "пусто", children: [
        { type: "meta", name: project.props?.philosophy || "Не задана" },
        { type: "meta", name: project.props?.principles ? `Принципы: ${project.props.principles}` : "Принципы не заданы" },
      ] },
      { id: project.id, type: "project_entity", entityKind: "deploy", name: "Деплой", meta: project.deploy_provider || "не указан", children: [{ type: "meta", name: project.deploy_provider || "Провайдер не указан" }, { type: "meta", name: project.deploy_target || "Цель деплоя не указана" }] },
      { id: project.id, type: "project_entity", entityKind: "stack", name: "Стек", meta: `${project.stack.length}`, children: project.stack.map((item) => ({ type: "meta", name: item })) },
      { id: project.id, type: "project_entity", entityKind: "access", name: "Доступ", meta: project.access_level, children: [{ type: "meta", name: project.access_level }] },
    ],
  };
}

function filterTree(nodes: FolderTreeNode[], query: string): FolderTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const result: FolderTreeNode[] = [];
  for (const node of nodes) {
    const children = node.children ? filterTree(node.children, query) : [];
    const ownMatch = `${node.name} ${node.meta ?? ""}`.toLowerCase().includes(needle);
    if (ownMatch || children.length) result.push({ ...node, children: children.length ? children : node.children });
  }
  return result;
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) throw new Error(`request_failed:${res.status}`);
  return (await res.json()) as T;
}

async function saveEntity(basePath: string, id: string, body: Record<string, unknown>) {
  return fetchJson(id.trim() ? `${basePath}/${id.trim()}` : basePath, {
    method: id.trim() ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sumBytes(values: number[]) {
  return values.reduce((sum, value) => sum + Number(value || 0), 0);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "нет даты";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "нет даты";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function projectName(projects: Project[], projectId: string | null) {
  if (!projectId) return "без проекта";
  return projects.find((project) => project.id === projectId)?.name ?? `project #${projectId}`;
}

function ShellLoading() {
  return (
    <main className="login-screen">
      <div className="login-panel">Загрузка</div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

