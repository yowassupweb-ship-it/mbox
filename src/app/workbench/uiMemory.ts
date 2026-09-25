import { useCallback, useEffect, useRef, useState } from "react";
import { scopedStorageKey } from "./tabs";

/**
 * Локальная память интерфейса сверх раскладки (usePersistentState):
 *  - useRemembered — выбор, привязанный к конкретной сущности (режим «просмотр/правка» у заметки №5);
 *  - useDraft — несохранённый ввод, который переживает перезагрузку и закрытие окна;
 *  - installScrollMemory — позиции прокрутки всех областей рабочего места.
 * Всё лежит в localStorage корзинами с ограничением числа записей: старые вытесняются первыми.
 */

type Entry<T> = { v: T; t: number };
type Bucket<T> = Record<string, Entry<T>>;

const LIMITS: Record<string, number> = { "mbox.ui.remembered": 400, "mbox.ui.drafts": 150, "mbox.ui.scroll": 400 };
// Черновик больше этого в localStorage не кладём: квота браузера ~5 МБ на всё приложение.
const MAX_DRAFT_CHARS = 200_000;

function readBucket<T>(name: string): Bucket<T> {
  try {
    const raw = window.localStorage.getItem(scopedStorageKey(name));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeEntry<T>(name: string, id: string, value: T | undefined) {
  try {
    const bucket = readBucket<T>(name);
    if (value === undefined) delete bucket[id];
    else bucket[id] = { v: value, t: Date.now() };
    const keys = Object.keys(bucket);
    const limit = LIMITS[name] ?? 200;
    if (keys.length > limit) {
      keys.sort((a, b) => bucket[a].t - bucket[b].t).slice(0, keys.length - limit).forEach((key) => delete bucket[key]);
    }
    window.localStorage.setItem(scopedStorageKey(name), JSON.stringify(bucket));
  } catch {
    // квота или приватный режим — живём без памяти
  }
}

function readEntry<T>(name: string, id: string): T | undefined {
  return readBucket<T>(name)[id]?.v;
}

/** Выбор для конкретной сущности. fallback — то, что было бы без памяти (может зависеть от содержимого). */
export function useRemembered<T>(id: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readEntry<T>("mbox.ui.remembered", id) ?? fallback);
  const idRef = useRef(id);
  useEffect(() => {
    if (idRef.current === id) return;
    idRef.current = id;
    setValue(readEntry<T>("mbox.ui.remembered", id) ?? fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const set = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
      writeEntry("mbox.ui.remembered", idRef.current, resolved);
      return resolved;
    });
  }, []);
  return [value, set] as const;
}

function sameValue(a: unknown, b: unknown) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Несохранённый ввод. base — сохранённое значение: пока ввод с ним совпадает, черновика нет.
 * Черновик, отличный от base, восстанавливается после перезагрузки. discard — забыть (после сохранения).
 */
export function useDraft<T>(id: string, base: T) {
  const [value, setValue] = useState<T>(() => readEntry<T>("mbox.ui.drafts", id) ?? base);
  const idRef = useRef(id);
  const baseRef = useRef(base);
  baseRef.current = base;
  useEffect(() => {
    if (idRef.current === id) return;
    idRef.current = id;
    setValue(readEntry<T>("mbox.ui.drafts", id) ?? baseRef.current);
  }, [id]);
  const set = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
      const tooBig = typeof resolved === "string" ? resolved.length > MAX_DRAFT_CHARS : JSON.stringify(resolved).length > MAX_DRAFT_CHARS;
      writeEntry("mbox.ui.drafts", idRef.current, sameValue(resolved, baseRef.current) || tooBig ? undefined : resolved);
      return resolved;
    });
  }, []);
  /** Сбросить на base (или на переданное значение) и забыть черновик. */
  const discard = useCallback((to?: T) => {
    writeEntry("mbox.ui.drafts", idRef.current, undefined);
    setValue(to === undefined ? baseRef.current : to);
  }, []);
  return [value, set, discard] as const;
}

/** Есть ли сохранённый черновик — чтобы, например, сразу открыть документ в режиме правки. */
export function hasDraft(id: string) {
  return readEntry("mbox.ui.drafts", id) !== undefined;
}

// --- Прокрутка ----------------------------------------------------------------------------------
//
// Ключ области — ближайший предок с data-scroll-scope (вкладка, раздел боковой панели, вкладка нижней
// панели) плюс путь от него до прокручиваемого элемента. Логи, которые сами держатся у нижнего края
// (role="log", терминал), и области с data-scroll-memory="off" не трогаем.

const restored = new WeakSet<Element>();
let installed = false;

function classKey(node: Element) {
  return typeof node.className === "string" ? node.className.split(/\s+/).filter((name) => name && !name.startsWith("is-") && !name.startsWith("has-")).join(".") : "";
}

function segmentOf(node: Element, parent: Element) {
  const cls = classKey(node);
  const same = [...parent.children].filter((child) => child.tagName === node.tagName && classKey(child) === cls);
  return `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${same.length > 1 ? `#${same.indexOf(node)}` : ""}`;
}

function scrollKey(el: Element): string | null {
  if (el.closest('[data-scroll-memory="off"], [role="log"], .xterm')) return null;
  const scope = el.closest<HTMLElement>("[data-scroll-scope]");
  if (!scope) return null;
  const parts: string[] = [];
  let node: Element = el;
  while (node !== scope) {
    const parent = node.parentElement;
    if (!parent) return null;
    parts.unshift(segmentOf(node, parent));
    node = parent;
  }
  return `${scope.dataset.scrollScope}|${parts.join(">")}`;
}

/** Обратный путь: от раздела по сегментам к элементу. Не нашли — содержимое ещё не отрисовано. */
function resolve(scope: Element, path: string): HTMLElement | null {
  let node: Element | null = scope;
  for (const part of path ? path.split(">") : []) {
    const current: Element = node;
    node = [...current.children].find((child) => segmentOf(child, current) === part) ?? null;
    if (!node) return null;
  }
  return node instanceof HTMLElement ? node : null;
}

// Разбор корзины на каждый кадр с изменениями DOM (чат обновляется часто) — дорого; держим копию в памяти.
let scrollCache: Bucket<{ top: number; left: number }> | null = null;
/**
 * Ключи, которые ещё не удалось применить.
 *
 * Раньше на каждое изменение DOM перебирались ВСЕ сохранённые ключи (их до 400) по всем областям,
 * и для каждого читались clientHeight/scrollHeight — то есть браузер принудительно считал раскладку
 * десятки раз подряд, пока в чате бежали сообщения. Отсюда и «мини-фризы». Теперь ключ выбывает из
 * работы, как только применён (или стало ясно, что область его не ждёт), а когда выбыли все —
 * восстановление не делает вообще ничего.
 */
let pendingScrollKeys: Set<string> | null = null;

function restoreAll() {
  if (!scrollCache) { scrollCache = readBucket<{ top: number; left: number }>("mbox.ui.scroll"); pendingScrollKeys = null; }
  const saved = scrollCache;
  if (!pendingScrollKeys) pendingScrollKeys = new Set(Object.keys(saved));
  const pending = pendingScrollKeys;
  if (!pending.size) return;
  const scopes = document.querySelectorAll<HTMLElement>("[data-scroll-scope]");
  if (!scopes.length) return;
  scopes.forEach((scope) => {
    const prefix = `${scope.dataset.scrollScope}|`;
    for (const key of pending) {
      if (!key.startsWith(prefix)) continue;
      const el = resolve(scope, key.slice(prefix.length));
      if (!el) continue;
      if (restored.has(el)) { pending.delete(key); continue; }
      // Ключ мог сохраниться до того, как область пометили исключением (лог чата, терминал) — не трогаем.
      if (!scrollKey(el)) { restored.add(el); pending.delete(key); continue; }
      if (!el.clientHeight && !el.clientWidth) continue; // скрытая вкладка — восстановим, когда покажут
      const { top, left } = saved[key].v;
      // Содержимое ещё догружается — дождёмся следующего изменения DOM.
      if (el.scrollHeight - el.clientHeight < top - 2 || el.scrollWidth - el.clientWidth < left - 2) continue;
      el.scrollTop = top;
      el.scrollLeft = left;
      restored.add(el);
      pending.delete(key);
    }
  });
}

export function installScrollMemory() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const timers = new Map<string, number>();
  document.addEventListener("scroll", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    // Человек прокрутил сам — поверх его прокрутки больше не восстанавливаем.
    restored.add(el);
    const key = scrollKey(el);
    if (!key) return;
    window.clearTimeout(timers.get(key));
    timers.set(key, window.setTimeout(() => {
      timers.delete(key);
      writeEntry("mbox.ui.scroll", key, el.scrollTop || el.scrollLeft ? { top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft) } : undefined);
      scrollCache = null;
    }, 250));
  }, true);

  // Списки и документы догружаются асинхронно, вкладки показываются снятием hidden — пробуем
  // после того, как правки DOM улеглись. Раньше это был requestAnimationFrame, то есть работа
  // с раскладкой в каждом кадре, пока в чате идут сообщения; задержка в 200 мс незаметна глазу,
  // а кадр во время прокрутки освобождает целиком.
  let timer = 0;
  const schedule = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      restoreAll();
    }, 200);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  schedule();
}
