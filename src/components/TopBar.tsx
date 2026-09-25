import { AlertTriangle, Check, Download, FolderOpen, LogOut, Monitor, PanelLeft, Play, Power, RefreshCw, Search, Square, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentAvatar, useWorkingFrame, WORKING_FRAMES, WORKING_FRAME_INTERVAL_MS, AgentName } from "./AgentAvatar";
import type { ToolOutputLine, ToolRunEvent } from "../types";
import { markOverlay } from "../app/workbench/BrowserDocument";

// Раньше burst длился 500мс — при интервале кадра 260мс это меньше двух кадров, ни одного
// полного круга по 4 кадрам осьминога. Минимум — 4 полных круга, длительность считается от
// реальных констант анимации, чтобы не разъезжаться при будущих правках скорости/числа кадров.
const LOGO_BURST_LOOPS = 4;
const LOGO_BURST_MS = LOGO_BURST_LOOPS * WORKING_FRAMES.length * WORKING_FRAME_INTERVAL_MS;

export type AgentRosterEntry = {
  id: string;
  name: string;
  status: string;
  live: boolean;
  statusLabel: string;
  detail?: string;
  since?: string;
};

export type AttentionTodo = { id: string; title: string; status: string; projectId: string; projectName: string };

type TopBarProps = {
  /** Кнопка-«командный центр» по центру шапки: открывает поиск по памяти. */
  onOpenSearch: () => void;
  onToggleSidebar?: () => void;
  onToggleConsole?: () => void;
  activeTitle?: string;
  activeHint?: string;
  activeIcon?: string;
  activeDirty?: boolean;
  tabCount?: number;
  realtimeState?: "connecting" | "connected" | "thinking" | "working" | "attention" | "offline";
  realtimeLabel?: string;
  notice?: string;
  notices?: Array<{ id: string; text: string; at: string }>;
  roster?: AgentRosterEntry[];
  attentionTodos?: AttentionTodo[];
  onOpenTodo?: (todoId: string) => void;
  /** Галочка на карточке «Требует внимания» — закрыть задачу, не открывая её. */
  onResolveTodo?: (todoId: string) => void;
  onLogout?: () => void;
  /** Загрузка данных, работа агента, раздумья Джарвиса — любой признак активности приложения:
   * лого-осьминог в шапке начинает шевелить щупальцами вместо статичной позы. */
  busy?: boolean;
};

type DesktopResponder = { pid: number; agent: string; commandLine?: string };
type DesktopApi = {
  status: () => Promise<DesktopResponder[]>;
  start: (name: string) => Promise<DesktopResponder[]>;
  stop: (name: string) => Promise<DesktopResponder[]>;
  installAutostart: () => Promise<unknown>;
  removeAutostart: () => Promise<unknown>;
  installAppAutostart: () => Promise<unknown>;
  removeAppAutostart: () => Promise<unknown>;
  openRepo: () => Promise<unknown>;
  openPath?: (targetPath: string) => Promise<unknown>;
  checkUpdates?: () => Promise<unknown>;
  installUpdate?: () => Promise<unknown>;
  onEvent: (handler: (event: { type: string; message?: string; at?: string }) => void) => void;
  // Запуск инструментов из MBOX — есть только в свежей оболочке, поэтому всё необязательное.
  runTool?: (toolId: string, commandLabel: string) => Promise<{ pid?: number }>;
  stopTool?: (toolId: string) => Promise<unknown>;
  toolStatus?: () => Promise<Array<{ tool: string; label: string; lines: ToolOutputLine[] }>>;
  onToolEvent?: (handler: (payload: ToolRunEvent) => void) => () => void;
};

declare global {
  interface Window {
    mboxDesktop?: DesktopApi;
  }
}

const attentionStatusLabel: Record<string, string> = { blocked: "заблокирована", review: "на проверке" };

/** «Агент Джарвис подключился» три раза подряд — одна строка «×3» со временем последнего раза. */
function collapseNotices(notices: Array<{ id: string; text: string; at: string }>) {
  const out: Array<{ id: string; text: string; at: string; count: number }> = [];
  for (const item of notices) {
    const last = out[out.length - 1];
    if (last && last.text === item.text) last.count += 1;
    else out.push({ ...item, count: 1 });
  }
  return out;
}
const desktopDownloadUrl = "/downloads/mbox-desktop-setup-0.1.43.exe";

function detectDesktopShell() {
  if (typeof window === "undefined") return false;
  const flag = document.documentElement.dataset.mboxDesktop === "true";
  const query = new URLSearchParams(window.location.search).get("mboxDesktop") === "1";
  const userAgent = window.navigator.userAgent.includes("MBOXDesktop/");
  return flag || query || userAgent;
}

export function TopBar({
  onOpenSearch,
  onToggleSidebar,
  onToggleConsole,
  activeTitle = "MBOX",
  activeHint = "Рабочее место",
  activeIcon = "/assets/icons/navigation/projects.png",
  activeDirty = false,
  tabCount = 0,
  realtimeState = "connecting",
  realtimeLabel = "Агент подключается",
  notice = "",
  notices = [],
  roster = [],
  attentionTodos = [],
  onOpenTodo,
  onResolveTodo,
  onLogout,
  busy = false,
}: TopBarProps) {
  const [open, setOpen] = useState(false);
  const [logoBurst, setLogoBurst] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [desktopRows, setDesktopRows] = useState<DesktopResponder[]>([]);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopError, setDesktopError] = useState("");
  const [desktopApi, setDesktopApi] = useState<DesktopApi | null>(null);
  const [isDesktopShell, setIsDesktopShell] = useState(false);
  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState("Обновления проверяются в установленном приложении");
  const barRef = useRef<HTMLElement | null>(null);
  const burstTimer = useRef<number | undefined>(undefined);
  const firstRun = useRef(true);
  const desktopOpenRef = useRef(desktopOpen);
  const online = roster.filter((agent) => agent.status === "active");
  const stack = (online.length ? online : roster).slice(0, 3);
  const logoFrame = useWorkingFrame(busy || logoBurst);
  const desktop = desktopApi;
  const chatgptLive = desktopRows.some((row) => row.agent === "ChatGPT" || row.agent === "Codex");
  const claudeLive = desktopRows.some((row) => row.agent === "Claude");

  async function refreshDesktop() {
    if (!desktop) return;
    try {
      setDesktopRows(await desktop.status());
      setDesktopError("");
    } catch (error) {
      setDesktopError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    desktopOpenRef.current = desktopOpen;
  }, [desktopOpen]);

  // Страница встроенного браузера рисуется главным процессом поверх всего окна, поэтому попапы
  // шапки уходили под неё. Пока попап открыт — страница прячется (тот же приём, что у WbMenu).
  useEffect(() => {
    if (!open) return;
    markOverlay(true);
    return () => markOverlay(false);
  }, [open]);
  useEffect(() => {
    if (!desktopOpen) return;
    markOverlay(true);
    return () => markOverlay(false);
  }, [desktopOpen]);

  async function desktopAction(action: () => Promise<unknown>) {
    if (!desktop) return;
    setDesktopBusy(true);
    try {
      await action();
      await refreshDesktop();
      setDesktopError("");
    } catch (error) {
      setDesktopError(error instanceof Error ? error.message : String(error));
    } finally {
      setDesktopBusy(false);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const detect = () => {
      if (cancelled) return false;
      if (detectDesktopShell()) setIsDesktopShell(true);
      if (!window.mboxDesktop) return false;
      setDesktopApi(window.mboxDesktop);
      return true;
    };
    if (detect()) return;
    const timer = window.setInterval(() => {
      if (detect()) window.clearInterval(timer);
    }, 150);
    const stopTimer = window.setTimeout(() => window.clearInterval(timer), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(stopTimer);
    };
  }, []);

  // Открыт не больше одного попапа; клик мимо и Escape закрывают — раньше два попапа ложились друг на друга.
  useEffect(() => {
    if (!open && !desktopOpen) return;
    const close = () => { setOpen(false); setDesktopOpen(false); };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".tb-pop, .tb-pop-trigger")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, desktopOpen]);

  // Открытие/закрытие менюшки — тоже триггер: лого-осьминог должен шевелить щупальцами
  // на сам переход, не только пока данные грузятся или агент работает.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setLogoBurst(true);
    window.clearTimeout(burstTimer.current);
    burstTimer.current = window.setTimeout(() => setLogoBurst(false), LOGO_BURST_MS);
    return () => window.clearTimeout(burstTimer.current);
  }, [open]);

  useEffect(() => {
    if (!desktop) return;
    void refreshDesktop();
    desktop.onEvent((event) => {
      if (event.type === "update" && event.message) setDesktopUpdateStatus(event.message);
      if (desktopOpenRef.current) void refreshDesktop();
    });
  }, [desktop]);

  // Кнопки окна Windows нарисованы поверх шапки (titleBarOverlay) — красим их в цвет шапки текущей темы.
  useEffect(() => {
    const setTheme = (window.mboxDesktop as { setTitleBarTheme?: (color: string, symbol: string) => Promise<unknown> } | undefined)?.setTitleBarTheme;
    if (!setTheme) return;
    const app = document.querySelector(".app");
    const sync = () => {
      const bar = document.querySelector(".wb-titlebar");
      if (!bar) return;
      const styles = getComputedStyle(bar);
      void setTheme(styles.backgroundColor, styles.color);
    };
    sync();
    if (!app) return;
    const observer = new MutationObserver(() => window.requestAnimationFrame(sync));
    observer.observe(app, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, [desktopApi]);

  return (
    <header className="topbar" ref={barRef}>
      <div className="topbar-context" title={`${activeTitle} — ${activeHint}${tabCount > 1 ? ` · ${tabCount} вкладок` : ""}`}>
        <img src={activeIcon} alt="" width={18} height={18} />
        <strong>{activeTitle}</strong>
        {activeDirty && <i className="topbar-dirty" aria-label="есть несохранённые правки" />}
        <span>{activeHint}</span>
      </div>
      <button className="command-center" type="button" onClick={onOpenSearch} title="Поиск и команды">
        <Search size={14} />
        <span>Поиск и команды</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="topbar-actions">
        {onToggleSidebar && (
          <button className="topbar-icon-action" type="button" onClick={onToggleSidebar} aria-label="Боковая панель" title="Боковая панель">
            <PanelLeft size={16} />
          </button>
        )}
        {onToggleConsole && (
          <button className="topbar-icon-action" type="button" onClick={onToggleConsole} aria-label="Консоль" title="Консоль">
            <TerminalSquare size={16} />
          </button>
        )}
      <div className={isDesktopShell || desktopApi ? "desktop-slot is-desktop-shell" : "desktop-slot"}>
        {desktop ? (
          <button
            className={`desktop-pill tb-pop-trigger ${chatgptLive && claudeLive ? "active" : ""}`}
            type="button"
            onClick={() => { setOpen(false); setDesktopOpen((value) => !value); void refreshDesktop(); }}
            aria-expanded={desktopOpen}
            title={`Локальные агенты MBOX Desktop: запущено ${desktopRows.length}`}
            aria-label={`Локальные агенты: запущено ${desktopRows.length}`}
          >
            <img className="desktop-pill-logo" src="/mbox-desktop-icon.png" alt="" />
            <span className={desktopRows.length ? "desktop-pill-count" : "desktop-pill-count is-zero"}>{desktopRows.length}</span>
          </button>
        ) : isDesktopShell ? (
          <button className="desktop-pill bridge-missing" type="button" disabled title="MBOX Desktop IPC не подключился">
            <img className="desktop-pill-logo" src="/mbox-desktop-icon.png" alt="" />
            <strong>Приложение</strong>
            <span>мост не подключен</span>
          </button>
        ) : (
          <a className="desktop-pill download" href={desktopDownloadUrl} target="_blank" rel="noreferrer">
            <Download size={17} />
            <strong>Скачать приложение</strong>
          </a>
        )}
        {desktop && desktopOpen && (
          <div className="tb-pop tb-pop-desktop" role="dialog" aria-label="Локальные агенты">
            <header className="tb-pop-head">
              <strong>Локальные агенты</strong>
              <button type="button" className="tb-pop-icon" onClick={refreshDesktop} disabled={desktopBusy} aria-label="Обновить состояние" title="Обновить состояние">
                <RefreshCw size={13} />
              </button>
            </header>
            <ul className="tb-pop-list">
              {["ChatGPT", "Claude"].map((name) => {
                const row = desktopRows.find((item) => item.agent === name || (name === "ChatGPT" && item.agent === "Codex"));
                return (
                  <li key={name} className="tb-pop-row">
                    <i className={row ? "tb-dot is-live" : "tb-dot"} aria-hidden="true" />
                    <span className="tb-pop-name">{name}</span>
                    <small>{row ? "работает" : "не запущен"}</small>
                  </li>
                );
              })}
            </ul>
            <div className="tb-pop-buttons">
              <button type="button" className="is-primary" disabled={desktopBusy || desktopRows.length >= 2} onClick={() => desktopAction(() => desktop.start("All"))}>
                <Play size={13} /> Запустить
              </button>
              <button type="button" disabled={desktopBusy || !desktopRows.length} onClick={() => desktopAction(() => desktop.stop("All"))}>
                <Square size={12} /> Остановить
              </button>
            </div>
            <div className="tb-pop-sep" role="separator" />
            <div className="tb-pop-menu" role="menu">
              <button type="button" role="menuitem" disabled={desktopBusy} onClick={() => desktopAction(() => desktop.installAutostart())}><Power size={14} /> Запускать агентов при входе в Windows</button>
              <button type="button" role="menuitem" disabled={desktopBusy} onClick={() => desktopAction(() => desktop.installAppAutostart())}><Monitor size={14} /> Запускать приложение при входе</button>
              <button type="button" role="menuitem" disabled={desktopBusy || !desktop.checkUpdates} onClick={() => desktopAction(() => desktop.checkUpdates?.() ?? Promise.resolve())}><Download size={14} /> Проверить обновления</button>
              <button type="button" role="menuitem" disabled={desktopBusy} onClick={() => desktopAction(() => desktop.openRepo())}><FolderOpen size={14} /> Открыть папку репозитория</button>
            </div>
            <footer className={`tb-pop-foot${desktopError ? " is-error" : ""}`}>{desktopError || desktopUpdateStatus}</footer>
          </div>
        )}
      </div>
      <button className={`realtime-pill monostatus tb-pop-trigger ${realtimeState}`} type="button" onClick={() => { setDesktopOpen(false); setOpen((value) => !value); }} aria-expanded={open} title="Агенты и последние действия">
        {stack.length > 0 && (
          <span className="pill-avatars" aria-hidden="true">
            {stack.map((agent) => (
              <AgentAvatar key={agent.id} name={agent.name} status={agent.status} live={agent.live} size={22} />
            ))}
          </span>
        )}
        <img className="topbar-logo" src={busy || logoBurst ? logoFrame : WORKING_FRAMES[0]} width={32} height={32} alt="" />
        {/* «MBOX» рядом с логотипом — повтор бренда; подпись нужна, только когда это состояние («Агент подключается»). */}
        {realtimeLabel === "MBOX" ? <span className="topbar-sr">MBOX: статус агентов</span> : <strong>{realtimeLabel}</strong>}
        {notice && <span>{notice}</span>}
      </button>
      {onLogout && (
        <button className="topbar-logout" type="button" onClick={onLogout} aria-label="Выйти из MBOX" title="Выйти">
          <LogOut size={17} />
        </button>
      )}
      </div>
      {open && (
        <div className="tb-pop tb-pop-agents" role="dialog" aria-label="Агенты и последние действия">
          {attentionTodos.length > 0 && (
            <section>
              <h3 className="tb-pop-label is-warn"><AlertTriangle size={12} /> Требует внимания · {attentionTodos.length}</h3>
              <ul className="tb-pop-list">
                {attentionTodos.map((todo) => (
                  <li key={todo.id} className="tb-pop-row is-action">
                    <button type="button" className="tb-pop-rowbtn" onClick={() => { onOpenTodo?.(todo.id); setOpen(false); }}>
                      <i className={`tb-dot ${todo.status === "blocked" ? "is-danger" : "is-warn"}`} aria-hidden="true" />
                      <span className="tb-pop-name">{todo.title}</span>
                      <small>{todo.projectName} · {attentionStatusLabel[todo.status] || todo.status}</small>
                    </button>
                    {onResolveTodo && (
                      <button type="button" className="tb-pop-icon" title="Отметить готовой" aria-label={`Отметить готовой: ${todo.title}`} onClick={() => onResolveTodo(todo.id)}>
                        <Check size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="tb-pop-label">Агенты</h3>
            {roster.length ? (
              <>
                <ul className="tb-pop-list">
                  {roster.filter((agent) => agent.status !== "offline").map((agent) => (
                    <li key={agent.id} className="tb-pop-row" title={agent.detail || agent.statusLabel}>
                      <AgentAvatar name={agent.name} status={agent.status} live={agent.live} size={20} />
                      <AgentName name={agent.name} className="tb-pop-name" />
                      <small className={agent.live ? "is-live" : agent.status === "active" ? "is-ok" : undefined}>{agent.live ? "в работе" : agent.statusLabel}</small>
                    </li>
                  ))}
                </ul>
                {roster.some((agent) => agent.status === "offline") && (
                  <p className="tb-pop-note">Не в сети: {roster.filter((agent) => agent.status === "offline").map((agent) => agent.name).join(", ")}</p>
                )}
              </>
            ) : <p className="tb-pop-note">Агенты пока не подключались</p>}
          </section>
          <section>
            <h3 className="tb-pop-label">Последние действия</h3>
            {notices.length ? (
              <ul className="tb-pop-feed">
                {collapseNotices(notices).slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <span>{item.text}{item.count > 1 && <b> ×{item.count}</b>}</span>
                    <time>{item.at}</time>
                  </li>
                ))}
              </ul>
            ) : <p className="tb-pop-note">Агенты ещё ничего не меняли</p>}
          </section>
        </div>
      )}
    </header>
  );
}
