import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Plus, SlidersHorizontal, X } from "lucide-react";
import type { MboxData } from "../../hooks/useMboxData";
import { AuthError, fetchJson } from "../../lib/api";
import { formatDate, plural } from "../../lib/format";
import { highlight, queryStems, snippet } from "./highlight";
import { usePersistentState, type TabsApi } from "./tabs";

type SearchHit = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  content: string;
  entity_type: string;
  tags: string[];
  metadata: Record<string, unknown>;
  updated_at: string;
  score: number;
};

type Filters = { projectId: string; recency: string; factsOnly: boolean; hideAuto: boolean };

const DEFAULT_FILTERS: Filters = { projectId: "", recency: "0", factsOnly: false, hideAuto: true };

/** Служебные отчёты агентов («Итог запуска: …», теги auto/agent-work) дублируют настоящие записи
 * и забивали выдачу — по умолчанию прячем их, одним переключателем можно вернуть. */
function isAutoLog(hit: SearchHit) {
  return hit.tags.includes("auto") || /^Итог (запуска|задачи):/.test(hit.title);
}

export function SearchView({ data, tabs, focusSignal }: { data: MboxData; tabs: TabsApi; focusSignal: number }) {
  const [query, setQuery] = usePersistentState("mbox.search.query", "");
  const [filters, setFilters] = usePersistentState<Filters>("mbox.search.filters", DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = usePersistentState("mbox.search.showFilters", false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  const trimmed = query.trim();
  const idMatch = trimmed.match(/^#?(\d+)$/);

  useEffect(() => {
    const id = ++requestId.current;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ detail: "full", limit: filters.hideAuto || filters.factsOnly ? "100" : "60" });
      if (trimmed && !idMatch) params.set("q", trimmed);
      if (filters.projectId) params.set("project_id", filters.projectId);
      if (filters.recency !== "0") params.set("recency_days", filters.recency);
      try {
        const response = await fetchJson<{ memories: SearchHit[] }>(`/api/mbox/memories/search?${params}`);
        if (id !== requestId.current) return;
        setHits(response.memories.map((hit) => ({ ...hit, tags: hit.tags ?? [], content: hit.content ?? "" })));
        setCursor(0);
      } catch (cause) {
        if (id !== requestId.current) return;
        setError(cause instanceof AuthError ? "Сессия истекла — войди заново" : "Поиск не ответил. Попробуй ещё раз.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, trimmed ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [trimmed, filters.projectId, filters.recency, filters.hideAuto, filters.factsOnly, data.memoriesTotal]);

  const visible = useMemo(() => hits.filter((hit) => (!filters.hideAuto || !isAutoLog(hit)) && (!filters.factsOnly || hit.entity_type === "fact")), [hits, filters.hideAuto, filters.factsOnly]);
  const hiddenAuto = filters.hideAuto ? hits.filter(isAutoLog).length : 0;
  const stems = useMemo(() => queryStems(trimmed), [trimmed]);
  const maxScore = visible.reduce((max, hit) => Math.max(max, hit.score || 0), 0) || 1;
  const itemCount = visible.length + (idMatch ? 1 : 0);

  useEffect(() => {
    listRef.current?.querySelector(".wb-hit.is-cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function openAt(index: number, pin: boolean) {
    if (idMatch && index === 0) return tabs.open(`memory:${idMatch[1]}`, pin);
    const hit = visible[index - (idMatch ? 1 : 0)];
    if (hit) tabs.open(`memory:${hit.id}`, pin);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((value) => Math.min(itemCount - 1, value + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setCursor((value) => Math.max(0, value - 1)); }
    if (event.key === "Enter") { event.preventDefault(); openAt(cursor, event.ctrlKey || event.metaKey); }
    if (event.key === "Escape") setQuery("");
  }

  const activeFilters = Number(Boolean(filters.projectId)) + Number(filters.recency !== "0") + Number(filters.factsOnly) + Number(!filters.hideAuto);

  return (
    <div className="wb-view">
      <header className="wb-view-head">
        <span>Поиск по памяти</span>
        <div className="wb-view-actions">
          <button type="button" className={showFilters || activeFilters ? "is-on" : undefined} onClick={() => setShowFilters((value) => !value)} title="Фильтры">
            <SlidersHorizontal size={13} />{activeFilters > 0 && <b>{activeFilters}</b>}
          </button>
          <button type="button" onClick={() => tabs.open("memory:new", true)} title="Новая запись"><Plus size={14} /></button>
        </div>
      </header>
      <div className="wb-filter wb-search-input">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Слова, фраза или #id"
          spellCheck={false}
        />
        {query && <button type="button" onClick={() => { setQuery(""); inputRef.current?.focus(); }} aria-label="Очистить"><X size={13} /></button>}
        {loading && <span className="wb-progress" />}
      </div>
      {showFilters && (
        <div className="wb-search-filters">
          <select value={filters.projectId} onChange={(event) => setFilters({ ...filters, projectId: event.target.value })}>
            <option value="">Все проекты</option>
            {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select value={filters.recency} onChange={(event) => setFilters({ ...filters, recency: event.target.value })}>
            <option value="0">За всё время</option>
            <option value="1">За сутки</option>
            <option value="7">За неделю</option>
            <option value="30">За месяц</option>
            <option value="90">За 3 месяца</option>
          </select>
          <label><input type="checkbox" checked={filters.factsOnly} onChange={(event) => setFilters({ ...filters, factsOnly: event.target.checked })} /> Только факты</label>
          <label><input type="checkbox" checked={!filters.hideAuto} onChange={(event) => setFilters({ ...filters, hideAuto: !event.target.checked })} /> Показывать автологи агентов</label>
          {activeFilters > 0 && <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)}>Сбросить</button>}
        </div>
      )}
      <div className="wb-search-summary">
        {error ? <span className="wb-error">{error}</span> : (
          <>
            {trimmed && !idMatch ? `${visible.length} ${plural(visible.length, "результат", "результата", "результатов")}` : "Недавние записи"}
            {hiddenAuto > 0 && <button type="button" onClick={() => setFilters({ ...filters, hideAuto: false })}>+{hiddenAuto} автологов скрыто</button>}
          </>
        )}
      </div>
      <div className="wb-view-body" ref={listRef} role="listbox" aria-label="Результаты поиска">
        {idMatch && (
          <div className={cursor === 0 ? "wb-hit is-cursor" : "wb-hit"} role="option" aria-selected={cursor === 0} onClick={() => openAt(0, false)} onDoubleClick={() => openAt(0, true)}>
            <div className="wb-hit-title">Открыть запись #{idMatch[1]}</div>
          </div>
        )}
        {visible.map((hit, index) => {
          const position = index + (idMatch ? 1 : 0);
          const active = tabs.active === `memory:${hit.id}`;
          return (
            <div
              key={hit.id}
              className={["wb-hit", cursor === position ? "is-cursor" : "", active ? "is-active" : ""].filter(Boolean).join(" ")}
              role="option"
              aria-selected={cursor === position}
              onClick={() => { setCursor(position); openAt(position, false); }}
              onDoubleClick={() => openAt(position, true)}
              title="Клик — предпросмотр, двойной клик — закрепить вкладку"
            >
              <div className="wb-hit-title">{highlight(hit.title || "Без названия", stems)}</div>
              {hit.content && <div className="wb-hit-snippet">{highlight(snippet(hit.content, stems), stems)}</div>}
              <div className="wb-hit-meta">
                <span>#{hit.id}</span>
                {hit.project_name && <span>{hit.project_name}</span>}
                <span>{formatDate(hit.updated_at)}</span>
                {hit.entity_type === "fact" && <span className="is-fact">факт</span>}
                {trimmed && !idMatch && hit.score > 0 && (
                  <span className="wb-score" title={`Релевантность ${hit.score.toFixed(2)}`}><i style={{ width: `${Math.max(8, Math.round((hit.score / maxScore) * 100))}%` }} /></span>
                )}
              </div>
            </div>
          );
        })}
        {!loading && !error && !visible.length && !idMatch && (
          <p className="wb-empty">{trimmed ? "Ничего не нашлось. Попробуй другие слова или сними фильтры." : "Записей пока нет"}</p>
        )}
      </div>
    </div>
  );
}
