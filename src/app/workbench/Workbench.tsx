import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Database, GitBranch, PanelBottom, PanelLeft, PanelRight, TerminalSquare, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { AgentChat } from "../../features/agents/AgentChat";
import { NeedsAnswer } from "../../features/agents/NeedsAnswer";
import { FolderBoard } from "../../features/projects/FolderBoard";
import { ProjectEntityView } from "../../features/projects/EntityPanels";
import type { ProjectEntityKind } from "../../features/tree/entityKinds";
import type { MboxData } from "../../hooks/useMboxData";
import { agentFamily, effectiveStatus, isAgentWorking, liveRunOf } from "../../lib/agents";
import { formatBytes, formatSince, plural } from "../../lib/format";
import { agentStatusLabels, todoStatusLabel } from "../../lib/labels";
import { AbilitiesBoard } from "../../pages/Abilities";
import { ArtifactsBoard } from "../../pages/Artifacts";
import { Overview } from "../../pages/Overview";
import type { Project, Todo } from "../../types";
import { SkillDocument, ToolDocument } from "./CatalogDocuments";
import { ConsoleArea, ConsolePaneDocument, PANE_MIME, TERMINAL_TAB } from "./ConsoleArea";
import { chatPeer, consoleLayout } from "./consoleLayout";
import { installScrollMemory } from "./uiMemory";
import { serverOrigin } from "../../lib/serverOrigin";
import { LocalImageDocument } from "./LocalImageDocument";
import { SkillsView, ToolsView } from "./CatalogViews";
import { useSkillsCatalog, useToolsCatalog } from "./catalog";
import { ExplorerView } from "./ExplorerView";
import { FileDocument, FilesView } from "./Files";
import { recentlyActiveAgent } from "./desktopSessions";
import { LocalFoldersView } from "./LocalFolders";
import { createNoteAndOpen, NoteDocument, NotesView } from "./Notes";
import { SshView } from "./SshView";
import { StorageDocument } from "./Storage";
import { ProjectMemories } from "./ProjectMemories";
import { TodoBoard, TodoDocument } from "./Todos";
import { CommitDocument, GitDiffDocument, LocalFileDocument } from "./LocalFileDocument";
import { IMAGE_FILE, setAgentHint, setWorkspaceUser, useLocalWorkspace } from "./localWorkspace";
import { MemoryDocument } from "./MemoryDocument";
import { SearchView } from "./SearchView";
import { tabMeta } from "./tabMeta";
import { encodeTabParam, projectIdOfTab, usePersistentState, useTabs, type TabsApi } from "./tabs";
import { WbMenu } from "./WbMenu";
import { applyOpenTab, type OpenTabEvent } from "./agentTabs";
import { SkillPageDocument } from "./SkillPageDocument";
import { SkillBlocksDocument } from "./SkillBlocksDocument";

const MENU = "/assets/icons/bottom-menu";

type Activity = "explorer" | "notes" | "local" | "files" | "search" | "agents" | "skills" | "tools" | "ssh";
type ConsoleDock = "bottom" | "right";
type PanelTab = "console" | "attention" | "journal";

export type WorkbenchRenderers = {
  history: () => ReactNode;
  settings: () => ReactNode;
  todo: (project: Project, todo: Todo) => ReactNode;
};

type Props = {
  data: MboxData;
  titleBar: (actions: {
    openSearch: () => void;
    openTodo: (todoId: string) => void;
    toggleSidebar: () => void;
    toggleConsole: () => void;
    activeTab: { title: string; hint: string; icon: string; dirty: boolean; tabs: number };
  }) => ReactNode;
  renderers: WorkbenchRenderers;
  realtime: { state: string; label: string };
  status: { state: string; label: string };
  user: { username: string; role: string };
  onProjectContext: (project: Project, position: { x: number; y: number }) => void;
};

function useDrag(onMove: (event: PointerEvent) => void) {
  return useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    document.body.classList.add("wb-resizing");
    const move = (moveEvent: PointerEvent) => onMove(moveEvent);
    const up = () => {
      document.body.classList.remove("wb-resizing");
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }, [onMove]);
}

export function Workbench({ data, titleBar, renderers, status, user, onProjectContext }: Props) {
  const tabs = useTabs();
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => { installScrollMemory(); }, []);
  const [activity, setActivity] = usePersistentState<Activity>("mbox.wb.activity", "explorer");
  const [sidebarOpen, setSidebarOpen] = usePersistentState("mbox.wb.sidebarOpen", true);
  const [sidebarWidth, setSidebarWidth] = usePersistentState("mbox.wb.sidebarWidth", 300);
  const [panelOpen, setPanelOpen] = usePersistentState("mbox.wb.panelOpen", true);
  const [panelHeight, setPanelHeight] = usePersistentState("mbox.wb.panelHeight", 300);
  const [panelMaximized, setPanelMaximized] = usePersistentState("mbox.wb.panelMaximized", false);
  const [panelTab, setPanelTab] = usePersistentState<PanelTab>("mbox.wb.panelTab", "console");
  const [consoleDock, setConsoleDock] = usePersistentState<ConsoleDock>("mbox.wb.consoleDock", "bottom");
  const [rightOpen, setRightOpen] = usePersistentState("mbox.wb.rightOpen", true);
  const [rightWidth, setRightWidth] = usePersistentState("mbox.wb.rightWidth", 460);
  const [searchFocus, setSearchFocus] = useState(0);
  const skillsCatalog = useSkillsCatalog();
  const localWorkspace = useLocalWorkspace();
  useEffect(() => {
    setWorkspaceUser(user.username);
    setAgentHint(recentlyActiveAgent);
  }, [user.username]);
  const toolsCatalog = useToolsCatalog();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [visited, setVisited] = useState<Set<string>>(() => new Set([tabs.active]));
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (tabs.active) setVisited((current) => (current.has(tabs.active) ? current : new Set(current).add(tabs.active)));
    // На телефоне панели перекрывают документ целиком: открыли вкладку — показываем её.
    if (window.matchMedia("(max-width: 720px)").matches) { setSidebarOpen(false); setPanelOpen(false); }
  }, [tabs.active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (window.matchMedia("(max-width: 720px)").matches) { setSidebarOpen(false); setPanelOpen(false); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onTitle = useCallback((key: string, title: string) => setTitles((current) => (current[key] === title ? current : { ...current, [key]: title })), []);
  const onDirty = useCallback((key: string, value: boolean) => setDirty((current) => (Boolean(current[key]) === value ? current : { ...current, [key]: value })), []);

  function showActivity(next: Activity) {
    if (activity === next && sidebarOpen) setSidebarOpen(false);
    else { setActivity(next); setSidebarOpen(true); }
    if (window.matchMedia("(max-width: 720px)").matches) setPanelOpen(false);
    if (next === "search") setSearchFocus((value) => value + 1);
  }

  const openSearch = useCallback(() => {
    setActivity("search");
    setSidebarOpen(true);
    setSearchFocus((value) => value + 1);
  }, [setActivity, setSidebarOpen]);

  /** Консоль живёт либо во вкладке нижней панели, либо отдельной колонкой справа — как чат в VS Code. */
  function toggleConsole(forceOpen = false) {
    if (consoleDock === "right") setRightOpen((value) => forceOpen || !value);
    else if (forceOpen) { setPanelTab("console"); setPanelOpen(true); }
    else showPanel("console");
  }

  function dockConsole(dock: ConsoleDock) {
    setConsoleDock(dock);
    if (dock === "right") {
      setRightOpen(true);
      if (panelTab === "console") { setPanelTab("attention"); setPanelOpen(false); }
    } else {
      setPanelTab("console");
      setPanelOpen(true);
    }
  }

  function showPanel(tab: PanelTab) {
    if (panelOpen && panelTab === tab) setPanelOpen(false);
    else { setPanelTab(tab); setPanelOpen(true); }
  }

  // Агент открыл вкладку (MCP open_tab): показываем её и коротко говорим, кто и зачем.
  const [agentNotice, setAgentNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const openTabHandler = useRef<(event: OpenTabEvent) => void>(() => undefined);
  openTabHandler.current = (event) => {
    void applyOpenTab(event, tabs, () => { setActivity("local"); setSidebarOpen(true); })
      .then((result) => {
        const who = event.actor || "Агент";
        setAgentNotice({ tone: result.tone, text: result.tone === "ok" ? `${who} открыл ${result.text}${event.note ? ` — ${event.note}` : ""}` : result.text });
      })
      .catch((cause) => setAgentNotice({ tone: "warn", text: `Не открылось: ${cause instanceof Error ? cause.message : String(cause)}` }));
  };
  useEffect(() => {
    const listener = (event: Event) => openTabHandler.current((event as CustomEvent<OpenTabEvent>).detail);
    window.addEventListener("mbox:open-tab", listener);
    return () => window.removeEventListener("mbox:open-tab", listener);
  }, []);
  useEffect(() => {
    if (!agentNotice) return;
    const timer = window.setTimeout(() => setAgentNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [agentNotice]);

  function closeTab(key: string) {
    if (dirty[key] && !window.confirm("Во вкладке несохранённые правки. Закрыть?")) return;
    tabs.close(key);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.shiftKey && (key === "k" || key === "p")) { event.preventDefault(); openSearch(); }
      else if (mod && event.shiftKey && (key === "f" || event.code === "KeyF")) { event.preventDefault(); openSearch(); }
      else if (mod && event.shiftKey && event.code === "KeyE") { event.preventDefault(); setActivity("explorer"); setSidebarOpen(true); }
      else if (mod && !event.shiftKey && event.code === "KeyB") { event.preventDefault(); setSidebarOpen((value) => !value); }
      else if (mod && !event.shiftKey && event.code === "KeyJ") { event.preventDefault(); setPanelOpen((value) => !value); }
      else if (mod && event.code === "Backquote") { event.preventDefault(); toggleConsole(); }
      else if (event.altKey && event.code === "KeyW" && tabs.active) { event.preventDefault(); closeTab(tabs.active); }
      else if (mod && event.altKey && event.code === "KeyN") { event.preventDefault(); setActivity("notes"); setSidebarOpen(true); void createNoteAndOpen(tabs); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const resizeSidebar = useDrag(useCallback((event: PointerEvent) => {
    setSidebarWidth(Math.min(640, Math.max(200, event.clientX - 48)));
  }, [setSidebarWidth]));

  const resizeRight = useDrag(useCallback((event: PointerEvent) => {
    setRightWidth(Math.min(Math.round(window.innerWidth * 0.6), Math.max(300, window.innerWidth - event.clientX)));
  }, [setRightWidth]));

  const resizePanel = useDrag(useCallback((event: PointerEvent) => {
    const rect = centerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelHeight(Math.min(rect.height - 120, Math.max(120, rect.bottom - event.clientY)));
  }, [setPanelHeight]));

  const needsHuman = data.inbox.filter((item) => item.requires_human && item.status !== "done");
  const attentionTodos = useMemo(
    () => data.projects.flatMap((project) => project.todos.filter((todo) => todo.status === "blocked" || todo.status === "review").map((todo) => ({ todo, project }))),
    [data.projects],
  );
  const knownAgents = data.agents.filter((agent) => agentFamily(agent.name));
  const working = knownAgents.filter((agent) => isAgentWorking(agent, data.runs));
  const agentGoals = useMemo(() => {
    const map: Record<string, string> = {};
    for (const agent of knownAgents) {
      const goal = liveRunOf(data.runs, agent.name)?.goal;
      if (goal) map[agent.name] = goal;
    }
    return map;
  }, [knownAgents, data.runs]);
  // Наблюдатель может работать вне этого окна (установленный MBOX Desktop, автозапуск, другая машина):
  // тогда локальной сессии нет, но сервер видит его присутствие — консоль должна это показать.
  const agentsOnline = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const agent of knownAgents) {
      const label = agentFamily(agent.name)?.label;
      if (label && (effectiveStatus(agent) !== "offline" || isAgentWorking(agent, data.runs))) map[label] = true;
    }
    return map;
  }, [knownAgents, data.runs]);
  const activeProjectId = projectIdOfTab(tabs.active);
  const currentProjectName = data.projects.find((project) => project.id === activeProjectId)?.name;
  const attentionCount = needsHuman.length + attentionTodos.length;
  const effectivePanelTab: PanelTab = consoleDock === "right" && panelTab === "console" ? "attention" : panelTab;

  const catalogTitles = useMemo(() => {
    const map: Record<string, string> = { ...titles };
    for (const skill of skillsCatalog.data.skills) map[`skill:${skill.id}`] = skill.name;
    for (const tool of toolsCatalog.data.tools) map[`tool:${tool.id}`] = tool.name;
    return map;
  }, [titles, skillsCatalog.data.skills, toolsCatalog.data.tools]);
  const activeTabMeta = tabMeta(tabs.active, data, catalogTitles);

  function renderTab(key: string): ReactNode {
    const [kind, first, second] = key.split(":");
    const rest = key.split(":").slice(2).join(":");
    const project = data.projects.find((item) => item.id === first);
    const lost = (text: string) => <div className="wb-doc-missing">{text}</div>;
    switch (kind) {
      case "welcome":
        return <Overview data={data} onOpenProject={(projectId) => tabs.open(`todos:${projectId}`, true)} />;
      case "artifacts":
        return <ArtifactsTab data={data} />;
      case "abilities":
        return <AbilitiesBoard />;
      case "history":
        return renderers.history();
      case "settings":
        return renderers.settings();
      case "todos":
        if (!project) return lost("Проект не найден — возможно, его удалили.");
        return <TodoBoard project={project} tabs={tabs} onSaved={data.reload} />;
      case "entity":
        if (!project) return lost("Проект не найден — возможно, его удалили.");
        if (second === "memories") return <ProjectMemories project={project} memories={data.memories} tabs={tabs} />;
        return (
          <div className="wb-doc-page">
            <DocHeader title={tabMeta(key, data, catalogTitles).title.split(" · ")[0]} project={project} tabs={tabs} />
            <ProjectEntityView project={project} projects={data.projects} memories={data.memories} kind={second as ProjectEntityKind} onSaved={data.reload} onOpenMemory={(memoryId) => tabs.open(`memory:${memoryId}`, true)} />
          </div>
        );
      case "folder": {
        const folder = data.folders.find((item) => item.id === second);
        if (!project || !folder) return lost("Папка не найдена — возможно, её удалили.");
        return (
          <div className="wb-doc-page">
            <DocHeader title={folder.name} project={project} tabs={tabs} detail={formatBytes(folder.memory_bytes)} />
            <FolderBoard folder={folder} project={project} memories={data.memories} onSaved={data.reload} onOpenMemory={(memoryId) => tabs.open(`memory:${memoryId}`, true)} />
          </div>
        );
      }
      case "todo": {
        const owner = data.projects.find((item) => item.todos.some((todo) => todo.id === first));
        const todo = owner?.todos.find((item) => item.id === first);
        if (!owner || !todo) return lost(data.loading ? "Загрузка…" : `Todo #${first} не найдено.`);
        return <TodoDocument project={owner} todo={todo} tabs={tabs} tabKey={key} visible={tabs.active === key} onDirty={onDirty} onSaved={data.reload} />;
      }
      case "note":
        return <NoteDocument noteId={first} data={data} tabs={tabs} tabKey={key} visible={tabs.active === key} onDirty={onDirty} />;
      case "storage":
        return <StorageDocument />;
      case "local":
        return IMAGE_FILE.test(rest)
          ? <LocalImageDocument rootKey={first} path={rest} />
          : <LocalFileDocument rootKey={first} path={rest} tabs={tabs} tabKey={key} visible={tabs.active === key} onDirty={onDirty} />;
      case "gitdiff":
        return <GitDiffDocument rootKey={first} path={rest} tabs={tabs} />;
      case "commit":
        return <CommitDocument rootKey={first} hash={rest} />;
      case "skill":
        return <SkillDocument skillId={first} tabs={tabs} />;
      case "skillblocks":
        return <SkillBlocksDocument skill={first} tabs={tabs} projectId={data.projects.find((item) => item.name === "MBOX")?.id} />;
      case "skillpage":
        return <SkillPageDocument skill={first} file={rest} tabKey={key} tabs={tabs} projectId={data.projects.find((item) => item.name === "MBOX")?.id} />;
      case "tool":
        return <ToolDocument toolId={first} />;
      case "file":
        return <FileDocument fileId={first} data={data} tabs={tabs} tabKey={key} visible={tabs.active === key} onDirty={onDirty} />;
      case "term":
        return <ConsolePaneDocument paneId={key.slice(TERMINAL_TAB.length)} tabs={tabs} agentGoals={agentGoals} agentsOnline={agentsOnline} renderChat={(paneId) => renderChat(tabs.active === key, paneId)} onReveal={() => toggleConsole(true)} />;
      case "memory":
        return <MemoryDocument memoryId={first} data={data} tabs={tabs} tabKey={key} visible={tabs.active === key} onTitle={onTitle} onDirty={onDirty} />;
      default:
        return lost("Неизвестная вкладка");
    }
  }

  // Сохранённые ширины — пожелание, а не закон: на узком окне консоль и боковая панель ужимаются
  // (сначала консоль, потом панель, потом панель прячется), чтобы редактору осталось место.
  // Сохранённые значения не трогаем — окно станет шире, вернутся как были.
  const fitted = fitLayout(viewport, {
    sidebar: sidebarOpen ? sidebarWidth : 0,
    right: consoleDock === "right" && rightOpen ? rightWidth : 0,
    panel: panelOpen && !panelMaximized ? panelHeight : 0,
  });
  const layoutStyle = {
    ["--wb-sidebar" as string]: `${fitted.sidebar}px`,
    ["--wb-panel" as string]: panelOpen ? (panelMaximized ? "calc(100% - 36px)" : `${fitted.panel}px`) : "0px",
    ["--wb-right" as string]: `${fitted.right}px`,
  };

  const consoleVisible = consoleDock === "right" ? rightOpen : panelOpen && panelTab === "console";
  const renderChat = (visible: boolean, paneId: string) => (
    <AgentChat embedded visible={visible} peer={chatPeer(paneId)} inbox={data.inbox} agents={data.agents} runs={data.runs} projects={data.projects} artifacts={data.artifacts} projectId={data.projects.find((project) => project.name === "MBOX")?.id} currentProjectName={currentProjectName} onSaved={data.reload} />
  );
  const chat = (
    <ConsoleArea
      onReveal={() => toggleConsole(true)}
      agentGoals={agentGoals}
      agentsOnline={agentsOnline}
      tabs={tabs}
      renderChat={(paneId) => renderChat(consoleVisible, paneId)}
    />
  );

  return (
    <div className={["wb", sidebarOpen ? "has-sidebar" : "", panelOpen ? "has-panel" : "", consoleDock === "right" && rightOpen ? "has-right" : ""].filter(Boolean).join(" ")} style={layoutStyle}>
      <div className="wb-titlebar">{titleBar({
        openSearch,
        openTodo: (todoId) => tabs.open(`todo:${todoId}`, true),
        toggleSidebar: () => setSidebarOpen((value) => !value),
        toggleConsole,
        activeTab: {
          ...activeTabMeta,
          dirty: Boolean(dirty[tabs.active]),
          tabs: tabs.tabs.length,
        },
      })}</div>

      <nav className="wb-activitybar" aria-label="Разделы">
        <ActivityButton label="Проводник (Ctrl+Shift+E)" icon={`${MENU}/provodnik.png`} active={sidebarOpen && activity === "explorer"} onClick={() => showActivity("explorer")} />
        <ActivityButton label="Заметки (Ctrl+Alt+N — новая)" icon={`${MENU}/zametki.png`} active={sidebarOpen && activity === "notes"} onClick={() => showActivity("notes")} />
        <ActivityButton label="Папки (локальные файлы и git)" icon={`${MENU}/papki.png`} active={sidebarOpen && activity === "local"} onClick={() => showActivity("local")} />
        <ActivityButton label="Артефакты" icon={`${MENU}/artefakty.png`} active={sidebarOpen && activity === "files"} onClick={() => showActivity("files")} />
        <ActivityButton label="Хранилище S3" icon={`${MENU}/hranilishe.png`} active={tabs.active === "storage"} onClick={() => tabs.open("storage", true)} />
        <ActivityButton label="Поиск по памяти (Ctrl+K)" icon={`${MENU}/pamyat.png`} active={sidebarOpen && activity === "search"} onClick={() => showActivity("search")} />
        <ActivityButton label="Агенты" icon={`${MENU}/agenty.png`} active={sidebarOpen && activity === "agents"} onClick={() => showActivity("agents")} badge={needsHuman.length} />
        <ActivityButton label="Навыки" icon={`${MENU}/navyki.png`} active={sidebarOpen && activity === "skills"} onClick={() => showActivity("skills")} />
        <ActivityButton label="Инструменты" icon={`${MENU}/instrumenty.png`} active={sidebarOpen && activity === "tools"} onClick={() => showActivity("tools")} />
        <ActivityButton label="SSH" icon="/assets/icons/icons/ssh.png" active={sidebarOpen && activity === "ssh"} onClick={() => showActivity("ssh")} />
        <span className="wb-activity-fill" />
        <button type="button" className={consoleVisible ? "wb-activity is-mobile-only is-active" : "wb-activity is-mobile-only"} onClick={() => { setSidebarOpen(false); toggleConsole(); }} aria-label="Консоль агентов">
          <img src={`${MENU}/konsol.png`} width={22} height={22} alt="" draggable={false} />
          <span className="wb-activity-tip" role="tooltip">Консоль агентов</span>
        </button>
        <ActivityButton label="Настройки" icon="/assets/icons/icons/settings.png" active={tabs.active === "settings"} onClick={() => tabs.open("settings", true)} />
      </nav>

      <aside className="wb-sidebar" aria-label="Боковая панель" data-scroll-scope={`sidebar:${activity}`}>
        {activity === "explorer" && <ExplorerView data={data} tabs={tabs} onProjectContext={onProjectContext} />}
        {activity === "search" && <SearchView data={data} tabs={tabs} focusSignal={searchFocus} />}
        {activity === "agents" && <AgentsView data={data} tabs={tabs} />}
        {activity === "notes" && <NotesView tabs={tabs} />}
        {activity === "local" && <LocalFoldersView tabs={tabs} />}
        {activity === "files" && <FilesView data={data} tabs={tabs} />}
        {activity === "skills" && <SkillsView tabs={tabs} />}
        {activity === "tools" && <ToolsView tabs={tabs} />}
        {activity === "ssh" && <SshView />}
        <div className="wb-sash is-vertical" onPointerDown={resizeSidebar} role="separator" aria-orientation="vertical" aria-label="Ширина боковой панели" />
      </aside>

      <div className="wb-center" ref={centerRef}>
        <section className="wb-editor" aria-label="Вкладки">
          <div
            className="wb-tabs"
            role="tablist"
            onWheel={(event) => { event.currentTarget.scrollLeft += event.deltaY; }}
            // Панель консоли, брошенная на полосу вкладок, переезжает в редактор — как терминал в VS Code.
            onDragOver={(event) => { if (event.dataTransfer.types.includes(PANE_MIME)) event.preventDefault(); }}
            onDrop={(event) => {
              const pane = event.dataTransfer.getData(PANE_MIME);
              if (!pane) return;
              event.preventDefault();
              consoleLayout.detach(pane);
              tabs.open(`${TERMINAL_TAB}${pane}`, true);
            }}
          >
            {tabs.tabs.map((tab) => {
              const meta = tabMeta(tab.key, data, catalogTitles);
              const active = tab.key === tabs.active;
              return (
                <div
                  key={tab.key}
                  role="tab"
                  aria-selected={active}
                  className={["wb-tab", active ? "is-active" : "", tab.pinned ? "" : "is-preview", dirty[tab.key] ? "is-dirty" : "", draggedTab && draggedTab !== tab.key ? "is-drop-zone" : ""].filter(Boolean).join(" ")}
                  title={meta.hint}
                  onClick={() => tabs.open(tab.key)}
                  onDoubleClick={() => tabs.pin(tab.key)}
                  onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.key); } }}
                  onContextMenu={(event) => { event.preventDefault(); setTabMenu({ key: tab.key, x: event.clientX, y: event.clientY }); }}
                  draggable
                  onDragStart={() => setDraggedTab(tab.key)}
                  onDragOver={(event) => { if (draggedTab) event.preventDefault(); }}
                  onDrop={(event) => { event.preventDefault(); if (draggedTab) tabs.move(draggedTab, tab.key); setDraggedTab(null); }}
                  onDragEnd={() => setDraggedTab(null)}
                >
                  <img src={meta.icon} width={14} height={14} alt="" />
                  <span className="wb-tab-title">{meta.title}</span>
                  <button type="button" className="wb-tab-close" onClick={(event) => { event.stopPropagation(); closeTab(tab.key); }} aria-label={`Закрыть ${meta.title}`}>
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="wb-docs">
            {tabs.tabs.length === 0 && (
              <div className="wb-watermark">
                <img src="/assets/icons/icons/logo.png" width={72} height={72} alt="" />
                <dl>
                  <dt>Поиск по памяти</dt><dd><kbd>Ctrl</kbd>+<kbd>K</kbd></dd>
                  <dt>Проводник</dt><dd><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd></dd>
                  <dt>Боковая панель</dt><dd><kbd>Ctrl</kbd>+<kbd>B</kbd></dd>
                  <dt>Нижняя панель</dt><dd><kbd>Ctrl</kbd>+<kbd>J</kbd></dd>
                  <dt>Закрыть вкладку</dt><dd><kbd>Alt</kbd>+<kbd>W</kbd></dd>
                </dl>
              </div>
            )}
            {tabs.tabs.filter((tab) => visited.has(tab.key) || tab.key === tabs.active).map((tab) => (
              <div key={tab.key} className="wb-doc" hidden={tab.key !== tabs.active} data-scroll-scope={`tab:${tab.key}`}>
                {renderTab(tab.key)}
              </div>
            ))}
          </div>
        </section>

        <section className="wb-panel" aria-label="Нижняя панель">
          <div className="wb-sash is-horizontal" onPointerDown={resizePanel} role="separator" aria-orientation="horizontal" aria-label="Высота нижней панели" />
          <div className="wb-panel-tabs" role="tablist">
            {consoleDock === "bottom" && <PanelTabButton active={effectivePanelTab === "console"} onClick={() => setPanelTab("console")} label="Консоль" badge={working.length ? "●" : undefined} />}
            <PanelTabButton active={effectivePanelTab === "attention"} onClick={() => setPanelTab("attention")} label="Внимание" badge={attentionCount || undefined} warn={needsHuman.length > 0} />
            <PanelTabButton active={effectivePanelTab === "journal"} onClick={() => setPanelTab("journal")} label="Журнал" />
            <span className="wb-panel-fill" />
            {consoleDock === "bottom" && effectivePanelTab === "console" && (
              <button type="button" className="wb-icon-btn" onClick={() => dockConsole("right")} title="Перенести консоль вправо"><PanelRight size={15} /></button>
            )}
            <button type="button" className="wb-icon-btn" onClick={() => setPanelMaximized((value) => !value)} title={panelMaximized ? "Восстановить" : "Развернуть"}>
              {panelMaximized ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
            </button>
            <button type="button" className="wb-icon-btn" onClick={() => setPanelOpen(false)} title="Скрыть панель (Ctrl+J)"><X size={15} /></button>
          </div>
          <div className="wb-panel-body">
            {consoleDock === "bottom" && <div className="wb-panel-pane is-console" hidden={effectivePanelTab !== "console"}>{chat}</div>}
            {effectivePanelTab === "attention" && (
              <div className="wb-panel-pane is-scroll" data-scroll-scope="panel:attention">
                <NeedsAnswer inbox={data.inbox} onSaved={data.reload} />
                {attentionTodos.length > 0 ? (
                  <ul className="wb-attention">
                    {attentionTodos.map(({ todo, project }) => (
                      <li key={todo.id}>
                        <button type="button" onClick={() => tabs.open(`todo:${todo.id}`, true)}>
                          <span className={`wb-status-dot status-${todo.status}`} />
                          <span className="wb-attention-title">{todo.title}</span>
                          <span className="wb-attention-meta">{project.name} · {todoStatusLabel(todo.status)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : !needsHuman.length && <p className="wb-empty">Ничего не требует внимания</p>}
              </div>
            )}
            {effectivePanelTab === "journal" && <div className="wb-panel-pane is-journal" data-scroll-scope="panel:journal">{renderers.history()}</div>}
          </div>
        </section>
      </div>

      <aside className="wb-right" aria-label="Консоль агентов">
        {consoleDock === "right" && (
          <>
            <div className="wb-sash is-vertical is-left" onPointerDown={resizeRight} role="separator" aria-orientation="vertical" aria-label="Ширина консоли" />
            <header className="wb-right-head">
              <span>Консоль{working.length > 0 && <i className="wb-live-dot" title="Агенты в работе" />}</span>
              <div className="wb-view-actions">
                <button type="button" onClick={() => dockConsole("bottom")} title="Перенести консоль вниз"><PanelBottom size={14} /></button>
                <button type="button" onClick={() => setRightOpen(false)} title="Скрыть консоль (Ctrl+`)"><X size={14} /></button>
              </div>
            </header>
            <div className="wb-right-body">{chat}</div>
          </>
        )}
      </aside>

      <footer className="wb-statusbar">
        <button type="button" className={`wb-status-item is-state state-${status.state}`} onClick={() => showActivity("agents")} title="Состояние агентов">
          <i className="wb-state-dot" />{status.label}
        </button>
        <button type="button" className={consoleVisible ? "wb-status-item is-on" : "wb-status-item"} onClick={() => toggleConsole()} title="Консоль агентов (Ctrl+`)">
          <TerminalSquare size={12} /> {working.length > 0 ? `${working.length} ${plural(working.length, "агент", "агента", "агентов")} в работе` : "Консоль"}
        </button>
        <span className="wb-status-fill" />
        {(() => {
          const [kind, rootKey] = tabs.active.split(":");
          const key = ["local", "gitdiff", "commit"].includes(kind) ? rootKey : localWorkspace.roots[0]?.key;
          const git = key ? localWorkspace.git(key) : undefined;
          if (!git?.isRepo) return null;
          return (
            <button type="button" className="wb-status-item" onClick={() => showActivity("local")} title={`Ветка git · ${git.changesTotal ?? 0} изменённых файлов`}>
              <GitBranch size={12} /> {git.branch}{(git.changesTotal ?? 0) > 0 ? `*${git.changesTotal}` : ""}{(git.ahead ?? 0) > 0 ? ` ↑${git.ahead}` : ""}{(git.behind ?? 0) > 0 ? ` ↓${git.behind}` : ""}
            </button>
          );
        })()}
        {attentionCount > 0 && (
          <button type="button" className={needsHuman.length ? "wb-status-item is-warn" : "wb-status-item"} onClick={() => showPanel("attention")} title="Требует внимания">
            <AlertTriangle size={12} /> {attentionCount}
          </button>
        )}
        <button type="button" className="wb-status-item" onClick={openSearch} title="Записей памяти">
          <Database size={12} /> {data.memoriesTotal.toLocaleString("ru-RU")} {plural(data.memoriesTotal, "запись", "записи", "записей")}
        </button>
        <button type="button" className="wb-status-item" onClick={() => setSidebarOpen((value) => !value)} title="Боковая панель (Ctrl+B)"><PanelLeft size={12} /></button>
        <button type="button" className="wb-status-item" onClick={() => setPanelOpen((value) => !value)} title="Нижняя панель (Ctrl+J)"><PanelBottom size={12} /></button>
        <button type="button" className="wb-status-item" onClick={() => dockConsole(consoleDock === "right" ? "bottom" : "right")} title={consoleDock === "right" ? "Консоль вниз" : "Консоль справа"}><PanelRight size={12} /></button>
        <span className="wb-status-item is-static">{user.username}</span>
      </footer>

      {agentNotice && (
        <div className={agentNotice.tone === "warn" ? "wb-agent-toast is-warn" : "wb-agent-toast"} role="status" onClick={() => setAgentNotice(null)}>
          {agentNotice.text}
        </div>
      )}

      {tabMenu && (
        <WbMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)}>
          <button type="button" role="menuitem" onClick={() => { closeTab(tabMenu.key); setTabMenu(null); }}>Закрыть</button>
          <button type="button" role="menuitem" onClick={() => { tabs.closeOthers(tabMenu.key); setTabMenu(null); }}>Закрыть остальные</button>
          <button type="button" role="menuitem" onClick={() => { tabs.pin(tabMenu.key); setTabMenu(null); }}>Закрепить</button>
          <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(`${serverOrigin()}/?tab=${encodeTabParam(tabMenu.key)}`); setTabMenu(null); }}>Копировать ссылку</button>
        </WbMenu>
      )}
    </div>
  );
}

function ActivityButton({ label, icon, active, onClick, badge }: { label: string; icon: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button type="button" className={active ? "wb-activity is-active" : "wb-activity"} onClick={onClick} aria-label={label} aria-pressed={active}>
      <img src={icon} width={22} height={22} alt="" />
      <span className="wb-activity-tip" role="tooltip">{label}</span>
      {Boolean(badge) && <b>{badge}</b>}
    </button>
  );
}

function PanelTabButton({ label, active, onClick, badge, warn }: { label: string; active: boolean; onClick: () => void; badge?: number | string; warn?: boolean }) {
  return (
    <button type="button" role="tab" aria-selected={active} className={active ? "wb-panel-tab is-active" : "wb-panel-tab"} onClick={onClick}>
      {label}{badge !== undefined && <b className={warn ? "is-warn" : undefined}>{badge}</b>}
    </button>
  );
}

function DocHeader({ title, project, detail, tabs }: { title: string; project: Project; detail?: string; tabs: TabsApi }) {
  return (
    <header className="wb-doc-header" style={{ ["--project-color" as string]: project.color || "#5b6b66" }}>
      <button type="button" className="wb-doc-project" onClick={() => tabs.open(`todos:${project.id}`, true)}>
        <span className="wb-project-dot" />{project.name}
      </button>
      <span className="wb-doc-sep">›</span>
      <h2>{title}</h2>
      {detail && <span className="wb-doc-detail">{detail}</span>}
    </header>
  );
}

function ArtifactsTab({ data }: { data: MboxData }) {
  const [node, setNode] = useState("");
  return <ArtifactsBoard artifacts={data.artifacts} folders={data.folders} projects={data.projects} query="" selectedNodeKey={node} onSelectedNodeKey={setNode} onSaved={data.reload} />;
}

const STALE_AGENT_MS = 24 * 60 * 60 * 1000;

function AgentsView({ data, tabs }: { data: MboxData; tabs: TabsApi }) {
  const [showStale, setShowStale] = usePersistentState("mbox.agents.showStale", false);
  const sorted = [...data.agents].sort((a, b) => Number(isAgentWorking(b, data.runs)) - Number(isAgentWorking(a, data.runs)));
  // Разовые сессии («vs-code-session», старый «VS Code») висели в команде неделями отключёнными.
  const isStale = (agent: (typeof sorted)[number]) => !isAgentWorking(agent, data.runs) && effectiveStatus(agent) !== "active" && (!agent.last_seen || Date.now() - Date.parse(agent.last_seen) > STALE_AGENT_MS);
  const stale = sorted.filter(isStale);
  const agents = showStale ? sorted : sorted.filter((agent) => !isStale(agent));
  const needsHuman = data.inbox.filter((item) => item.requires_human && item.status !== "done");
  return (
    <div className="wb-view">
      <header className="wb-view-head">
        <span>Агенты</span>
      </header>
      <div className="wb-view-body">
        {needsHuman.length > 0 && (
          <section className="wb-side-section">
            <h3>Ждут твоего решения · {needsHuman.length}</h3>
            <NeedsAnswer inbox={data.inbox} onSaved={data.reload} />
          </section>
        )}
        <section className="wb-side-section">
          <h3>Команда</h3>
          <ul className="wb-agent-list">
            {agents.map((agent) => {
              const status = effectiveStatus(agent);
              const live = isAgentWorking(agent, data.runs);
              const run = liveRunOf(data.runs, agent.name);
              return (
                <li key={agent.id} className={live ? "is-live" : undefined}>
                  <AgentAvatar name={agent.name} status={status} live={live} size={28} />
                  <div>
                    <strong>{agent.name}</strong>
                    <span>{live ? run?.goal || "в работе" : `${agentStatusLabels[status] || status} · ${formatSince(agent.last_seen)}`}</span>
                  </div>
                </li>
              );
            })}
            {!agents.length && <li className="wb-empty">Агенты пока не подключались</li>}
          </ul>
          {stale.length > 0 && <button type="button" className="wb-board-more" onClick={() => setShowStale(!showStale)}>{showStale ? "скрыть давно отключённых" : `ещё ${stale.length} давно отключённых`}</button>}
        </section>
      </div>
    </div>
  );
}

const ACTIVITY_PX = 44;
const EDITOR_MIN_PX = 380;
const EDITOR_MIN_HEIGHT_PX = 140;

function fitLayout(viewport: { width: number; height: number }, wanted: { sidebar: number; right: number; panel: number }) {
  let { sidebar, right } = wanted;
  const room = viewport.width - ACTIVITY_PX - EDITOR_MIN_PX;
  const excess = () => sidebar + right - room;
  if (excess() > 0 && right) right = Math.max(280, right - excess());
  if (excess() > 0 && sidebar) sidebar = Math.max(180, sidebar - excess());
  if (excess() > 0) sidebar = 0;
  if (excess() > 0 && right) right = Math.max(220, right - excess());
  // Титульная строка и строка состояния ~60px; редактору оставляем хотя бы полосу вкладок и немного текста.
  const panel = wanted.panel ? Math.max(120, Math.min(wanted.panel, viewport.height - 60 - EDITOR_MIN_HEIGHT_PX)) : 0;
  return { sidebar, right, panel };
}
