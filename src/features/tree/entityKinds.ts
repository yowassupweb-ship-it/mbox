import { Brain, Figma, GitBranch, Layers, Link2, Rocket, ShieldCheck, Sliders, Sparkles, type LucideIcon } from "lucide-react";

export type ProjectEntityKind = "relations" | "properties" | "philosophy" | "deploy" | "stack" | "access" | "git" | "figma" | "memories";

/** У каждой постоянной сущности проекта своё лицо: иконка и акцент. Раньше все восемь были одинаковой папкой. */
export const projectEntityKinds: Record<ProjectEntityKind, { icon: LucideIcon; accent: string; label: string }> = {
  git: { icon: GitBranch, accent: "#7ee2a8", label: "Git" },
  figma: { icon: Figma, accent: "#f24e1e", label: "Figma" },
  relations: { icon: Link2, accent: "#8ab4ff", label: "Связи" },
  properties: { icon: Sliders, accent: "#c9a6ff", label: "Свойства" },
  philosophy: { icon: Sparkles, accent: "#ffd479", label: "Философия" },
  deploy: { icon: Rocket, accent: "#ff9f7a", label: "Деплой" },
  stack: { icon: Layers, accent: "#7cd8e8", label: "Стек" },
  access: { icon: ShieldCheck, accent: "#f2a0c0", label: "Доступ" },
  memories: { icon: Brain, accent: "#29e0d6", label: "Воспоминания" },
};

export function entityKindMeta(kind?: string) {
  return kind && kind in projectEntityKinds ? projectEntityKinds[kind as ProjectEntityKind] : null;
}
