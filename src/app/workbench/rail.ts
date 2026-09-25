import { useEffect, useState } from "react";
import { scopedStorageKey } from "./tabs";

/**
 * Левое меню рабочего места (полоса разделов).
 *
 * Раньше кнопки перечислялись прямо в разметке Workbench сплошным столбиком: тринадцать иконок
 * подряд без единой паузы, и было не видно, что относится к проектам, а что к агентам. Теперь
 * состав описан здесь группами — Workbench рисует между группами разделитель, а «Настройки»
 * показывают тот же список галочками, чтобы лишние разделы можно было убрать.
 *
 * Идентификаторы попадают в localStorage, поэтому переименовывать их нельзя.
 */

export type RailItemId =
  | "explorer"
  | "notes"
  | "local"
  | "files"
  | "browser"
  | "search"
  | "storage"
  | "skills"
  | "tools"
  | "agents"
  | "ssh"
  | "history";

export type RailItem = {
  id: RailItemId;
  /** Подпись в подсказке и в настройках. */
  label: string;
  icon: string;
  /** Только в MBOX Desktop: в вебе рядом есть настоящий браузер. */
  desktopOnly?: boolean;
  /** Раздел нельзя выключить: без него до проектов не добраться. */
  required?: boolean;
};

const NAVIGATION = "/assets/icons/navigation";
const SYSTEM = "/assets/icons/system";

export const RAIL_GROUPS: Array<{ id: string; title: string; items: RailItem[] }> = [
  {
    id: "projects",
    title: "Проекты",
    items: [{ id: "explorer", label: "Проекты (Ctrl+Shift+E)", icon: `${NAVIGATION}/projects.png`, required: true }],
  },
  {
    id: "documents",
    title: "Документы",
    items: [
      { id: "notes", label: "Заметки (Ctrl+Alt+N — новая)", icon: `${NAVIGATION}/notes.png` },
      { id: "local", label: "Папки (локальные файлы и git)", icon: `${NAVIGATION}/folders.png` },
      { id: "files", label: "Артефакты", icon: `${NAVIGATION}/artifacts.png` },
      { id: "browser", label: "Браузер", icon: "/assets/icons/files/browser-file.png", desktopOnly: true },
    ],
  },
  {
    id: "memory",
    title: "Память и хранилище",
    items: [
      { id: "search", label: "Поиск по памяти (Ctrl+K)", icon: `${NAVIGATION}/memory.png` },
      { id: "storage", label: "Хранилище S3", icon: `${NAVIGATION}/storage.png` },
    ],
  },
  {
    id: "abilities",
    title: "Навыки и инструменты",
    items: [
      { id: "skills", label: "Навыки", icon: `${NAVIGATION}/skills.png` },
      { id: "tools", label: "Инструменты", icon: `${NAVIGATION}/tools.png` },
    ],
  },
  {
    id: "agents",
    title: "Агенты",
    items: [
      { id: "agents", label: "Агенты", icon: `${NAVIGATION}/agents.png` },
      { id: "ssh", label: "SSH", icon: "/assets/icons/project/ssh.png" },
      { id: "history", label: "История", icon: `${SYSTEM}/history.png` },
    ],
  },
];

export const RAIL_ITEMS: RailItem[] = RAIL_GROUPS.flatMap((group) => group.items);

export const RAIL_HIDDEN_KEY = "mbox.wb.rail.hidden";

/**
 * Состав полосы читают сразу двое — сама полоса и страница настроек, — поэтому одного
 * localStorage мало: галочка в настройках должна убирать кнопку сразу, без перезагрузки.
 * Значение живёт здесь, а подписчики узнают о правке событием.
 */
const RAIL_EVENT = "mbox:rail-hidden";

function readHidden(): RailItemId[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(scopedStorageKey(RAIL_HIDDEN_KEY)) || "[]");
    return Array.isArray(raw) ? (raw as RailItemId[]) : [];
  } catch {
    return [];
  }
}

export function setRailHidden(next: RailItemId[]) {
  try {
    window.localStorage.setItem(scopedStorageKey(RAIL_HIDDEN_KEY), JSON.stringify(next));
  } catch {
    // приватный режим — настройка не переживёт перезагрузку, но в этой сессии работает
  }
  window.dispatchEvent(new CustomEvent(RAIL_EVENT, { detail: next }));
}

export function useRailHidden(): RailItemId[] {
  const [hidden, setHidden] = useState<RailItemId[]>(readHidden);
  useEffect(() => {
    const listener = (event: Event) => setHidden((event as CustomEvent<RailItemId[]>).detail || []);
    window.addEventListener(RAIL_EVENT, listener);
    return () => window.removeEventListener(RAIL_EVENT, listener);
  }, []);
  return hidden;
}
