import { create, onPlannerChange, plannerFetch } from '../lib';
import { myId } from '../people';
import { showToast } from '../ui/Toast';

/**
 * Данные раздела «Задачи»: все задачи MBOX, к которым есть доступ, — задачи проектов (их же видят агенты и канбан)
 * и личные (без проекта, видны только хозяину). Список задачи = её проект или «Личные».
 * Текст задачи — markdown в note, срок/повтор/исполнители — в props (см. server/planner.mjs).
 */

export type Status = 'open' | 'next' | 'doing' | 'review' | 'done';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export interface Task {
  id: string;
  title: string;
  note: string;
  status: Status;
  priority: Priority;
  listId: string;
  dueDate: string | null;
  repeat: string | null;
  assignees: string[];
  automation: TaskAutomation | null;
  automationRun: AutomationRun | null;
  /** Агент, который сейчас держит задачу (claim), — видно, что над ней уже работают. */
  claimedBy: string;
  claimActive: boolean;
  createdAt: string;
  updatedAt: string;
  props: Record<string, unknown>;
}

/** Автоматизация задачи: в день срока (в `time`) агент получает задание с текстом задачи. */
export interface TaskAutomation { agent: string; prompt: string; time: string }
/** Последний запуск: дошло ли задание и был ли агент на связи (иначе оно ждёт, пока наблюдатель вернётся). */
export interface AutomationRun { due: string; fired_at: string; inbox_id: string | null; agent_online: boolean | null; error: string }

export interface TaskList { id: string; name: string; color?: string }

export const PERSONAL = 'personal';

/** Открытые статусы — группы списка, в этом порядке. Выполненные — отдельно, свёрнуты. */
export const STATUSES: { id: Status; label: string; tone: string }[] = [
  { id: 'doing', label: 'В работе', tone: 'var(--note-blue)' },
  { id: 'next', label: 'Следующие', tone: 'var(--note-purple)' },
  { id: 'open', label: 'Открытые', tone: 'var(--note-orange)' },
  { id: 'review', label: 'На проверке', tone: 'var(--note-green)' },
];
export const DONE_STATUS = { id: 'done' as Status, label: 'Выполнена', tone: 'var(--note-gray)' };
export const statusOf = (t: Task): Status => t.status;
export const isDone = (t: Task) => t.status === 'done';
export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: 'urgent', label: 'Срочно' },
  { id: 'high', label: 'Важно' },
  { id: 'normal', label: 'Обычная' },
  { id: 'low', label: 'Низкая' },
];
export const isImportant = (t: Task) => t.priority === 'urgent' || t.priority === 'high';

export { myId };

export const taskMarkdown = (t: Task): string => t.note || '';

/** Исполнители плюс агент, который держит задачу сейчас. */
export function assigneesOf(t: Task): string[] {
  const ids = [...t.assignees];
  if (t.claimActive && t.claimedBy) ids.push(`agent:${t.claimedBy}`);
  return Array.from(new Set(ids));
}

type Row = {
  id: string; list_id: string; title: string; note: string; status: string; priority: string;
  props: Record<string, unknown> | null; claimed_by: string; claim_active: boolean; created_at: string; updated_at: string;
  automation_run?: AutomationRun | null;
};

function parseAutomation(value: unknown): TaskAutomation | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.agent !== 'string' || typeof v.prompt !== 'string' || !v.agent || !v.prompt) return null;
  return { agent: v.agent, prompt: v.prompt, time: typeof v.time === 'string' ? v.time : '09:00' };
}

function fromRow(row: Row): Task {
  const props = row.props || {};
  return {
    id: String(row.id),
    title: row.title || '',
    note: row.note || '',
    status: (['open', 'next', 'doing', 'review', 'done'].includes(row.status) ? row.status : 'open') as Status,
    priority: (['urgent', 'high', 'normal', 'low'].includes(row.priority) ? row.priority : 'normal') as Priority,
    listId: String(row.list_id || PERSONAL),
    dueDate: typeof props.due === 'string' ? props.due.slice(0, 10) : null,
    repeat: typeof props.repeat === 'string' ? props.repeat : null,
    assignees: Array.isArray(props.assignees) ? props.assignees.map(String) : [],
    automation: parseAutomation(props.automation),
    automationRun: row.automation_run || null,
    claimedBy: row.claimed_by || '',
    claimActive: Boolean(row.claim_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    props,
  };
}

// ── Стор ────────────────────────────────────────────────────────────────────

interface State {
  tasks: Record<string, Task>;
  lists: TaskList[];
  phase: 'loading' | 'ready' | 'error';
}

const cacheKey = () => `mbox.planner.tasks:${myId()}`;

function readCache(): Pick<State, 'tasks' | 'lists'> | null {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const d = JSON.parse(raw) as { tasks: Task[]; lists: TaskList[] };
    return { tasks: Object.fromEntries(d.tasks.map((t) => [t.id, t])), lists: d.lists };
  } catch { return null; }
}

let cacheTimer = 0;
function writeCacheSoon() {
  window.clearTimeout(cacheTimer);
  cacheTimer = window.setTimeout(() => {
    const s = useTasks.getState();
    try { localStorage.setItem(cacheKey(), JSON.stringify({ tasks: Object.values(s.tasks), lists: s.lists })); } catch { /* переполнено — без кэша */ }
  }, 500);
}

export const useTasks = create<State>(() => ({ tasks: {}, lists: [], phase: 'loading' }));

let booted = false;
let inflight: Promise<void> | null = null;
/** Свои правки, которые ещё сохраняются: перечитывание с сервера их не перетирает. */
const dirty = new Set<string>();

/** Первая загрузка: сразу из кэша, затем с сервера. Повторные вызовы — один запрос. */
export function loadTasks(): Promise<void> {
  if (!booted) {
    booted = true;
    const cached = readCache();
    if (cached) useTasks.setState({ ...cached, phase: 'ready' });
    let timer = 0;
    // Задачи меняют и агенты, и канбан проектов — всё приходит событием «todos».
    onPlannerChange(['todos', 'projects'], () => { window.clearTimeout(timer); timer = window.setTimeout(() => void loadTasks(), 300); });
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const d = await plannerFetch<{ tasks: Row[]; lists: TaskList[] }>('/api/mbox/planner/tasks');
      const current = useTasks.getState().tasks;
      const tasks: Record<string, Task> = {};
      for (const row of d.tasks) {
        const t = fromRow(row);
        tasks[t.id] = dirty.has(t.id) && current[t.id] ? current[t.id] : t;
      }
      useTasks.setState({ tasks, lists: d.lists || [], phase: 'ready' });
      writeCacheSoon();
    } catch {
      useTasks.setState((s) => ({ phase: Object.keys(s.tasks).length ? 'ready' : 'error' }));
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function put(t: Task) {
  useTasks.setState((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
  writeCacheSoon();
}

// ── Запись ──────────────────────────────────────────────────────────────────

/** Поля задачи → тело запроса сервера. В props уходят только изменённые ключи; null — удалить. */
function toBody(patch: Partial<Task>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.note !== undefined) body.note = patch.note;
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.priority !== undefined) body.priority = patch.priority;
  if (patch.listId !== undefined) body.list_id = patch.listId;
  const props: Record<string, unknown> = {};
  if (patch.dueDate !== undefined) props.due = patch.dueDate ? patch.dueDate.slice(0, 10) : null;
  if (patch.repeat !== undefined) props.repeat = patch.repeat && patch.repeat !== 'none' ? patch.repeat : null;
  if (patch.assignees !== undefined) props.assignees = patch.assignees.length ? patch.assignees : null;
  if (patch.automation !== undefined) props.automation = patch.automation;
  if (Object.keys(props).length) body.props = props;
  return body;
}

export async function createTask(init: Partial<Task> = {}): Promise<Task> {
  const { task } = await plannerFetch<{ task: Row }>('/api/mbox/planner/tasks', {
    method: 'POST',
    body: JSON.stringify({ ...toBody({ status: 'open', priority: 'normal', ...init }), list_id: init.listId || PERSONAL }),
  });
  const t = fromRow(task);
  put(t);
  return t;
}

const dayLabel = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

/** Правка полей: сразу в стор, затем на сервер. Ошибка — откат и исключение. */
export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  const before = useTasks.getState().tasks[id];
  if (!before) return;
  put({ ...before, ...patch, updatedAt: new Date().toISOString() });
  dirty.add(id);
  try {
    const { task, rolled } = await plannerFetch<{ task: Row; rolled: { from: string; to: string } | null }>(`/api/mbox/planner/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(toBody(patch)),
    });
    put(fromRow(task));
    // Повторяющаяся задача не закрылась, а уехала на следующий срок — скажем, куда.
    if (rolled) showToast(`Повторится ${dayLabel.format(new Date(`${rolled.to}T12:00:00`))}`, 'success');
  } catch (e) {
    put(before);
    throw e;
  } finally {
    dirty.delete(id);
  }
}

/** Текст задачи: заголовок — первая строка документа, дальше markdown. */
export function saveText(id: string, title: string, md: string): Promise<void> {
  return updateTask(id, { title, note: md });
}

export async function deleteTask(id: string): Promise<void> {
  const before = useTasks.getState().tasks[id];
  useTasks.setState((s) => { const next = { ...s.tasks }; delete next[id]; return { tasks: next }; });
  try {
    await plannerFetch(`/api/mbox/planner/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    if (before) put(before);
    throw e;
  }
  writeCacheSoon();
}
