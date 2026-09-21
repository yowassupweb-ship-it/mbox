import type { SectionKey } from "../types";

const NAVIGATION = "/assets/icons/navigation";
const SYSTEM = "/assets/icons/system";

// Сервер и Доступ раньше были двумя отдельными кнопками нижнего меню — задача свести их в одну
// «Настройки» стояла с самого начала переверстки и была не отменена, просто отложена.
export const sections: Array<{ key: SectionKey; label: string; image: string }> = [
  { key: "overview", label: "Обзор", image: `${NAVIGATION}/overview.png` },
  { key: "memories", label: "Память", image: `${NAVIGATION}/memory.png` },
  { key: "artifacts", label: "Артефакты", image: `${NAVIGATION}/artifacts.png` },
  { key: "projects", label: "Проекты", image: `${NAVIGATION}/projects.png` },
  { key: "abilities", label: "Умения", image: `${NAVIGATION}/skills.png` },
  { key: "history", label: "История", image: `${SYSTEM}/history.png` },
  { key: "settings", label: "Настройки", image: `${SYSTEM}/settings.png` },
];
