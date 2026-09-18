// Типы для импорта server/storage.mjs из vite.config.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

type Row = Record<string, any>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;
type Handler = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  allowed: boolean;
};

export const STORAGE_SCHEMA_SQL: string;
export function ensureStorageSchema(query: Query): Promise<void>;
export function signRequest(input: Row): { headers: Record<string, string>; signature: string };
export function presignUrl(input: Row): string;
export function handleStorageApi(input: Handler & { secretKey: string }): Promise<boolean>;
export function storageSignedGet(query: Query, secretKey: string, key: string, expires?: number): Promise<string | null>;
export function storagePutStream(query: Query, secretKey: string, key: string, stream: ReadableStream, length: number, contentType: string): Promise<{ ok: boolean; error?: string }>;
