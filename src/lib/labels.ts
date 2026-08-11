import type { AuditEvent, Project } from "../types";
import { formatClock } from "./format";

export const todoStatusLabels: Record<string, string> = {
  open: "Новая",
  next: "Следующая",
  doing: "В работе",
  blocked: "Заблокирована",
  review: "На проверке",
  done: "Готово",
  archived: "Архив",
};

export const todoPriorityLabels: Record<string, string> = {
  low: "Низкий",
  normal: "Обычный",
  high: "Высокий",
  urgent: "Срочно",
};

export const todoStatusHint: Record<string, string> = {
  open: "можно брать, но не первая в очереди",
  next: "следующая задача для агента",
  doing: "сейчас в работе",
  blocked: "нужен ответ или внешний доступ",
  review: "готово к проверке человеком",
  done: "завершено, не брать в работу",
  archived: "историческая запись",
};

export const agentStatusLabels: Record<string, string> = {
  active: "на связи",
  idle: "ожидает",
  offline: "отключен",
};

export const runStatusLabels: Record<string, string> = {
  running: "идёт",
  doing: "в работе",
  done: "готово",
  finished: "завершено",
  failed: "ошибка",
  blocked: "блок",
};

export const auditActionLabels: Record<string, string> = {
  create: "добавил",
  update: "отредактировал",
  delete: "удалил",
  claim: "взял в работу",
  heartbeat: "обновил работу",
  finish: "завершил",
};

export function todoStatusLabel(value: string) {
  return todoStatusLabels[value] ?? value;
}

export function todoPriorityLabel(value: string) {
  return todoPriorityLabels[value] ?? value;
}

export function auditNotice(event: AuditEvent) {
  const verb = auditActionLabels[event.action] || event.action;
  const detail = event.summary || event.entity_type;
  return {
    id: `audit-${event.id}`,
    text: `Агент ${event.actor} ${verb} ${detail}`,
    at: formatClock(event.created_at),
  };
}

export function projectName(projects: Project[], projectId: string | null) {
  if (!projectId) return "без проекта";
  return projects.find((project) => project.id === projectId)?.name ?? `project #${projectId}`;
}
