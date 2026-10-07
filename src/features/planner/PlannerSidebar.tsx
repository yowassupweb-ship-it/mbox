import { useMemo } from 'react';
import { CalendarDays, ListChecks } from 'lucide-react';
import { CalendarSide } from './calendar/CalendarSide';
import { isDone, useTasks } from './tasks/api';
import { TaskList } from './tasks/TaskList';
import { openCalendar, setPlannerMode, usePlannerNav, type PlannerMode } from './nav';

/**
 * Боковая панель «Дел»: задачи и календарь — одна сущность с двумя видами, как «Таблицы | Документы».
 * «Задачи» — список всех задач (личные и проектов), «Календарь» — мини-месяц и выбранный день, где события
 * и задачи со сроком вместе. Документ задачи и сетка календаря открываются вкладками.
 */
export function PlannerSidebar() {
  const mode = usePlannerNav((s) => s.mode);
  const tasks = useTasks((s) => s.tasks);
  const openCount = useMemo(() => Object.values(tasks).filter((t) => !isDone(t)).length, [tasks]);
  const pick = (next: PlannerMode) => {
    setPlannerMode(next);
    if (next === 'calendar') openCalendar();
  };
  const items: Array<{ id: PlannerMode; label: string; icon: typeof ListChecks }> = [
    { id: 'tasks', label: 'Задачи', icon: ListChecks },
    { id: 'calendar', label: 'Календарь', icon: CalendarDays },
  ];
  return (
    <div className="wb-view wb-planner-view">
      <header className="wb-view-head">
        <span>Дела</span>
      </header>
      <div
        className="wb-mode-tabs"
        role="tablist"
        aria-label="Вид"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          pick(mode === 'tasks' ? 'calendar' : 'tasks');
        }}
      >
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id} tabIndex={mode === id ? 0 : -1} className={mode === id ? 'is-on' : undefined} onClick={() => pick(id)}>
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
            {id === 'tasks' && openCount > 0 && <b>{openCount}</b>}
          </button>
        ))}
      </div>
      <div className="nx wb-planner-body">
        {mode === 'tasks' ? <TaskList /> : <div className="nx-scroll-y wb-planner-scroll"><CalendarSide /></div>}
      </div>
    </div>
  );
}
