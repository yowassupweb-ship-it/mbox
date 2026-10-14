import { Bell, BellOff, CheckCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { markOverlay } from "../app/workbench/BrowserDocument";
import { ENTITY_CHANGED_EVENT } from "../hooks/useRealtime";
import { fetchJson } from "../lib/api";
import { formatSince } from "../lib/format";

type NotifyItem = { id: string; project_id: string; project: string; entity: string; entity_id: string; who: string; text: string; title: string; at: string; unread: boolean };
type NotifyProject = { id: string; name: string; muted: boolean; unread: number };
type NotifyState = { items: NotifyItem[]; projects: NotifyProject[]; unread: number };

const REFRESH_MS = 60_000;
const WATCHED_ENTITIES = new Set(["todos", "decision_log", "decisions", ""]);

function badge(count: number) {
  return count > 99 ? "99+" : String(count);
}

/** Системное уведомление, когда окно не в фокусе: так же, как у планировщика, только по чужим действиям в проектах. */
function showDesktopNotice(items: NotifyItem[]) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden || !items.length) return;
  const first = items[0];
  const more = items.length > 1 ? ` и ещё ${items.length - 1}` : "";
  try {
    new Notification(`${first.project}${more}`, { body: `${first.who} ${first.text}: ${first.title}`, tag: "mbox-notifications" });
  } catch {
    // окружение без системных уведомлений — остаётся значок со счётчиком
  }
}

/**
 * Уведомления по проектам, как в мессенджере: колокольчик со счётчиком, лента чужих действий,
 * «прочитать всё» и отключение отдельных проектов (server/notifications.mjs). Пока сервер не отвечает
 * (старая версия без ручки), колокольчик не показывается.
 */
export function NotificationBell({ onOpenTodo }: { onOpenTodo?: (todoId: string) => void }) {
  const [state, setState] = useState<NotifyState | null>(null);
  const [open, setOpen] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [permission, setPermission] = useState<string>(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const knownIds = useRef<Set<string> | null>(null);
  const openRef = useRef(open);
  const unreadRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const next = await fetchJson<NotifyState>("/api/mbox/notifications");
      const known = knownIds.current;
      if (known) showDesktopNotice(next.items.filter((item) => item.unread && !known.has(item.id)));
      knownIds.current = new Set(next.items.map((item) => item.id));
      unreadRef.current = next.unread;
      setState(next);
    } catch {
      // нет связи или сервер без этой ручки — оставляем прежнее состояние
    }
  }, []);

  const markRead = useCallback(async () => {
    if (!unreadRef.current) return;
    unreadRef.current = 0;
    setState((current) => current && { ...current, unread: 0, items: current.items.map((item) => ({ ...item, unread: false })), projects: current.projects.map((project) => ({ ...project, unread: 0 })) });
    await fetchJson("/api/mbox/notifications/read", { method: "POST" }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    let pending = 0;
    const onChanged = (event: Event) => {
      if (!WATCHED_ENTITIES.has(String((event as CustomEvent<string>).detail ?? ""))) return;
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void load(), 600);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(ENTITY_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(pending);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(ENTITY_CHANGED_EVENT, onChanged);
    };
  }, [load]);

  // Закрытие: клик мимо или Escape. Прочитанным всё становится в момент закрытия — пока окно открыто, видно, что новое.
  useEffect(() => {
    openRef.current = open;
    if (!open) return;
    // Страница встроенного браузера рисуется поверх всего окна — пока список открыт, её подменяет снимок.
    markOverlay(true);
    const close = () => { setOpen(false); void markRead(); };
    const onDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      markOverlay(false);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, markRead]);

  async function toggleMute(project: NotifyProject) {
    setState((current) => current && { ...current, projects: current.projects.map((item) => (item.id === project.id ? { ...item, muted: !item.muted } : item)) });
    try {
      await fetchJson("/api/mbox/notifications/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: project.id, muted: !project.muted }) });
    } finally {
      await load();
    }
  }

  async function askPermission() {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission());
  }

  if (!state) return null;
  const muted = state.projects.filter((project) => project.muted).length;
  const label = state.unread > 0 ? `Уведомления, непрочитанных: ${state.unread}` : "Уведомления";

  return (
    <div className="tb-notify" ref={rootRef}>
      <button
        className="topbar-icon-action tb-notify-trigger"
        type="button"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => { if (open) void markRead(); setOpen(!open); }}
      >
        <Bell size={16} />
        {state.unread > 0 && <span className="tb-notify-count">{badge(state.unread)}</span>}
      </button>
      {open && (
        <div className="tb-pop tb-pop-notify" role="dialog" aria-label="Уведомления">
          <header className="tb-pop-head">
            <strong>Уведомления</strong>
            <button type="button" className="tb-pop-icon" onClick={() => void markRead()} disabled={!state.unread} aria-label="Прочитать всё" title="Прочитать всё">
              <CheckCheck size={14} />
            </button>
          </header>
          <section>
            {state.items.length ? (
              <ul className="tb-pop-list tb-notify-list">
                {state.items.map((item) => {
                  const openable = item.entity === "todos" && Boolean(onOpenTodo);
                  const body = (
                    <>
                      <i className={`tb-dot${item.unread ? " is-live" : ""}`} aria-hidden="true" />
                      <span className="tb-notify-text"><b>{item.who}</b> {item.text}: {item.title}</span>
                      <small>{item.project} · {formatSince(item.at)}</small>
                    </>
                  );
                  return (
                    <li key={item.id} className={`tb-pop-row is-action${item.unread ? " is-unread" : ""}`}>
                      {openable ? (
                        <button type="button" className="tb-pop-rowbtn" onClick={() => { onOpenTodo?.(item.entity_id); setOpen(false); void markRead(); }}>{body}</button>
                      ) : (
                        <div className="tb-pop-rowbtn is-static">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : <p className="tb-pop-note">Пока тихо. Здесь появятся действия коллег в ваших проектах: новые задачи, закрытые задачи, решения.</p>}
          </section>
          <section>
            <button type="button" className="tb-notify-toggle" aria-expanded={showProjects} onClick={() => setShowProjects(!showProjects)}>
              Проекты{muted ? ` · отключено ${muted}` : ""}
            </button>
            {showProjects && (
              <ul className="tb-pop-list">
                {state.projects.map((project) => (
                  <li key={project.id} className={`tb-pop-row tb-notify-project${project.muted ? " is-muted" : ""}`}>
                    <span className="tb-pop-name" title={project.name}>{project.name}</span>
                    {project.unread > 0 && <span className="tb-notify-pill">{badge(project.unread)}</span>}
                    <button
                      type="button"
                      className="tb-pop-icon"
                      onClick={() => void toggleMute(project)}
                      aria-pressed={project.muted}
                      aria-label={project.muted ? `Включить уведомления: ${project.name}` : `Отключить уведомления: ${project.name}`}
                      title={project.muted ? "Включить уведомления" : "Отключить уведомления"}
                    >
                      {project.muted ? <BellOff size={13} /> : <Bell size={13} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {permission === "default" && (
            <section>
              <button type="button" className="tb-notify-toggle" onClick={() => void askPermission()}>Показывать уведомления на рабочем столе</button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
