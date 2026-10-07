import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { ENTITY_CHANGED_EVENT } from "../../../hooks/useRealtime";
import { plannerRequest, type CalendarEvent, type PersonalTask } from "../api";
import { addDays, dayKey, localIso, parseLocal, weekDays } from "./model";
import "./calendar.css";
import "./task-layer.css";

type View = "week" | "list";
const blank = () => { const start = new Date(); start.setMinutes(0, 0, 0); const end = new Date(start.getTime() + 3600000); return { title: "", description: "", starts_at: localIso(start).slice(0, 16), ends_at: localIso(end).slice(0, 16), all_day: false, location: "", color: "blue", reminder_minutes: null as number | null, recurrence_rule: "" }; };

export function CalendarPanel() {
  const [anchor, setAnchor] = useState(new Date());
  const [view, setView] = useState<View>("week");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [tasks, setTasks] = useState<PersonalTask[]>([]);
  const [showTasks, setShowTasks] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(blank);
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const load = useCallback(async () => { const from = localIso(days[0]); const to = localIso(addDays(days[6], 1)); const [calendar, personal] = await Promise.all([plannerRequest<{ events: CalendarEvent[] }>(`/api/mbox/calendar-events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), plannerRequest<{ tasks: PersonalTask[] }>("/api/mbox/personal-tasks")]); setEvents(calendar.events); setTasks(personal.tasks); }, [days]);
  useEffect(() => { void load(); const changed = (event: Event) => { const entity = (event as CustomEvent).detail; if (!entity || entity === "calendar_events" || entity === "personal_tasks") void load(); }; window.addEventListener(ENTITY_CHANGED_EVENT, changed); return () => window.removeEventListener(ENTITY_CHANGED_EVENT, changed); }, [load]);
  async function add() { if (!draft.title.trim()) return; await plannerRequest("/api/mbox/calendar-events", { method: "POST", body: JSON.stringify(draft) }); setDraft(blank()); setEditing(false); await load(); }
  async function remove(event: CalendarEvent) { if (event.id.startsWith("task-")) return; await plannerRequest(`/api/mbox/calendar-events/${event.master_id || event.id.split("::")[0]}`, { method: "DELETE" }); await load(); }
  const taskEvents: CalendarEvent[] = showTasks ? tasks.filter((task) => task.due_at && !task.completed_at).map((task) => ({ id: `task-${task.id}`, title: task.title, description: task.description, starts_at: task.due_at!, ends_at: task.due_at!, all_day: false, location: "Личная задача", color: "green", reminder_minutes: null, recurrence_rule: task.recurrence_rule })) : [];
  const sorted = [...events, ...taskEvents].sort((a, b) => parseLocal(a.starts_at).getTime() - parseLocal(b.starts_at).getTime());
  return <section className="planner calendar-panel" aria-label="Календарь">
    <label className="calendar-layer"><input type="checkbox" checked={showTasks} onChange={(event) => setShowTasks(event.target.checked)} /> Задачи со сроком</label>
    <header className="planner-toolbar calendar-toolbar"><strong>Календарь</strong><div><button type="button" className={view === "week" ? "is-active" : ""} onClick={() => setView("week")}>Неделя</button><button type="button" className={view === "list" ? "is-active" : ""} onClick={() => setView("list")}>Список</button><button type="button" onClick={() => setAnchor(addDays(anchor, -7))} aria-label="Предыдущая неделя"><ChevronLeft size={16} /></button><button type="button" onClick={() => setAnchor(new Date())}>Сегодня</button><button type="button" onClick={() => setAnchor(addDays(anchor, 7))} aria-label="Следующая неделя"><ChevronRight size={16} /></button><button type="button" onClick={() => setEditing((v) => !v)}><Plus size={16} /> Событие</button></div></header>
    {editing && <div className="planner-editor calendar-editor"><input autoFocus placeholder="Название" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /><textarea placeholder="Описание" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /><div><input type="datetime-local" aria-label="Начало" value={draft.starts_at} onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })} /><input type="datetime-local" aria-label="Конец" value={draft.ends_at} onChange={(e) => setDraft({ ...draft, ends_at: e.target.value })} /><input placeholder="Место" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} /><select aria-label="Повтор" value={draft.recurrence_rule} onChange={(e) => setDraft({ ...draft, recurrence_rule: e.target.value })}><option value="">Не повторять</option><option value="FREQ=DAILY">Каждый день</option><option value="FREQ=WEEKLY">Каждую неделю</option><option value="FREQ=MONTHLY">Каждый месяц</option><option value="FREQ=YEARLY">Каждый год</option></select><button type="button" onClick={() => void add()}>Сохранить</button></div></div>}
    {view === "week" ? <div className="calendar-week">{days.map((day) => <section key={dayKey(day)}><h3>{day.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })}</h3>{sorted.filter((event) => dayKey(parseLocal(event.starts_at)) === dayKey(day)).map((event) => <EventCard key={event.id} event={event} remove={remove} />)}</section>)}</div> : <div className="calendar-list">{sorted.map((event) => <EventCard key={event.id} event={event} remove={remove} showDate />)}</div>}
    {!events.length && <p className="planner-empty">На этой неделе событий нет</p>}
  </section>;
}

function EventCard({ event, remove, showDate = false }: { event: CalendarEvent; remove: (event: CalendarEvent) => Promise<void>; showDate?: boolean }) { const start = parseLocal(event.starts_at); return <article className="calendar-event" style={{ borderLeftColor: `var(--note-${event.color || "blue"})` }}><div><b>{event.title}</b><time>{showDate && start.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + " · "}{event.all_day ? "Весь день" : start.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time>{event.location && <small>{event.location}</small>}</div><button type="button" className="planner-icon" onClick={() => void remove(event)} aria-label={`Удалить: ${event.title}`}><Trash2 size={14} /></button></article>; }
