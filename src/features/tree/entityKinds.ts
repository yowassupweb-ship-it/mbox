export type ProjectEntityKind = "relations" | "properties" | "philosophy" | "deploy" | "stack" | "access" | "git" | "figma" | "memories" | "sources";

const ICONS = "/assets/icons/icons";
const SYSTEM = "/assets/icons/system";

/** У каждой постоянной сущности проекта своё лицо: иконка и акцент. Иконки — растровые (см.
 * public/assets/icons/icons), не lucide: набор нарисован отдельно под MBOX. */
export const projectEntityKinds: Record<ProjectEntityKind, { image: string; accent: string; label: string }> = {
  git: { image: `${SYSTEM}/git.png`, accent: "#7ee2a8", label: "Git" },
  figma: { image: `${SYSTEM}/figma.png`, accent: "#f24e1e", label: "Figma" },
  relations: { image: `${SYSTEM}/relations.png`, accent: "#8ab4ff", label: "Связи" },
  properties: { image: `${SYSTEM}/properties.png`, accent: "#c9a6ff", label: "Свойства" },
  philosophy: { image: `${SYSTEM}/philosophy.png`, accent: "#ffd479", label: "Философия" },
  deploy: { image: `${ICONS}/деплой.png`, accent: "#ff9f7a", label: "Деплой" },
  stack: { image: `${ICONS}/стек.png`, accent: "#7cd8e8", label: "Стек" },
  access: { image: `${ICONS}/дсотуп.png`, accent: "#f2a0c0", label: "Доступ" },
  memories: { image: `${ICONS}/память.png`, accent: "#29e0d6", label: "Память" },
  sources: { image: `${ICONS}/источники.png`, accent: "#ffb454", label: "Источники" },
};

export function entityKindMeta(kind?: string) {
  return kind && kind in projectEntityKinds ? projectEntityKinds[kind as ProjectEntityKind] : null;
}
