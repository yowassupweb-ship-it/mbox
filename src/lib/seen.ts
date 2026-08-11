/**
 * Отметки «просмотрено» для сущностей MBOX.
 *
 * Механизм заимствован у Memora (memories_events с флагом consumed) и обобщён на любую сущность.
 * Хранилище — таблица seen_marks в базе, привязанная к пользователю, поэтому непрочитанное
 * одинаково на телефоне и на десктопе. localStorage остался кешем: он даёт мгновенную отрисовку
 * до ответа сервера и не даёт экрану ослепнуть, если сервер недоступен.
 *
 * Точного «+строк / −строк» из этого не выйдет: сравнивается размер сущности на момент просмотра
 * с текущим, то есть получается одно знаковое число, а не пара «добавлено / удалено».
 */

const CACHE_KEY = "mbox.seen.v1";

type SeenEntry = { bytes: number; at: number };
type SeenMap = Record<string, SeenEntry>;

let memory: SeenMap = readCache();
let loaded = false;

const listeners = new Set<() => void>();

export function onSeenChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of listeners) listener();
}

function readCache(): SeenMap {
  try {
    return JSON.parse(window.localStorage.getItem(CACHE_KEY) || "{}") as SeenMap;
  } catch {
    return {};
  }
}

function writeCache() {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(memory));
  } catch {
    // приватный режим или переполненное хранилище — живём на серверных отметках
  }
}

function keyOf(entityType: string, entityId: string) {
  return `${entityType}:${entityId}`;
}

/** Тянет отметки из базы. Вызывается один раз при старте рабочей области. */
export async function loadSeen() {
  if (loaded) return;
  loaded = true;
  try {
    const res = await fetch("/api/mbox/seen");
    if (!res.ok) return;
    const data = (await res.json()) as { marks: Array<{ entity_type: string; entity_id: string; seen_bytes: number; seen_at: string }> };
    for (const mark of data.marks) {
      memory[keyOf(mark.entity_type, mark.entity_id)] = { bytes: Number(mark.seen_bytes) || 0, at: Date.parse(mark.seen_at) || 0 };
    }
    writeCache();
    notify();
  } catch {
    // сервер недоступен — работаем на кеше
  }
}

function push(marks: Array<{ entity_type: string; entity_id: string; bytes: number }>) {
  // Пачкой: у сервера нет пула соединений, каждый запрос открывает свой клиент к базе.
  void fetch("/api/mbox/seen", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marks }),
  }).catch(() => undefined);
}

export function markSeen(key: string, bytes: number) {
  const [entityType, entityId] = key.split(":");
  memory[key] = { bytes, at: Date.now() };
  writeCache();
  notify();
  push([{ entity_type: entityType, entity_id: entityId, bytes }]);
}

export function markAllSeen(items: Array<{ key: string; bytes: number }>) {
  const at = Date.now();
  for (const item of items) memory[item.key] = { bytes: item.bytes, at };
  writeCache();
  notify();
  push(items.map((item) => {
    const [entityType, entityId] = item.key.split(":");
    return { entity_type: entityType, entity_id: entityId, bytes: item.bytes };
  }));
}

/**
 * Первый запуск: отметок нет ни в базе, ни в кеше. Без этого всё существующее показалось бы новым
 * разом, и признак потерял бы смысл. Гасим то, что уже есть, — «новым» дальше будет только новое.
 */
export function bootstrapSeen(items: Array<{ key: string; bytes: number }>) {
  if (!loaded || Object.keys(memory).length) return false;
  markAllSeen(items);
  return true;
}

export type SeenDelta = { state: "new" | "changed" | "seen"; delta: number };

export function seenDelta(key: string, bytes: number): SeenDelta {
  const entry = memory[key];
  if (!entry) return { state: "new", delta: bytes };
  const delta = bytes - entry.bytes;
  return delta === 0 ? { state: "seen", delta: 0 } : { state: "changed", delta };
}

export function countUnseen(items: Array<{ key: string; bytes: number }>) {
  return items.filter((item) => {
    const entry = memory[item.key];
    return !entry || entry.bytes !== item.bytes;
  }).length;
}

export function formatDelta(delta: number) {
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`;
}
