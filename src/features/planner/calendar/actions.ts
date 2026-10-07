import { showToast } from '../ui/Toast';
import { askConfirm } from '../ui/overlay';
import { updateTask } from '../tasks/api';
import { openTask } from '../nav';
import { deleteEvent, updateEvent, type Scope } from './api';
import { askScope, newDraft } from './EventEditor';
import { addDays, addMinutes, dayIso, localIso, parseLocal, sameDay, startOfDay, type CalEvent } from './model';
import { openEventEditor, useCalendarUi } from './ui';

/** Действия над событиями — общие для сетки календаря и боковой панели «Дел». Задача в календаре ведёт в «Задачи». */

export function createAt(start: Date, end?: Date, allDay = false) {
  openEventEditor({ mode: 'new', draft: newDraft(start, end, allDay) });
}

/** Новое событие «от кнопки»: ближайший получас выбранного дня (сегодня — от текущего времени, иначе с 9:00). */
export function createDefault() {
  const { selected } = useCalendarUi.getState();
  const now = new Date();
  const base = sameDay(selected, now) ? now : new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 9);
  const start = new Date(base);
  start.setMinutes(Math.ceil(base.getMinutes() / 30) * 30, 0, 0);
  createAt(start, addMinutes(start, 60));
}

export function openEvent(e: CalEvent) {
  if (e.taskId) openTask(e.taskId);
  else openEventEditor({ mode: 'edit', event: e });
}

export async function moveEvent(e: CalEvent, start: Date, end: Date) {
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
}

export function moveEventToDay(e: CalEvent, day: Date) {
  const s = parseLocal(e.start);
  const shift = Math.round((startOfDay(day).getTime() - startOfDay(s).getTime()) / 86400000);
  if (!shift) return;
  void moveEvent(e, addDays(s, shift), addDays(parseLocal(e.end), shift));
}

/** Удалить: у серии — спросить, что именно; обычное — подтвердить. Задачу отсюда не удаляем. */
export async function removeEvent(e: CalEvent) {
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
}

/** Копия — редактор с теми же полями: дату и время можно поправить до сохранения. */
export function duplicateEvent(e: CalEvent) {
  openEventEditor({ mode: 'new', draft: {
    title: e.title, description: e.description, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
    color: e.color, reminderMinutesBefore: e.reminderMinutesBefore ?? null, recurrenceRule: null,
  } });
}

export function recolorEvent(e: CalEvent, color: string) {
  updateEvent(e, { color }, 'all').catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
}

export function toggleTaskDone(e: CalEvent) {
  if (!e.taskId) return;
  updateTask(e.taskId, { status: e.done ? 'open' : 'done' }).catch(() => showToast('Не сохранилось — нет связи с сервером.', 'error'));
}
