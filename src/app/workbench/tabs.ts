import { useCallback, useEffect, useState } from "react";

/**
 * Ключ вкладки — адрес сущности:
 * welcome | artifacts | abilities | history | settings | agents
 * todos:<projectId> | entity:<projectId>:<kind> | folder:<projectId>:<folderId>
 * todo:<todoId> | memory:<memoryId> | memory:new
 */
export type TabRef = { key: string; pinned: boolean };
type TabsState = { tabs: TabRef[]; active: string };

import { isIncognitoKey } from "./incognito";

const STORAGE_KEY = "mbox.workbench.tabs.v1";
const MAX_TABS = 24;
let storageUser = "anonymous";

export function setWorkbenchStorageUser(username: string) {
  const normalized = String(username || "anonymous").trim().toLowerCase().replace(/[^a-z0-9_.@-]+/g, "-").replace(/^-+|-+$/g, "");
  storageUser = normalized || "anonymous";
}

export function scopedStorageKey(key: string) {
  return `${key}.user.${storageUser}`;
}

const legacySections: Record<string, string> = {
  overview: "welcome",
  artifacts: "artifacts",
  abilities: "abilities",
  tools: "abilities",
  skills: "abilities",
  history: "history",
  settings: "settings",
  server: "settings",
};

/** Старые адреса (/projects?node=1:todo, /history, …) по-прежнему открывают нужное — вкладкой. */
export function tabFromLocation(): string {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab) return decodeTabParam(tab);
  const section = window.location.pathname.split("/").filter(Boolean)[0] || "";
  const node = params.get("node") || "";
  if (section === "projects" && node) {
    const [projectId, view, folderId] = node.split(":");
    if (projectId) {
      if (view === "folder" && folderId) return `folder:${projectId}:${folderId}`;
      if (!view || view === "todo") return `todos:${projectId}`;
      return `entity:${projectId}:${view}`;
    }
  }
  return legacySections[section] || "";
}

function readStored(): TabsState {
  try {
    const raw = JSON.parse(window.localStorage.getItem(scopedStorageKey(STORAGE_KEY)) || "null");
    if (raw && Array.isArray(raw.tabs)) {
      const tabs = raw.tabs.filter((tab: TabRef) => tab && typeof tab.key === "string" && !["memory:new", "file:new", "agents"].includes(tab.key) && !isIncognitoKey(tab.key));
      const active = String(raw.active || "");
      return { tabs, active: isIncognitoKey(active) ? "" : active };
    }
  } catch {
    // пустое хранилище или приватный режим — начинаем с чистого листа
  }
  return { tabs: [], active: "" };
}

function initialState(): TabsState {
  const stored = readStored();
  const fromUrl = tabFromLocation();
  const tabs = [...stored.tabs];
  if (fromUrl && !tabs.some((tab) => tab.key === fromUrl)) tabs.push({ key: fromUrl, pinned: true });
  const active = fromUrl || (tabs.some((tab) => tab.key === stored.active) ? stored.active : tabs[0]?.key ?? "");
  return { tabs, active };
}

export function useTabs() {
  const [state, setState] = useState<TabsState>(initialState);

  useEffect(() => {
    try {
      const persisted = { tabs: state.tabs.filter((tab) => !isIncognitoKey(tab.key)), active: isIncognitoKey(state.active) ? "" : state.active };
      window.localStorage.setItem(scopedStorageKey(STORAGE_KEY), JSON.stringify(persisted));
    } catch {
      // не критично: вкладки просто не переживут перезагрузку
    }
    // «.svg» в строке запроса dev-сервер Vite принимает за обращение к файлу и отвечает 403 (в том числе
    // в закодированном виде) — такую вкладку в адрес не пишем: после перезагрузки она откроется из localStorage.
    const url = state.active && !isIncognitoKey(state.active) && !/\.svg/i.test(state.active) ? `/?tab=${encodeTabParam(state.active)}` : "/";
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState({}, "", url);
  }, [state]);

  /** Одиночный клик открывает «предпросмотр» — он переиспользует единственную незакреплённую
   * вкладку, как в VS Code, чтобы пролистывание дерева не плодило десятки вкладок. */
  const open = useCallback((key: string, pin = false) => {
    setState((current) => {
      const existing = current.tabs.find((tab) => tab.key === key);
      if (existing) {
        const tabs = pin && !existing.pinned ? current.tabs.map((tab) => (tab.key === key ? { ...tab, pinned: true } : tab)) : current.tabs;
        return { tabs, active: key };
      }
      const next = { key, pinned: pin };
      const previewIndex = current.tabs.findIndex((tab) => !tab.pinned);
      if (!pin && previewIndex >= 0) {
        const tabs = [...current.tabs];
        tabs[previewIndex] = next;
        return { tabs, active: key };
      }
      const tabs = [...current.tabs];
      tabs.splice(tabs.findIndex((tab) => tab.key === current.active) + 1, 0, next);
      while (tabs.length > MAX_TABS) {
        const dropIndex = tabs.findIndex((tab) => tab.key !== key);
        tabs.splice(dropIndex, 1);
      }
      return { tabs, active: key };
    });
  }, []);

  const close = useCallback((key: string) => {
    setState((current) => {
      const index = current.tabs.findIndex((tab) => tab.key === key);
      if (index < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.key !== key);
      if (current.active !== key) return { tabs, active: current.active };
      const neighbour = tabs[index] ?? tabs[index - 1];
      return { tabs, active: neighbour?.key ?? "" };
    });
  }, []);

  const closeOthers = useCallback((key: string) => {
    setState((current) => ({ tabs: current.tabs.filter((tab) => tab.key === key), active: key }));
  }, []);

  /** Закрыть вкладки правее этой; закреплённые остаются. */
  const closeRight = useCallback((key: string) => {
    setState((current) => {
      const index = current.tabs.findIndex((tab) => tab.key === key);
      if (index < 0) return current;
      const tabs = current.tabs.filter((tab, at) => at <= index || tab.pinned);
      return { tabs, active: tabs.some((tab) => tab.key === current.active) ? current.active : key };
    });
  }, []);

  const pin = useCallback((key: string) => {
    setState((current) => ({ ...current, tabs: current.tabs.map((tab) => (tab.key === key ? { ...tab, pinned: true } : tab)) }));
  }, []);

  /** memory:new после сохранения становится memory:<id> на том же месте. */
  const replace = useCallback((from: string, to: string) => {
    setState((current) => {
      const tabs = current.tabs
        .filter((tab) => tab.key !== to)
        .map((tab) => (tab.key === from ? { key: to, pinned: true } : tab));
      return { tabs, active: current.active === from ? to : current.active };
    });
  }, []);

  const move = useCallback((key: string, beforeKey: string) => {
    setState((current) => {
      if (key === beforeKey) return current;
      const moving = current.tabs.find((tab) => tab.key === key);
      if (!moving) return current;
      const tabs = current.tabs.filter((tab) => tab.key !== key);
      const index = tabs.findIndex((tab) => tab.key === beforeKey);
      tabs.splice(index < 0 ? tabs.length : index, 0, moving);
      return { ...current, tabs };
    });
  }, []);

  return { tabs: state.tabs, active: state.active, open, close, closeOthers, closeRight, pin, replace, move };
}

export type TabsApi = ReturnType<typeof useTabs>;

export function encodeTabParam(key: string): string {
  return encodeURIComponent(key);
}

function decodeTabParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function projectIdOfTab(key: string): string | undefined {
  const [kind, projectId] = key.split(":");
  return ["todos", "entity", "folder"].includes(kind) ? projectId : undefined;
}

/** Состояние раскладки, которое переживает перезагрузку: ширины, высоты, что открыто. */
export function usePersistentState<T>(key: string, fallback: T, persistable: (value: T) => T = (value) => value) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(scopedStorageKey(key));
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(scopedStorageKey(key), JSON.stringify(persistable(value)));
    } catch {
      // приватный режим — живём без памяти раскладки
    }
    // persistable — чистая функция-фильтр, её идентичность на сохранение не влияет
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);
  return [value, setValue] as const;
}
