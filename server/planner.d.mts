import type { IncomingMessage, ServerResponse } from "node:http";

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;

export type PlannerApiOptions = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => unknown;
  scope: { userId?: string; all?: boolean; projectIds?: string[] };
  broadcast?: (type: string, payload?: Record<string, unknown>) => void;
  /** Кто делает запрос: имя агента (из заголовка) попадает на событие как источник; человек — пусто. */
  actor?: string;
  userName?: string;
};
export type Automation = { agent: string; prompt: string; project_id?: string };
export type AutomationItem = { id: string; source: string; title: string; starts_at: string; ends_at: string; status: string; detail: string; tab?: string };

export function handlePlannerApi(options: PlannerApiOptions): Promise<boolean>;
export function expandEvent(event: Record<string, any>, from: string, to: string): Record<string, any>[];
export function localDate(value: string): Date;
export function isoLocal(value: Date): string;
export function automationOf(value: unknown): Automation | null;
export function listEvents(query: Query, userId: string, from: string, to: string): Promise<Record<string, any>[]>;
export function readEvent(query: Query, userId: string, id: string): Promise<Record<string, any> | null>;
export function createEvent(query: Query, userId: string, body: Record<string, unknown>, source?: string): Promise<Record<string, any>>;
export function changeEvent(query: Query, userId: string, id: string, body: Record<string, unknown>, source?: string): Promise<Record<string, any> | null>;
export function deleteEvent(query: Query, userId: string, id: string, scope?: string, recurrenceId?: string): Promise<boolean>;
export function listAutomations(query: Query, from: string, to: string): Promise<AutomationItem[]>;
export function wallClock(now?: Date, timeZone?: string): string;
export function startPlannerAutomations(options: {
  query: Query;
  dispatch: (task: { ownerUserId: string; agent: string; projectId: string | null; title: string; prompt: string; eventId: string; occurrence: string }) => Promise<string | null>;
  log?: (message: string) => void;
  broadcast?: (type: string, payload?: Record<string, unknown>) => void;
}): () => void;
