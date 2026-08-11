import { BookOpen, FileCode2, FolderKanban, GitBranch, History, Library, Server, ShieldCheck, type LucideIcon } from "lucide-react";
import type { SectionKey } from "../types";

export const sections: Array<{ key: SectionKey; label: string; icon: LucideIcon }> = [
  { key: "overview", label: "Обзор", icon: Library },
  { key: "memories", label: "Память", icon: BookOpen },
  { key: "artifacts", label: "Артефакты", icon: FileCode2 },
  { key: "projects", label: "Проекты", icon: FolderKanban },
  { key: "graph", label: "Граф", icon: GitBranch },
  { key: "history", label: "История", icon: History },
  { key: "server", label: "Сервер", icon: Server },
  { key: "settings", label: "Доступ", icon: ShieldCheck },
];
