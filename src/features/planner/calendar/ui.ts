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

type CalendarUi = { view: View; anchor: Date; selected: Date; miniMonth: Date; editor: EditorState | null };

const today = startOfDay(new Date());
export const useCalendarUi = create<CalendarUi>(() => ({ view: readView(), anchor: today, selected: today, miniMonth: startOfMonth(today), editor: null }));

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
