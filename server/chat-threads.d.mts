import type { IncomingMessage, ServerResponse } from "node:http";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export declare const THREAD_ID: RegExp;
export declare const CHAT_THREADS_SCHEMA_SQL: string;
export declare function ensureChatThreadsSchema(query: Query): Promise<void>;

export type ChatThread = {
  id: string;
  title: string;
  custom_title: boolean;
  peer: string | null;
  last_agent: string | null;
  messages: number;
  started_at: string;
  last_at: string;
  last_work: Record<string, unknown> | null;
  archived: boolean;
};

export declare function listChatThreads(
  query: Query,
  options: { userId: string; owner: boolean; scopeAll?: boolean; projectIds?: string[]; limit?: unknown; archived?: boolean },
): Promise<ChatThread[]>;

export declare function handleChatThreadsApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  user: { id: string | number };
  owner: boolean;
  scopeAll?: boolean;
  projectIds?: string[];
}): Promise<boolean>;
