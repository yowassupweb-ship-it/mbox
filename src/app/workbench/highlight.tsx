import type { ReactNode } from "react";

/** Основы слов запроса: сервер ищет слова с отрезанными окончаниями, подсветка ведёт себя так же,
 * иначе «релиза» в тексте не подсветилось бы по запросу «релиз». */
export function queryStems(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const stems = words
    .filter((word) => word.length > 1)
    .map((word) => (word.length > 5 ? word.slice(0, word.length - 2) : word.length > 3 ? word.slice(0, word.length - 1) : word));
  return [...new Set(stems)].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stemPattern(stems: string[]) {
  return stems.length ? new RegExp(`(${stems.map(escapeRegExp).join("|")})[\\p{L}\\p{N}]*`, "giu") : null;
}

export function highlight(text: string, stems: string[]): ReactNode {
  const pattern = stemPattern(stems);
  if (!pattern || !text) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<mark key={start}>{match[0]}</mark>);
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Кусок текста вокруг первого совпадения — чтобы в выдаче было видно, почему запись нашлась. */
export function snippet(content: string, stems: string[], size = 180): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length <= size) return text;
  const pattern = stemPattern(stems);
  const index = pattern ? text.search(pattern) : -1;
  if (index < 0) return `${text.slice(0, size).trimEnd()}…`;
  const start = Math.max(0, index - Math.round(size / 3));
  const end = Math.min(text.length, start + size);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
