import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Columns2, Database, GitBranch, MessageSquare, PanelBottom, PanelLeft, PanelRight, Power, RotateCcw, TerminalSquare, Trash2, X } from "lucide-react";
import { AgentAvatar, AgentName } from "../../components/AgentAvatar";
import { AgentChat, type FocusItem } from "../../features/agents/AgentChat";
import { NeedsAnswer } from "../../features/agents/NeedsAnswer";
import { FolderBoard } from "../../features/projects/FolderBoard";
import { ProjectEntityView } from "../../features/projects/EntityPanels";
import type { ProjectEntityKind } from "../../features/tree/entityKinds";
import type { MboxData } from "../../hooks/useMboxData";
import { agentFamily, effectiveStatus, isAgentWorking, liveRunOf, CLOUD_AGENTS, isCloudAgent } from "../../lib/agents";
import { formatBytes, formatSince, plural } from "../../lib/format";
import { agentStatusLabels, todoStatusLabel } from "../../lib/labels";
import { AbilitiesBoard } from "../../pages/Abilities";
import { ArtifactsBoard } from "../../pages/Artifacts";
import { Overview } from "../../pages/Overview";
import type { Project, Todo } from "../../types";
import { SkillDocument, ToolDocument } from "./CatalogDocuments";
import { SeoBoard } from "../../pages/Seo";
import { ConsoleArea, ConsolePaneDocument, PANE_MIME, TERMINAL_TAB, type ChatDebug } from "./ConsoleArea";
import { chatPeer, consoleLayout } from "./consoleLayout";
import { installScrollMemory } from "./uiMemory";
import { serverOrigin } from "../../lib/serverOrigin";
import { fetchJson, saveEntity } from "../../lib/api";
import { LocalImageDocument } from "./LocalImageDocument";
import { BROWSER_FAVICON_EVENT, BrowserDocument, browserBridge, browserFaviconOrigin, browserTabKey, browserTabUrl, cachedBrowserFavicon, Favicon, type BrowserFaviconDetail } from "./BrowserDocument";
import { LocalOfficeDocument } from "./LocalOfficeDocument";
import { SkillsView, ToolsView } from "./CatalogViews";
import { useSkillsCatalog, useToolsCatalog } from "./catalog";
import { ExplorerView } from "./ExplorerView";
import { FileDocument, FilesView } from "./Files";
import { recentlyActiveAgent, useDesktopSessions } from "./desktopSessions";
import { LocalFoldersView } from "./LocalFolders";
import { createNoteAndOpen, NoteDocument, NotesView } from "./Notes";
import { SshView } from "./SshView";
import { StorageDocument } from "./Storage";
import { STORAGE_SHEET_TAB, StorageSheetDocument } from "./StorageSheetDocument";
import { ProjectMemories } from "./ProjectMemories";
import { TodoBoard, TodoDocument } from "./Todos";
import { CommitDocument, GitDiffDocument, LocalFileDocument } from "./LocalFileDocument";
import { IMAGE_FILE, OFFICE_FILE, setAgentHint, setWorkspaceUser, useLocalWorkspace } from "./localWorkspace";
import { MemoryDocument } from "./MemoryDocument";
import { SearchView } from "./SearchView";
import { tabMeta } from "./tabMeta";
import { encodeTabParam, projectIdOfTab, setWorkbenchStorageUser, usePersistentState, useTabs, type TabsApi } from "./tabs";
import { WbMenu } from "./WbMenu";
import { applyOpenTab, type OpenTabEvent, type OpenTabResult } from "./agentTabs";
import { installBrowserAgent } from "./browserAgent";
import { SkillPageDocument } from "./SkillPageDocument";
import { FileTypeIcon } from "./FileTypeIcon";
import { RAIL_GROUPS, useRailHidden, type RailItemId } from "./rail";

type Activity = "explorer" | "notes" | "local" | "files" | "search" | "agents" | "skills" | "tools" | "ssh";
type ConsoleDock = "bottom" | "right";
type PanelTab = "console" | "attention" | "journal";

const ACTIVITY_ICONS = "/assets/icons/navigation";
const SYSTEM_ICONS = "/assets/icons/system";

function activityIcon(file: string) {
  return <img src={`${ACTIVITY_ICONS}/${file}`} alt="" draggable={false} />;
}

function systemIcon(file: string) {
  return <img src={`${SYSTEM_ICONS}/${file}`} alt="" draggable={false} />;
}

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
  user: { username: string; role: string; jarvis_enabled?: boolean; jarvis_autoreply?: boolean };
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
  setWorkbenchStorageUser(user.username);
  const tabs = useTabs();
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const defaultNoteProjectId = user.role === "owner" ? null : data.projects[0]?.id;

  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setViewport((current) => {
          const next = { width: window.innerWidth, height: window.innerHeight };
          return current.width === next.width && current.height === next.height ? current : next;
        });
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  useEffect(() => { installScrollMemory(); }, []);
  const [activity, setActivity] = usePersistentState<Activity>("mbox.wb.activity", "explorer");
  const [sidebarOpen, setSidebarOpen] = usePersistentState("mbox.wb.sidebarOpen", true);
  const [sidebarWidth, setSidebarWidth] = usePersistentState("mbox.wb.sidebarWidth", 300);
  const [panelOpen, setPanelOpen] = usePersistentState("mbox.wb.panelOpen", true);
  // Группировка верхних вкладок по видам (todo #328): браузер, документы и задачи не вперемешку.
  const [groupTabs, setGroupTabs] = usePersistentState("mbox.wb.groupTabs", true);
  const [panelHeight, setPanelHeight] = usePersistentState("mbox.wb.panelHeight", 300);
  const [panelMaximized, setPanelMaximized] = usePersistentState("mbox.wb.panelMaximized", false);
  const [panelTab, setPanelTab] = usePersistentState<PanelTab>("mbox.wb.panelTab", "console");
  const [consoleDock, setConsoleDock] = usePersistentState<ConsoleDock>("mbox.wb.consoleDock", "bottom");
  // Сплит центральной части: вторая группа редактора справа от основной. Держит ровно одну
  // вкладку (браузер слева — заметка справа, и наоборот), поэтому хватает одного ключа и доли ширины.
  const [splitKey, setSplitKey] = usePersistentState<string | null>("mbox.wb.splitKey", null);
  const [splitRatio, setSplitRatio] = usePersistentState("mbox.wb.splitRatio", 0.5);
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
  const [browserFavicons, setBrowserFavicons] = useState<Record<string, string>>({});
  const [browserOriginFavicons, setBrowserOriginFavicons] = useState<Record<string, string>>({});
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
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<BrowserFaviconDetail>).detail;
      if (!detail?.favicon) return;
      if (detail.key) setBrowserFavicons((current) => (current[detail.key!] === detail.favicon ? current : { ...current, [detail.key!]: detail.favicon }));
      const origin = detail.url ? browserFaviconOrigin(detail.url) : "";
      if (origin) setBrowserOriginFavicons((current) => (current[origin] === detail.favicon ? current : { ...current, [origin]: detail.favicon }));
    };
    window.addEventListener(BROWSER_FAVICON_EVENT, listener);
    return () => window.removeEventListener(BROWSER_FAVICON_EVENT, listener);
  }, []);

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

  // Разделы, которые открываются не боковой панелью, а вкладкой документа.
  const RAIL_TABS: Partial<Record<RailItemId, string>> = { storage: "storage", history: "history", browser: "web:" };
  const hasBrowser = Boolean(browserBridge());
  const railHidden = useRailHidden();

  function railActive(id: RailItemId) {
    const tabKey = RAIL_TABS[id];
    if (tabKey) return id === "browser" ? tabs.active.startsWith("web:") : tabs.active === tabKey;
    return sidebarOpen && activity === (id as Activity);
  }

  function openRail(id: RailItemId) {
    const tabKey = RAIL_TABS[id];
    if (tabKey) tabs.open(tabKey, true);
    else showActivity(id as Activity);
  }

  /** Галочка на карточке «Требует внимания»: задача уходит в «Готово» без открытия. */
  const resolveTodo = useCallback(async (todoId: string) => {
    await saveEntity("/api/mbox/todos", todoId, { status: "done" });
    data.reload();
  }, [data]);

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
  const [agentNotice, setAgentNotice] = useState<{ text: string; tone: "ok" | "warn"; action?: OpenTabResult["action"] } | null>(null);
  const openTabHandler = useRef<(event: OpenTabEvent) => void>(() => undefined);
  openTabHandler.current = (event) => {
    void applyOpenTab(event, tabs, () => { setActivity("local"); setSidebarOpen(true); })
      .then((result) => {
        if (event.quiet && result.tone === "ok") return;
        const who = event.actor || "Агент";
        setAgentNotice({ tone: result.tone, action: result.action, text: result.tone === "ok" ? `${who} открыл ${result.text}${event.note ? ` — ${event.note}` : ""}` : result.text });
      })
      .catch((cause) => setAgentNotice({ tone: "warn", text: `Не открылось: ${cause instanceof Error ? cause.message : String(cause)}` }));
  };
  // Агент во встроенном браузере: действия приходят вебсокетом, выполняет главный процесс MBOX Desktop.
  useEffect(() => { installBrowserAgent(); }, []);
  useEffect(() => {
    const listener = (event: Event) => openTabHandler.current((event as CustomEvent<OpenTabEvent>).detail);
    window.addEventListener("mbox:open-tab", listener);
    return () => window.removeEventListener("mbox:open-tab", listener);
  }, []);
  useEffect(() => {
    if (!agentNotice) return;
    // С кнопкой уведомление живёт дольше: восемь секунд — это меньше, чем нужно, чтобы прочитать,
    // решить и выбрать папку в системном диалоге.
    const timer = window.setTimeout(() => setAgentNotice(null), agentNotice.action ? 40000 : 8000);
    return () => window.clearTimeout(timer);
  }, [agentNotice]);

  /** Действие из уведомления (подключить папку и повторить открытие) — и сразу его результат. */
  const runNoticeAction = useCallback(async (action: NonNullable<OpenTabResult["action"]>) => {
    setAgentNotice(null);
    try {
      const result = await action.run();
      if (result) setAgentNotice({ tone: result.tone, action: result.action, text: result.tone === "ok" ? `Открыто: ${result.text}` : result.text });
    } catch (cause) {
      setAgentNotice({ tone: "warn", text: `Не открылось: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }, []);

  function closeTab(key: string) {
    if (dirty[key] && !window.confirm("Во вкладке несохранённые правки. Закрыть?")) return;
    if (key === splitKey) setSplitKey(null);
    tabs.close(key);
  }

  // Ссылка сайта на новое окно. Браузер во второй области открывает её там же: вкладка встаёт во вторую
  // область вместо него (он уходит в основной список вкладок), основная область не меняется. Через ref —
  // отрисованные документы кешируются и держат старое замыкание.
  const splitKeyRef = useRef(splitKey);
  splitKeyRef.current = splitKey;
  const tabsApiRef = useRef(tabs);
  tabsApiRef.current = tabs;
  const openFromBrowser = useCallback((fromKey: string, url: string) => {
    const key = browserTabKey(url);
    const api = tabsApiRef.current;
    if (splitKeyRef.current === fromKey) {
      const mainActive = api.active;
      api.open(key, true);
      setSplitKey(key);
      if (mainActive && mainActive !== key) api.open(mainActive);
      return;
    }
    api.open(key, true);
  }, [setSplitKey]);

  /** Отправить вкладку во вторую область. Активной она при этом быть не может — иначе в основной
   *  группе не останется документа, и левая половина будет пустой. */
  function splitTab(key: string) {
    // Делить нечего, если вкладка одна: слева осталась бы пустота вместо документа.
    if (!key || tabs.tabs.length < 2) return;
    setSplitKey(key);
    if (tabs.active === key) {
      const neighbour = tabs.tabs.find((tab) => tab.key !== key);
      if (neighbour) tabs.open(neighbour.key);
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.shiftKey && (key === "k" || key === "p")) { event.preventDefault(); openSearch(); }
      else if (mod && event.shiftKey && (key === "f" || event.code === "KeyF")) { event.preventDefault(); openSearch(); }
      else if (mod && event.code === "Backslash") { event.preventDefault(); if (splitKey) setSplitKey(null); else splitTab(tabs.active); }
      else if (mod && event.shiftKey && event.code === "KeyE") { event.preventDefault(); setActivity("explorer"); setSidebarOpen(true); }
      else if (mod && !event.shiftKey && event.code === "KeyB") { event.preventDefault(); setSidebarOpen((value) => !value); }
      else if (mod && !event.shiftKey && event.code === "KeyJ") { event.preventDefault(); setPanelOpen((value) => !value); }
      else if (mod && event.code === "Backquote") { event.preventDefault(); toggleConsole(); }
      else if (event.altKey && event.code === "KeyW" && tabs.active) { event.preventDefault(); closeTab(tabs.active); }
      else if (mod && event.altKey && event.code === "KeyN") {
        event.preventDefault();
        setActivity("notes");
        setSidebarOpen(true);
        if (defaultNoteProjectId !== undefined) void createNoteAndOpen(tabs, defaultNoteProjectId);
      }
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

  const groupsRef = useRef<HTMLDivElement | null>(null);
  const resizeSplit = useDrag(useCallback((event: PointerEvent) => {
    const rect = groupsRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 200) return;
    setSplitRatio(Math.min(0.8, Math.max(0.2, (event.clientX - rect.left) / rect.width)));
  }, [setSplitRatio]));

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
      // Облачный агент — по своему служебному имени: иначе ClaudeCloud зажигал бы точку локального Claude.
      const label = isCloudAgent(agent.name) ? agent.name : agentFamily(agent.name)?.label;
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

  /**
   * Открытые вкладки остаются в DOM, чтобы не терять прокрутку и состояние редакторов. Но при
   * любом обновлении данных React пересобирал их все, включая скрытые — отсюда подтормаживания
   * при живом потоке событий. Готовый элемент скрытой вкладки переиспользуется как есть: React
   * видит тот же объект и пропускает её поддерево целиком, а пересобирается только видимое.
   * Скрытая вкладка догонит данные в тот момент, когда её снова покажут.
   */
  const renderedDocs = useRef(new Map<string, ReactNode>());
  function docNode(key: string, active: boolean): ReactNode {
    const cached = renderedDocs.current.get(key);
    if (!active && cached !== undefined) return cached;
    const node = renderTab(key);
    renderedDocs.current.set(key, node);
    return node;
  }
  useEffect(() => {
    const live = new Set(tabs.tabs.map((tab) => tab.key));
    for (const key of renderedDocs.current.keys()) if (!live.has(key)) renderedDocs.current.delete(key);
  }, [tabs.tabs]);

  function renderTab(key: string): ReactNode {
    const [kind, first, second] = key.split(":");
    const rest = key.split(":").slice(2).join(":");
    const project = data.projects.find((item) => item.id === first);
    const documentVisible = key === tabs.active || key === splitKey;
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
        return <TodoDocument project={owner} todo={todo} tabs={tabs} tabKey={key} visible={documentVisible} onDirty={onDirty} onSaved={data.reload} />;
      }
      case "note":
        return <NoteDocument noteId={first} data={data} tabs={tabs} tabKey={key} visible={documentVisible} onDirty={onDirty} />;
      case "storage":
        return <StorageDocument />;
      case "s3sheet":
        return <StorageSheetDocument storageKey={key.slice(STORAGE_SHEET_TAB.length)} tabs={tabs} tabKey={key} visible={documentVisible} onDirty={onDirty} />;
      case "web":
        return <BrowserDocument tabKey={key} visible={documentVisible} tabs={tabs} onTitle={onTitle} onOpenUrl={openFromBrowser} />;
      case "local":
        return IMAGE_FILE.test(rest)
          ? <LocalImageDocument rootKey={first} path={rest} />
          : OFFICE_FILE.test(rest)
            ? <LocalOfficeDocument rootKey={first} path={rest} tabs={tabs} tabKey={key} visible={documentVisible} onDirty={onDirty} />
          : <LocalFileDocument rootKey={first} path={rest} tabs={tabs} tabKey={key} visible={documentVisible} onDirty={onDirty} />;
      case "gitdiff":
        return <GitDiffDocument rootKey={first} path={rest} tabs={tabs} />;
      case "commit":
        return <CommitDocument rootKey={first} hash={rest} />;
      case "skill":
        return <SkillDocument skillId={first} tabs={tabs} />;
      case "seo":
        return <SeoBoard mode="dashboard" />;
      case "skillblocks":
        return <SkillPageDocument skill={first} file="library.html" tabKey={key} tabs={tabs} projectId={data.projects.find((item) => item.name === "MBOX")?.id ?? defaultNoteProjectId ?? data.projects[0]?.id} />;
      case "skillpage":
        return <SkillPageDocument skill={first} file={rest} tabKey={key} tabs={tabs} projectId={data.projects.find((item) => item.name === "MBOX")?.id ?? defaultNoteProjectId ?? data.projects[0]?.id} />;
      case "tool":
        return <ToolDocument toolId={first} tabs={tabs} />;
      case "file":
        return <FileDocument fileId={first} data={data} tabs={tabs} tabKey={key} visible={documentVisible} onDirty={onDirty} />;
      case "term":
        return <ConsolePaneDocument paneId={key.slice(TERMINAL_TAB.length)} tabs={tabs} agentGoals={agentGoals} agentsOnline={agentsOnline} renderChat={(paneId) => renderChat(tabs.active === key, paneId)} onReveal={() => toggleConsole(true)} />;
      case "memory":
        return <MemoryDocument memoryId={first} data={data} tabs={tabs} tabKey={key} visible={documentVisible} onTitle={onTitle} onDirty={onDirty} />;
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
  // Что открыто сейчас: активная вкладка и вторая область. Агент получает это с сообщением и не ищет файл сам.
  const chatFocus = useMemo<FocusItem[]>(() => {
    const keys = [tabs.active, splitKey].filter((key): key is string => Boolean(key));
    return keys.flatMap((key): FocusItem[] => {
      const [kind, first] = key.split(":");
      const rest = key.split(":").slice(2).join(":");
      const title = tabMeta(key, data, catalogTitles).title;
      switch (kind) {
        case "local":
        case "gitdiff": {
          const root = localWorkspace.roots.find((item) => item.key === first);
          const path = root ? `${root.path.replace(/[\\/]+$/, "")}/${rest}` : rest;
          return [{ key, kind: kind === "local" ? "file" : "diff", title, detail: path }];
        }
        case "note":
        case "todo":
        case "memory":
          return [{ key, kind, title, id: first }];
        case "file":
          return [{ key, kind: "mbox-file", title, id: first }];
        case "s3sheet":
          return [{ key, kind: "storage", title, detail: key.slice("s3sheet:".length) }];
        case "web": {
          const url = browserTabUrl(key);
          return url ? [{ key, kind: "web", title, detail: url }] : [];
        }
        case "todos":
        case "project":
          return [{ key, kind: "project", title, id: first }];
        case "skill":
        case "skillpage":
        case "skillblocks":
          return [{ key, kind: "skill", title, id: first, ...(rest ? { detail: rest } : {}) }];
        default:
          return [];
      }
    });
  }, [tabs.active, splitKey, data, catalogTitles, localWorkspace.roots]);
  const renderChat = (visible: boolean, paneId: string, debug?: ChatDebug) => (
    <AgentChat embedded visible={visible} peer={chatPeer(paneId)} debug={debug} jarvisEnabled={user.role === "owner" || user.jarvis_enabled !== false} defaultResponder={user.role === "owner" && user.jarvis_autoreply === false ? CLOUD_AGENTS.claude : undefined} focus={chatFocus} inbox={data.inbox} agents={data.agents} runs={data.runs} projects={data.projects} artifacts={data.artifacts} projectId={data.projects.find((project) => project.name === "MBOX")?.id} currentProjectName={currentProjectName} onSaved={data.reload} />
  );
  const chat = (
    <ConsoleArea
      onReveal={() => toggleConsole(true)}
      agentGoals={agentGoals}
      agentsOnline={agentsOnline}
      tabs={tabs}
      renderChat={(paneId, debug, active) => renderChat(consoleVisible && active !== false, paneId, debug)}
      ownerOnlyAgents={user.role !== "owner"}
      actions={consoleDock === "right" ? (
        <>
          <button type="button" className="wb-icon-btn" onClick={() => dockConsole("bottom")} title="Перенести чат вниз"><PanelBottom size={14} /></button>
          <button type="button" className="wb-icon-btn" onClick={() => setRightOpen(false)} title="Скрыть чат (Ctrl+`)"><X size={14} /></button>
        </>
      ) : undefined}
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
        {/* Состав и порядок — в rail.ts: группы разделены чертой, лишнее выключается в настройках.
            Браузер живёт только в приложении: сайт показывает главный процесс Electron. */}
        {RAIL_GROUPS.map((group) => {
          const items = group.items.filter((item) => !railHidden.includes(item.id) && (!item.desktopOnly || hasBrowser));
          if (!items.length) return null;
          return (
            <div className="wb-activity-group" key={group.id} role="group" aria-label={group.title}>
              {items.map((item) => (
                <ActivityButton
                  key={item.id}
                  label={item.label}
                  icon={<img src={item.icon} alt="" draggable={false} />}
                  active={railActive(item.id)}
                  onClick={() => openRail(item.id)}
                  badge={item.id === "agents" ? needsHuman.length : undefined}
                />
              ))}
            </div>
          );
        })}
        <span className="wb-activity-fill" />
        <button type="button" className={consoleVisible ? "wb-activity is-mobile-only is-active" : "wb-activity is-mobile-only"} onClick={() => { setSidebarOpen(false); toggleConsole(); }} aria-label="Чат с агентами">
          <span className="wb-activity-icon" aria-hidden="true">{systemIcon("console.png")}</span>
          <span className="wb-activity-tip" role="tooltip">Чат с агентами</span>
        </button>
        <ActivityButton label="Настройки" icon={systemIcon("settings.png")} active={tabs.active === "settings"} onClick={() => tabs.open("settings", true)} />
      </nav>

      <aside className="wb-sidebar" aria-label="Боковая панель" data-scroll-scope={`sidebar:${activity}`}>
        {activity === "explorer" && <ExplorerView data={data} tabs={tabs} onProjectContext={onProjectContext} />}
        {activity === "search" && <SearchView data={data} tabs={tabs} focusSignal={searchFocus} />}
        {activity === "agents" && <AgentsView data={data} tabs={tabs} />}
        {activity === "notes" && <NotesView tabs={tabs} defaultProjectId={defaultNoteProjectId} />}
        {activity === "local" && <LocalFoldersView tabs={tabs} />}
        {activity === "files" && <FilesView data={data} tabs={tabs} />}
        {activity === "skills" && <SkillsView tabs={tabs} />}
        {activity === "tools" && <ToolsView tabs={tabs} />}
        {activity === "ssh" && <SshView />}
        <div className="wb-sash is-vertical" onPointerDown={resizeSidebar} role="separator" aria-orientation="vertical" aria-label="Ширина боковой панели" />
      </aside>

      <div className="wb-center" ref={centerRef}>
        <div className={splitKey ? "wb-groups is-split" : "wb-groups"} ref={groupsRef} style={{ ["--wb-split" as string]: `${Math.round(splitRatio * 100)}%` }}>
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
            {orderTabs(tabs.tabs.filter((tab) => tab.key !== splitKey), groupTabs).map((tab, index, list) => {
              const meta = tabMeta(tab.key, data, catalogTitles);
              const group = tabGroupOf(tab.key);
              // Разделитель — там, где начинается новая группа; подпись группы — в подсказке.
              const groupStart = groupTabs && index > 0 && tabGroupOf(list[index - 1].key) !== group;
              const active = tab.key === tabs.active;
              const isFileTab = tab.key.startsWith("file:") || tab.key.startsWith("local:");
              const browserUrl = tab.key.startsWith("web:") ? browserTabUrl(tab.key) : "";
              const browserFavicon = browserUrl
                ? browserFavicons[tab.key] || browserOriginFavicons[browserFaviconOrigin(browserUrl)] || cachedBrowserFavicon(tab.key, browserUrl)
                : "";
              return (
                <div
                  key={tab.key}
                  role="tab"
                  aria-selected={active}
                  data-tab-group={groupTabs ? group : undefined}
                  className={["wb-tab", active ? "is-active" : "", tab.pinned ? "" : "is-preview", dirty[tab.key] ? "is-dirty" : "", draggedTab && draggedTab !== tab.key ? "is-drop-zone" : "", groupStart ? "is-group-start" : ""].filter(Boolean).join(" ")}
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
                  {isFileTab ? <FileTypeIcon name={meta.title} size={18} /> : browserUrl ? <Favicon tabKey={tab.key} url={browserUrl} size={18} /> : <img src={browserFavicon || meta.icon} width={18} height={18} alt="" />}
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
                  <dt>Проекты</dt><dd><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd></dd>
                  <dt>Боковая панель</dt><dd><kbd>Ctrl</kbd>+<kbd>B</kbd></dd>
                  <dt>Нижняя панель</dt><dd><kbd>Ctrl</kbd>+<kbd>J</kbd></dd>
                  <dt>Закрыть вкладку</dt><dd><kbd>Alt</kbd>+<kbd>W</kbd></dd>
                </dl>
              </div>
            )}
            {tabs.tabs.filter((tab) => (visited.has(tab.key) || tab.key === tabs.active) && tab.key !== splitKey).map((tab) => (
              <div key={tab.key} className="wb-doc" hidden={tab.key !== tabs.active} data-scroll-scope={`tab:${tab.key}`}>
                {docNode(tab.key, tab.key === tabs.active)}
              </div>
            ))}
          </div>
        </section>

        {/* Вторая группа: один документ рядом с основным — браузер и заметка одновременно.
            Документ живёт только здесь, из основной группы он на это время исключён. */}
        {splitKey && (
          <>
            <div className="wb-sash is-vertical is-left" onPointerDown={resizeSplit} role="separator" aria-orientation="vertical" aria-label="Ширина второй области" />
            <section className="wb-editor is-split" aria-label="Вторая область">
              <div className="wb-tabs" role="tablist">
                {(() => {
                  const meta = tabMeta(splitKey, data, catalogTitles);
                  const isFileTab = splitKey.startsWith("file:") || splitKey.startsWith("local:");
                  const browserUrl = splitKey.startsWith("web:") ? browserTabUrl(splitKey) : "";
                  const browserFavicon = browserUrl
                    ? browserFavicons[splitKey] || browserOriginFavicons[browserFaviconOrigin(browserUrl)] || cachedBrowserFavicon(splitKey, browserUrl)
                    : "";
                  return (
                    <div className="wb-tab is-active" role="tab" aria-selected title={meta.hint}>
                      {isFileTab ? <FileTypeIcon name={meta.title} size={18} /> : browserUrl ? <Favicon tabKey={splitKey} url={browserUrl} size={18} /> : <img src={browserFavicon || meta.icon} width={18} height={18} alt="" />}
                      <span className="wb-tab-title">{meta.title}</span>
                      <button type="button" className="wb-tab-close" onClick={() => setSplitKey(null)} aria-label="Закрыть вторую область">
                        <X size={13} />
                      </button>
                    </div>
                  );
                })()}
              </div>
              <div className="wb-docs">
                <div className="wb-doc" data-scroll-scope={`split:${splitKey}`}>{docNode(splitKey, true)}</div>
              </div>
            </section>
          </>
        )}
        </div>

        <section className="wb-panel" aria-label="Нижняя панель">
          <div className="wb-sash is-horizontal" onPointerDown={resizePanel} role="separator" aria-orientation="horizontal" aria-label="Высота нижней панели" />
          <div className="wb-panel-tabs">
            {/* В tablist — только вкладки: кнопки «развернуть/скрыть» внутри него ломали роль для скринридеров (axe aria-required-children). */}
            <div className="wb-tablist-contents" role="tablist" aria-label="Нижняя панель">
              {consoleDock === "bottom" && <PanelTabButton active={effectivePanelTab === "console"} onClick={() => setPanelTab("console")} label="Чат" badge={working.length ? "●" : undefined} />}
              <PanelTabButton active={effectivePanelTab === "attention"} onClick={() => setPanelTab("attention")} label="Внимание" badge={attentionCount || undefined} warn={needsHuman.length > 0} />
              <PanelTabButton active={effectivePanelTab === "journal"} onClick={() => setPanelTab("journal")} label="Журнал" />
            </div>
            <span className="wb-panel-fill" />
            {consoleDock === "bottom" && effectivePanelTab === "console" && (
              <button type="button" className="wb-icon-btn" onClick={() => dockConsole("right")} title="Перенести чат вправо"><PanelRight size={15} /></button>
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
                        {/* Галочка прямо на карточке: снять задачу с внимания, не открывая её. */}
                        <button
                          type="button"
                          className="wb-attention-done"
                          title="Отметить готовой"
                          aria-label={`Отметить готовой: ${todo.title}`}
                          onClick={() => void resolveTodo(todo.id)}
                        >
                          <Check size={14} />
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

      <aside className="wb-right" aria-label="Чат с агентами">
        {consoleDock === "right" && (
          <>
            <div className="wb-sash is-vertical is-left" onPointerDown={resizeRight} role="separator" aria-orientation="vertical" aria-label="Ширина консоли" />
            <div className="wb-right-body">{chat}</div>
          </>
        )}
      </aside>

      <footer className="wb-statusbar">
        <button type="button" className={`wb-status-item is-state state-${status.state}`} onClick={() => showActivity("agents")} title="Состояние агентов">
          <i className="wb-state-dot" />{status.label}
        </button>
        <button type="button" className={consoleVisible ? "wb-status-item is-on" : "wb-status-item"} onClick={() => toggleConsole()} title="Чат с агентами (Ctrl+`)">
          <TerminalSquare size={12} /> {working.length > 0 ? `${working.length} ${plural(working.length, "агент", "агента", "агентов")} в работе` : "Чат"}
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
        <button
          type="button"
          className={splitKey ? "wb-status-item is-on" : "wb-status-item"}
          onClick={() => { if (splitKey) setSplitKey(null); else splitTab(tabs.active); }}
          title={splitKey ? "Убрать вторую область (Ctrl+\)" : "Разделить на две области (Ctrl+\)"}
        >
          <Columns2 size={12} />
        </button>
        <button type="button" className="wb-status-item" onClick={() => dockConsole(consoleDock === "right" ? "bottom" : "right")} title={consoleDock === "right" ? "Чат вниз" : "Чат справа"}><PanelRight size={12} /></button>
        <span className="wb-status-item is-static">{user.username}</span>
      </footer>

      {agentNotice && (
        <div className={agentNotice.tone === "warn" ? "wb-agent-toast is-warn" : "wb-agent-toast"} role="status" onClick={() => setAgentNotice(null)}>
          {agentNotice.text}
          {agentNotice.action && (
            <button
              type="button"
              className="wb-agent-toast-action"
              onClick={(event) => { event.stopPropagation(); void runNoticeAction(agentNotice.action!); }}
            >
              {agentNotice.action.label}
            </button>
          )}
        </div>
      )}

      {tabMenu && (
        <WbMenu x={tabMenu.x} y={tabMenu.y} onClose={() => setTabMenu(null)}>
          <button type="button" role="menuitem" onClick={() => { closeTab(tabMenu.key); setTabMenu(null); }}>Закрыть</button>
          <button type="button" role="menuitem" onClick={() => { tabs.closeOthers(tabMenu.key); setTabMenu(null); }}>Закрыть остальные</button>
          <button type="button" role="menuitem" onClick={() => { tabs.pin(tabMenu.key); setTabMenu(null); }}>Закрепить</button>
          <button type="button" role="menuitem" onClick={() => { splitTab(tabMenu.key); setTabMenu(null); }}>Открыть во второй области</button>
          {splitKey && <button type="button" role="menuitem" onClick={() => { setSplitKey(null); setTabMenu(null); }}>Убрать вторую область</button>}
          <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(`${serverOrigin()}/?tab=${encodeTabParam(tabMenu.key)}`); setTabMenu(null); }}>Копировать ссылку</button>
          <button type="button" role="menuitemcheckbox" aria-checked={groupTabs} onClick={() => { setGroupTabs(!groupTabs); setTabMenu(null); }}>{groupTabs ? "Не группировать вкладки" : "Группировать вкладки по видам"}</button>
        </WbMenu>
      )}
    </div>
  );
}

function ActivityButton({ label, icon, active, onClick, badge }: { label: string; icon: ReactNode; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button type="button" className={active ? "wb-activity is-active" : "wb-activity"} onClick={onClick} aria-label={label} aria-pressed={active}>
      <span className="wb-activity-icon" aria-hidden="true">{icon}</span>
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
  const [busy, setBusy] = useState("");
  const desktop = useDesktopSessions();
  const sorted = [...data.agents].sort((a, b) => Number(isAgentWorking(b, data.runs)) - Number(isAgentWorking(a, data.runs)));
  // Разовые сессии («vs-code-session», старый «VS Code») висели в команде неделями отключёнными.
  const isStale = (agent: (typeof sorted)[number]) => !isAgentWorking(agent, data.runs) && effectiveStatus(agent) !== "active" && (!agent.last_seen || Date.now() - Date.parse(agent.last_seen) > STALE_AGENT_MS);
  const stale = sorted.filter(isStale);
  const agents = showStale ? sorted : sorted.filter((agent) => !isStale(agent));
  const needsHuman = data.inbox.filter((item) => item.requires_human && item.status !== "done");
  const agentSession = (name: string) => desktop.sessions.find((session) => session.id === `agent:${name}` && session.status === "running");
  const isOutside = (name: string) => desktop.outsideAgents.some((row) => row.agent === name);
  // Облачного агента запускает systemd на сервере, не это окно.
  const canStart = (name: string) => !isCloudAgent(name) && ["Claude", "ChatGPT"].includes(agentFamily(name)?.label || "");
  const openChat = (name: string) => {
    const pane = consoleLayout.newChatId(agentFamily(name)?.label || name);
    tabs.open(`${TERMINAL_TAB}${pane}`, true);
  };
  const closeRuns = async (name: string) => {
    setBusy(`close:${name}`);
    try {
      await fetchJson(`/api/mbox/agents/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "manual_close_from_agents_view" }),
      });
      data.reload("agent_presence");
    } finally {
      setBusy("");
    }
  };
  const forgetAgent = async (name: string) => {
    setBusy(`forget:${name}`);
    try {
      await fetchJson(`/api/mbox/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
      data.reload("agent_presence");
    } finally {
      setBusy("");
    }
  };
  const stopAgent = async (name: string) => {
    setBusy(`stop:${name}`);
    try {
      await desktop.stopAgent(name);
      await fetchJson(`/api/mbox/agents/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "manual_stop_from_agents_view" }),
      });
      data.reload("agent_presence");
    } finally {
      setBusy("");
    }
  };
  const startAgent = async (name: string) => {
    const label = agentFamily(name)?.label;
    if (label !== "Claude" && label !== "ChatGPT") return;
    setBusy(`start:${name}`);
    try {
      await desktop.startAgent(label);
      data.reload("agent_presence");
    } finally {
      setBusy("");
    }
  };
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
              const session = agentSession(agent.name);
              const outside = isOutside(agent.name);
              const staleAgent = isStale(agent);
              const runningRuns = data.runs.filter((item) => item.agent_name === agent.name && !item.finished_at && ["running", "doing"].includes(item.status));
              const stateText = live
                ? run?.goal || "в работе"
                : `${agentStatusLabels[status] || status} · ${formatSince(agent.last_seen)}`;
              return (
                <li
                  key={agent.id}
                  className={[live ? "is-live" : "", staleAgent ? "is-stale" : ""].filter(Boolean).join(" ")}
                  title={[agent.client || agent.kind, agent.runs ? `${agent.runs} запусков` : "", outside && !session ? "работает вне этого окна" : ""].filter(Boolean).join(" · ")}
                >
                  <AgentAvatar name={agent.name} status={status} live={live} size={28} />
                  <div className="wb-agent-main">
                    <strong><AgentName name={agent.name} /><small>{isCloudAgent(agent.name) ? "сервер MBOX" : agentClientLabel(agent.client || agent.kind)}</small></strong>
                    <span className={live ? "is-live" : status === "active" ? "is-ok" : undefined}>{stateText}</span>
                  </div>
                  <div className="wb-agent-actions">
                    <button type="button" onClick={() => openChat(agent.name)} title="Открыть чат">
                      <MessageSquare size={12} />
                    </button>
                    {session || outside ? (
                      <button type="button" onClick={() => void stopAgent(agent.name)} disabled={busy === `stop:${agent.name}`} title="Остановить локальный процесс">
                        <Power size={12} />
                      </button>
                    ) : canStart(agent.name) ? (
                      <button type="button" onClick={() => void startAgent(agent.name)} disabled={busy === `start:${agent.name}`} title="Запустить responder">
                        <RotateCcw size={12} />
                      </button>
                    ) : null}
                    {runningRuns.length > 0 && (
                      <button type="button" onClick={() => void closeRuns(agent.name)} disabled={busy === `close:${agent.name}`} title="Завершить зависшие запуски">
                        <Check size={12} />
                      </button>
                    )}
                    <button type="button" className="is-danger" onClick={() => void forgetAgent(agent.name)} disabled={busy === `forget:${agent.name}`} title="Убрать из списка">
                      <Trash2 size={12} />
                    </button>
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

/** «claude-inbox-watcher» и «mbox-prod MCP» — внутренние имена; человеку достаточно, через что агент работает. */
/** Вид вкладки для группировки строки: задачи, документы, браузер, сервисные разделы. */
type TabGroup = "work" | "docs" | "web" | "system";
const TAB_GROUP_ORDER: TabGroup[] = ["work", "docs", "web", "system"];

function tabGroupOf(key: string): TabGroup {
  const kind = key.split(":")[0];
  if (kind === "web") return "web";
  if (["note", "notes", "file", "local", "memory", "artifact", "gitdiff", "commit", "storage", "sheet"].includes(kind)) return "docs";
  if (["todo", "todos", "entity", "folder", "project", "welcome"].includes(kind)) return "work";
  return "system";
}

/** Порядок внутри группы — тот, что задал человек (перетаскивание); группы — в фиксированном порядке. */
function orderTabs<T extends { key: string }>(list: T[], grouped: boolean): T[] {
  if (!grouped) return list;
  return TAB_GROUP_ORDER.flatMap((group) => list.filter((tab) => tabGroupOf(tab.key) === group));
}

function agentClientLabel(client: string) {
  const value = String(client || "").toLowerCase();
  if (/claude-inbox-watcher|claude-code/.test(value)) return "Claude Code";
  if (/codex/.test(value)) return "Codex CLI";
  if (/mcp/.test(value)) return "через MCP";
  if (/jarvis|server/.test(value)) return "сервер MBOX";
  if (/vscode|vs code/.test(value)) return "VS Code";
  return "";
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
