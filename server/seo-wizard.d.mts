import type { IncomingMessage, ServerResponse } from "node:http";

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;

export function ensureSeoWizardSchema(query: Query): Promise<void>;
export function pageKind(pathname: string): { type: string; section: string };
export function handleSeoWizardApi(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => unknown;
  allowed: boolean;
}): Promise<boolean>;
