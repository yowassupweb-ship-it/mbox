import type { IncomingMessage, ServerResponse } from "node:http";

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export const SESSION_COOKIE: string;
export function ensureAssortmentShareSchema(query: Query): Promise<void>;
export function handleSharedAssortmentApi(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => unknown;
  api: (options: any) => Promise<boolean>;
  chat: (options: any) => Promise<boolean>;
}): Promise<boolean>;
