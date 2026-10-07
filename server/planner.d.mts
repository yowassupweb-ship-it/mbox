import type { IncomingMessage, ServerResponse } from "node:http";

export type PlannerApiOptions = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => unknown;
  scope: { userId?: string; all?: boolean; projectIds?: string[] };
  broadcast?: (type: string, payload?: Record<string, unknown>) => void;
};
export function handlePlannerApi(options: PlannerApiOptions): Promise<unknown>;
export function expandRecurringEvent(event: Record<string, any>, rangeStart: string, rangeEnd: string): Record<string, any>[];
export function localDate(value: string): Date;
export function isoLocal(value: Date): string;
