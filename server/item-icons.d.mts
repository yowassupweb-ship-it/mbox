// Типы для импорта server/item-icons.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export function ensureItemIconsSchema(query: Query): Promise<void>;
export function iconsFor(query: Query, kind: "skill" | "tool", refs: string[]): Promise<Map<string, string>>;
export function handleItemIconsApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  user: { id: string; role: string };
  canManage: (kind: "skill" | "tool", ref: string) => Promise<boolean>;
}): Promise<boolean>;
