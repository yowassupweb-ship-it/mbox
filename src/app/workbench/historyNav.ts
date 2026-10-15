import { useEffect, useState } from "react";

/**
 * Общее состояние «Истории» для боковой панели с днями (HistorySidebar) и ленты во вкладке (HistoryDocument):
 * фильтры, день, который сейчас на экране, и просьба перейти к дню.
 */
export type HistoryFilters = { mode: "important" | "all"; actor: string; q: string };
type State = HistoryFilters & { visibleDay: string };

const STORAGE = "mbox.history.filters";
const EVENT = "mbox:history-nav";
const JUMP = "mbox:history-jump";

function initial(): State {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE) || "{}");
    return { mode: saved.mode === "all" ? "all" : "important", actor: typeof saved.actor === "string" ? saved.actor : "", q: "", visibleDay: "" };
  } catch { return { mode: "important", actor: "", q: "", visibleDay: "" }; }
}

let state: State = typeof window === "undefined" ? { mode: "important", actor: "", q: "", visibleDay: "" } : initial();

export function setHistoryState(patch: Partial<State>) {
  state = { ...state, ...patch };
  if ("mode" in patch || "actor" in patch) {
    try { window.localStorage.setItem(STORAGE, JSON.stringify({ mode: state.mode, actor: state.actor })); } catch { /* без памяти фильтров */ }
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: state }));
}

export function useHistoryState(): State {
  const [value, setValue] = useState(state);
  useEffect(() => {
    const listener = (event: Event) => setValue((event as CustomEvent<State>).detail);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
  return value;
}

/** Перейти к дню «YYYY-MM-DD»: лента прокручивается к нему, догружая события, если их ещё нет. */
export function jumpToHistoryDay(day: string) {
  window.dispatchEvent(new CustomEvent(JUMP, { detail: day }));
}

export function useHistoryJump(handler: (day: string) => void) {
  useEffect(() => {
    const listener = (event: Event) => handler((event as CustomEvent<string>).detail);
    window.addEventListener(JUMP, listener);
    return () => window.removeEventListener(JUMP, listener);
  }, [handler]);
}

/** Местный день события: «2026-10-15». */
export function dayKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dayTitle(key: string, withWeekday = false) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const today = new Date();
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - date.getTime()) / 86_400_000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  const text = date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", ...(year !== today.getFullYear() ? { year: "numeric" } : {}) });
  return withWeekday ? `${text}, ${date.toLocaleDateString("ru-RU", { weekday: "short" })}` : text;
}
