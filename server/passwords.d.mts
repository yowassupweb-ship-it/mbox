// Типы для импорта server/passwords.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export function ensurePasswordsSchema(query: Query): Promise<void>;
export function approvedSecrets(query: Query, userId: string | number, projectName?: string): Promise<any[]>;
export function handlePasswordsApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  userId: string;
  broadcast?: (type: string, payload: Record<string, unknown>) => void;
}): Promise<boolean>;
