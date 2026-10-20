import type { IncomingMessage, ServerResponse } from "node:http";

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export function ensureAssortment(query: Query): Promise<void>;
export function handleAssortmentApi(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => unknown;
  allowed: boolean;
  access?: "read" | "manage" | "owner";
  actor?: string;
  runtime?: { readOnly: boolean; feedbackUrl: string; badge: string } | null;
}): Promise<boolean>;
