// Типы для импорта server/spaces.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export type ProjectScope = { all: boolean; owner: boolean; projectIds: string[] };
export function ensureSpacesSchema(query: Query): Promise<void>;
export function spacesEnabled(query: Query): Promise<boolean>;
export function projectScopeFor(query: Query, user: { id: string; role: string }): Promise<ProjectScope>;
export function addProjectMember(query: Query, projectId: string | undefined, userId: string): Promise<void>;
export function generalProjectId(query: Query, userId: string): Promise<string | null>;
export function migrateToSpaces(query: Query, options?: { dryRun?: boolean }): Promise<Record<string, unknown>>;
export function resetSpacesCache(): void;
export function disableSpaces(query: Query): Promise<void>;
export function handleSpacesApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  user: { id: string; role: string };
}): Promise<boolean>;
