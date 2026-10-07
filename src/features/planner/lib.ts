import { useSyncExternalStore } from "react";
import { ENTITY_CHANGED_EVENT, REALTIME_OPEN_EVENT } from "../../hooks/useRealtime";

/**
 * Опора перенесённого из shar-2 планировщика: крошечный стор с тем же API, что у zustand (create → хук с селектором,
 * getState/setState), видимая часть окна для меню и подписка на realtime MBOX. Экраны shar-2 остались почти как были.
 */

type SetState<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void;
export type Store<T> = {
  <S>(selector: (state: T) => S): S;
  getState: () => T;
  setState: SetState<T>;
  subscribe: (listener: () => void) => () => void;
};

export function create<T extends object>(init: () => T): Store<T> {
  let state = init();
  const listeners = new Set<() => void>();
  const getState = () => state;
  const setState: SetState<T> = (partial) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  // Селектор возвращает срез состояния; useSyncExternalStore сравнивает по ссылке, срезы из стора стабильны.
  const useStore = (<S,>(selector: (s: T) => S) => useSyncExternalStore(subscribe, () => selector(state), () => selector(state))) as Store<T>;
  useStore.getState = getState;
  useStore.setState = setState;
  useStore.subscribe = subscribe;
  return useStore;
}

/** Видимая часть окна: на телефоне низ закрыт клавиатурой — меню не должно под неё уходить. */
export function visibleBox(): { top: number; bottom: number; width: number } {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return { top: 0, bottom: window.innerHeight, width: window.innerWidth };
  return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height, width: vv.width };
}

/**
 * Изменения с сервера: какая сущность изменилась (todos, calendar_events) или resync после переподключения сокета,
 * когда события могли потеряться. Пустая сущность — «что-то изменилось», перечитать стоит всё.
 */
export function onPlannerChange(entities: string[], listener: () => void): () => void {
  const changed = (event: Event) => {
    const entity = String((event as CustomEvent).detail || "");
    if (!entity || entities.includes(entity)) listener();
  };
  window.addEventListener(ENTITY_CHANGED_EVENT, changed);
  window.addEventListener(REALTIME_OPEN_EVENT, listener);
  return () => {
    window.removeEventListener(ENTITY_CHANGED_EVENT, changed);
    window.removeEventListener(REALTIME_OPEN_EVENT, listener);
  };
}

/** Корень оверлеев (меню, листы, диалоги): один на документ, вне вкладок — скрытая вкладка не прячет меню. */
export function overlayRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let root = document.getElementById("planner-overlays");
  if (!root) {
    root = document.createElement("div");
    root.id = "planner-overlays";
    root.className = "nx";
    document.body.append(root);
  }
  return root;
}

export async function plannerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) throw new Error(`planner_${response.status}`);
  return response.json() as Promise<T>;
}
