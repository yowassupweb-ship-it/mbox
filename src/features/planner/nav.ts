import { create } from './lib';

/**
 * Навигация раздела «Задачи»: задачи и календарь — одна сущность, части которой живут в разных местах рабочего места
 * (список и мини-месяц — в боковой панели, документ задачи и сетка — вкладками). Workbench регистрирует,
 * как открыть вкладку и боковую панель; экраны планировщика вызывают это, не зная про Workbench.
 */

export type PlannerMode = 'tasks' | 'calendar';
/** Как открыть задачу: заменить текущую вкладку-превью (обычный клик), новой вкладкой или во второй области. */
export type OpenHow = 'replace' | 'tab' | 'split';

type Navigator = {
  openTask: (taskId: string, how?: OpenHow) => void;
  openCalendar: () => void;
  showSidebar: (mode: PlannerMode) => void;
  closeTask: (taskId: string) => void;
  pinTask: (taskId: string) => void;
};

let navigator: Navigator = {
  openTask: () => {},
  openCalendar: () => {},
  showSidebar: () => {},
  closeTask: () => {},
  pinTask: () => {},
};

export function setPlannerNavigator(next: Navigator) { navigator = next; }

export const openTask = (taskId: string, how: OpenHow = 'replace') => navigator.openTask(taskId, how);
export const openCalendar = () => navigator.openCalendar();
export const showPlannerSidebar = (mode: PlannerMode) => navigator.showSidebar(mode);
export const closeTaskTab = (taskId: string) => navigator.closeTask(taskId);
/** Задачу начали править — вкладка-превью закрепляется, следующий клик в списке её не заменит. */
export const pinTaskTab = (taskId: string) => navigator.pinTask(taskId);

const MODE_KEY = 'mbox.planner.mode';
const readMode = (): PlannerMode => { try { return localStorage.getItem(MODE_KEY) === 'calendar' ? 'calendar' : 'tasks'; } catch { return 'tasks'; } };

/** Режим боковой панели «Задачи» и задача, открытая сейчас (подсвечивается в списке). */
export const usePlannerNav = create<{ mode: PlannerMode; activeTask: string | null }>(() => ({ mode: readMode(), activeTask: null }));

export function setPlannerMode(mode: PlannerMode) {
  usePlannerNav.setState({ mode });
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* без памяти */ }
}
