import { Fragment, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Columns2, List, MessagesSquare, PanelTop, Play, Plus, RotateCcw, Rows2, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { CHAT, CHAT_PEERS, MAX_PANES_PER_GROUP, chatPeer, consoleLayout, findPane, isChatPane, isConsoleShortcut, useConsoleLayout, type ConsoleGroup, type DropZone } from "./consoleLayout";
import { onSessionReveal, useDesktopSessions, type Session } from "./desktopSessions";
import type { TabsApi } from "./tabs";
import { WbMenu } from "./WbMenu";
// xterm — треть всего бандла (~325 КБ), а нужен только в SSH-панели приложения: грузим по требованию.
const TerminalView = lazy(() => import("./TerminalView").then((module) => ({ default: module.TerminalView })));

const MIN_PANE_PX = 90;
export const PANE_MIME = "application/x-mbox-console-pane";
export const TERMINAL_TAB = "term:";

type ChatRenderer = (paneId: string) => ReactNode;
type PaneProps = { renderChat: ChatRenderer; agentGoals: Record<string, string>; agentsOnline: Record<string, boolean>; tabs: TabsApi };
type MenuState = { pane: string; x: number; y: number } | null;
/** Значение пункта «Чат с агентом» в выпадающем списке панели, пока такой панели ещё нет. */
const PEER_OPTION = "peer:";

export function paneTitle(paneId: string, session: Session | undefined, labels: Record<string, string>) {
  if (labels[paneId]) return labels[paneId];
  if (chatPeer(paneId)) return `Чат с ${chatPeer(paneId)}`;
  if (isChatPane(paneId)) return "Чат агентов";
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

const MIN_COLUMN_PX = 170;
const MIN_PANE_OPEN_PX = 96;
const STRIP_PX = 31;
const HEADER_PX = 32;

/**
 * Что свернуть автоматически, когда панели не помещаются. Считается от размера консоли, а не от размеров
 * панелей, поэтому сворачивание не раскачивает раскладку. Сначала сворачиваются целые столбцы (с конца),
 * потом панели внутри столбцов; столбец и панель, где сейчас работают, не трогаем никогда.
 */
function autoCollapse(columns: string[][], layout: "row" | "column", pinned: Set<string>, focused: string, size: { width: number; height: number }) {
  const result = new Set<string>();
  if (!size.width || !size.height) return result;
  const across = layout === "row" ? size.width : size.height;
  const along = layout === "row" ? size.height : size.width;
  const minColumn = layout === "row" ? MIN_COLUMN_PX : MIN_PANE_OPEN_PX;
  const minPane = layout === "row" ? MIN_PANE_OPEN_PX : MIN_COLUMN_PX;
  const collapsedPane = layout === "row" ? HEADER_PX : STRIP_PX;
  const collapsedColumn = layout === "row" ? STRIP_PX : HEADER_PX;
  const isClosed = (column: string[]) => column.every((id) => pinned.has(id) || result.has(id));
  const acrossNeed = () => columns.reduce((sum, column) => sum + (isClosed(column) ? collapsedColumn : minColumn), 0);
  for (let c = columns.length - 1; c >= 0 && acrossNeed() > across; c -= 1) {
    if (columns[c].includes(focused) || isClosed(columns[c])) continue;
    columns[c].forEach((id) => result.add(id));
  }
  for (const column of columns) {
    if (isClosed(column)) continue;
    const need = () => column.reduce((sum, id) => sum + (pinned.has(id) || result.has(id) ? collapsedPane : minPane), 0);
    for (let i = column.length - 1; i >= 0 && need() > along; i -= 1) {
      const id = column[i];
      if (id === focused || pinned.has(id) || result.has(id)) continue;
      if (column.filter((item) => !pinned.has(item) && !result.has(item)).length <= 1) break;
      result.add(id);
    }
  }
  return result;
}

function dropZoneOf(event: ReactDragEvent<HTMLElement>): DropZone {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const dx = Math.min(x, 1 - x);
  const dy = Math.min(y, 1 - y);
  if (dx > 0.28 && dy > 0.28) return "center";
  if (dx < dy) return x < 0.5 ? "left" : "right";
  return y < 0.5 ? "top" : "bottom";
}

/** Фокус клавиатуры в панель: терминалу — его скрытое поле ввода, чату — строку ввода. */
function focusPaneDom(paneId: string) {
  window.requestAnimationFrame(() => {
    const pane = document.querySelector<HTMLElement>(`[data-console-pane="${CSS.escape(paneId)}"]`);
    const target = pane?.querySelector<HTMLElement>(".xterm-helper-textarea, textarea, input:not([type=hidden])");
    target?.focus();
  });
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

/** Разделитель: тянем — перераспределяем долю двух соседей, остальные не трогаем. Слушаем окно, а не полосу:
 * полоса в пару пикселей теряла захват указателя, и граница отставала от мыши. */
function startPairResize(event: ReactPointerEvent<HTMLElement>, first: HTMLElement | null, second: HTMLElement | null, vertical: boolean, pairShare: number, apply: (a: number, b: number) => void) {
  if (!first || !second) return;
  event.preventDefault();
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  const startPos = vertical ? event.clientY : event.clientX;
  const firstPx = vertical ? a.height : a.width;
  const pairPx = firstPx + (vertical ? b.height : b.width);
  document.body.classList.add("wb-resizing");
  const move = (moveEvent: PointerEvent) => {
    const delta = (vertical ? moveEvent.clientY : moveEvent.clientX) - startPos;
    const nextFirst = Math.min(pairPx - MIN_PANE_PX, Math.max(MIN_PANE_PX, firstPx + delta));
    const share = (nextFirst / pairPx) * pairShare;
    apply(share, pairShare - share);
  };
  const up = () => {
    document.body.classList.remove("wb-resizing");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/**
 * Консоль рабочего места — терминалы VS Code: группы в списке справа, активная группа на экране, в ней
 * столбцы и панели друг под другом. Панель перетаскивается за заголовок (к краю другой панели — встанет
 * рядом, в центр — поменяются местами, в список — к группе или отдельной группой, во вкладки — в редактор).
 * Ctrl+Shift+5 — разделить, Alt+стрелки — соседняя панель, Ctrl+PageUp/PageDown — соседняя группа.
 */
export function ConsoleArea({ renderChat, onReveal, agentGoals = {}, agentsOnline = {}, tabs }: { renderChat: ChatRenderer; onReveal: () => void; agentGoals?: Record<string, string>; agentsOnline?: Record<string, boolean>; tabs: TabsApi }) {
  const desktop = useDesktopSessions();
  const state = useConsoleLayout();
  const group = state.groups[state.active] ?? state.groups[0];
  const [drop, setDrop] = useState<{ pane: string; zone: DropZone } | null>(null);
  const [listDrop, setListDrop] = useState<number | "new" | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const paneProps: PaneProps = { renderChat, agentGoals, agentsOnline, tabs };

  // Процесс, запущенный кнопкой, сам появляется: во вкладке редактора, если он там, иначе в консоли.
  useEffect(() => onSessionReveal((id) => {
    const key = `${TERMINAL_TAB}${id}`;
    if (tabsRef.current.tabs.some((tab) => tab.key === key)) {
      tabsRef.current.open(key, true);
      return;
    }
    consoleLayout.reveal(id);
    onRevealRef.current();
  }), []);

  const inEditor = (id: string) => tabs.tabs.some((tab) => tab.key === `${TERMINAL_TAB}${id}`);
  const allPanes = state.groups.flatMap((item) => item.columns.flat());
  const totalPanes = allPanes.length;
  const running = desktop.sessions.filter((session) => session.status === "running");
  const agentAliases = (name: string) => name === "ChatGPT" ? ["ChatGPT", "Codex"] : [name];
  const agentInConsole = (name: string) => agentAliases(name).some((alias) => running.some((session) => session.id === `agent:${alias}`));
  const agentOutside = (name: string) => agentAliases(name).some((alias) => desktop.outsideAgents.some((row) => row.agent === alias));
  // Мало места — список сам сворачивается в значки, совсем мало — прячется (сохранённый выбор не меняем).
  const [bodyWidth, setBodyWidth] = useState(0);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setGridSize((current) => (current.width === el.clientWidth && current.height === el.clientHeight ? current : { width: el.clientWidth, height: el.clientHeight }));
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBodyWidth(el.clientWidth));
    observer.observe(el);
    setBodyWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const autoCompact = bodyWidth > 0 && bodyWidth < state.listWidth + 380;
  const listCompact = state.listCompact || autoCompact;
  const showList = state.listOpen && totalPanes > 1 && !(bodyWidth > 0 && bodyWidth < 240);
  const groupFull = group.columns.flat().length >= MAX_PANES_PER_GROUP;
  const pinnedCollapsed = new Set(state.collapsed);
  const autoCollapsed = autoCollapse(group.columns, group.layout, pinnedCollapsed, state.focused, gridSize);
  const collapsed = new Set([...pinnedCollapsed, ...autoCollapsed]);
  const columnCollapsed = (column: string[]) => column.every((id) => collapsed.has(id));
  // Автоматически свёрнутую панель «развернуть» — значит сделать её активной: тогда свернётся соседняя.
  const toggleCollapse = (pane: string) => {
    if (autoCollapsed.has(pane) && !pinnedCollapsed.has(pane)) {
      consoleLayout.focus(pane);
      focusPaneDom(pane);
    } else {
      consoleLayout.toggleCollapse(pane);
    }
  };

  /** Что поставить в новую панель: сессию, которой нигде не видно, иначе ещё один чат. */
  const freshPane = () => desktop.sessions.find((session) => !allPanes.includes(session.id) && !inEditor(session.id))?.id ?? consoleLayout.newChatId();

  const split = (target: string, direction: "right" | "down") => {
    const pane = freshPane();
    consoleLayout.split(target, direction, pane);
    focusPaneDom(pane);
  };

  function toEditor(pane: string) {
    consoleLayout.detach(pane);
    tabs.open(`${TERMINAL_TAB}${pane}`, true);
  }

  // Переименование идёт в списке: в режиме значков поля ввода нет, поэтому список сначала разворачиваем.
  function startRename(pane: string) {
    consoleLayout.setList(true, undefined, false);
    setRenaming(pane);
  }

  function closePane(pane: string) {
    consoleLayout.close(pane);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isConsoleShortcut(event)) return;
    event.preventDefault();
    const focused = state.focused;
    if (event.ctrlKey && event.shiftKey) {
      if (focused) split(focused, "right");
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      const next = (state.active + (event.key === "PageUp" ? -1 : 1) + state.groups.length) % state.groups.length;
      const pane = state.groups[next].columns[0][0];
      consoleLayout.activate(next, pane);
      focusPaneDom(pane);
      return;
    }
    const direction = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[event.key as "ArrowLeft"];
    const next = focused && direction ? consoleLayout.neighbour(focused, direction) : null;
    if (next) {
      consoleLayout.focus(next);
      focusPaneDom(next);
    }
  }

  const readDragged = (event: ReactDragEvent) => event.dataTransfer.getData(PANE_MIME);
  const hasDrag = (event: ReactDragEvent) => event.dataTransfer.types.includes(PANE_MIME);

  function acceptDraggedPane(pane: string) {
    // Из вкладки редактора панель возвращается в консоль — вкладку закрываем.
    const key = `${TERMINAL_TAB}${pane}`;
    if (inEditor(pane)) tabs.close(key);
  }

  const LIST_COMPACT_PX = 38;
  const menuPane = menu?.pane ?? "";
  const menuSession = menuPane ? desktop.get(menuPane) : undefined;
  const menuPos = menuPane ? findPane(state, menuPane) : null;

  return (
    <div className="wb-console" onKeyDown={onKeyDown}>
      <div className="wb-console-toolbar">
        {desktop.supported ? (
          <>
            <span className="wb-console-label">Агенты</span>
            {(["Claude", "ChatGPT"] as const).map((name) => {
              const inConsole = agentInConsole(name);
              const outside = !inConsole && agentOutside(name);
              const paneAgent = agentAliases(name).find((alias) => running.some((session) => session.id === `agent:${alias}`)) || name;
              return (
                <button
                  key={name}
                  type="button"
                  className={[inConsole ? "is-live" : "", outside ? "is-outside" : ""].filter(Boolean).join(" ") || undefined}
                  onClick={() => (inConsole || outside ? consoleLayout.reveal(`agent:${paneAgent}`) : void desktop.startAgent(name))}
                  title={inConsole ? `${name} работает — показать вывод` : outside ? `${name} запущен вне MBOX — открыть перезапуск внутри приложения` : `Запустить ${name} внутри приложения`}
                >
                  {inConsole ? <i className="wb-dot is-live" /> : outside ? <i className="wb-dot is-outside" /> : <Play size={11} />}{name}
                </button>
              );
            })}
            {running.length > 0 && <span className="wb-console-count">{running.length} {plural(running.length, "процесс", "процесса", "процессов")}</span>}
          </>
        ) : (
          <span className="wb-console-label is-hint" title="Вывод агентов и инструментов появляется здесь в приложении MBOX Desktop">Консоль</span>
        )}
        <span className="wb-console-fill" />
        <button type="button" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setAddMenu({ x: rect.left, y: rect.bottom + 4 }); }} title="Новая группа">
          <Plus size={13} />
        </button>
        <button type="button" onClick={() => state.focused && split(state.focused, "right")} disabled={groupFull} title="Разделить вправо (Ctrl+Shift+5)">
          <Columns2 size={13} />
        </button>
        <button type="button" onClick={() => state.focused && split(state.focused, "down")} disabled={groupFull} title="Разделить вниз">
          <Rows2 size={13} />
        </button>
        <button type="button" onClick={() => consoleLayout.rotate(state.active)} title={group.layout === "row" ? "Повернуть группу: столбцы → строки" : "Повернуть группу: строки → столбцы"}>
          <RotateCcw size={12} />
        </button>
        <button type="button" className={state.listOpen ? "is-on" : undefined} onClick={() => consoleLayout.setList(!state.listOpen)} title={state.listOpen ? "Скрыть список терминалов" : "Показать список терминалов"}>
          <List size={13} />
        </button>
      </div>

      <div className="wb-console-body" ref={bodyRef}>
        <div className={`wb-console-panes is-${group.layout}`} ref={gridRef}>
          {group.columns.map((column, c) => (
            <Fragment key={`col-${c}`}>
              {c > 0 && (columnCollapsed(group.columns[c - 1]) || columnCollapsed(column)) && <div className="wb-console-gap" />}
              {c > 0 && !columnCollapsed(group.columns[c - 1]) && !columnCollapsed(column) && (
                <div
                  className="wb-console-sash is-column-sash"
                  onPointerDown={(event) => {
                    const cols = gridRef.current?.querySelectorAll<HTMLElement>(":scope > .wb-console-column");
                    startPairResize(event, cols?.[c - 1] ?? null, cols?.[c] ?? null, group.layout === "column", group.colSizes[c - 1] + group.colSizes[c], (a, b) => consoleLayout.resizeColumns(state.active, c - 1, a, b));
                  }}
                  onDoubleClick={() => consoleLayout.evenOut(state.active)}
                  role="separator"
                  title="Потяни, чтобы изменить размер. Двойной клик — поровну"
                />
              )}
              <div className={columnCollapsed(column) ? "wb-console-column is-all-collapsed" : "wb-console-column"} style={{ flexGrow: group.colSizes[c] }}>
                {column.map((paneId, i) => {
                  const isCollapsed = collapsed.has(paneId);
                  // Полоска (узкая, вертикальная) — когда свёрнутая панель стоит рядом с другими по горизонтали.
                  const strip = isCollapsed && (group.layout === "row" ? columnCollapsed(column) : !columnCollapsed(column));
                  const session = desktop.get(paneId);
                  return (
                  <Fragment key={paneId}>
                    {i > 0 && (collapsed.has(column[i - 1]) || isCollapsed) && <div className="wb-console-gap" />}
                    {i > 0 && !collapsed.has(column[i - 1]) && !isCollapsed && (
                      <div
                        className="wb-console-sash is-pane-sash"
                        onPointerDown={(event) => {
                          const panes = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(":scope > .wb-console-pane");
                          startPairResize(event, panes?.[i - 1] ?? null, panes?.[i] ?? null, group.layout === "row", group.paneSizes[c][i - 1] + group.paneSizes[c][i], (a, b) => consoleLayout.resizePanes(state.active, c, i - 1, a, b));
                        }}
                        onDoubleClick={() => consoleLayout.evenOut(state.active)}
                        role="separator"
                        title="Потяни, чтобы изменить размер. Двойной клик — поровну"
                      />
                    )}
                    <section
                      data-console-pane={paneId}
                      className={["wb-console-pane", paneClass(paneId), isCollapsed ? "is-collapsed" : "", strip ? "is-strip" : "", state.focused === paneId && group.columns.flat().length > 1 ? "is-focused" : "", drop?.pane === paneId ? `is-drop-${drop.zone}` : ""].filter(Boolean).join(" ")}
                      style={{ flexGrow: group.paneSizes[c][i] }}
                      onMouseDown={() => consoleLayout.focus(paneId)}
                      onDragOver={(event) => {
                        if (!hasDrag(event)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        const zone = dropZoneOf(event);
                        if (drop?.pane !== paneId || drop.zone !== zone) setDrop({ pane: paneId, zone });
                      }}
                      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}
                      onDrop={(event) => {
                        const dragged = readDragged(event);
                        setDrop(null);
                        if (!dragged) return;
                        event.preventDefault();
                        acceptDraggedPane(dragged);
                        consoleLayout.drop(dragged, paneId, dropZoneOf(event));
                      }}
                    >
                      {strip ? (
                        <header
                          className="wb-console-pane-strip"
                          draggable
                          onDragStart={(event) => { event.dataTransfer.setData(PANE_MIME, paneId); event.dataTransfer.effectAllowed = "move"; }}
                          onClick={() => toggleCollapse(paneId)}
                          onContextMenu={(event) => { event.preventDefault(); setMenu({ pane: paneId, x: event.clientX, y: event.clientY }); }}
                          title={`${paneTitle(paneId, session, state.labels)} — развернуть`}
                        >
                          <PaneIcon paneId={paneId} session={session} />
                          {session?.status === "running" && <i className="wb-dot is-live" />}
                          <span className="wb-console-strip-title">{paneTitle(paneId, session, state.labels)}</span>
                        </header>
                      ) : <PaneHeader
                        paneId={paneId}
                        props={paneProps}
                        labels={state.labels}
                        draggable
                        collapsed={isCollapsed}
                        onToggleCollapse={() => toggleCollapse(paneId)}
                        onMenu={(x, y) => setMenu({ pane: paneId, x, y })}
                        actions={
                          <>
                            <button type="button" className="wb-icon-btn" onClick={() => split(paneId, "right")} disabled={groupFull} title="Разделить вправо"><Columns2 size={12} /></button>
                            <button type="button" className="wb-icon-btn" onClick={() => split(paneId, "down")} disabled={groupFull} title="Разделить вниз"><Rows2 size={12} /></button>
                            {totalPanes > 1 && <button type="button" className="wb-icon-btn" onClick={() => closePane(paneId)} title="Закрыть панель (процесс продолжит работу)"><X size={13} /></button>}
                          </>
                        }
                      />}
                      <div className="wb-console-pane-body">
                        <PaneBody paneId={paneId} props={paneProps} visibleKey={`${state.active}:${state.focused}:${gridSize.width}x${gridSize.height}:${isCollapsed ? "0" : "1"}`} />
                      </div>
                    </section>
                  </Fragment>
                  );
                })}
              </div>
            </Fragment>
          ))}
        </div>

        {showList && (
          <>
            <div
              className="wb-console-sash is-list-sash"
              onPointerDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startWidth = state.listCompact ? LIST_COMPACT_PX : state.listWidth;
                document.body.classList.add("wb-resizing");
                // Как в VS Code: сузил список почти до нуля — остаются только значки.
                const move = (moveEvent: PointerEvent) => {
                  const width = startWidth - (moveEvent.clientX - startX);
                  if (width < 90) consoleLayout.setList(true, undefined, true);
                  else consoleLayout.setList(true, width, false);
                };
                const up = () => {
                  document.body.classList.remove("wb-resizing");
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
              role="separator"
            />
            <nav
              className={["wb-console-list", listDrop === "new" ? "is-drop" : "", listCompact ? "is-compact" : ""].filter(Boolean).join(" ")}
              style={{ width: listCompact ? LIST_COMPACT_PX : state.listWidth }}
              aria-label="Терминалы"
              onDragOver={(event) => { if (!hasDrag(event)) return; event.preventDefault(); if (listDrop !== "new") setListDrop("new"); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setListDrop(null); }}
              onDrop={(event) => {
                const dragged = readDragged(event);
                setListDrop(null);
                if (!dragged) return;
                event.preventDefault();
                acceptDraggedPane(dragged);
                consoleLayout.newGroup(dragged);
              }}
            >
              <div className="wb-console-list-head">
                <button type="button" className="wb-icon-btn" disabled={autoCompact && !state.listCompact} onClick={() => consoleLayout.setList(true, undefined, !state.listCompact)} title={autoCompact && !state.listCompact ? "Консоль узкая — список в значках, пока не станет шире" : state.listCompact ? "Развернуть список" : "Свернуть список в значки"}>
                  {listCompact ? <ChevronsLeft size={13} /> : <ChevronsRight size={13} />}
                </button>
              </div>
              {state.groups.map((item: ConsoleGroup, g) => {
                const panes = item.columns.flat();
                return (
                  <div
                    key={item.id}
                    className={["wb-console-list-group", g === state.active ? "is-active" : "", listDrop === g ? "is-drop" : ""].filter(Boolean).join(" ")}
                    onDragOver={(event) => { if (!hasDrag(event)) return; event.preventDefault(); event.stopPropagation(); if (listDrop !== g) setListDrop(g); }}
                    onDrop={(event) => {
                      const dragged = readDragged(event);
                      setListDrop(null);
                      if (!dragged) return;
                      event.preventDefault();
                      event.stopPropagation();
                      acceptDraggedPane(dragged);
                      consoleLayout.joinGroup(dragged, g);
                    }}
                  >
                    {panes.map((paneId, index) => {
                      const session = desktop.get(paneId);
                      const glyph = panes.length === 1 ? "" : index === 0 ? "┌" : index === panes.length - 1 ? "└" : "├";
                      return (
                        <div
                          key={paneId}
                          role="button"
                          tabIndex={0}
                          draggable
                          className={state.focused === paneId ? "wb-console-list-item is-focused" : "wb-console-list-item"}
                          onDragStart={(event) => { event.dataTransfer.setData(PANE_MIME, paneId); event.dataTransfer.effectAllowed = "move"; }}
                          onClick={() => {
                            // Свёрнутую панель клик в списке разворачивает — иначе переходить не к чему.
                            if (pinnedCollapsed.has(paneId)) consoleLayout.toggleCollapse(paneId);
                            consoleLayout.activate(g, paneId);
                            focusPaneDom(paneId);
                          }}
                          onDoubleClick={() => startRename(paneId)}
                          onKeyDown={(event) => { if (event.key === "F2") startRename(paneId); if (event.key === "Delete") closePane(paneId); }}
                          onContextMenu={(event) => { event.preventDefault(); setMenu({ pane: paneId, x: event.clientX, y: event.clientY }); }}
                          title={paneTitle(paneId, session, state.labels)}
                        >
                          {glyph && !listCompact && <span className="wb-console-list-glyph">{glyph}</span>}
                          <PaneIcon paneId={paneId} session={session} />
                          {listCompact ? null : renaming === paneId ? (
                            <input
                              autoFocus
                              defaultValue={paneTitle(paneId, session, state.labels)}
                              onClick={(event) => event.stopPropagation()}
                              onBlur={(event) => { consoleLayout.rename(paneId, event.currentTarget.value); setRenaming(null); }}
                              onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === "Enter") event.currentTarget.blur();
                                if (event.key === "Escape") setRenaming(null);
                              }}
                            />
                          ) : (
                            <span className="wb-console-list-title">{paneTitle(paneId, session, state.labels)}</span>
                          )}
                          {session?.status === "running" && <i className="wb-dot is-live" />}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </nav>
          </>
        )}
      </div>

      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button type="button" role="menuitem" disabled={groupFull} onClick={() => { split(menuPane, "right"); setMenu(null); }}>Разделить вправо</button>
          <button type="button" role="menuitem" disabled={groupFull} onClick={() => { split(menuPane, "down"); setMenu(null); }}>Разделить вниз</button>
          <button type="button" role="menuitem" disabled={!menuPos || state.groups[menuPos.g].columns.flat().length < 2} onClick={() => { consoleLayout.unsplit(menuPane); setMenu(null); }}>Отделить в свою группу</button>
          <button type="button" role="menuitem" onClick={() => { toggleCollapse(menuPane); setMenu(null); }}>{collapsed.has(menuPane) ? "Развернуть" : "Свернуть"}</button>
          <button type="button" role="menuitem" onClick={() => { toEditor(menuPane); setMenu(null); }}>Переместить в редактор</button>
          <button type="button" role="menuitem" onClick={() => { startRename(menuPane); setMenu(null); }}>Переименовать…</button>
          {menuSession?.status === "running" && <button type="button" role="menuitem" onClick={() => { void desktop.stop(menuPane); setMenu(null); }}>Остановить процесс</button>}
          <button type="button" role="menuitem" disabled={totalPanes < 2} onClick={() => { closePane(menuPane); setMenu(null); }}>Закрыть панель</button>
          {menuPos && state.groups.length > 1 && <button type="button" role="menuitem" onClick={() => { consoleLayout.closeGroup(menuPos.g); setMenu(null); }}>Закрыть группу</button>}
        </WbMenu>
      )}

      {addMenu && (
        <WbMenu x={addMenu.x} y={addMenu.y} onClose={() => setAddMenu(null)}>
          <button type="button" role="menuitem" onClick={() => { consoleLayout.newGroup(); setAddMenu(null); }}><MessagesSquare size={13} /> Чат агентов</button>
          {CHAT_PEERS.map((peer) => (
            <button key={peer} type="button" role="menuitem" onClick={() => { consoleLayout.newGroup(consoleLayout.newChatId(peer)); setAddMenu(null); }}>
              <AgentAvatar name={peer} size={14} /> Чат с {peer}
            </button>
          ))}
          {desktop.sessions.filter((session) => !allPanes.includes(session.id)).map((session) => (
            <button key={session.id} type="button" role="menuitem" onClick={() => { if (inEditor(session.id)) tabs.close(`${TERMINAL_TAB}${session.id}`); consoleLayout.newGroup(session.id); setAddMenu(null); }}>
              <PaneIcon paneId={session.id} session={session} /> {paneTitle(session.id, session, state.labels)}{session.status === "running" ? "" : " · завершён"}
            </button>
          ))}
        </WbMenu>
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
              <option value={isChatPane(paneId) && !chatPeer(paneId) ? paneId : CHAT}>Чат агентов</option>
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

function PaneBody({ paneId, props, visibleKey }: { paneId: string; props: PaneProps; visibleKey: string }) {
  const desktop = useDesktopSessions();
  if (isChatPane(paneId)) return <>{props.renderChat(paneId)}</>;
  return <SessionView id={paneId} session={desktop.get(paneId)} desktop={desktop} online={Boolean(props.agentsOnline[paneId.slice(6)])} visibleKey={visibleKey} />;
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
        <PaneBody paneId={paneId} props={props} visibleKey={`document:${paneId}`} />
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
  return (
    <span className="wb-console-pane-actions">
      <span className={`wb-session-state is-${session.status}`}>{session.status === "running" ? `pid ${session.pid ?? "—"}` : session.status === "failed" ? "ошибка" : session.status === "stopped" ? "остановлен" : `завершён${session.code !== null ? ` · ${session.code}` : ""}`}</span>
      {session.status === "running" ? (
        <button type="button" className="wb-icon-btn" onClick={() => void desktop.stop(session.id)} title="Остановить"><Square size={12} /></button>
      ) : (
        <>
          {agent && <button type="button" className="wb-icon-btn" onClick={() => void desktop.startAgent(agent as "ChatGPT" | "Codex" | "Claude")} title="Запустить снова"><RotateCcw size={12} /></button>}
          {session.kind === "ssh" && <button type="button" className="wb-icon-btn" onClick={() => void desktop.startSsh(session.title.replace(/^SSH · /, "")).catch(() => undefined)} title="Подключиться снова"><RotateCcw size={12} /></button>}
          <button type="button" className="wb-icon-btn" onClick={() => void desktop.remove(session.id)} title="Убрать сессию"><Trash2 size={12} /></button>
        </>
      )}
    </span>
  );
}

function SessionView({ id, session, desktop, online, visibleKey }: { id: string; session?: Session; desktop: DesktopApi; online: boolean; visibleKey: string }) {
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

  if (session.terminal) return <Suspense fallback={<div className="wb-session-empty"><p>Открываю терминал…</p></div>}><TerminalView session={session} sendInput={desktop.sendInput} visibleKey={visibleKey} /></Suspense>;

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
