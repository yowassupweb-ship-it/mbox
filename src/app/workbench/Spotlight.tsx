import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Brain, Calculator, CornerDownLeft, File as FileIcon, FileText, FolderKanban, Globe, Package, Search, SquareCheck, StickyNote, Table2, Zap } from "lucide-react";
import { formatSince } from "../../lib/format";
import { highlight, queryStems } from "./highlight";
import { markOverlay, browserBridge, browserTabKey } from "./BrowserDocument";
import { readBrowserSettings } from "./browserSettings";
import { useLocalWorkspace, workspaceBridge } from "./localWorkspace";
import type { TabsApi } from "./tabs";

/**
 * Поиск по всему MBOX в духе Spotlight: одно поле, результаты по группам, предпросмотр справа.
 * Ищет по названиям и ТЕКСТАМ — заметок (со всеми вкладками), документов, ячеек таблиц, задач, памяти,
 * артефактов, а в Desktop ещё и по файлам локальных папок. Умеет считать («12*4,5»), открывать адреса и
 * запускать действия. Сервер ранжирует найденное (/api/mbox/spotlight), здесь — порядок групп и клавиатура.
 */

export type SpotlightCommand = { id: string; title: string; hint?: string; keywords?: string; shortcut?: string; icon?: ReactNode; run: () => void };

type Kind = "note" | "doc" | "table" | "project" | "todo" | "memory" | "artifact";
type ServerHit = { kind: Kind; id: string; key: string; title: string; project?: string; updated_at: string; score: number; snippet: string; excerpt: string; status?: string; pinned?: boolean };
type Response = { query: string; recent: boolean; results: ServerHit[]; failed: number };

type Item = {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  snippet?: string;
  excerpt?: string;
  icon: ReactNode;
  badge?: string;
  run: () => void;
  /** Что показать в предпросмотре вместо отрывка (результат вычисления, подсказка к действию). */
  note?: string;
};

const GROUPS: Array<{ id: string; label: string; limit: number }> = [
  { id: "top", label: "Лучшее совпадение", limit: 1 },
  { id: "recent", label: "Недавние", limit: 8 },
  { id: "action", label: "Действия", limit: 5 },
  { id: "note", label: "Заметки", limit: 6 },
  { id: "doc", label: "Документы", limit: 5 },
  { id: "table", label: "Таблицы", limit: 5 },
  { id: "project", label: "Проекты", limit: 4 },
  { id: "todo", label: "Задачи", limit: 5 },
  { id: "memory", label: "Память", limit: 5 },
  { id: "artifact", label: "Артефакты", limit: 4 },
  { id: "file", label: "Файлы", limit: 6 },
  { id: "web", label: "Интернет", limit: 2 },
];

const KIND: Record<Kind, { group: string; label: string; icon: ReactNode }> = {
  note: { group: "note", label: "Заметка", icon: <StickyNote size={16} aria-hidden="true" /> },
  doc: { group: "doc", label: "Документ", icon: <FileText size={16} aria-hidden="true" /> },
  table: { group: "table", label: "Таблица", icon: <Table2 size={16} aria-hidden="true" /> },
  project: { group: "project", label: "Проект", icon: <FolderKanban size={16} aria-hidden="true" /> },
  todo: { group: "todo", label: "Задача", icon: <SquareCheck size={16} aria-hidden="true" /> },
  memory: { group: "memory", label: "Память", icon: <Brain size={16} aria-hidden="true" /> },
  artifact: { group: "artifact", label: "Артефакт", icon: <Package size={16} aria-hidden="true" /> },
};

const SEARCH_URLS: Record<string, (q: string) => string> = {
  yandex: (q) => `https://yandex.ru/search/?text=${q}`,
  google: (q) => `https://www.google.com/search?q=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${q}`,
  bing: (q) => `https://www.bing.com/search?q=${q}`,
};

/** Арифметика без eval: + − × ÷ ^ % и скобки, десятичная запятая. null — это не выражение. */
export function calculate(source: string): number | null {
  const text = source.replace(/\s+/g, "").replace(/,/g, ".").replace(/[×х]/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  if (!/^[\d.+\-*/^%()]+$/.test(text) || !/[+\-*/^%]/.test(text.replace(/^-/, "")) || !/\d/.test(text)) return null;
  let at = 0;
  const peek = () => text[at];
  function number(): number {
    const start = at;
    while (/[\d.]/.test(peek() ?? "")) at += 1;
    const value = Number(text.slice(start, at));
    if (start === at || Number.isNaN(value)) throw new Error("number");
    return value;
  }
  function primary(): number {
    if (peek() === "(") { at += 1; const value = sum(); if (peek() !== ")") throw new Error("paren"); at += 1; return value; }
    if (peek() === "-") { at += 1; return -primary(); }
    if (peek() === "+") { at += 1; return primary(); }
    return number();
  }
  function power(): number {
    let base = primary();
    while (peek() === "%") { at += 1; base /= 100; }
    if (peek() === "^") { at += 1; return base ** power(); }
    return base;
  }
  function product(): number {
    let value = power();
    while (peek() === "*" || peek() === "/") {
      const op = text[at]; at += 1;
      const right = power();
      value = op === "*" ? value * right : value / right;
    }
    return value;
  }
  function sum(): number {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      const op = text[at]; at += 1;
      const right = product();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }
  try {
    const result = sum();
    return at === text.length && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 10 }).format(value);
}

const URL_LIKE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

function fuzzy(command: SpotlightCommand, query: string) {
  const needle = query.toLowerCase();
  const hay = `${command.title} ${command.keywords ?? ""}`.toLowerCase();
  if (hay.includes(needle)) return hay.startsWith(needle) || command.title.toLowerCase().startsWith(needle) ? 2 : 1;
  const words = needle.split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every((word) => hay.includes(word)) ? 1 : 0;
}

export function Spotlight({ open, onClose, tabs, commands }: { open: boolean; onClose: () => void; tabs: TabsApi; commands: SpotlightCommand[] }) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Response | null>(null);
  const [files, setFiles] = useState<Array<{ rootKey: string; path: string; root: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const requestId = useRef(0);
  const ws = useLocalWorkspace();
  const trimmed = query.trim();

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    markOverlay(true);
    setQuery("");
    setCursor(0);
    setFailed(false);
    const focus = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focus);
      markOverlay(false);
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [open]);

  // Запрос на сервер: короткая задержка, отмена устаревших ответов, предыдущая выдача остаётся на экране, пока идёт новая.
  useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/mbox/spotlight?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as Response;
        if (id === requestId.current) { setData(next); setFailed(false); setCursor(0); }
      } catch (cause) {
        if ((cause as Error).name !== "AbortError" && id === requestId.current) setFailed(true);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, trimmed ? 90 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, trimmed]);

  // Файлы локальных папок (Desktop): по имени, как «Найти файл» в боковой панели.
  useEffect(() => {
    const bridge = workspaceBridge();
    if (!open || !bridge || trimmed.length < 2) { setFiles([]); return; }
    let alive = true;
    const timer = window.setTimeout(async () => {
      const found = await Promise.all(ws.roots.map(async (root) => (await bridge.find(root.key, trimmed).catch(() => [])).map((path) => ({ rootKey: root.key, path, root: root.name }))));
      if (alive) setFiles(found.flat().slice(0, 12));
    }, 160);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [open, trimmed, ws.roots]);

  const finish = useCallback((action: () => void) => { onClose(); window.setTimeout(action, 0); }, [onClose]);
  const stems = useMemo(() => queryStems(trimmed), [trimmed]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    const calc = trimmed ? calculate(trimmed) : null;
    if (calc !== null) {
      const shown = formatNumber(calc);
      list.push({
        id: "calc", group: "top", title: shown, subtitle: `${trimmed} =`, icon: <Calculator size={16} aria-hidden="true" />, badge: "Калькулятор",
        note: "Enter — скопировать результат", run: () => { void navigator.clipboard?.writeText(String(calc)); setCopied(true); window.setTimeout(() => setCopied(false), 1200); onClose(); },
      });
    }
    const matchedCommands = trimmed
      ? commands.map((command) => ({ command, rank: fuzzy(command, trimmed) })).filter((entry) => entry.rank > 0).sort((a, b) => b.rank - a.rank).map((entry) => entry.command)
      : commands.slice(0, 6);
    for (const command of matchedCommands) {
      list.push({ id: `cmd:${command.id}`, group: "action", title: command.title, subtitle: command.hint, icon: command.icon ?? <Zap size={16} aria-hidden="true" />, badge: command.shortcut, note: command.hint, run: () => finish(command.run) });
    }
    for (const hit of data?.results ?? []) {
      const meta = KIND[hit.kind];
      if (!meta) continue;
      list.push({
        id: `${hit.kind}:${hit.id}`,
        group: data?.recent ? "recent" : meta.group,
        title: hit.title,
        subtitle: [meta.label, hit.project, hit.updated_at ? formatSince(hit.updated_at) : ""].filter(Boolean).join(" · "),
        snippet: hit.snippet,
        excerpt: hit.excerpt,
        icon: meta.icon,
        badge: hit.status,
        run: () => finish(() => tabs.open(hit.key, true)),
      });
    }
    for (const file of files) {
      const name = file.path.split("/").pop() || file.path;
      list.push({ id: `file:${file.rootKey}:${file.path}`, group: "file", title: name, subtitle: `${file.root} · ${file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "корень"}`, icon: <FileIcon size={16} aria-hidden="true" />, run: () => finish(() => tabs.open(`local:${file.rootKey}:${file.path}`, true)) });
    }
    if (trimmed && calc === null) {
      const engine = readBrowserSettings().search;
      const open = (url: string) => finish(() => { if (browserBridge()) tabs.open(browserTabKey(url), true); else window.open(url, "_blank", "noopener"); });
      if (URL_LIKE.test(trimmed)) {
        const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        list.push({ id: "web:open", group: "web", title: `Открыть ${trimmed}`, subtitle: "Адрес сайта", icon: <Globe size={16} aria-hidden="true" />, run: () => open(url) });
      }
      list.push({ id: "web:search", group: "web", title: `Искать «${trimmed}» в интернете`, subtitle: "Поиск в браузере", icon: <Search size={16} aria-hidden="true" />, run: () => open((SEARCH_URLS[engine] ?? SEARCH_URLS.duckduckgo)(encodeURIComponent(trimmed))) });
    }
    return list;
  }, [commands, data, files, finish, onClose, tabs, trimmed]);

  // Порядок на экране: лучшее совпадение, затем группы по порядку; каждая группа ограничена.
  const sections = useMemo(() => {
    const body = items.filter((item) => item.group !== "top");
    const top = items.find((item) => item.group === "top") ?? (trimmed ? body.find((item) => item.group !== "web" && item.group !== "file") : undefined);
    const rest = top ? body.filter((item) => item !== top) : body;
    const result: Array<{ id: string; label: string; items: Item[] }> = [];
    if (top) result.push({ id: "top", label: GROUPS[0].label, items: [top] });
    for (const group of GROUPS.slice(1)) {
      const inGroup = rest.filter((item) => item.group === group.id).slice(0, group.limit);
      if (inGroup.length) result.push({ id: group.id, label: group.label, items: inGroup });
    }
    return result;
  }, [items, trimmed]);

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const active = flat[Math.min(cursor, flat.length - 1)];

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, flat]);

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) { event.preventDefault(); setCursor((value) => (flat.length ? (value + 1) % flat.length : 0)); return; }
    if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) { event.preventDefault(); setCursor((value) => (flat.length ? (value - 1 + flat.length) % flat.length : 0)); return; }
    if (event.key === "Enter") { event.preventDefault(); active?.run(); return; }
    const digit = /^[1-9]$/.test(event.key) && (event.metaKey || event.ctrlKey) ? Number(event.key) - 1 : -1;
    if (digit >= 0 && flat[digit]) { event.preventDefault(); flat[digit].run(); }
  }

  if (!open) return null;
  const host = (document.querySelector(".wb") as HTMLElement | null) ?? document.body;
  const listId = "wb-spot-list";
  let index = -1;

  return createPortal(
    <div className="wb-spot-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="wb-spot" role="dialog" aria-modal="true" aria-label="Поиск по MBOX" onKeyDown={onKey}>
        <div className="wb-spot-field">
          <Search size={20} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по заметкам, документам, таблицам, задачам и файлам"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={active ? `wb-spot-opt-${Math.min(cursor, flat.length - 1)}` : undefined}
            aria-label="Поиск"
          />
          {copied && <span className="wb-spot-copied" role="status">Скопировано</span>}
          <kbd>Esc</kbd>
        </div>
        <div className={loading ? "wb-spot-progress is-on" : "wb-spot-progress"} aria-hidden="true" />
        <div className="wb-spot-body">
          <div className="wb-spot-list" ref={listRef} id={listId} role="listbox" aria-label="Результаты">
            {sections.map((section) => (
              <div className="wb-spot-section" key={section.id} role="group" aria-label={section.label}>
                <div className="wb-spot-head">{section.label}</div>
                {section.items.map((item) => {
                  index += 1;
                  const own = index;
                  return (
                    <div
                      key={item.id}
                      id={`wb-spot-opt-${own}`}
                      data-index={own}
                      role="option"
                      aria-selected={own === cursor}
                      className={own === cursor ? "wb-spot-row is-selected" : "wb-spot-row"}
                      onMouseMove={() => { if (own !== cursor) setCursor(own); }}
                      onClick={() => item.run()}
                    >
                      <span className="wb-spot-icon">{item.icon}</span>
                      <span className="wb-spot-text">
                        <span className="wb-spot-title">{highlight(item.title, stems)}</span>
                        {(item.snippet || item.subtitle) && <span className="wb-spot-sub">{item.snippet && trimmed ? highlight(item.snippet, stems) : item.subtitle}</span>}
                      </span>
                      {item.badge && <span className="wb-spot-badge">{item.badge}</span>}
                      {own < 9 && <kbd className="wb-spot-key">{`Ctrl ${own + 1}`}</kbd>}
                    </div>
                  );
                })}
              </div>
            ))}
            {!flat.length && !loading && (
              <div className="wb-spot-empty" role="status">{failed ? "Поиск сейчас недоступен. Проверьте соединение." : trimmed ? "Ничего не нашлось" : "Начните вводить"}</div>
            )}
            {failed && flat.length > 0 && <div className="wb-spot-note" role="alert">Часть результатов не загрузилась.</div>}
          </div>
          <aside className="wb-spot-preview" aria-label="Предпросмотр">
            {active ? (
              <>
                <div className="wb-spot-pv-icon" aria-hidden="true">{active.icon}</div>
                <h3>{active.group === "top" && active.id === "calc" ? active.title : highlight(active.title, stems)}</h3>
                {active.subtitle && <p className="wb-spot-pv-meta">{active.subtitle}</p>}
                {active.excerpt ? <p className="wb-spot-pv-text">{highlight(active.excerpt, stems)}</p> : active.note ? <p className="wb-spot-pv-text">{active.note}</p> : null}
                <div className="wb-spot-pv-open"><CornerDownLeft size={13} aria-hidden="true" /> Открыть</div>
              </>
            ) : <p className="wb-spot-pv-empty">Предпросмотр появится здесь</p>}
          </aside>
        </div>
        <div className="wb-spot-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span>
          <span><kbd>↵</kbd> открыть</span>
          <span><kbd>Ctrl</kbd><kbd>1–9</kbd> быстро</span>
          <span><kbd>Esc</kbd> закрыть</span>
        </div>
      </div>
    </div>,
    host,
  );
}
