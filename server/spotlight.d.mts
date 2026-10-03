import type { IncomingMessage, ServerResponse } from "node:http";

type Row = Record<string, any>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;

export function handleSpotlightApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  scope?: { all?: boolean; projectIds?: string[]; userId?: string };
  searchTerms: (query: string) => string[];
}): Promise<boolean>;
