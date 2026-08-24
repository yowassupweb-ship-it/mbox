import { AlertTriangle, Download, FolderOpen, Play, RefreshCw, Search, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentAvatar, useWorkingFrame, WORKING_FRAMES, WORKING_FRAME_INTERVAL_MS } from "./AgentAvatar";

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
  query: string;
  onQueryChange: (query: string) => void;
  realtimeState?: "connecting" | "connected" | "thinking" | "working" | "attention" | "offline";
  realtimeLabel?: string;
  notice?: string;
  notices?: Array<{ id: string; text: string; at: string }>;
  roster?: AgentRosterEntry[];
  attentionTodos?: AttentionTodo[];
  onOpenTodo?: (projectId: string) => void;
  /** Загрузка данных, работа агента, раздумья Джарвиса — любой признак активности приложения:
   * лого-осьминог в шапке начинает шевелить щупальцами вместо статичной позы. */
  busy?: boolean;
};

type DesktopResponder = { pid: number; agent: string; commandLine?: string };

declare global {
  interface Window {
    mboxDesktop?: {
      status: () => Promise<DesktopResponder[]>;
      start: (name: string) => Promise<DesktopResponder[]>;
      stop: (name: string) => Promise<DesktopResponder[]>;
      installAutostart: () => Promise<unknown>;
      removeAutostart: () => Promise<unknown>;
      installAppAutostart: () => Promise<unknown>;
      removeAppAutostart: () => Promise<unknown>;
      openRepo: () => Promise<unknown>;
      onEvent: (handler: (event: { type: string; message?: string; at?: string }) => void) => void;
    };
  }
}

const attentionStatusLabel: Record<string, string> = { blocked: "заблокирована", review: "на проверке" };
const desktopDownloadUrl = "/downloads/mbox-desktop-setup-0.1.1.exe";

export function TopBar({
  query,
  onQueryChange,
  realtimeState = "connecting",
  realtimeLabel = "Агент подключается",
  notice = "",
  notices = [],
  roster = [],
  attentionTodos = [],
  onOpenTodo,
  busy = false,
}: TopBarProps) {
  const [open, setOpen] = useState(false);
  const [popoverMounted, setPopoverMounted] = useState(false);
  const [popoverClosing, setPopoverClosing] = useState(false);
  const [logoBurst, setLogoBurst] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [desktopRows, setDesktopRows] = useState<DesktopResponder[]>([]);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const burstTimer = useRef<number | undefined>(undefined);
  const firstRun = useRef(true);
  const online = roster.filter((agent) => agent.status === "active");
  const stack = (online.length ? online : roster).slice(0, 3);
  const logoFrame = useWorkingFrame(busy || logoBurst);
  const desktop = typeof window !== "undefined" ? window.mboxDesktop : undefined;
  const codexLive = desktopRows.some((row) => row.agent === "Codex");
  const claudeLive = desktopRows.some((row) => row.agent === "Claude");

  async function refreshDesktop() {
    if (!desktop) return;
    setDesktopRows(await desktop.status());
  }

  async function desktopAction(action: () => Promise<unknown>) {
    if (!desktop) return;
    setDesktopBusy(true);
    try {
      await action();
      await refreshDesktop();
    } finally {
      setDesktopBusy(false);
    }
  }

  // Попап раньше пропадал мгновенно при закрытии — CSS-анимация играла только на открытии.
  // Держим DOM ещё один тик, проигрываем обратную анимацию, и только потом размонтируем.
  useEffect(() => {
    window.clearTimeout(closeTimer.current);
    if (open) {
      setPopoverClosing(false);
      setPopoverMounted(true);
    } else if (popoverMounted) {
      setPopoverClosing(true);
      closeTimer.current = window.setTimeout(() => {
        setPopoverMounted(false);
        setPopoverClosing(false);
      }, 160);
    }
    return () => window.clearTimeout(closeTimer.current);
  }, [open]);

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
    const timer = window.setInterval(() => { void refreshDesktop(); }, 6000);
    desktop.onEvent(() => { void refreshDesktop(); });
    return () => window.clearInterval(timer);
  }, [desktop]);

  return (
    <header className="topbar">
      <div className="desktop-slot">
        {desktop ? (
          <button
            className={`desktop-pill ${codexLive && claudeLive ? "active" : ""}`}
            type="button"
            onClick={() => { setDesktopOpen((value) => !value); void refreshDesktop(); }}
            aria-expanded={desktopOpen}
          >
            <img className="desktop-pill-logo" src="/mbox-desktop-icon.png" alt="" />
            <strong>Приложение</strong>
            <span>{codexLive && claudeLive ? "агенты слушают" : desktopRows.length ? "частично" : "тихо"}</span>
          </button>
        ) : (
          <a className="desktop-pill download" href={desktopDownloadUrl} target="_blank" rel="noreferrer">
            <Download size={17} />
            <strong>Скачать приложение</strong>
          </a>
        )}
        {desktop && desktopOpen && (
          <div className="desktop-popover" role="dialog" aria-label="MBOX Desktop">
            <div className="desktop-popover-head">
              <strong>Локальные агенты</strong>
              <button type="button" onClick={refreshDesktop} disabled={desktopBusy} aria-label="Обновить">
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="desktop-agent-list">
              {["Codex", "Claude"].map((name) => {
                const row = desktopRows.find((item) => item.agent === name);
                return (
                  <div className="desktop-agent-row" key={name}>
                    <span className={row ? "desktop-dot live" : "desktop-dot"} />
                    <div>
                      <strong>{name}</strong>
                      <span>{row ? `pid ${row.pid}` : "не запущен"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="desktop-actions">
              <button type="button" disabled={desktopBusy} onClick={() => desktopAction(() => desktop.start("All"))}>
                <Play size={14} /> Запустить
              </button>
              <button type="button" disabled={desktopBusy} onClick={() => desktopAction(() => desktop.stop("All"))}>
                <Square size={14} /> Остановить
              </button>
              <button type="button" disabled={desktopBusy} onClick={() => desktopAction(() => desktop.installAutostart())}>
                Автозапуск агентов
              </button>
              <button type="button" disabled={desktopBusy} onClick={() => desktopAction(() => desktop.installAppAutostart())}>
                Автозапуск приложения
              </button>
              <button type="button" disabled={desktopBusy} onClick={() => desktopAction(() => desktop.openRepo())}>
                <FolderOpen size={14} /> Репозиторий
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="search-shell">
        <Search size={18} />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Поиск" />
      </div>
      <button className={`realtime-pill monostatus ${realtimeState}`} type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {stack.length > 0 && (
          <span className="pill-avatars" aria-hidden="true">
            {stack.map((agent) => (
              <AgentAvatar key={agent.id} name={agent.name} status={agent.status} live={agent.live} size={22} />
            ))}
          </span>
        )}
        <img className="topbar-logo" src={busy || logoBurst ? logoFrame : WORKING_FRAMES[0]} width={32} height={32} alt="" />
        <strong className={realtimeLabel === "MBOX" ? "is-brand" : ""}>{realtimeLabel}</strong>
        {notice && <span>{notice}</span>}
      </button>
      {popoverMounted && (
        <div className={`agent-status-popover${popoverClosing ? " closing" : ""}`} role="dialog" aria-label="Статус агентов">
          {attentionTodos.length > 0 && (
            <section className="popover-section">
              <strong><AlertTriangle size={14} /> Требует внимания</strong>
              <ul className="attention-list">
                {attentionTodos.map((todo) => (
                  <li key={todo.id}>
                    <button type="button" onClick={() => { onOpenTodo?.(todo.projectId); setOpen(false); }}>
                      <span className={`attention-dot status-${todo.status}`} />
                      <span className="attention-body">
                        <span className="attention-title">{todo.title}</span>
                        <span className="attention-meta">{todo.projectName} · {attentionStatusLabel[todo.status] || todo.status}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="popover-section">
            <strong>Команда</strong>
            {roster.length ? (
              <ul className="agent-roster">
                {roster.map((agent) => (
                  <li className={`agent-roster-item ${agent.status}`} key={agent.id}>
                    <AgentAvatar name={agent.name} status={agent.status} live={agent.live} size={34} />
                    <div className="agent-roster-body">
                      <span className="agent-roster-name">{agent.name}</span>
                      <span className="agent-roster-detail">{agent.detail || agent.statusLabel}</span>
                    </div>
                    <div className="agent-roster-meta">
                      <span className={`agent-roster-state ${agent.live ? "working" : agent.status}`}>{agent.live ? "в работе" : agent.statusLabel}</span>
                      {agent.since && <time>{agent.since}</time>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p>Агенты пока не подключены</p>}
          </section>
          <section className="popover-section">
            <strong>Действия</strong>
            {notices.length ? (
              <div className="agent-status-list">
                {notices.map((item) => (
                  <div className="agent-status-item" key={item.id}>
                    <span>{item.text}</span>
                    <time>{item.at}</time>
                  </div>
                ))}
              </div>
            ) : <p>Агенты ещё ничего не меняли</p>}
          </section>
        </div>
      )}
    </header>
  );
}
