import { create } from '../lib';
import type { EditorState } from './EventEditor';
import { startOfDay, startOfMonth } from './model';

/**
 * Состояние календаря, общее для вкладки с сеткой и мини-месяца в боковой панели: какой вид, какая дата на экране,
 * какой день выбран, открыт ли редактор события. День, выбранный слева, сразу показывается в сетке справа.
 */

export type View = 'day' | 'week' | 'month';

const VIEW_KEY = 'mbox.planner.view';
function readView(): View {
  try { const v = localStorage.getItem(VIEW_KEY); return v === 'day' || v === 'week' || v === 'month' ? v : 'week'; } catch { return 'week'; }
}

type CalendarUi = {
  view: View; anchor: Date; selected: Date; miniMonth: Date; editor: EditorState | null;
  /** Показывать ли системные автоматизации (SEO Wizard) поверх событий. */
  showSystem: boolean;
  /** Что только что поменял агент: id событий и задач, подсвечиваются несколько секунд. */
  fresh: string[];
  /** Открытый лист системной автоматизации. */
  systemItem: import('./model').CalEvent | null;
};

const today = startOfDay(new Date());
const SYSTEM_KEY = 'mbox.planner.showSystem';
const readShowSystem = () => { try { return localStorage.getItem(SYSTEM_KEY) !== '0'; } catch { return true; } };

export const useCalendarUi = create<CalendarUi>(() => ({ view: readView(), anchor: today, selected: today, miniMonth: startOfMonth(today), editor: null, showSystem: readShowSystem(), fresh: [], systemItem: null }));

export function setShowSystem(showSystem: boolean) {
  useCalendarUi.setState({ showSystem });
  try { localStorage.setItem(SYSTEM_KEY, showSystem ? '1' : '0'); } catch { /* без памяти */ }
}

/** Подсветить то, что поменял агент: на несколько секунд, чтобы было видно, что и где он сделал. */
export function flash(ids: string[]) {
  if (!ids.length) return;
  useCalendarUi.setState((s) => ({ fresh: [...new Set([...s.fresh, ...ids])] }));
  window.setTimeout(() => useCalendarUi.setState((s) => ({ fresh: s.fresh.filter((id) => !ids.includes(id)) })), 6000);
}

export function setView(view: View) {
  useCalendarUi.setState({ view });
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* без памяти */ }
}

/** Выбрать день: он становится выбранным, сетка показывает его неделю (день, месяц), мини-месяц — его месяц. */
export function pickDay(day: Date) {
  const d = startOfDay(day);
  useCalendarUi.setState({ selected: d, anchor: d, miniMonth: startOfMonth(d) });
}

export const goToday = () => pickDay(new Date());
export const setMiniMonth = (month: Date) => useCalendarUi.setState({ miniMonth: startOfMonth(month) });
export const openEventEditor = (editor: EditorState) => useCalendarUi.setState({ editor });
export const closeEventEditor = () => useCalendarUi.setState({ editor: null });
