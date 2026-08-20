import { useEffect, useState } from "react";
import { Check, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { fetchJson, saveEntity } from "../../lib/api";
import { formatSince } from "../../lib/format";
import type { DataSource, Project } from "../../types";
import { Button, EmptyState, SaveButton, TextInput, type SaveState } from "../../ui";

/**
 * Источники данных проекта: внешний URL, который MBOX сам перечитывает по графику (см.
 * scripts/mbox-archivist.mjs — тикает раз в минуту, проверяет, у кого вышел срок) и кладёт
 * короткую сводку в память. Раньше единственный способ «следить за сайтом» — вручную зайти,
 * прочитать и записать факт руками.
 */
export function DataSourcesPanel({ project }: { project: Project }) {
  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  async function reload() {
    const data = await fetchJson<{ sources: DataSource[] }>("/api/mbox/data-sources");
    setSources(data.sources.filter((source) => source.project_id === project.id));
    setLoading(false);
  }

  useEffect(() => { void reload(); }, [project.id]);

  return (
    <div className="entity-panel sources-panel">
      {loading ? null : sources.length ? (
        <div className="source-rows">
          {sources.map((source) => <SourceRow key={source.id} source={source} onSaved={reload} />)}
        </div>
      ) : <EmptyState text="Источников пока нет. Добавьте сайт или API — MBOX сам будет перечитывать его по графику." />}

      {adding ? (
        <NewSource project={project} onDone={() => setAdding(false)} onSaved={reload} />
      ) : (
        <Button variant="ghost" icon={Plus} onClick={() => setAdding(true)}>Добавить источник</Button>
      )}
    </div>
  );
}

function NewSource({ project, onDone, onSaved }: { project: Project; onDone: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [scheduleHours, setScheduleHours] = useState("24");
  const [state, setState] = useState<SaveState>("idle");

  async function save() {
    if (!name.trim() || !url.trim()) return;
    setState("saving");
    try {
      await saveEntity("/api/mbox/data-sources", "", {
        name: name.trim(),
        url: url.trim(),
        project_id: project.id,
        schedule_minutes: Math.max(5, Math.round(Number(scheduleHours) * 60) || 1440),
      });
      setState("saved");
      onSaved();
      onDone();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="source-form">
      <TextInput label="Название" value={name} onChange={(event) => { setName(event.target.value); setState("idle"); }} placeholder="Сайт vs-travel.ru" />
      <TextInput label="Адрес" value={url} onChange={(event) => { setUrl(event.target.value); setState("idle"); }} placeholder="https://…" />
      <TextInput label="Перечитывать раз в, часов" value={scheduleHours} onChange={(event) => { setScheduleHours(event.target.value); setState("idle"); }} />
      <div className="source-form-actions">
        <Button variant="ghost" onClick={onDone}>Отмена</Button>
        <SaveButton state={state} idleLabel="Добавить" disabled={!name.trim() || !url.trim()} onClick={save} />
      </div>
    </div>
  );
}

const statusLabel: Record<string, string> = {
  never: "ещё не читался",
  ok: "прочитан",
  error: "ошибка чтения",
};

function SourceRow({ source, onSaved }: { source: DataSource; onSaved: () => void }) {
  const [refreshing, setRefreshing] = useState(false);

  async function remove() {
    if (!window.confirm(`Удалить источник «${source.name}»?`)) return;
    await fetchJson(`/api/mbox/data-sources/${source.id}`, { method: "DELETE" });
    onSaved();
  }

  // Синхронно: сервер тянет URL и гоняет Groq прямо в этом запросе, поэтому кнопка ждёт реальный
  // ответ (несколько секунд), а не просто помечает источник и надеется на тик архивариуса.
  async function forceRefresh() {
    setRefreshing(true);
    try {
      await fetchJson(`/api/mbox/data-sources/${source.id}/refresh`, { method: "POST" });
      onSaved();
    } catch {
      onSaved(); // даже при ошибке last_status/last_summary на сервере уже обновились — подтянуть их
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <article className={`source-row status-${source.last_status}`}>
      <div className="source-row-main">
        <strong>{source.name}</strong>
        <a href={source.url} target="_blank" rel="noreferrer" className="source-url">{source.url}</a>
      </div>
      <div className="source-row-meta">
        <span className={`source-status status-${source.last_status}`}>
          {source.last_status === "ok" && <Check size={12} />}
          {source.last_status === "error" && <X size={12} />}
          {statusLabel[source.last_status] || source.last_status}
        </span>
        <span className="muted">каждые {Math.round(source.schedule_minutes / 60) || 1} ч · {source.last_fetched_at ? formatSince(source.last_fetched_at) : "никогда"}</span>
      </div>
      {source.last_summary && <p className="source-summary">{source.last_summary}</p>}
      <div className="source-row-actions">
        <Button variant="ghost" icon={RefreshCw} onClick={forceRefresh} disabled={refreshing}>{refreshing ? "Запрошено…" : "Обновить сейчас"}</Button>
        <Button variant="icon" icon={Trash2} aria-label="Удалить источник" onClick={remove} />
      </div>
    </article>
  );
}
