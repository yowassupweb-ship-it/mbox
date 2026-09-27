import { Brain, Database, FileText, Files, Figma, Folder, GitBranch, Layers, Lightbulb, Link2, ListTodo, Newspaper, Rocket, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";

/**
 * Символы сущностей проекта — монохромные, одного размера, как в боковой панели Finder и проводнике VS Code.
 * Общие для дерева проектов (ExplorerView), вкладок и заголовка окна: сущность выглядит одинаково везде.
 * Раньше здесь стояли цветные PNG разных стилей и калибров.
 */
const TREE_GLYPHS: Record<string, LucideIcon> = {
  todos: ListTodo,
  git: GitBranch,
  figma: Figma,
  relations: Link2,
  properties: SlidersHorizontal,
  philosophy: Lightbulb,
  deploy: Rocket,
  stack: Layers,
  access: ShieldCheck,
  memories: Brain,
  sources: Database,
  files: Files,
  folder: Folder,
  posts: Newspaper,
  documents: FileText,
};

export function TreeGlyph({ kind, size = 16 }: { kind: string; size?: number }) {
  const Icon = TREE_GLYPHS[kind] || FileText;
  return <Icon className={`wb-tree-glyph is-${kind}`} size={size} strokeWidth={1.8} aria-hidden="true" />;
}

/** Символ папки проекта по её названию: «Посты», «Документы» — свои, остальные — папка. */
export function folderGlyph(name: string) {
  return name === "Посты" ? "posts" : name === "Документы" ? "documents" : "folder";
}
