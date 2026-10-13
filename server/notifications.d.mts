import type { IncomingMessage, ServerResponse } from "node:http";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type Scope = { all: boolean; projectIds: string[]; owner?: boolean };

export declare const NOTIFICATIONS_SCHEMA_SQL: string;
export declare function ensureNotificationsSchema(query: Query): Promise<void>;
export declare function listNotifications(query: Query, options: { user: { id: string | number }; scope: Scope; username?: string }): Promise<{ items: any[]; projects: any[]; unread: number; username?: string }>;
export declare function handleNotificationsApi(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: <T = Record<string, unknown>>(req: IncomingMessage) => Promise<T>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  user: { id: string | number; username?: string };
  scope: Scope;
  hasProjectAccess: (scope: any, projectId: unknown) => boolean;
}): Promise<boolean>;
