import type { IncomingMessage, ServerResponse } from "node:http";

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export function chatAvailable(env?: Record<string, string | undefined>): boolean;
export function handleAssortmentChat(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => unknown;
  share: { id: string; mode: string; chat: boolean; label: string; kind: string };
  access: "read" | "manage" | "owner";
  route?: string;
}): Promise<boolean>;
