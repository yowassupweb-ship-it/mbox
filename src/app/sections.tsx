import type { SectionKey } from "../types";

const ICONS = "/assets/icons/bottom-menu";

// Сервер и Доступ раньше были двумя отдельными кнопками нижнего меню — задача свести их в одну
// «Настройки» стояла с самого начала переверстки и была не отменена, просто отложена.
export const sections: Array<{ key: SectionKey; label: string; image: string }> = [
  { key: "overview", label: "Обзор", image: `${ICONS}/обзор.png` },
  { key: "memories", label: "Память", image: `${ICONS}/память.png` },
  { key: "artifacts", label: "Артефакты", image: `${ICONS}/артефакты.png` },
  { key: "projects", label: "Проекты", image: `${ICONS}/проекты.png` },
  { key: "graph", label: "Граф", image: `${ICONS}/граф.png` },
  { key: "history", label: "История", image: `${ICONS}/история.png` },
  { key: "settings", label: "Настройки", image: `${ICONS}/настройки.png` },
];
