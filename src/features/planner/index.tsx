import { useEffect } from 'react';
import { plannerFetch } from './lib';
import { normalize, parseLocal } from './calendar/model';
import { ScopeHost } from './calendar/EventEditor';
import { OverlayHost } from './ui/overlay';
import ToastHost, { showToast } from './ui/Toast';
import './planner.css';
import './tasks/tasks.css';
import './calendar/calendar.css';

export { default as TasksScreen } from './tasks/TasksScreen';
export { default as CalendarScreen } from './calendar/CalendarScreen';

/** Открыть задачу в «Задачах»: экран читает её id при показе (см. TasksScreen, ACTIVE_KEY). */
export function rememberActiveTask(taskId: string) {
  try { sessionStorage.setItem('mbox.planner.activeTask', taskId); } catch { /* без памяти — откроется список */ }
  window.dispatchEvent(new CustomEvent('mbox:planner-open-task', { detail: taskId }));
}

// ── Напоминания о событиях ──────────────────────────────────────────────────
// Пока MBOX открыт: раз в 5 минут берём события ближайших суток, раз в 20 секунд проверяем, не пора ли.
// Уже показанные помним в localStorage, чтобы перезапуск окна не повторял их.

const FIRED_KEY = 'mbox.planner.reminded';
const LOOKAHEAD_MS = 26 * 3600_000;
/** Опоздавшее напоминание (окно было закрыто) показываем, только если событие ещё не началось или идёт меньше 15 минут. */
const LATE_MS = 15 * 60_000;

type Upcoming = { key: string; at: number; startsAt: number; title: string; body: string };

function readFired(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(FIRED_KEY) || '{}') as Record<string, number>; } catch { return {}; }
}
function writeFired(fired: Record<string, number>) {
  const weekAgo = Date.now() - 7 * 86400_000;
  const kept = Object.fromEntries(Object.entries(fired).filter(([, at]) => at > weekAgo));
  try { localStorage.setItem(FIRED_KEY, JSON.stringify(kept)); } catch { /* без памяти — максимум повтор */ }
}

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function notify(item: Upcoming) {
  const show = () => {
    try {
      new Notification(item.title, { body: item.body, tag: item.key, silent: false });
      return true;
    } catch { return false; }
  };
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && show()) return;
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void Notification.requestPermission().then((permission) => { if (permission !== 'granted' || !show()) showToast(`${item.title} — ${item.body}`, 'info'); });
    return;
  }
  showToast(`${item.title} — ${item.body}`, 'info');
}

function useEventReminders() {
  useEffect(() => {
    let upcoming: Upcoming[] = [];
    let alive = true;
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
    const refresh = async () => {
      const now = new Date();
      const qs = new URLSearchParams({ from: local(new Date(now.getTime() - LATE_MS)), to: local(new Date(now.getTime() + LOOKAHEAD_MS)) });
      try {
        const data = await plannerFetch<{ events?: Record<string, unknown>[] }>(`/api/mbox/planner/events?${qs}`);
        if (!alive) return;
        upcoming = (data.events || []).map(normalize).flatMap((event) => {
          if (!event || event.reminderMinutesBefore == null) return [];
          const startsAt = parseLocal(event.start).getTime();
          const minutes = event.reminderMinutesBefore;
          const when = event.allDay ? 'сегодня' : minutes === 0 ? `сейчас, ${timeFmt.format(startsAt)}` : `в ${timeFmt.format(startsAt)}`;
          return [{ key: `${event.id}@${event.start}@${minutes}`, at: startsAt - minutes * 60_000, startsAt, title: event.title || 'Событие', body: event.location ? `${when} · ${event.location}` : when }];
        });
      } catch { /* нет связи — проверим в следующий раз */ }
    };
    const tick = () => {
      const now = Date.now();
      const fired = readFired();
      let changed = false;
      for (const item of upcoming) {
        if (fired[item.key] || item.at > now || now - item.startsAt > LATE_MS) continue;
        fired[item.key] = now;
        changed = true;
        notify(item);
      }
      if (changed) writeFired(fired);
    };
    void refresh().then(tick);
    const refreshTimer = window.setInterval(() => void refresh(), 5 * 60_000);
    const tickTimer = window.setInterval(tick, 20_000);
    const onChange = (event: Event) => { if ((event as CustomEvent).detail === 'calendar_events') void refresh(); };
    window.addEventListener('mbox:entity-changed', onChange);
    return () => {
      alive = false;
      window.clearInterval(refreshTimer);
      window.clearInterval(tickTimer);
      window.removeEventListener('mbox:entity-changed', onChange);
    };
  }, []);
}

/** Один раз на окно MBOX: подтверждения, вопрос «это / следующие / вся серия», сообщения и напоминания. */
export function PlannerHosts() {
  useEventReminders();
  return (
    <>
      <OverlayHost />
      <ScopeHost />
      <ToastHost />
    </>
  );
}
