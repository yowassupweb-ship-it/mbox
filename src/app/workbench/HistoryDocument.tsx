import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import type { AuditEvent } from "../../types";
import { usePersistentState } from "./tabs";

/** Что стоит за таблицей — по-человечески. Неизвестная таблица показывается как есть. */
const ENTITY_LABEL: Record<string, string> = {
  memories: "память",
  memory_actions: "действие с памятью",
  agent_inbox: "сообщение",
  agent_runs: "запуск агента",
  todos: "задача",
  projects: "проект",
  artifacts: "артефакт",
  notes: "заметка",
  decision_log: "решение",
  graph_edges: "связь",
  folders: "папка",
  secrets: "секрет",
  users: "пользователь",
  chat_threads: "чат",
  workspace_file_versions: "версия файла",
  skill_file_versions: "файл навыка",
};
/** Служебные записи: их много, и человеку они почти ничего не говорят — видны только в режиме «Всё». */
const SERVICE = new Set(["memory_actions", "agent_runs", "agent_presence", "server_metrics", "workspace_ops", "llm_usage"]);
const ACTION: Record<string, { word: string; tone: string }> = {
  INSERT: { word: "Новое", tone: "is-new" },
  UPDATE: { word: "Изменено", tone: "is-edit" },
  DELETE: { word: "Удалено", tone: "is-delete" },
};

type Row = { key: string; event: AuditEvent; count: number };

function dayLabel(date: Date) {
  const today = new Date();
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((start(today) - start(date)) / 86_400_000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

/** «memory_actions #1902» в summary — просто повтор таблицы и номера, такое не показываем. */
function summaryOf(event: AuditEvent) {
  const text = String(event.summary || "").trim();
  if (!text || text === "—") return "";
  if (text.replace(/\s+/g, "") === `${event.entity_type}#${event.entity_id ?? ""}`.replace(/\s+/g, "")) return "";
  return text.replace(new RegExp(`^${event.entity_type}\\s*#?\\d*\\s*`), "");
}

const isHuman = (actor: string) => !actor || /^(admin|system|человек)$/i.test(actor) || !/^(джарвис|jarvis|claude|codex|chatgpt|gemini)/i.test(actor);

export function HistoryDocument({ events }: { events: AuditEvent[] }) {
  const [mode, setMode] = usePersistentState<"important" | "all">("mbox.history.mode", "important");
  const [actorFilter, setActorFilter] = usePersistentState<string>("mbox.history.actor", "");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const actors = useMemo(() => [...new Set(events.map((event) => event.actor || "system"))], [events]);
  const hiddenService = useMemo(() => events.filter((event) => SERVICE.has(event.entity_type)).length, [events]);

  const days = useMemo(() => {
    const filtered = events.filter((event) => {
      if (mode === "important" && SERVICE.has(event.entity_type)) return false;
      if (actorFilter && (event.actor || "system") !== actorFilter) return false;
      if (needle && !`${event.actor} ${event.summary} ${ENTITY_LABEL[event.entity_type] || event.entity_type}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    // Подряд одно и то же (тот же участник, действие и тип записи в пределах пары минут) — одной строкой «×N».
    const rows: Row[] = [];
    for (const event of filtered) {
      const last = rows[rows.length - 1];
      const near = last && Math.abs(new Date(last.event.created_at).getTime() - new Date(event.created_at).getTime()) < 120_000;
      if (last && near && last.event.actor === event.actor && last.event.action === event.action && last.event.entity_type === event.entity_type && last.event.entity_id === event.entity_id) {
        last.count += 1;
      } else {
        rows.push({ key: event.id, event, count: 1 });
      }
    }
    const byDay = new Map<string, Row[]>();
    for (const row of rows) {
      const label = dayLabel(new Date(row.event.created_at));
      byDay.set(label, [...(byDay.get(label) ?? []), row]);
    }
    return [...byDay.entries()];
  }, [events, mode, actorFilter, needle]);

  return (
    <div className="wb-doc-page wb-history">
      <header className="wb-history-head">
        <div>
          <h1>История</h1>
          <p>Что меняли люди и агенты в MBOX — последние {events.length} событий.</p>
        </div>
        <div className="wb-history-mode" role="radiogroup" aria-label="Что показывать">
          <button type="button" role="radio" aria-checked={mode === "important"} className={mode === "important" ? "is-on" : undefined} onClick={() => setMode("important")}>Важное</button>
          <button type="button" role="radio" aria-checked={mode === "all"} className={mode === "all" ? "is-on" : undefined} onClick={() => setMode("all")} title={`Плюс служебные записи: ${hiddenService}`}>Всё</button>
        </div>
      </header>
      <div className="wb-history-tools">
        <label className="wb-history-search">
          <Search size={13} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в истории" aria-label="Найти в истории" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить"><X size={12} /></button>}
        </label>
        <div className="wb-history-actors" role="group" aria-label="Кто">
          <button type="button" className={!actorFilter ? "is-on" : undefined} aria-pressed={!actorFilter} onClick={() => setActorFilter("")}>Все</button>
          {actors.map((actor) => (
            <button key={actor} type="button" className={actorFilter === actor ? "is-on" : undefined} aria-pressed={actorFilter === actor} onClick={() => setActorFilter(actorFilter === actor ? "" : actor)}>
              {!isHuman(actor) && <AgentAvatar name={actor} size={14} />}{actor}
            </button>
          ))}
        </div>
      </div>
      {days.length ? days.map(([day, rows]) => (
        <section key={day} className="wb-history-day">
          <h2>{day}</h2>
          <ol>
            {rows.map(({ key, event, count }) => {
              const action = ACTION[(event.action || "").toUpperCase()] ?? { word: event.action, tone: "" };
              const summary = summaryOf(event);
              const time = new Date(event.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
              return (
                <li key={key} className={SERVICE.has(event.entity_type) ? "is-service" : undefined}>
                  <time dateTime={event.created_at} title={new Date(event.created_at).toLocaleString("ru-RU")}>{time}</time>
                  <span className="wb-history-who">
                    {isHuman(event.actor) ? <span className="wb-history-human" aria-hidden="true">{(event.actor || "S").slice(0, 1).toUpperCase()}</span> : <AgentAvatar name={event.actor} size={18} />}
                    <b>{event.actor || "system"}</b>
                  </span>
                  <span className="wb-history-what">
                    <em className={action.tone}>{action.word}</em>
                    <span>{ENTITY_LABEL[event.entity_type] || event.entity_type}{event.entity_id ? <small> #{event.entity_id}</small> : null}</span>
                    {summary && <q title={summary}>{summary}</q>}
                    {count > 1 && <small className="wb-history-count">×{count}</small>}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )) : <p className="wb-empty">{needle || actorFilter ? "Ничего не найдено — сбросьте фильтр." : "Журнал пуст."}</p>}
    </div>
  );
}
