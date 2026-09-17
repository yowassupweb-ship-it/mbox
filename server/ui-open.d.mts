// Типы для импорта server/ui-open.mjs из vite.config.ts.
export type OpenTabEvent = {
  kind: "skill-file" | "skill-blocks" | "path" | "url" | "tab";
  title: string;
  note: string;
  actor: string;
  reply_to: string;
  skill?: string;
  file?: string;
  path?: string;
  url?: string;
  key?: string;
};
export function parseOpenRequest(body: unknown, actor: string): { error: string; event?: undefined } | { event: OpenTabEvent; error?: undefined };
export function tagSocketUser(socket: unknown, user: { id: string } | null): void;
export function sendOpenTab(clients: Iterable<unknown>, userId: string, event: OpenTabEvent): number;
