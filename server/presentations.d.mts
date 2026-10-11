// Типы для импорта server/presentations.mjs из vite.config.ts.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export function defaultDeck(): Record<string, unknown>;
export function parseDeck(content: string): Record<string, any> | null;
export function ensurePresentationsSchema(query: Query): Promise<void>;
export function deckTitle(content: string): string;
export function deckHead(content: string): string;
export function handlePresentationsApi(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  url: URL;
  query: Query;
  readBody: (req: import("node:http").IncomingMessage) => Promise<any>;
  sendJson: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown;
  actor: string;
  scope?: Record<string, unknown>;
  broadcast?: (type: string, payload: Record<string, unknown>) => void;
}): Promise<boolean>;
