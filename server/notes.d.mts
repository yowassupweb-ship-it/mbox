// Типы для импорта server/notes.mjs из vite.config.ts.
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

export const NOTES_SCHEMA_SQL: string;
export function ensureNotesSchema(query: Query): Promise<void>;
export function listNotes(query: Query, search?: string, limit?: unknown): Promise<Row[]>;
export function createNote(query: Query, input: Row): Promise<Row>;
export function handleNotesApi(input: Handler & { actor: string }): Promise<boolean>;
