type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
export type UsageWindow = { id: string; label: string; used_percent: number; resets_at?: number; expired?: boolean };
export function usageAgentName(value: unknown): string;
export function normalizeWindows(value: unknown): UsageWindow[];
export function mergeWindows(existing: unknown, incoming: UsageWindow[]): UsageWindow[];
export function shapeWindows(windows: unknown, now?: number): UsageWindow[];
export function ensureAgentUsage(query: Query): Promise<void>;
export function publishAgentUsage(query: Query, body: unknown): Promise<{ agent: string; windows: number }>;
export function readAgentUsage(query: Query, now?: number): Promise<Record<string, { windows: UsageWindow[]; updated_at: string }>>;
