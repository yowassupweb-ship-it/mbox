// Типы для импорта server/history.mjs из vite.config.ts.
export const SERVICE_ENTITIES: string[];
export function handleHistoryApi(options: { url: URL; query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>; sendJson: (res: any, status: number, body: unknown) => unknown; res: any; scope: (first: number) => { sql: string; params: unknown[] } }): Promise<boolean>;
