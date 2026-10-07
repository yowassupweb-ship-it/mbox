import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

/**
 * Панель «найти в документе»: поле, «3 из 17», вперёд/назад, закрыть. Сама ничего не ищет — это делает
 * владелец (текст страницы, холст документа, ячейки таблицы). Enter — дальше, Shift+Enter — назад, Esc — закрыть.
 */
export function FindBar({ query, onQuery, count, index, onNext, onPrev, onClose, focusKey, placeholder = "Найти в документе", className }: {
  query: string;
  onQuery: (value: string) => void;
  count: number;
  /** Номер текущего совпадения (с нуля), -1 — нет. */
  index: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Меняется при каждом повторном Ctrl+F: поле снова получает фокус и выделение. */
  focusKey?: number;
  placeholder?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  const status = !query.trim() ? "" : count ? `${index + 1} из ${count}` : "нет совпадений";
  return (
    <div className={["wb-find-bar", className].filter(Boolean).join(" ")} role="search" aria-label="Поиск в документе">
      <Search size={14} aria-hidden="true" />
      <input
        ref={input}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); if (event.shiftKey) onPrev(); else onNext(); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <span className={count || !query.trim() ? "wb-find-status" : "wb-find-status is-none"} aria-live="polite">{status}</span>
      <button type="button" onClick={onPrev} disabled={!count} title="Назад (Shift+Enter)" aria-label="Предыдущее совпадение"><ChevronUp size={14} aria-hidden="true" /></button>
      <button type="button" onClick={onNext} disabled={!count} title="Дальше (Enter)" aria-label="Следующее совпадение"><ChevronDown size={14} aria-hidden="true" /></button>
      <button type="button" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть поиск"><X size={14} aria-hidden="true" /></button>
    </div>
  );
}
