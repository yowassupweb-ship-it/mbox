import { scopedStorageKey } from "./tabs";
import { isIncognitoKey } from "./incognito";

/**
 * Журнал «где я был»: каждая открытая вкладка (сайт, заметка, документ, таблица, презентация, файл, задача, проект)
 * запоминается с названием и временем. Поиск (Ctrl+K) показывает его в «Недавних» и находит по нему, поэтому место,
 * где человек уже был, всегда под рукой, а не только то, что менялось на сервере. Хранится у человека в браузере.
 */

export type Visit = { key: string; title: string; hint: string; url?: string; at: number };

const STORAGE_KEY = "mbox.recent.visits.v1";
const MAX_VISITS = 120;
// Служебные вкладки журнал не засоряют.
const SKIPPED = new Set(["welcome", "settings", "history", "memory:new", "file:new", "agents"]);

function isSkipped(key: string) {
  return !key || SKIPPED.has(key) || key.startsWith("term:") || isIncognitoKey(key);
}

export function readVisits(): Visit[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(scopedStorageKey(STORAGE_KEY)) || "[]");
    return Array.isArray(raw)
      ? raw.filter((item): item is Visit => item && typeof item.key === "string" && typeof item.at === "number").slice(0, MAX_VISITS)
      : [];
  } catch {
    return [];
  }
}

/** Вкладка открыта или сменила название: запись встаёт наверх, повтор того же ключа не плодит дублей. */
export function recordVisit(visit: Omit<Visit, "at">) {
  if (isSkipped(visit.key)) return;
  if (visit.key.startsWith("web:") && !visit.url) return;
  try {
    const list = readVisits();
    const existing = list.find((item) => item.key === visit.key);
    const next: Visit = { key: visit.key, title: visit.title || existing?.title || visit.key, hint: visit.hint || existing?.hint || "", url: visit.url || existing?.url, at: Date.now() };
    const rest = list.filter((item) => item.key !== visit.key);
    window.localStorage.setItem(scopedStorageKey(STORAGE_KEY), JSON.stringify([next, ...rest].slice(0, MAX_VISITS)));
  } catch {
    // хранилище недоступно или переполнено — журнал просто не обновится
  }
}
