// Типы для импорта server/skill-overrides.mjs из vite.config.ts.
export function ensureSkillOverridesSchema(query: (sql: string, values?: unknown[]) => Promise<unknown>): Promise<void>;
export function handleSkillPackagesApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
  skillsRoot: string;
  actor: string;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  onChange?: (change: Record<string, unknown>) => void;
}): Promise<boolean>;
