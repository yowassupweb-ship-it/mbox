import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { ENTITY_CHANGED_EVENT } from "../../hooks/useRealtime";
import { dayTitle, jumpToHistoryDay, setHistoryState, useHistoryState } from "./historyNav";

type Day = { day: string; count: number };

/** Дни «Истории» в боковой панели: по месяцам, с числом событий. Активный — тот, что сейчас на экране ленты. */
export function HistorySidebar({ onOpen }: { onOpen: () => void }) {
  const nav = useHistoryState();
  const [days, setDays] = useState<Day[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow", mode: nav.mode });
    if (nav.actor) params.set("actor", nav.actor);
    if (nav.q.trim()) params.set("q", nav.q.trim());
    try { setDays((await fetchJson<{ days: Day[] }>(`/api/mbox/history/days?${params}`)).days); } catch { setDays([]); }
  }, [nav.mode, nav.actor, nav.q]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let timer = 0;
    const listener = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 3000); };
    window.addEventListener(ENTITY_CHANGED_EVENT, listener);
    return () => { window.removeEventListener(ENTITY_CHANGED_EVENT, listener); window.clearTimeout(timer); };
  }, [load]);

  // Лента прокрутилась на другой день — держим его видимым и в списке.
  useEffect(() => {
    if (!nav.visibleDay) return;
    listRef.current?.querySelector<HTMLElement>(`[data-day="${nav.visibleDay}"]`)?.scrollIntoView({ block: "nearest" });
  }, [nav.visibleDay]);

  const months = useMemo(() => {
    const groups = new Map<string, Day[]>();
    for (const day of days || []) {
      const [year, month] = day.day.split("-").map(Number);
      const label = new Date(year, month - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
      groups.set(label, [...(groups.get(label) ?? []), day]);
    }
    return [...groups.entries()];
  }, [days]);

  return (
    <div className="wb-view wb-history-side">
      <header className="wb-view-head">
        <span>История</span>
        <div className="wb-view-actions">
          <button type="button" onClick={() => void load()} title="Обновить" aria-label="Обновить"><RefreshCw size={13} /></button>
        </div>
      </header>
      <div className="wb-history-side-mode" role="radiogroup" aria-label="Что показывать">
        <button type="button" role="radio" aria-checked={nav.mode === "important"} className={nav.mode === "important" ? "is-on" : undefined} onClick={() => setHistoryState({ mode: "important" })}>Важное</button>
        <button type="button" role="radio" aria-checked={nav.mode === "all"} className={nav.mode === "all" ? "is-on" : undefined} onClick={() => setHistoryState({ mode: "all" })}>Всё</button>
      </div>
      <div className="wb-view-body" ref={listRef}>
        {days === null && <OctopusSpinner compact label="Загружаю дни…" />}
        {days !== null && !days.length && <p className="wb-view-empty">Событий нет</p>}
        {months.map(([month, items]) => (
          <section className="wb-menu-group" key={month}>
            <div className="wb-menu-group-head is-static">{month}</div>
            {items.map((item) => (
              <button
                key={item.day}
                type="button"
                data-day={item.day}
                className={item.day === nav.visibleDay ? "wb-menu-item wb-history-side-day is-active" : "wb-menu-item wb-history-side-day"}
                aria-current={item.day === nav.visibleDay ? "date" : undefined}
                onClick={() => { onOpen(); window.setTimeout(() => jumpToHistoryDay(item.day), 0); }}
              >
                <span className="wb-menu-item-title">{dayTitle(item.day, true)}</span>
                <span className="wb-history-side-count">{item.count}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
