import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { onPlannerChange, plannerFetch } from './lib';
import { loadPeople } from './people';
import { isDone, loadTasks, useTasks } from './tasks/api';

const pad = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Вход в «Дела» в строке состояния, под боковой панелью: что на сегодня — задачи со сроком сегодня, события дня
 * и просроченное. Клик открывает «Дела» в боковой панели.
 */
export function PlannerStatus({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const tasks = useTasks((s) => s.tasks);
  const [events, setEvents] = useState(0);
  const [today, setToday] = useState(() => day(new Date()));

  const loadEvents = useCallback(async () => {
    const now = new Date();
    const from = `${day(now)}T00:00:00`;
    const to = `${day(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))}T00:00:00`;
    try {
      const data = await plannerFetch<{ events?: unknown[] }>(`/api/mbox/planner/events?${new URLSearchParams({ from, to })}`);
      setEvents((data.events || []).length);
    } catch { /* нет связи — счётчик прежний */ }
  }, []);

  useEffect(() => { void loadPeople().then(() => loadTasks()); void loadEvents(); }, [loadEvents]);
  useEffect(() => onPlannerChange(['calendar_events'], () => void loadEvents()), [loadEvents]);
  // Полночь: «сегодня» сменилось — пересчитать.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = day(new Date());
      if (next !== today) { setToday(next); void loadEvents(); }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [today, loadEvents]);

  const { dueToday, overdue } = useMemo(() => {
    let dueTodayCount = 0;
    let overdueCount = 0;
    for (const t of Object.values(tasks)) {
      if (isDone(t) || !t.dueDate) continue;
      if (t.dueDate === today) dueTodayCount += 1;
      else if (t.dueDate < today) overdueCount += 1;
    }
    return { dueToday: dueTodayCount, overdue: overdueCount };
  }, [tasks, today]);

  const parts = [dueToday ? `задач ${dueToday}` : '', events ? `событий ${events}` : ''].filter(Boolean);
  const summary = parts.length ? `Сегодня: ${parts.join(', ')}` : 'Сегодня свободно';
  return (
    <button type="button" className={active ? 'wb-status-item wb-status-planner is-on' : 'wb-status-item wb-status-planner'} onClick={onOpen} title={`Дела: задачи и календарь · ${summary}${overdue ? ` · просрочено ${overdue}` : ''}`}>
      <CalendarCheck size={12} aria-hidden="true" />
      <b>Дела</b>
      <span>{summary}</span>
      {overdue > 0 && <span className="is-late">просрочено {overdue}</span>}
    </button>
  );
}
