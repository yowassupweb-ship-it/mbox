import { create, onPlannerChange, plannerFetch } from '../lib';
import { isDone, type Task } from '../tasks/api';
import { byStart, localIso, normalize, normalizeSystem, parseLocal, rowId, type Automation, type CalEvent } from './model';

/**
 * Данные календаря: события видимого диапазона (личный календарь, calendar_events).
 *
 * Сервер разворачивает повторы сам (/api/mbox/planner/events с диапазоном), поэтому держим ровно то, что на экране,
 * и перечитываем диапазон после каждой записи. Правка сразу видна (оптимистично), ошибка — откат.
 * Живое обновление — без опроса: событие calendar_events по сокету MBOX, после переподключения — перечитать.
 */

export type Phase = 'idle' | 'loading' | 'ready' | 'error';
export type Scope = 'this' | 'following' | 'all';

interface State {
  events: CalEvent[];
  /** Системные автоматизации MBOX в том же диапазоне (SEO Wizard): только чтение. */
  system: CalEvent[];
  range: { from: string; to: string } | null;
  phase: Phase;
}

export const useCalendar = create<State>(() => ({ events: [], system: [], range: null, phase: 'idle' }));

// ── Кэш: последний диапазон показывается мгновенно ──────────────────────────

const CACHE_KEY = 'mbox.planner.calendar';

function readCache(from: string, to: string): CalEvent[] | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as { from: string; to: string; events: CalEvent[] } | null;
    return c && c.from === from && c.to === to ? c.events : null;
  } catch { return null; }
}
function writeCache(from: string, to: string, events: CalEvent[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ from, to, events })); } catch { /* переполнено — без кэша */ }
}

// ── Чтение ──────────────────────────────────────────────────────────────────

let seq = 0;

export async function loadRange(from: string, to: string): Promise<void> {
  const cur = useCalendar.getState();
  const sameRange = cur.range?.from === from && cur.range?.to === to;
  if (!sameRange) {
    const cached = readCache(from, to);
    useCalendar.setState({ range: { from, to }, events: cached || [], phase: cached ? 'ready' : 'loading' });
  }
  listen();
  const mine = ++seq;
  try {
    const qs = new URLSearchParams({ from, to });
    const [data, automations] = await Promise.all([
      plannerFetch<{ events?: Record<string, unknown>[] }>(`/api/mbox/planner/events?${qs}`),
      plannerFetch<{ items?: Record<string, unknown>[] }>(`/api/mbox/planner/automations?${qs}`).catch(() => ({ items: [] })),
    ]);
    if (mine !== seq) return; // пока ждали, перешли на другой диапазон
    const events = (data.events || []).map(normalize).filter((e): e is CalEvent => Boolean(e)).sort(byStart);
    const system = (automations.items || []).map(normalizeSystem).filter((e): e is CalEvent => Boolean(e));
    useCalendar.setState({ events, system, phase: 'ready' });
    writeCache(from, to, events);
  } catch {
    if (mine === seq) useCalendar.setState((s) => ({ phase: s.events.length ? 'ready' : 'error' }));
  }
}

export function reload(): Promise<void> {
  const r = useCalendar.getState().range;
  return r ? loadRange(r.from, r.to) : Promise.resolve();
}

let reloadTimer: number | null = null;
function reloadSoon() {
  if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => { reloadTimer = null; void reload(); }, 250);
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onPlannerChange(['calendar_events'], reloadSoon);
}

// ── Задачи со сроком — слой поверх событий ──────────────────────────────────

/** Задача со сроком в диапазоне → «событие на весь день»: видно в сетке, открывается в «Задачах». */
export function taskEvents(tasks: Record<string, Task>, from: string, to: string): CalEvent[] {
  const start = from.slice(0, 10);
  const end = to.slice(0, 10);
  return Object.values(tasks)
    .filter((t) => t.dueDate && t.dueDate >= start && t.dueDate < end)
    .map((t) => ({
      id: `task:${t.id}`,
      taskId: t.id,
      done: isDone(t),
      title: t.title || 'Задача без названия',
      start: `${t.dueDate}T00:00:00`,
      end: `${t.dueDate}T00:00:00`,
      allDay: true,
      color: isDone(t) ? 'gray' : t.priority === 'urgent' || t.priority === 'high' ? 'red' : 'green',
      recurrenceRule: null,
    }));
}

// ── Запись ──────────────────────────────────────────────────────────────────

export interface Draft {
  title: string;
  description?: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  color?: string;
  reminderMinutesBefore?: number | null;
  recurrenceRule?: string | null;
  automation?: Automation | null;
}

/** Поля для сервера (server/planner.mjs, eventFields). */
function body(d: Partial<Draft>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d.title !== undefined) out.title = d.title;
  if (d.description !== undefined) out.description = d.description || '';
  if (d.start !== undefined) out.start = d.start;
  if (d.end !== undefined) out.end = d.end;
  if (d.allDay !== undefined) out.all_day = d.allDay;
  if (d.location !== undefined) out.location = d.location || '';
  if (d.color !== undefined) out.color = d.color;
  if (d.reminderMinutesBefore !== undefined) out.reminder_minutes = d.reminderMinutesBefore;
  if (d.recurrenceRule !== undefined) out.recurrence_rule = d.recurrenceRule;
  if (d.automation !== undefined) out.automation = d.automation;
  return out;
}

function replaceLocal(fn: (list: CalEvent[]) => CalEvent[]) {
  useCalendar.setState((s) => ({ events: fn(s.events).sort(byStart) }));
}

export async function createEvent(d: Draft): Promise<void> {
  const local: CalEvent = { ...d, id: `new:${Date.now()}` };
  const before = useCalendar.getState().events;
  replaceLocal((list) => [...list, local]);
  try {
    await plannerFetch('/api/mbox/planner/events', { method: 'POST', body: JSON.stringify(body(d)) });
  } catch (e) {
    useCalendar.setState({ events: before });
    throw e;
  }
  void reload();
}

export async function updateEvent(e: CalEvent, patch: Partial<Draft>, scope: Scope = 'all'): Promise<void> {
  const before = useCalendar.getState().events;
  replaceLocal((list) => list.map((x) => (x.id === e.id ? { ...x, ...patch } : x)));
  try {
    const recurring = Boolean(e.masterId);
    let fields = patch;
    // Серия целиком: новое время повторения — это сдвиг начала серии на ту же разницу,
    // а не новое начало (иначе серия начиналась бы с этого повторения).
    if (recurring && scope === 'all' && (patch.start || patch.end)) {
      const { event } = await plannerFetch<{ event: Record<string, unknown> }>(`/api/mbox/planner/events/${encodeURIComponent(rowId(e))}`);
      const master = normalize(event);
      if (master) {
        const shift = (iso: string | undefined, from: string, base: string) =>
          (iso ? localIso(new Date(parseLocal(base).getTime() + (parseLocal(iso).getTime() - parseLocal(from).getTime()))) : undefined);
        fields = {
          ...patch,
          ...(patch.start ? { start: shift(patch.start, e.start, master.start) } : {}),
          ...(patch.end ? { end: shift(patch.end, e.end, master.end) } : {}),
        };
      }
    }
    await plannerFetch(`/api/mbox/planner/events/${encodeURIComponent(rowId(e))}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...body(fields), ...(recurring && scope !== 'all' ? { scope, recurrence_id: e.recurrenceId } : {}) }),
    });
  } catch (err) {
    useCalendar.setState({ events: before });
    throw err;
  }
  void reload();
}

export async function deleteEvent(e: CalEvent, scope: Scope = 'all'): Promise<void> {
  const before = useCalendar.getState().events;
  const series = rowId(e);
  replaceLocal((list) => list.filter((x) => (scope === 'this' ? x.id !== e.id : rowId(x) !== series)));
  try {
    const qs = new URLSearchParams({ scope: e.masterId ? scope : 'all' });
    if (e.masterId && e.recurrenceId) qs.set('recurrence_id', e.recurrenceId);
    await plannerFetch(`/api/mbox/planner/events/${encodeURIComponent(series)}?${qs}`, { method: 'DELETE' });
  } catch (err) {
    useCalendar.setState({ events: before });
    throw err;
  }
  void reload();
}
