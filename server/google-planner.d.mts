// Типы для импорта server/google-planner.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export function ensureGooglePlannerSchema(query: Query): Promise<void>;
export function handleGooglePlannerApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  userId: string;
  origin: string;
  broadcast?: (type: string, payload: Record<string, unknown>) => void;
}): Promise<boolean>;
