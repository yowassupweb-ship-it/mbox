// Типы для импорта server/skill-access.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
type User = { id: string; role: string };
export function ensureSkillAccessSchema(query: Query): Promise<void>;
export function allowedSkills(query: Query, user: User): Promise<{ has(id: string): boolean } | null>;
export function canWriteSkill(query: Query, user: User, id: string, exists: boolean): Promise<boolean>;
export function canManageSkill(query: Query, user: User, id: string): Promise<boolean>;
export function claimSkill(query: Query, user: User, id: string): Promise<void>;
export function extraCatalogEntries(query: Query, user: User, summaries: Array<{ id: string; name: string; description: string }>, catalogIds: string[]): Promise<Array<Record<string, any>>>;
export function isCatalogSkillAllowed(allowed: { has(id: string): boolean } | null, catalogId: string): boolean;
export function handleSkillAccessApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  user: User;
  actor: string;
  skillsRoot: string;
}): Promise<boolean>;
