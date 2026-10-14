import type { IncomingMessage, ServerResponse } from "node:http";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type Scope = { all: boolean; projectIds: string[]; owner?: boolean };

export declare function ensureCompaniesSchema(query: Query): Promise<void>;
export declare function applyProjectCompany(query: Query, projectId: string | undefined, body: Record<string, unknown>): Promise<void>;
export declare function handleCompaniesApi(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: <T = Record<string, unknown>>(req: IncomingMessage) => Promise<T>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  scope: Scope;
  isOwner: boolean;
  broadcast?: (action: string, entity: string, detail: string) => void;
}): Promise<boolean>;
