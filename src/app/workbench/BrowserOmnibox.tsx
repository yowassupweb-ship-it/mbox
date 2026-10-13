import { Bookmark, Clock3, Globe, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Favicon } from "./BrowserDocument";

/**
 * Подсказки строки адреса, как в Chrome: сверху то, что набрали («Открыть …» или «Искать …»), ниже закладки,
 * недавние страницы из общей истории и поисковые подсказки выбранной поисковой системы. Стрелки подставляют строку
 * в поле, Enter открывает выбранное, Shift+Delete убирает страницу из истории, Esc закрывает.
 */

export type OmniboxRow = {
  id: string;
  kind: "open" | "search" | "bookmark" | "history" | "suggest";
  /** Что подставить в поле, когда строку выбрали стрелками. */
  fill: string;
  /** Что открыть: адрес или поисковый запрос. */
  target: string;
  title: string;
  subtitle?: string;
  url?: string;
};

type Source = {
  bookmarks: Array<{ title: string; url: string; folder?: string }>;
  history?: (search: string, limit?: number) => Promise<Array<{ url: string; title: string }>>;
  suggest?: (query: string) => Promise<string[]>;
};

const URL_LIKE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?$/i;

export function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** Строка похожа на адрес сайта, а не на поисковый запрос. */
export function looksLikeAddress(text: string) {
  return URL_LIKE.test(text.trim()) || /^https?:\/\//i.test(text.trim());
}

function matches(text: string, words: string[]) {
  const hay = text.toLowerCase();
  return words.every((word) => hay.includes(word));
}

/**
 * Подсказки для введённого текста. Закладки считаются сразу, история и поисковые подсказки приходят с короткой задержкой;
 * устаревший ответ отбрасывается. Пустой ввод — без подсказок (при фокусе на поле показываем недавнюю историю отдельно).
 */
export function useOmniboxRows(query: string, active: boolean, source: Source, engineLabel: string, withSuggestions: boolean, refresh = 0): OmniboxRow[] {
  const text = query.trim();
  const [history, setHistory] = useState<Array<{ url: string; title: string }>>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    if (!active) { setHistory([]); setSuggestions([]); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      void (source.history?.(text, 8) ?? Promise.resolve([])).then((rows) => { if (alive) setHistory(rows); }).catch(() => { if (alive) setHistory([]); });
      if (text && withSuggestions && !looksLikeAddress(text) && source.suggest) {
        void source.suggest(text).then((list) => { if (alive) setSuggestions(list); }).catch(() => { if (alive) setSuggestions([]); });
      } else setSuggestions([]);
    }, text ? 110 : 0);
    return () => { alive = false; window.clearTimeout(timer); };
  // источник приходит из моста приложения и не меняется между рендерами
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, active, withSuggestions, refresh]);

  return useMemo(() => {
    if (!active) return [];
    const rows: OmniboxRow[] = [];
    const seen = new Set<string>();
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (text) {
      if (looksLikeAddress(text)) {
        const target = /^https?:\/\//i.test(text) ? text : `https://${text}`;
        rows.push({ id: "typed", kind: "open", fill: text, target, title: text, subtitle: "Открыть адрес", url: target });
        seen.add(target);
      } else {
        rows.push({ id: "typed", kind: "search", fill: text, target: text, title: text, subtitle: `Поиск в ${engineLabel}` });
      }
    }
    const take = (kind: "bookmark" | "history", url: string, title: string, subtitle: string) => {
      if (seen.has(url)) return;
      seen.add(url);
      rows.push({ id: `${kind}:${url}`, kind, fill: url, target: url, title: title || hostOf(url), subtitle, url });
    };
    if (words.length) {
      let count = 0;
      for (const item of source.bookmarks) {
        if (count >= 3) break;
        if (!matches(`${item.title} ${item.url}`, words)) continue;
        take("bookmark", item.url, item.title, `Закладка · ${hostOf(item.url)}`);
        count += 1;
      }
    }
    for (const item of history.slice(0, text ? 4 : 8)) take("history", item.url, item.title, hostOf(item.url));
    for (const phrase of suggestions.slice(0, 5)) {
      if (!phrase || phrase.toLowerCase() === text.toLowerCase()) continue;
      rows.push({ id: `suggest:${phrase}`, kind: "suggest", fill: phrase, target: phrase, title: phrase });
    }
    return rows;
  }, [active, text, history, suggestions, source.bookmarks, engineLabel]);
}

function rowIcon(row: OmniboxRow): ReactNode {
  if (row.kind === "bookmark" && row.url) return <Favicon url={row.url} size={16} />;
  if (row.kind === "history" && row.url) return <Favicon url={row.url} size={16} />;
  if (row.kind === "open" && row.url) return <Favicon url={row.url} size={16} />;
  if (row.kind === "suggest" || row.kind === "search") return <Search size={16} aria-hidden="true" />;
  return <Globe size={16} aria-hidden="true" />;
}

const KIND_BADGE: Partial<Record<OmniboxRow["kind"], ReactNode>> = {
  bookmark: <Bookmark size={12} aria-hidden="true" />,
  history: <Clock3 size={12} aria-hidden="true" />,
};

export function OmniboxList({ rows, cursor, onPick, onHover, onRemoveHistory }: {
  rows: OmniboxRow[];
  cursor: number;
  onPick: (row: OmniboxRow) => void;
  onHover: (index: number) => void;
  onRemoveHistory?: (row: OmniboxRow) => void;
}) {
  if (!rows.length) return null;
  return (
    <div className="wb-omnibox" role="listbox" aria-label="Подсказки">
      {rows.map((row, index) => (
        <div
          key={row.id}
          role="option"
          aria-selected={index === cursor}
          className={`wb-omnibox-row${index === cursor ? " is-active" : ""}`}
          // mousedown, а не click: иначе поле теряет фокус раньше, и список закрывается до выбора
          onMouseDown={(event) => { event.preventDefault(); onPick(row); }}
          onMouseEnter={() => onHover(index)}
        >
          <span className="wb-omnibox-icon">{rowIcon(row)}</span>
          <span className="wb-omnibox-text">
            <span className="wb-omnibox-title">{row.title}</span>
            {row.subtitle && <span className="wb-omnibox-sub">{KIND_BADGE[row.kind]}{row.subtitle}</span>}
          </span>
          {row.kind === "history" && onRemoveHistory && (
            <button type="button" className="wb-omnibox-remove" tabIndex={-1} title="Убрать из истории (Shift+Delete)" aria-label="Убрать из истории" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); onRemoveHistory(row); }}>×</button>
          )}
        </div>
      ))}
    </div>
  );
}
