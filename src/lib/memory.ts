import type { Memory, Project } from "../types";

/** Запись памяти принадлежит проекту напрямую, через metadata.project_id, либо через привязанный todo. */
export function projectMemoryMatches(memory: Memory, project: Project, todoIds: Set<string>): boolean {
  const metadataProject = typeof memory.metadata?.project_id === "string" ? memory.metadata.project_id : "";
  const metadataTodo = typeof memory.metadata?.todo_id === "string" ? memory.metadata.todo_id : "";
  return memory.project_id === project.id || metadataProject === project.id || (!!metadataTodo && todoIds.has(metadataTodo));
}
