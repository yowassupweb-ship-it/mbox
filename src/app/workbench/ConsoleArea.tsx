import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, MessagesSquare, PanelTop, Play, RotateCcw, Square, SquareTerminal, Trash2 } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { CHAT, CHAT_PEERS, chatPeer, consoleLayout, isChatPane, useConsoleLayout } from "./consoleLayout";
import { onSessionReveal, sshStatus, useDesktopSessions, useNow, type Session } from "./desktopSessions";
import { usePersistentState, type TabsApi } from "./tabs";
import { ChatHeadSlot } from "./chatHeadSlot";
// xterm — треть всего бандла (~325 КБ), а нужен только в SSH-панели приложения: грузим по требованию.
const TerminalView = lazy(() => import("./TerminalView").then((module) => ({ default: module.TerminalView })));

export const PANE_MIME = "application/x-mbox-console-pane";
export const TERMINAL_TAB = "term:";

/** Режим отладки чата: вывод процесса агента прячется в шапке чата и раскрывается по кнопке. */
export type ChatDebug = { open: boolean; toggle: () => void; live: boolean; panel: ReactNode; process?: AgentProcessState };
/** Что на самом деле с процессом агента — чат не пишет «работает», когда наблюдатель мёртв. */
export type AgentProcessState = { state: "running" | "outside" | "remote" | "dead"; text: string; start: () => void };
type ChatRenderer = (paneId: string, debug?: ChatDebug, active?: boolean) => ReactNode;
type PaneProps = { renderChat: ChatRenderer; agentGoals: Record<string, string>; agentsOnline: Record<string, boolean>; tabs: TabsApi };
/** Значение пункта «Чат с агентом» в выпадающем списке панели, пока такой панели ещё нет. */
const PEER_OPTION = "peer:";

/**
 * Три вида чата — и больше ничего. Общий (там отвечает Джарвис и видны вопросы, ждущие решения),
 * Claude и ChatGPT. Внутри каждого — свои чаты (props.thread): один чат = одна сессия CLI агента.
 */
const CHAT_KINDS = [
  { peer: "", label: "Общий", pane: CHAT, aliases: [] as string[] },
  { peer: "Claude", label: "Claude", pane: `${CHAT}~Claude~main`, aliases: ["Claude"] },
  { peer: "ChatGPT", label: "ChatGPT", pane: `${CHAT}~ChatGPT~main`, aliases: ["Codex", "ChatGPT"] },
];

export function paneTitle(paneId: string, session: Session | undefined, labels: Record<string, string>) {
  if (labels[paneId]) return labels[paneId];
  if (chatPeer(paneId)) return `Чат с ${chatPeer(paneId)}`;
  if (isChatPane(paneId)) return "Общий чат";
  if (paneId.startsWith("agent:")) return paneId.slice(6);
  return session?.title ?? paneId.replace(/^ssh:/, "SSH · ").replace(/^tool:/, "");
}

function PaneIcon({ paneId, session }: { paneId: string; session?: Session }) {
  if (chatPeer(paneId)) return <AgentAvatar name={chatPeer(paneId)} size={16} />;
  if (isChatPane(paneId)) return <MessagesSquare size={13} className="wb-console-pane-icon" />;
  if (paneId.startsWith("agent:")) return <AgentAvatar name={paneId.slice(6)} status={session?.status ?? "stopped"} live={session?.status === "running"} size={16} />;
  if (paneId.startsWith("ssh:")) return <img className="wb-console-pane-icon" src="/assets/icons/project/ssh.png" width={14} height={14} alt="" draggable={false} />;
  return <SquareTerminal size={13} className="wb-console-pane-icon" />;
}

function paneClass(paneId: string) {
  if (isChatPane(paneId)) return "is-chat";
  if (paneId.startsWith("agent:")) return "is-agent";
  if (paneId.startsWith("ssh:")) return "is-ssh";
  return "is-process";
}

function scrollElementToBottom(el: HTMLElement | null) {
  if (!el) return () => undefined;
  el.scrollTop = el.scrollHeight;
  const frame = window.requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
    window.requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  });
  const timer = window.setTimeout(() => { el.scrollTop = el.scrollHeight; }, 80);
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

/**
 * Консоль рабочего места — это просто чат: переключатель «Общий · Claude · ChatGPT» и сам разговор.
 * Раньше здесь была сетка терминалов как в VS Code (группы, сплиты, список панелей), и чат терялся среди
 * процессов. Вывод процесса агента теперь — режим отладки в шапке чата, а SSH и инструменты открываются
 * вкладками редактора.
 */
export function ConsoleArea({ renderChat, agentGoals = {}, agentsOnline = {}, tabs, actions, ownerOnlyAgents = false }: { renderChat: ChatRenderer; onReveal?: () => void; agentGoals?: Record<string, string>; agentsOnline?: Record<string, boolean>; tabs: TabsApi; actions?: ReactNode; ownerOnlyAgents?: boolean }) {
  const desktop = useDesktopSessions();
  const [peer, setPeer] = usePersistentState("mbox.console.peer", "");
  const [debugOpen, setDebugOpen] = usePersistentState<Record<string, boolean>>("mbox.console.debug", {});
  // Claude и ChatGPT работают на компьютере владельца и отвечают только ему — участнику остаётся общий чат.
  const kinds = ownerOnlyAgents ? CHAT_KINDS.filter((item) => !item.peer) : CHAT_KINDS;
  const kind = kinds.find((item) => item.peer === peer) ?? kinds[0];
  // Каждый чат держит свой черновик, прокрутку и ожидание ответа — не размонтируем его при переключении.
  const [visited, setVisited] = useState<string[]>(() => [kind.peer]);
  const [headSlot, setHeadSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => { setVisited((current) => (current.includes(kind.peer) ? current : [...current, kind.peer])); }, [kind.peer]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Процесс, запущенный кнопкой (SSH, инструмент), открывается вкладкой редактора. Наблюдатели агентов
  // сами не всплывают — их вывод доступен в режиме отладки нужного чата.
  useEffect(() => onSessionReveal((id) => {
    if (id.startsWith("agent:")) return;
    tabsRef.current.open(`${TERMINAL_TAB}${id}`, true);
  }), []);

  const sessionOf = (aliases: string[]) => {
    const sessions = aliases.map((alias) => desktop.get(`agent:${alias}`)).filter((item): item is Session => Boolean(item));
    return sessions.find((item) => item.status === "running") ?? sessions[0];
  };
  const stateOf = (item: (typeof CHAT_KINDS)[number]) => {
    if (!item.peer) return "";
    if (item.aliases.some((alias) => agentGoals[alias])) return "working";
    if (sessionOf(item.aliases)?.status === "running" || agentsOnline[item.peer]) return "online";
    return "offline";
  };

  return (
    <div className="wb-console">
      <div className="wb-chat-kinds">
        <div className="wb-tablist-contents" role="tablist" aria-label="Чаты">
        {kinds.map((item) => {
          const state = stateOf(item);
          const active = item.peer === kind.peer;
          return (
            <button
              key={item.pane}
              type="button"
              role="tab"
              aria-selected={active}
              className={active ? "wb-chat-kind is-active" : "wb-chat-kind"}
              onClick={() => setPeer(item.peer)}
              title={!item.peer ? "Общий чат: отвечает сервер MBOX, @ — чтобы позвать другого агента" : `${item.label}: ${state === "working" ? "работает" : state === "online" ? "на связи" : "не запущен"}`}
            >
              {item.peer ? <AgentAvatar name={item.peer} size={20} /> : <MessagesSquare size={18} />}
              <span className="wb-chat-kind-label">{item.label}</span>
              {state && <i className={`wb-chat-kind-dot is-${state}`} aria-hidden="true" />}
            </button>
          );
        })}
        </div>
        <div className="wb-chat-head-slot" ref={setHeadSlot} />
        {actions}
      </div>
      <div className="wb-console-chats">
        {kinds.filter((item) => visited.includes(item.peer)).map((item) => {
          const session = sessionOf(item.aliases);
          const open = Boolean(debugOpen[item.peer || "common"]);
          const outside = session?.status !== "running" && item.aliases.some((alias) => desktop.outsideAgents.some((row) => row.agent === alias));
          const process: AgentProcessState | undefined = !item.peer ? undefined : {
            state: session?.status === "running" ? "running" : outside ? "outside" : !session && agentsOnline[item.peer] ? "remote" : "dead",
            text: session
              ? session.status === "failed" ? "процесс не запустился" : session.status === "stopped" ? "процесс остановлен" : session.status === "exited" || session.status !== "running" ? `процесс завершился${session.code !== null ? `, код ${session.code}` : ""}` : ""
              : "наблюдатель не запущен",
            start: () => void desktop.startAgent(item.peer as "Claude" | "ChatGPT"),
          };
          const debug: ChatDebug | undefined = desktop.supported && !ownerOnlyAgents ? {
            open,
            live: session?.status === "running",
            toggle: () => setDebugOpen({ ...debugOpen, [item.peer || "common"]: !open }),
            process,
            panel: <ChatDebugPanel peer={item.peer} aliases={item.aliases} session={session} online={Boolean(agentsOnline[item.peer])} tabs={tabs} visibleKey={`${kind.peer}:${open}`} />,
          } : undefined;
          return (
            <div key={item.pane} className="wb-console-chat" hidden={item.peer !== kind.peer}>
              <ChatHeadSlot.Provider value={item.peer === kind.peer ? headSlot : null}>
                {renderChat(item.pane, debug, item.peer === kind.peer)}
              </ChatHeadSlot.Provider>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Режим отладки: что происходит с процессом агента на этой машине. Наблюдатель у агента один на все его
 * чаты — каждый чат продолжает свою сессию CLI (claude --resume / codex exec resume) внутри этого процесса.
 */
function ChatDebugPanel({ peer, aliases, session, online, tabs, visibleKey }: { peer: string; aliases: string[]; session?: Session; online: boolean; tabs: TabsApi; visibleKey: string }) {
  const desktop = useDesktopSessions();
  if (!peer) {
    const others = desktop.sessions.filter((item) => !item.id.startsWith("agent:"));
    return (
      <div className="chat-debug">
        <div className="chat-debug-head">
          <span className="chat-debug-state">Общий чат ведёт Джарвис на сервере — локального процесса у него нет.</span>
        </div>
        {others.length > 0 ? (
          <ul className="chat-debug-list">
            {others.map((item) => (
              <li key={item.id}>
                <PaneIcon paneId={item.id} session={item} />
                <span>{item.title}</span>
                <em>{item.status === "running" ? "работает" : "завершён"}</em>
                <button type="button" className="wb-icon-btn" onClick={() => tabs.open(`${TERMINAL_TAB}${item.id}`, true)} title="Открыть вкладкой"><ExternalLink size={12} /></button>
              </li>
            ))}
          </ul>
        ) : <p className="chat-debug-note">Других процессов (SSH, инструменты) сейчас нет.</p>}
      </div>
    );
  }
  // Процесс в окне завершился сразу, потому что наблюдатель уже работает снаружи (автозапуск Windows,
  // установленный MBOX Desktop): скрипт запуска не поднимает второй экземпляр и выходит с кодом 0.
  const outside = session?.status !== "running" && aliases.some((alias) => desktop.outsideAgents.some((row) => row.agent === alias));
  const agent = (session?.id.slice(6) || aliases[0]) as "Claude" | "Codex";
  const state = outside
    ? "запущен в другом окне или без окна"
    : session
    ? session.status === "running" ? `работает · pid ${session.pid ?? "—"}` : session.status === "failed" ? "не запустился" : session.status === "stopped" ? "остановлен" : `завершён${session.code !== null ? ` · код ${session.code}` : ""}`
    : online ? "работает на другом компьютере" : "не запущен";
  return (
    <div className="chat-debug">
      <div className="chat-debug-head">
        <i className={`wb-chat-kind-dot is-${session?.status === "running" || outside ? "online" : "offline"}`} aria-hidden="true" />
        <span className="chat-debug-state">Наблюдатель {peer}: {state}</span>
        <span className="wb-console-fill" />
        {session?.status === "running" ? (
          <>
            <button type="button" className="wb-icon-btn" onClick={() => void desktop.restartAgent(agent)} title="Перезапустить"><RotateCcw size={12} /></button>
            <button type="button" className="wb-icon-btn" onClick={() => void desktop.stop(session.id)} title="Остановить"><Square size={12} /></button>
          </>
        ) : outside ? (
          <button type="button" className="chat-debug-btn" onClick={() => void desktop.restartAgent(agent)}><RotateCcw size={12} /> Забрать в это окно</button>
        ) : !online || session ? (
          <button type="button" className="chat-debug-btn" onClick={() => void desktop.startAgent(peer as "Claude" | "ChatGPT")}><Play size={12} /> Запустить</button>
        ) : null}
        {session && <button type="button" className="wb-icon-btn" onClick={() => tabs.open(`${TERMINAL_TAB}${session.id}`, true)} title="Открыть вывод вкладкой"><ExternalLink size={12} /></button>}
      </div>
      {outside && (
        <p className="chat-debug-note">
          Наблюдатель должен работать в окне MBOX. «Забрать в это окно» остановит тот экземпляр и поднимет его здесь, со свежими скриптами и выводом в этой панели.
        </p>
      )}
      {session ? (
        <div className="chat-debug-log">
          <SessionView id={session.id} session={session} desktop={desktop} online={online} visibleKey={visibleKey} />
        </div>
      ) : (
        <p className="chat-debug-note">
          {online ? "Запускать второй экземпляр не нужно: два наблюдателя будут отвечать на одни и те же сообщения." : "Пока наблюдатель не запущен, сообщения ждут в очереди и будут отвечены после запуска."}
        </p>
      )}
    </div>
  );
}

function PaneHeader({ paneId, props, labels, draggable, onMenu, actions, collapsed = false, onToggleCollapse }: { paneId: string; props: PaneProps; labels: Record<string, string>; draggable: boolean; onMenu?: (x: number, y: number) => void; actions: ReactNode; collapsed?: boolean; onToggleCollapse?: () => void }) {
  const desktop = useDesktopSessions();
  const session = desktop.get(paneId);
  const { tabs } = props;
  const shownElsewhere = (id: string) => tabs.tabs.some((tab) => tab.key === `${TERMINAL_TAB}${id}`);
  return (
    <header
      className="wb-console-pane-head"
      draggable={draggable}
      onDragStart={(event) => {
        if ((event.target as HTMLElement).closest("select, button, input")) { event.preventDefault(); return; }
        event.dataTransfer.setData(PANE_MIME, paneId);
        event.dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={(event) => { if (!onMenu) return; event.preventDefault(); onMenu(event.clientX, event.clientY); }}
      onDoubleClick={(event) => { if (onToggleCollapse && !(event.target as HTMLElement).closest("select, button, input")) onToggleCollapse(); }}
      title={draggable ? "Перетащи к краю другой панели, в список терминалов или во вкладки редактора. Двойной клик — свернуть" : undefined}
    >
      {onToggleCollapse && (
        <button type="button" className="wb-icon-btn wb-console-collapse" onClick={onToggleCollapse} title={collapsed ? "Развернуть" : "Свернуть"} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      )}
      {paneId.startsWith("agent:") ? (
        <AgentPaneTitle paneId={paneId} session={session} online={Boolean(props.agentsOnline[paneId.slice(6)])} />
      ) : (
        <>
          <PaneIcon paneId={paneId} session={session} />
          {labels[paneId] ? (
            <strong className="wb-console-pane-label">{labels[paneId]}</strong>
          ) : (
            <select
              value={paneId}
              onChange={(event) => {
                const value = event.target.value;
                const next = value === CHAT ? consoleLayout.newChatId() : value.startsWith(PEER_OPTION) ? consoleLayout.newChatId(value.slice(PEER_OPTION.length)) : value;
                if (shownElsewhere(next)) tabs.close(`${TERMINAL_TAB}${next}`);
                consoleLayout.replace(paneId, next);
              }}
              aria-label="Что показать в панели"
            >
              <option value={isChatPane(paneId) && !chatPeer(paneId) ? paneId : CHAT}>Общий чат</option>
              {CHAT_PEERS.map((peer) => (
                <option key={peer} value={chatPeer(paneId) === peer ? paneId : `${PEER_OPTION}${peer}`}>Чат с {peer}</option>
              ))}
              {desktop.sessions.map((item) => (
                <option key={item.id} value={item.id}>{item.status === "running" ? "● " : "○ "}{item.title}</option>
              ))}
              {!isChatPane(paneId) && !session && <option value={paneId}>{paneId}</option>}
            </select>
          )}
        </>
      )}
      <PaneActions paneId={paneId} session={session} desktop={desktop} />
      {onMenu && <button type="button" className="wb-icon-btn wb-console-pane-more" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu(rect.left, rect.bottom + 2); }} title="Действия с панелью">⋯</button>}
      {actions}
    </header>
  );
}

function PaneBody({ paneId, props, visibleKey, onClose }: { paneId: string; props: PaneProps; visibleKey: string; onClose?: () => void }) {
  const desktop = useDesktopSessions();
  if (isChatPane(paneId)) return <>{props.renderChat(paneId)}</>;
  return <SessionView id={paneId} session={desktop.get(paneId)} desktop={desktop} online={Boolean(props.agentsOnline[paneId.slice(6)])} visibleKey={visibleKey} onClose={onClose} />;
}

/** Терминал во вкладке редактора («Переместить в редактор»). Возвращается кнопкой или перетаскиванием в консоль. */
export function ConsolePaneDocument({ paneId, renderChat, agentGoals = {}, agentsOnline = {}, tabs, onReveal }: { paneId: string; renderChat: ChatRenderer; agentGoals?: Record<string, string>; agentsOnline?: Record<string, boolean>; tabs: TabsApi; onReveal: () => void }) {
  const state = useConsoleLayout();
  const props: PaneProps = { renderChat, agentGoals, agentsOnline, tabs };
  return (
    <section className={`wb-console-pane is-document ${paneClass(paneId)}`} data-console-pane={paneId}>
      <PaneHeader
        paneId={paneId}
        props={props}
        labels={state.labels}
        draggable
        actions={
          <button type="button" className="wb-icon-btn" onClick={() => { tabs.close(`${TERMINAL_TAB}${paneId}`); consoleLayout.reveal(paneId); onReveal(); }} title="Вернуть в консоль">
            <PanelTop size={13} />
          </button>
        }
      />
      <div className="wb-console-pane-body">
        <PaneBody paneId={paneId} props={props} visibleKey={`document:${paneId}`} onClose={() => tabs.close(`${TERMINAL_TAB}${paneId}`)} />
      </div>
    </section>
  );
}

type DesktopApi = ReturnType<typeof useDesktopSessions>;

function AgentPaneTitle({ paneId, session, online }: { paneId: string; session?: Session; online: boolean }) {
  const agent = paneId.slice(6);
  // Без локальной сессии судим по присутствию на сервере, а не считаем агента запущенным.
  const status = session?.status ?? (online ? "running" : "stopped");
  const verb = session
    ? status === "running" ? "отвечает" : status === "failed" ? "ошибка" : status === "stopped" ? "остановлен" : "завершён"
    : online ? "на связи" : "не запущен";
  const detail = session ? session.title : online ? "работает вне этого окна" : "наблюдатель";
  return (
    <div className="wb-agent-pane-title" title={`${agent}: ${verb} — ${detail}`}>
      <AgentAvatar name={agent} status={status} live={status === "running"} size={22} />
      <strong>{agent}: {verb}</strong>
    </div>
  );
}

function PaneActions({ paneId, session, desktop }: { paneId: string; session?: Session; desktop: DesktopApi }) {
  if (isChatPane(paneId)) return null;
  if (!session) return null;
  const agent = session.id.startsWith("agent:") ? session.id.slice(6) : "";
  if (session.kind === "ssh") return <SshPaneActions session={session} desktop={desktop} />;
  return (
    <span className="wb-console-pane-actions">
      <span className={`wb-session-state is-${session.status}`}>{session.status === "running" ? `pid ${session.pid ?? "—"}` : session.status === "failed" ? "ошибка" : session.status === "stopped" ? "остановлен" : `завершён${session.code !== null ? ` · ${session.code}` : ""}`}</span>
      {session.status === "running" ? (
        <button type="button" className="wb-icon-btn" onClick={() => void desktop.stop(session.id)} title="Остановить"><Square size={12} /></button>
      ) : (
        <>
          {agent && <button type="button" className="wb-icon-btn" onClick={() => void desktop.startAgent(agent as "ChatGPT" | "Codex" | "Claude")} title="Запустить снова"><RotateCcw size={12} /></button>}
          <button type="button" className="wb-icon-btn" onClick={() => void desktop.remove(session.id)} title="Убрать сессию"><Trash2 size={12} /></button>
        </>
      )}
    </span>
  );
}

function reconnectSsh(session: Session, desktop: DesktopApi) {
  void desktop.startSsh(session.title.replace(/^SSH · /, ""), { direct: session.direct }).catch(() => undefined);
}

function SshPaneActions({ session, desktop }: { session: Session; desktop: DesktopApi }) {
  const now = useNow(session.status === "running");
  const status = sshStatus(session, now);
  const route = session.direct ? "напрямую" : session.jump ? `через ${session.jump}` : "";
  return (
    <span className="wb-console-pane-actions">
      <span className={`wb-session-state is-${status.tone}`} title={route ? `Маршрут: ${route}` : undefined}>{status.text}</span>
      {session.status === "running" ? (
        <button type="button" className="wb-icon-btn" onClick={() => void desktop.stop(session.id)} title="Отключить" aria-label="Отключить"><Square size={12} /></button>
      ) : (
        <button type="button" className="wb-icon-btn" onClick={() => reconnectSsh(session, desktop)} title="Подключиться снова" aria-label="Подключиться снова"><RotateCcw size={12} /></button>
      )}
    </span>
  );
}

function SessionView({ id, session, desktop, online, visibleKey, onClose }: { id: string; session?: Session; desktop: DesktopApi; online: boolean; visibleKey: string; onClose?: () => void }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useLayoutEffect(() => {
    stickRef.current = true;
    return scrollElementToBottom(bodyRef.current);
  }, [session?.id, visibleKey]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !stickRef.current) return;
    return scrollElementToBottom(body);
  }, [session?.id, session?.lines.length, session?.status]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(() => {
      if (body.clientHeight) scrollElementToBottom(body);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [session?.id]);

  if (!session) {
    const agent = id.startsWith("agent:") ? id.slice(6) : "";
    const outside = agent && desktop.outsideAgents.some((row) => row.agent === agent);
    return (
      <div className="wb-session-empty">
        {outside ? (
          <>
            <p>{agent} запущен вне приложения (автозапуск Windows или прошлый сеанс) — его вывод сюда не попадает.</p>
            <button type="button" onClick={() => void desktop.restartAgent(agent)}><RotateCcw size={13} /> Перезапустить внутри MBOX</button>
          </>
        ) : agent && online ? (
          <>
            <p>{agent} на связи, но работает вне этого окна — в установленном MBOX Desktop или на другой машине. Отвечает в чате, а его вывод сюда не попадает.</p>
            <p className="wb-muted">Запускать здесь второй экземпляр не нужно: два наблюдателя будут отвечать на одни и те же сообщения.</p>
          </>
        ) : agent ? (
          <>
            <p>{agent} не запущен.</p>
            <button type="button" onClick={() => void desktop.startAgent(agent as "ChatGPT" | "Codex" | "Claude")}><Play size={13} /> Запустить</button>
          </>
        ) : <p>Сессия завершена и убрана. Выбери другую в списке выше.</p>}
      </div>
    );
  }

  if (session.terminal) return <Suspense fallback={<div className="wb-session-empty"><p>Открываю терминал…</p></div>}><TerminalView session={session} sendInput={desktop.sendInput} visibleKey={visibleKey} actions={session.kind === "ssh" ? { reconnect: () => reconnectSsh(session, desktop), stop: () => void desktop.stop(session.id), remove: () => { void desktop.remove(session.id); onClose?.(); } } : undefined} /></Suspense>;

  return (
    <div className="wb-session-shell">
      <div
        className="wb-session-log"
        ref={bodyRef}
        role="log"
        aria-label={session.title}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {session.command && <div className="wb-session-cmd">{session.cwd ? `${session.cwd}> ` : "> "}{session.command}</div>}
        {session.lines.map((row, index) => (
          <div key={index} className={row.stream === "err" ? "is-err" : undefined}>{row.line}</div>
        ))}
        {session.status !== "running" && (
          <div className="wb-session-end">— {session.status === "failed" ? "процесс не запустился" : session.status === "stopped" ? "остановлен" : `процесс завершён${session.code !== null ? `, код ${session.code}` : ""}`} —</div>
        )}
      </div>
    </div>
  );
}

function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
