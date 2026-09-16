// Типы для импорта server/workspaces.mjs из vite.config.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

type Row = Record<string, any>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;

export const WORKSPACE_SCHEMA_SQL: string;
export const WORKSPACE_OPS: string[];
export function ensureWorkspaceSchema(query: Query): Promise<void>;
export function normalizeWorkspacePath(value: unknown): string;
export function listWorkspaces(query: Query): Promise<Row[]>;
export function findWorkspace(query: Query, idOrName: unknown): Promise<Row | null>;
export function recordVersion(query: Query, input: Row): Promise<Row>;
export function listVersions(query: Query, workspaceId: string, path: string, limit?: number): Promise<Row[]>;
export function requestWorkspaceOp(query: Query, input: Row): Promise<Row>;
export function describeWorkspaceError(error: unknown, workspace?: Row | null): string;
export function handleWorkspaceApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  actor: string;
  allowed: boolean;
  broadcast?: (type: string, payload?: Record<string, unknown>) => void;
}): Promise<boolean>;
