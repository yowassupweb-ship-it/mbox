// Типы для импорта server/integrations.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export function ensureIntegrationsSchema(query: Query): Promise<void>;
export function handleIntegrationsApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  owner: boolean;
  actor: string;
  userId: string;
}): Promise<boolean>;
export function canManageTool(query: Query, id: string, ctx?: { owner?: boolean; userId?: string }): Promise<boolean>;
