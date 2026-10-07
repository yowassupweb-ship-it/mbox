import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ENTITY_CHANGED_EVENT } from "../../../hooks/useRealtime";
import { plannerRequest, type PersonalTask } from "../api";
import "./tasks.css";

const EMPTY = { title: "", description: "", due_at: "", recurrence_rule: "" };

export function TasksPanel() {
  const [tasks, setTasks] = useState<PersonalTask[]>([]);
  const [draft, setDraft] = useState(EMPTY);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => plannerRequest<{ tasks: PersonalTask[] }>("/api/mbox/personal-tasks").then((data) => setTasks(data.tasks)), []);
  useEffect(() => { void load(); const changed = (event: Event) => { if (!(event as CustomEvent).detail || (event as CustomEvent).detail === "personal_tasks") void load(); }; window.addEventListener(ENTITY_CHANGED_EVENT, changed); return () => window.removeEventListener(ENTITY_CHANGED_EVENT, changed); }, [load]);
  async function add() { if (!draft.title.trim()) return; await plannerRequest("/api/mbox/personal-tasks", { method: "POST", body: JSON.stringify(draft) }); setDraft(EMPTY); setEditing(false); await load(); }
  async function update(task: PersonalTask, patch: Partial<PersonalTask>) { await plannerRequest(`/api/mbox/personal-tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ ...task, ...patch, completed: patch.completed_at !== undefined ? Boolean(patch.completed_at) : Boolean(task.completed_at) }) }); await load(); }
  async function remove(id: string) { await plannerRequest(`/api/mbox/personal-tasks/${id}`, { method: "DELETE" }); await load(); }
  return <section className="planner tasks-panel" aria-label="Личные задачи">
    <header className="planner-toolbar"><strong>Личные задачи</strong><button type="button" onClick={() => setEditing((v) => !v)}><Plus size={16} /> Новая задача</button></header>
    {editing && <div className="planner-editor"><input autoFocus placeholder="Название" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /><textarea placeholder="Описание" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /><div><input type="datetime-local" aria-label="Срок" value={draft.due_at} onChange={(e) => setDraft({ ...draft, due_at: e.target.value })} /><select aria-label="Повтор" value={draft.recurrence_rule} onChange={(e) => setDraft({ ...draft, recurrence_rule: e.target.value })}><option value="">Не повторять</option><option value="FREQ=DAILY">Каждый день</option><option value="FREQ=WEEKLY">Каждую неделю</option><option value="FREQ=MONTHLY">Каждый месяц</option></select><button type="button" onClick={() => void add()}>Добавить</button></div></div>}
    <ul className="task-list">{tasks.map((task) => <li key={task.id} className={task.completed_at ? "is-done" : ""}><input type="checkbox" checked={Boolean(task.completed_at)} onChange={() => void update(task, { completed_at: task.completed_at ? null : new Date().toISOString() })} aria-label={`Готово: ${task.title}`} /><div><b>{task.title}</b>{task.description && <p>{task.description}</p>}{task.due_at && <time>{new Date(task.due_at).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}</time>}</div><button type="button" className="planner-icon" onClick={() => void remove(task.id)} aria-label={`Удалить: ${task.title}`}><Trash2 size={16} /></button></li>)}</ul>
    {!tasks.length && <p className="planner-empty">Личных задач пока нет</p>}
  </section>;
}
