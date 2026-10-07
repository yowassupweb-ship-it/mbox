import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Plus, RotateCw, Zap } from 'lucide-react';
import type { MenuAnchor } from '../ui/overlay';
import { loadTasks, useTasks } from '../tasks/api';
import { loadRange, reload, taskEvents, useCalendar } from './api';
import { createAt, createDefault, moveEvent, moveEventToDay, openEvent, removeEvent } from './actions';
import { EventMenu } from './EventMenu';
import { DayAgenda, MonthView } from './MonthViews';
import TimeGrid from './TimeGrid';
import { goToday, pickDay, setShowSystem, setView, useCalendarUi, type View } from './ui';
import {
  addDays, byStart, localIso, monthGrid, MONTHS, MONTHS_GEN, startOfDay, startOfWeek, weekdayIndex, WEEKDAYS_FULL, type CalEvent,
} from './model';

/**
 * Вкладка «Календарь» раздела «Задачи» (из shar-2): сетка дня, недели или месяца. Мини-месяц и повестка дня — в боковой панели
 * «Задачи» (PlannerSidebar), они делят с сеткой общее состояние (ui.ts). Поверх событий — задачи со сроком.
 *
 * Клавиши (как в «Календаре» macOS), только пока вкладка на экране: T — сегодня, ←/→ — назад/вперёд,
 * D/W/M — день/неделя/месяц, N — новое событие. По физической клавише — работают и в русской раскладке.
 */

const NARROW = '(max-width: 640px)';
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

function rangeOf(view: View, anchor: Date): { from: Date; to: Date } {
  if (view === 'day') return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
  if (view === 'week') { const s = startOfWeek(anchor); return { from: s, to: addDays(s, 7) }; }
  const grid = monthGrid(anchor);
  return { from: grid[0], to: addDays(grid[grid.length - 1], 1) };
}

function titleOf(view: View, anchor: Date): { main: string; sub?: string } {
  if (view === 'month') return { main: MONTHS[anchor.getMonth()], sub: String(anchor.getFullYear()) };
  if (view === 'day') {
    return { main: `${anchor.getDate()} ${MONTHS_GEN[anchor.getMonth()]}`, sub: `${WEEKDAYS_FULL[weekdayIndex(anchor)]}, ${anchor.getFullYear()}` };
  }
  const s = startOfWeek(anchor);
  const e = addDays(s, 6);
  const main = s.getMonth() === e.getMonth() ? MONTHS[s.getMonth()] : `${MONTHS[s.getMonth()].slice(0, 3)} – ${MONTHS[e.getMonth()].slice(0, 3)}`;
  return { main, sub: String(e.getFullYear()) };
}

export default function CalendarScreen({ visible = true }: { visible?: boolean }) {
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);
  const viewPref = useCalendarUi((s) => s.view);
  // На телефоне недели нет: семь колонок по 50px не читаются.
  const view: View = narrow && viewPref === 'week' ? 'month' : viewPref;
  const anchor = useCalendarUi((s) => s.anchor);
  const selected = useCalendarUi((s) => s.selected);
  const editorOpen = useCalendarUi((s) => Boolean(s.editor));
  const [evMenu, setEvMenu] = useState<{ event: CalEvent; anchor: MenuAnchor } | null>(null);
  const showMenu = useCallback((event: CalEvent, at: { x: number; y: number }) => setEvMenu({ event, anchor: at }), []);
  const calendarEvents = useCalendar((s) => s.events);
  const systemEvents = useCalendar((s) => s.system);
  const showSystem = useCalendarUi((s) => s.showSystem);
  const phase = useCalendar((s) => s.phase);
  const tasks = useTasks((s) => s.tasks);
  useEffect(() => { void loadTasks(); }, []);

  const range = useMemo(() => rangeOf(view, anchor), [view, anchor]);
  const fromIso = localIso(range.from);
  const toIso = localIso(range.to);
  useEffect(() => { void loadRange(fromIso, toIso); }, [fromIso, toIso]);
  const events = useMemo(
    () => [...calendarEvents, ...(showSystem ? systemEvents : []), ...taskEvents(tasks, fromIso, toIso)].sort(byStart),
    [calendarEvents, systemEvents, showSystem, tasks, fromIso, toIso],
  );

  const step = useCallback((dir: number) => {
    const a = useCalendarUi.getState().anchor;
    const next = view === 'day' ? addDays(a, dir) : view === 'week' ? addDays(a, dir * 7) : new Date(a.getFullYear(), a.getMonth() + dir, 1);
    if (view === 'month') useCalendarUi.setState({ anchor: next, miniMonth: next });
    else pickDay(next);
  }, [view]);

  const openDay = useCallback((d: Date) => { pickDay(d); setView('day'); }, []);

  // ── Клавиши: только у вкладки на экране, иначе T и стрелки перехватывались бы в заметках ─────
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (editorOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('.wb-sidebar, .wb-panel, .wb-right'))) return;
      if (document.querySelector('#planner-overlays .nx-scrim, #planner-overlays .nx-menu')) return;
      const code = e.code;
      if (code === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (code === 'ArrowRight') { e.preventDefault(); step(1); } else if (code === 'KeyT') goToday();
      else if (code === 'KeyD') setView('day');
      else if (code === 'KeyW' && !narrow) setView('week');
      else if (code === 'KeyM') setView('month');
      else if (code === 'KeyN') { e.preventDefault(); createDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, editorOpen, step, narrow]);

  const title = titleOf(view, anchor);
  const days = view === 'day' ? [anchor] : view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)) : [];
  const empty = phase === 'error' && events.length === 0;

  return (
    <div className="ncal" data-layout="grid-only">
      <main className="ncal-main">
        <header className="ncal-bar">
          <h2 className="ncal-bar-title">
            <b>{title.main}</b>{title.sub && <span>{title.sub}</span>}
          </h2>
          <div className="ncal-nav">
            <button type="button" className="nx-icon-btn" onClick={() => step(-1)} aria-label="Назад" title="Назад (←)"><ChevronLeft size={17} /></button>
            <button type="button" className="nx-ghost ncal-today" onClick={goToday} title="Сегодня (T)">Сегодня</button>
            <button type="button" className="nx-icon-btn" onClick={() => step(1)} aria-label="Вперёд" title="Вперёд (→)"><ChevronRight size={17} /></button>
          </div>
          <div className="nx-segment ncal-views" role="group" aria-label="Вид">
            <button type="button" aria-pressed={view === 'day'} onClick={() => setView('day')} title="День (D)">День</button>
            {!narrow && <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')} title="Неделя (W)">Неделя</button>}
            <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')} title="Месяц (M)">Месяц</button>
          </div>
          <button type="button" className="nx-icon-btn ncal-system-toggle" aria-pressed={showSystem} onClick={() => setShowSystem(!showSystem)}
            title={showSystem ? 'Скрыть автоматизации MBOX (SEO Wizard)' : 'Показать автоматизации MBOX (SEO Wizard)'} aria-label="Автоматизации MBOX">
            <Zap size={16} aria-hidden="true" />
          </button>
          <button type="button" className="nx-primary ncal-new" onClick={createDefault} title="Новое событие (N)">
            <Plus size={15} aria-hidden="true" /> Событие
          </button>
        </header>

        {empty ? (
          <div className="nx-state" data-tone="danger" role="alert">
            <AlertCircle size={28} aria-hidden="true" />
            <h2>Не загрузил календарь</h2>
            <p>Сервер не ответил. Проверьте связь и повторите.</p>
            <button type="button" className="nx-ghost" onClick={() => void reload()}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
          </div>
        ) : view === 'month' ? (
          <div className="ncal-month-wrap" data-loading={phase === 'loading' ? 'true' : undefined}>
            <MonthView
              anchor={anchor}
              events={events}
              selected={selected}
              compact={narrow}
              onSelect={(d) => useCalendarUi.setState({ selected: startOfDay(d), miniMonth: startOfDay(new Date(d.getFullYear(), d.getMonth(), 1)) })}
              onOpenDay={narrow ? (d) => useCalendarUi.setState({ selected: startOfDay(d) }) : openDay}
              onCreate={(d) => createAt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9), undefined)}
              onOpen={openEvent}
              onMoveToDay={moveEventToDay}
              onMenu={showMenu}
              onDelete={(e) => void removeEvent(e)}
            />
            {narrow && (
              <div className="ncal-month-agenda nx-scroll-y">
                <DayAgenda day={selected} events={events} onOpen={openEvent} onCreate={createDefault} />
              </div>
            )}
          </div>
        ) : (
          <TimeGrid days={days} events={events} onCreate={createAt} onOpen={openEvent} onMove={(e, s, en) => void moveEvent(e, s, en)} onPickDay={openDay}
            onMenu={showMenu} onDelete={(e) => void removeEvent(e)} />
        )}
      </main>
      {evMenu && <EventMenu event={evMenu.event} anchor={evMenu.anchor} onClose={() => setEvMenu(null)} />}
    </div>
  );
}
