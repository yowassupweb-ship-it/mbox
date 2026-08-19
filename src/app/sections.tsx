import { BookOpen, FileCode2, FolderKanban, GitBranch, History, Library, Settings, type LucideIcon } from "lucide-react";
import type { SectionKey } from "../types";

// Сервер и Доступ раньше были двумя отдельными кнопками нижнего меню — задача свести их в одну
// «Настройки» стояла с самого начала переверстки и была не отменена, просто отложена.
export const sections: Array<{ key: SectionKey; label: string; icon: LucideIcon }> = [
  { key: "overview", label: "Обзор", icon: Library },
  { key: "memories", label: "Память", icon: BookOpen },
  { key: "artifacts", label: "Артефакты", icon: FileCode2 },
  { key: "projects", label: "Проекты", icon: FolderKanban },
  { key: "graph", label: "Граф", icon: GitBranch },
  { key: "history", label: "История", icon: History },
  { key: "settings", label: "Настройки", icon: Settings },
];
