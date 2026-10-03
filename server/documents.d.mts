import type { IncomingMessage, ServerResponse } from "node:http";

type Row = Record<string, any>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;

export function ensureDocumentsSchema(query: Query): Promise<void>;
export function handleDocumentsApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  actor: string;
  scope?: { all?: boolean; projectIds?: string[]; userId?: string };
  broadcast?: (type: string, payload: Record<string, unknown>) => void;
}): Promise<boolean>;
