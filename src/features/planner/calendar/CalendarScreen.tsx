import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, CircleCheck, Copy, ExternalLink, Pencil, Plus, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { showToast } from '../ui/Toast';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '../ui/overlay';
import { loadTasks, updateTask, useTasks } from '../tasks/api';
import { deleteEvent, loadRange, reload, taskEvents, updateEvent, useCalendar, type Scope } from './api';
import EventEditor, { askScope, newDraft, type EditorState } from './EventEditor';
import { DayAgenda, MiniMonth, MonthView } from './MonthViews';
import TimeGrid from './TimeGrid';
import {
  addDays, addMinutes, byStart, COLORS, colorVar, dayIso, localIso, monthGrid, MONTHS, MONTHS_GEN, parseLocal, sameDay, startOfDay,
  startOfMonth, startOfWeek, weekdayIndex, WEEKDAYS_FULL, type CalEvent,
} from './model';

/**
 * Раздел «Календарь» (перенесён из shar-2). Календарь личный; поверх событий — задачи со сроком
 * (из «Задач»): клик открывает задачу, перетаскивание на другой день переносит срок.
 *
 * Клавиши (как в «Календаре» macOS): T — сегодня, ←/→ — назад/вперёд,
 * D/W/M — день/неделя/месяц, N — новое событие. Считаются по физической
 * клавише, поэтому работают и в русской раскладке.
 */

type View = 'day' | 'week' | 'month';

const NARROW = '(max-width: 640px)';
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const subscribeNoop = () => () => {};

const VIEW_KEY = 'nxcal:view';
function readView(): View {
  try { const v = localStorage.getItem(VIEW_KEY); return v === 'day' || v === 'week' || v === 'month' ? v : 'week'; } catch { return 'week'; }
}

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

export default function CalendarScreen({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);
  const [viewPref, setViewPref] = useState<View>(readView);
  // На телефоне недели нет: семь колонок по 50px не читаются.
  const view: View = narrow && viewPref === 'week' ? 'month' : viewPref;
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [miniMonth, setMiniMonth] = useState(() => startOfMonth(new Date()));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [evMenu, setEvMenu] = useState<{ event: CalEvent; anchor: MenuAnchor } | null>(null);
  const showMenu = useCallback((event: CalEvent, at: { x: number; y: number }) => setEvMenu({ event, anchor: at }), []);
  const calendarEvents = useCalendar((s) => s.events);
  const phase = useCalendar((s) => s.phase);
  const tasks = useTasks((s) => s.tasks);
  useEffect(() => { void loadTasks(); }, []);

  const setView = useCallback((v: View) => {
    setViewPref(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ }
  }, []);

  const range = useMemo(() => rangeOf(view, anchor), [view, anchor]);
  const fromIso = localIso(range.from);
  const toIso = localIso(range.to);
  useEffect(() => { void loadRange(fromIso, toIso); }, [fromIso, toIso]);
  const events = useMemo(() => [...calendarEvents, ...taskEvents(tasks, fromIso, toIso)].sort(byStart), [calendarEvents, tasks, fromIso, toIso]);

  const goToday = useCallback(() => {
    const t = startOfDay(new Date());
    setAnchor(t); setSelected(t); setMiniMonth(startOfMonth(t));
  }, []);

  const step = useCallback((dir: number) => {
    setAnchor((a) => {
      const next = view === 'day' ? addDays(a, dir) : view === 'week' ? addDays(a, dir * 7) : new Date(a.getFullYear(), a.getMonth() + dir, 1);
      setMiniMonth(startOfMonth(next));
      if (view !== 'month') setSelected(next);
      return next;
    });
  }, [view]);

  const pickDay = useCallback((d: Date) => {
    const day = startOfDay(d);
    setSelected(day);
    setAnchor(day);
    setMiniMonth(startOfMonth(day));
  }, []);

  const openDay = useCallback((d: Date) => { pickDay(d); setView('day'); }, [pickDay, setView]);

  const createAt = useCallback((start: Date, end?: Date, allDay = false) => {
    setEditor({ mode: 'new', draft: newDraft(start, end, allDay) });
  }, []);

  /** Новое событие «от кнопки»: ближайший получас выбранного дня. */
  const createDefault = useCallback(() => {
    const now = new Date();
    const base = sameDay(selected, now) ? now : new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 9);
    const start = new Date(base);
    start.setMinutes(Math.ceil(base.getMinutes() / 30) * 30, 0, 0);
    createAt(start, addMinutes(start, 60));
  }, [selected, createAt]);

  const openEvent = useCallback((e: CalEvent) => {
    if (e.taskId) onOpenTask(e.taskId);
    else setEditor({ mode: 'edit', event: e });
  }, [onOpenTask]);

  const move = useCallback(async (e: CalEvent, start: Date, end: Date) => {
    if (e.taskId) {
      updateTask(e.taskId, { dueDate: dayIso(start) }).catch(() => showToast('Срок не перенёсся — нет связи с сервером.', 'error'));
      return;
    }
    let scope: Scope = 'all';
    if (e.masterId) {
      const picked = await askScope('edit');
      if (!picked) return;
      scope = picked;
    }
    try {
      await updateEvent(e, { start: localIso(start), end: localIso(end) }, scope);
    } catch {
      showToast('Не перенеслось — нет связи с сервером.', 'error');
    }
  }, []);

  /** Удалить: у серии — спросить, что именно; обычное — подтвердить. */
  const removeEvent = useCallback(async (e: CalEvent) => {
    if (e.taskId) return;
    let scope: Scope = 'all';
    if (e.masterId) {
      const picked = await askScope('delete');
      if (!picked) return;
      scope = picked;
    } else if (!await askConfirm({ title: `Удалить «${e.title || 'Без названия'}»?`, confirm: 'Удалить', tone: 'danger' })) {
      return;
    }
    try { await deleteEvent(e, scope); } catch { showToast('Не удалилось — нет связи с сервером.', 'error'); }
  }, []);

  /** Копия — редактор с теми же полями: дату и время можно поправить до сохранения. */
  const duplicate = useCallback((e: CalEvent) => {
    setEditor({ mode: 'new', draft: {
      title: e.title, description: e.description, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
      color: e.color, reminderMinutesBefore: e.reminderMinutesBefore ?? null, recurrenceRule: null,
    } });
  }, []);

  const recolor = useCallback((e: CalEvent, color: string) => {
    updateEvent(e, { color }, 'all').catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
  }, []);

  const moveToDay = useCallback((e: CalEvent, day: Date) => {
    const s = parseLocal(e.start);
    const shift = Math.round((startOfDay(day).getTime() - startOfDay(s).getTime()) / 86400000);
    if (!shift) return;
    void move(e, addDays(s, shift), addDays(parseLocal(e.end), shift));
  }, [move]);

  // ── Клавиши ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editor || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('.nx-scrim, .nx-menu')) return;
      const code = e.code;
      if (code === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (code === 'ArrowRight') { e.preventDefault(); step(1); } else if (code === 'KeyT') goToday();
      else if (code === 'KeyD') setView('day');
      else if (code === 'KeyW' && !narrow) setView('week');
      else if (code === 'KeyM') setView('month');
      else if (code === 'KeyN') { e.preventDefault(); createDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, step, goToday, setView, createDefault, narrow]);

  if (!mounted) return null;

  const title = titleOf(view, anchor);
  const days = view === 'day' ? [anchor] : view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)) : [];
  const empty = phase === 'error' && events.length === 0;

  return (
    <div className="ncal" data-narrow={narrow ? 'true' : undefined}>
      {!narrow && (
        <aside className="ncal-side" aria-label="Обзор">
          <div className="ncal-side-head">
            <h1>Календарь</h1>
            <button type="button" className="nx-primary ncal-new" onClick={createDefault} title="Новое событие (N)">
              <Plus size={15} aria-hidden="true" /> Событие
            </button>
          </div>
          <MiniMonth month={miniMonth} selected={selected} events={events} onMonth={setMiniMonth} onPick={pickDay} />
          <div className="ncal-side-agenda nx-scroll-y">
            <DayAgenda day={selected} events={events} onOpen={openEvent} onCreate={createDefault} onMenu={showMenu} />
          </div>
        </aside>
      )}

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
          {narrow && (
            <button type="button" className="nx-primary-round" onClick={createDefault} aria-label="Новое событие"><Plus size={18} /></button>
          )}
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
              onSelect={(d) => { setSelected(startOfDay(d)); setMiniMonth(startOfMonth(d)); }}
              onOpenDay={narrow ? (d) => setSelected(startOfDay(d)) : openDay}
              onCreate={(d) => createAt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9), undefined)}
              onOpen={openEvent}
              onMoveToDay={moveToDay}
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
          <TimeGrid days={days} events={events} onCreate={createAt} onOpen={openEvent} onMove={(e, s, en) => void move(e, s, en)} onPickDay={openDay}
            onMenu={showMenu} onDelete={(e) => void removeEvent(e)} />
        )}
      </main>

      {editor && <EventEditor key={editor.mode === 'edit' ? editor.event.id : dayIso(parseLocal(editor.draft.start))} state={editor} onClose={() => setEditor(null)} />}
      {evMenu && (() => {
        const e = evMenu.event;
        const close = () => setEvMenu(null);
        if (e.taskId) {
          const taskId = e.taskId;
          return (
            <Menu anchor={evMenu.anchor} label={e.title || 'Задача'} onClose={close}>
              <MenuItem icon={<ExternalLink size={16} />} onSelect={() => { close(); onOpenTask(taskId); }}>Открыть задачу</MenuItem>
              <MenuItem icon={e.done ? <RotateCcw size={16} /> : <CircleCheck size={16} />} onSelect={() => {
                close();
                updateTask(taskId, { status: e.done ? 'open' : 'done' }).catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
              }}>{e.done ? 'Вернуть в работу' : 'Отметить выполненной'}</MenuItem>
            </Menu>
          );
        }
        return (
          <Menu anchor={evMenu.anchor} label={e.title || 'Событие'} onClose={close}>
            <MenuItem icon={<Pencil size={16} />} onSelect={() => { close(); openEvent(e); }}>Открыть</MenuItem>
            <MenuItem icon={<Copy size={16} />} onSelect={() => { close(); duplicate(e); }}>Дублировать…</MenuItem>
            <div className="nx-menu-sep" />
            <div className="ncal-menu-colors" role="group" aria-label="Цвет">
              {COLORS.map((c) => (
                <button key={c.id} type="button" className="ncal-swatch" aria-label={c.label} title={c.label}
                  aria-checked={(e.color || 'blue') === c.id} role="radio"
                  style={{ '--ev': colorVar(c.id) } as React.CSSProperties}
                  onClick={() => { close(); recolor(e, c.id); }} />
              ))}
            </div>
            <div className="nx-menu-sep" />
            <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { close(); void removeEvent(e); }}>Удалить</MenuItem>
          </Menu>
        );
      })()}
    </div>
  );
}
