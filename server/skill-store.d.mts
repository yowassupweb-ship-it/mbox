// Типы для импорта server/skill-store.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export function ensureSkillStoreSchema(query: Query): Promise<void>;
export function handleSkillStoreApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  user: { id: string; username: string; role: string };
  owner: boolean;
  isSkillMine: (id: string) => Promise<boolean>;
}): Promise<boolean>;
