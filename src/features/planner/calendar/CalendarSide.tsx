import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Check, Plus } from 'lucide-react';
import type { MenuAnchor } from '../ui/overlay';
import { onPlannerChange, plannerFetch } from '../lib';
import { loadTasks, useTasks } from '../tasks/api';
import { openCalendar } from '../nav';
import { taskEvents } from './api';
import { createDefault, openEvent, toggleTaskDone } from './actions';
import { EventMenu } from './EventMenu';
import { MiniMonth } from './MonthViews';
import { addDays, byStart, colorVar, localIso, monthGrid, normalize, onDay, sameDay, startOfDay, timeRange, type CalEvent } from './model';
import { pickDay, setMiniMonth, useCalendarUi } from './ui';

/**
 * Календарь «Дел» в боковой панели: мини-месяц (точки — и события, и сроки задач) и выбранный день целиком —
 * события вперемешку с задачами, задачу можно отметить прямо здесь. Выбор дня показывает его в сетке во вкладке.
 * Свои данные — месяц мини-календаря, независимо от того, какой диапазон открыт в сетке.
 */
export function CalendarSide() {
  const month = useCalendarUi((s) => s.miniMonth);
  const selected = useCalendarUi((s) => s.selected);
  const tasks = useTasks((s) => s.tasks);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [menu, setMenu] = useState<{ event: CalEvent; anchor: MenuAnchor } | null>(null);

  const grid = useMemo(() => monthGrid(month), [month]);
  const from = localIso(grid[0]);
  const to = localIso(addDays(grid[grid.length - 1], 1));

  const load = useCallback(async () => {
    try {
      const data = await plannerFetch<{ events?: Record<string, unknown>[] }>(`/api/mbox/planner/events?${new URLSearchParams({ from, to })}`);
      setEvents((data.events || []).map(normalize).filter((e): e is CalEvent => Boolean(e)));
    } catch { /* без связи — остаются прежние */ }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onPlannerChange(['calendar_events'], () => void load()), [load]);
  useEffect(() => { void loadTasks(); }, []);

  const all = useMemo(() => [...events, ...taskEvents(tasks, from, to)].sort(byStart), [events, tasks, from, to]);
  const day = useMemo(() => all.filter((e) => onDay(e, selected)), [all, selected]);
  const today = startOfDay(new Date());
  const heading = sameDay(selected, today) ? 'Сегодня' : sameDay(selected, addDays(today, 1)) ? 'Завтра'
    : selected.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

  const pick = (d: Date) => { pickDay(d); openCalendar(); };

  return (
    <div className="ncal-sidebar">
      <MiniMonth month={month} selected={selected} events={all} onMonth={setMiniMonth} onPick={pick} />
      <section className="ncal-agenda" aria-label={heading}>
        <div className="ncal-agenda-bar">
          <h3 className="ncal-agenda-head">{heading}</h3>
          <button type="button" className="nx-icon-btn" onClick={() => { openCalendar(); createDefault(); }} aria-label="Новое событие" title="Новое событие"><Plus size={16} /></button>
        </div>
        {day.length === 0 ? (
          <button type="button" className="ncal-agenda-empty" onClick={() => { openCalendar(); createDefault(); }}>Свободный день — добавить событие</button>
        ) : (
          <ul className="ncal-agenda-list">
            {day.map((e) => (
              <li key={e.id}>
                <div className="ncal-agenda-row" data-task={e.taskId ? 'true' : undefined} data-done={e.done ? 'true' : undefined} style={{ '--ev': colorVar(e.color) } as CSSProperties}
                  onContextMenu={(ev) => { ev.preventDefault(); setMenu({ event: e, anchor: { x: ev.clientX, y: ev.clientY } }); }}>
                  {e.taskId ? (
                    <button type="button" className="ntl-check ncal-agenda-check" aria-pressed={Boolean(e.done)} aria-label={e.done ? 'Вернуть в работу' : 'Отметить выполненной'} onClick={() => toggleTaskDone(e)}>
                      {e.done && <Check size={12} strokeWidth={3} aria-hidden="true" />}
                    </button>
                  ) : (
                    <span className="ncal-agenda-time">{e.allDay ? 'весь день' : timeRange(e).replace('–', '\n')}</span>
                  )}
                  <button type="button" className="ncal-agenda-text" onClick={() => { if (!e.taskId) openCalendar(); openEvent(e); }}>
                    <span className="ncal-agenda-title">{e.title || 'Без названия'}</span>
                    {e.location && <span className="ncal-agenda-place">{e.location}</span>}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {menu && <EventMenu event={menu.event} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  );
}
