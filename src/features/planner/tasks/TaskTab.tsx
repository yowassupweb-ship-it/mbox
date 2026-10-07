import { useEffect } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { loadPeople } from '../people';
import { closeTaskTab, usePlannerNav } from '../nav';
import { loadTasks, useTasks } from './api';
import TaskDocument from './TaskDocument';

/** Название вкладки задачи — из общего стора задач; до загрузки — номер. */
export function taskTabTitle(taskId: string): string {
  const task = useTasks.getState().tasks[taskId];
  return task ? task.title || 'Без названия' : `Задача #${taskId}`;
}

/**
 * Вкладка задачи (task:<id>): документ задачи во всю ширину. Список, из которого её открыли, — в боковой панели;
 * пока вкладка на экране, задача подсвечена в списке.
 */
export function TaskTab({ taskId, visible }: { taskId: string; visible: boolean }) {
  const task = useTasks((s) => s.tasks[taskId]);
  const phase = useTasks((s) => s.phase);

  useEffect(() => { void loadPeople().then(() => loadTasks()); }, []);
  useEffect(() => {
    if (visible) usePlannerNav.setState({ activeTask: taskId });
    else if (usePlannerNav.getState().activeTask === taskId) usePlannerNav.setState({ activeTask: null });
  }, [visible, taskId]);
  useEffect(() => () => { if (usePlannerNav.getState().activeTask === taskId) usePlannerNav.setState({ activeTask: null }); }, [taskId]);

  if (!task) {
    return (
      <div className="ntd ntd-none">
        <div className="nx-state ntd-empty-state" data-tone={phase === 'ready' ? 'danger' : undefined}>
          {phase === 'ready' ? <AlertCircle size={28} aria-hidden="true" /> : <Loader2 size={24} className="nx-spin" aria-hidden="true" />}
          <h2>{phase === 'ready' ? 'Задачи нет' : 'Загружаю задачу'}</h2>
          {phase === 'ready' && <p>Её удалили или она выполнена давно и в «Дела» не попадает.</p>}
        </div>
      </div>
    );
  }
  return <TaskDocument key={task.id} task={task} onBack={() => closeTaskTab(taskId)} onGone={() => closeTaskTab(taskId)} />;
}
