// Типы для импорта server/design-systems.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export function ensureDesignSystemsSchema(query: Query): Promise<void>;
export function htmlText(html: string): string;
export function htmlTitle(html: string): string;
export function starterHtml(title?: string): string;
export function handleDesignSystemsApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  actor: string;
  scope?: Record<string, unknown>;
  broadcast?: (type: string, payload: Record<string, unknown>) => void;
}): Promise<boolean>;
