import type { FolderTreeNode } from "../components/FolderTree";
import type { Artifact, FolderRow, Project, Todo } from "../types";
import { formatBytes, plural } from "./format";
import { todoPriorityLabel, todoStatusLabel } from "./labels";

const containerTypes = new Set(["folder", "project", "todo_group"]);

export function sortTodos(todos: Todo[]) {
  const statusWeight: Record<string, number> = { doing: 0, next: 1, open: 2, blocked: 3, review: 4, done: 8, archived: 9 };
  const priorityWeight: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...todos].sort((a, b) => (statusWeight[a.status] ?? 5) - (statusWeight[b.status] ?? 5) || (priorityWeight[a.priority] ?? 2) - (priorityWeight[b.priority] ?? 2));
}

/**
 * Ручной порядок карточек todo. Колонки под него в схеме нет, поэтому позиция живёт в props.position.
 * Позиции дробные с большими зазорами: перетаскивание меняет одну запись, а не пересчитывает весь список.
 */
export const TODO_POSITION_GAP = 1000;

export function todoPosition(todo: Todo, fallbackIndex: number) {
  const raw = Number(todo.props?.position);
  return Number.isFinite(raw) ? raw : (fallbackIndex + 1) * TODO_POSITION_GAP;
}

const priorityWeight: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * Порядок по умолчанию: приоритет, затем время добавления.
 * Отдельного created_at у todo в API нет, поэтому временем считается id — он serial, растёт с добавлением.
 * Завершённые и архивные всегда внизу, иначе доска забивается сделанным.
 */
export function defaultTodoOrder(todos: Todo[]) {
  return [...todos].sort((a, b) => {
    const doneA = ["done", "archived"].includes(a.status) ? 1 : 0;
    const doneB = ["done", "archived"].includes(b.status) ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    const byPriority = (priorityWeight[a.priority] ?? 2) - (priorityWeight[b.priority] ?? 2);
    if (byPriority) return byPriority;
    return Number(a.id) - Number(b.id);
  });
}

/** Ручной порядок перебивает сортировку по умолчанию — но только для карточек, которые двигали. */
export function orderTodos(todos: Todo[]) {
  const base = defaultTodoOrder(todos);
  return [...base].sort((a, b) => todoPosition(a, base.indexOf(a)) - todoPosition(b, base.indexOf(b)));
}

/** Позиция для карточки, вставшей между соседями. Края получают отступ на зазор. */
export function positionBetween(before?: number, after?: number) {
  if (before == null && after == null) return TODO_POSITION_GAP;
  if (before == null) return after! - TODO_POSITION_GAP;
  if (after == null) return before + TODO_POSITION_GAP;
  return (before + after) / 2;
}

export function parseProps(value: string) {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
        if (separator === -1) return [line, ""] as const;
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
      })
      .filter(([key]) => key),
  );
}

export function formatProps(props: Record<string, string>) {
  return Object.entries(props || {}).map(([key, value]) => `${key}: ${value}`).join("\n");
}

export function countContained(nodes: FolderTreeNode[] | undefined): number {
  if (!nodes) return 0;
  return nodes.reduce((sum, node) => sum + 1 + countContained(node.children), 0);
}

export function rollupBytes(nodes: FolderTreeNode[]): FolderTreeNode[] {
  return nodes.map((node) => {
    const children = node.children ? rollupBytes(node.children) : node.children;
    const total = (node.bytes || 0) + (children || []).reduce((sum, child) => sum + (child.total_bytes || 0), 0);
    if (!containerTypes.has(node.type || "")) return { ...node, children, total_bytes: total };
    const items = countContained(children);
    const size = `${items} ${plural(items, "элемент", "элемента", "элементов")} · ${formatBytes(total)}`;
    return { ...node, children, total_bytes: total, meta: node.meta ? `${node.meta} · ${size}` : size };
  });
}

export function buildArtifactTree(artifacts: Artifact[], folders: FolderRow[]): FolderTreeNode[] {
  const baseFolders = folders
    .filter((folder) => folder.entity_type === "artifact")
    .map((folder) => ({ id: folder.id, type: "folder" as const, name: folder.name, bytes: folder.memory_bytes, color: folder.color, children: [] as FolderTreeNode[] }));

  const byCategory = new Map<string, FolderTreeNode>();
  for (const folder of baseFolders) byCategory.set(folder.name, folder);
  for (const artifact of artifacts) {
    const category = artifact.category || "Other";
    if (!byCategory.has(category)) byCategory.set(category, { type: "folder", name: category, bytes: 0, children: [] });
    byCategory.get(category)!.children!.push({
      id: artifact.id,
      type: "artifact",
      name: artifact.name,
      note: artifact.content,
      bytes: artifact.memory_bytes,
      meta: `${artifact.version} · ${artifact.status} · ${formatBytes(artifact.memory_bytes)}`,
    });
  }
  return rollupBytes(Array.from(byCategory.values()));
}

export function projectToTree(project: Project): FolderTreeNode {
  const sortedTodos = sortTodos(project.todos);
  const openTodos = sortedTodos.filter((todo) => !["done", "archived"].includes(todo.status)).length;
  const relatedNames = project.relations.map((relation) => relation.from_project_id === project.id ? relation.to_project_name : relation.from_project_name);
  return {
    id: project.id,
    type: "project",
    name: project.name,
    meta: project.status,
    bytes: project.memory_bytes,
    color: project.color,
    children: [
      { id: project.id, type: "todo_group", name: `Todo (${openTodos})`, color: "#28466d", children: sortedTodos.map((todo) => ({ id: todo.id, type: "todo" as const, name: todo.title, note: todo.note, status: todo.status, priority: todo.priority, bytes: todo.memory_bytes, meta: `${todoStatusLabel(todo.status)} · ${todoPriorityLabel(todo.priority)}${todo.claimed_by ? ` · ${todo.claimed_by}` : ""} · ${formatBytes(todo.memory_bytes)}` })) },
      { id: project.id, type: "project_entity", entityKind: "git", name: "Git", meta: project.git_url ? "репозиторий" : "не указан", color: "#2e4a3a", children: [{ type: "meta", name: project.git_url || "Git не указан" }] },
      { id: project.id, type: "project_entity", entityKind: "relations", name: "Связи", meta: `${relatedNames.length}`, children: relatedNames.length ? relatedNames.map((name) => ({ type: "meta", name })) : [{ type: "meta", name: "Связей нет" }] },
      { id: project.id, type: "project_entity", entityKind: "properties", name: "Свойства", meta: `${Object.keys(project.props || {}).length}`, children: Object.entries(project.props || {}).map(([key, value]) => ({ type: "meta", name: `${key}: ${value}` })) },
      { id: project.id, type: "project_entity", entityKind: "philosophy", name: "Философия", meta: project.props?.philosophy ? "задана" : "пусто", children: [
        { type: "meta", name: project.props?.philosophy || "Не задана" },
        { type: "meta", name: project.props?.principles ? `Принципы: ${project.props.principles}` : "Принципы не заданы" },
      ] },
      { id: project.id, type: "project_entity", entityKind: "deploy", name: "Деплой", meta: project.deploy_provider || "не указан", children: [{ type: "meta", name: project.deploy_provider || "Провайдер не указан" }, { type: "meta", name: project.deploy_target || "Цель деплоя не указана" }] },
      { id: project.id, type: "project_entity", entityKind: "stack", name: "Стек", meta: `${project.stack.length}`, children: project.stack.map((item) => ({ type: "meta", name: item })) },
      { id: project.id, type: "project_entity", entityKind: "access", name: "Доступ", meta: project.access_level, children: [{ type: "meta", name: project.access_level }] },
    ],
  };
}

export function filterTree(nodes: FolderTreeNode[], query: string): FolderTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  const result: FolderTreeNode[] = [];
  for (const node of nodes) {
    const children = node.children ? filterTree(node.children, query) : [];
    const ownMatch = `${node.name} ${node.meta ?? ""}`.toLowerCase().includes(needle);
    if (ownMatch || children.length) result.push({ ...node, children: children.length ? children : node.children });
  }
  return result;
}
