import type { AuditEvent, Project } from "../types";
import { formatClock } from "./format";

// next технически тот же статус, что и раньше, но в кабане и везде в UI он значит «вернули
// на доработку после проверки» — этим же статусом ReviewQueue помечает «Доработать».
// Отдельного статуса под это не заводили, чтобы не трогать схему.
export const todoStatusLabels: Record<string, string> = {
  open: "В ожидании",
  next: "Переработка",
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
  next: "вернули на доработку после проверки",
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

/** Типы связей проектов. Словами: на карте и в панели связей должно читаться одинаково. */
export const edgeTypeLabels: Record<string, string> = {
  related: "связан с",
  depends_on: "зависит от",
  part_of: "часть",
  shares_infra: "общая инфраструктура",
  shares_team: "общая команда",
};

export function edgeTypeLabel(value: string) {
  return edgeTypeLabels[value] ?? value;
}

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
