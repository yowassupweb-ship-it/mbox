import type { Task } from './api';

/**
 * Повтор задачи. Задача одна: когда её выполняют, сервер не закрывает её, а переносит срок на следующий раз
 * (server/planner.mjs, nextDue). В календаре повторяющаяся задача видна на своём сроке, как любая задача со сроком.
 */

export const TASK_REPEATS: { id: string; label: string }[] = [
  { id: 'none', label: 'Не повторять' },
  { id: 'daily', label: 'Каждый день' },
  { id: 'weekdays', label: 'По будням' },
  { id: 'weekly', label: 'Каждую неделю' },
  { id: 'monthly', label: 'Каждый месяц' },
  { id: 'yearly', label: 'Каждый год' },
];

export const repeatIdOf = (t: Task) => t.repeat || 'none';
export const repeatLabel = (id: string) => TASK_REPEATS.find((r) => r.id === id)?.label || 'Повтор';
