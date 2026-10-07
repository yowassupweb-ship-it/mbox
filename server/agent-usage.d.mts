type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
export type UsageWindow = { id: string; label: string; used_percent: number; resets_at?: number; expired?: boolean };
export function usageAgentName(value: unknown): string;
export function normalizeWindows(value: unknown): UsageWindow[];
export function mergeWindows(existing: unknown, incoming: UsageWindow[]): UsageWindow[];
export function shapeWindows(windows: unknown, now?: number): UsageWindow[];
export function ensureAgentUsage(query: Query): Promise<void>;
export function publishAgentUsage(query: Query, body: unknown): Promise<{ agent: string; windows: number }>;
export type DailyModelUsage = { model: string; tokens_today: number; calls_today: number; limit_tokens?: number; used_percent?: number };
export type AgentUsageEntry =
  | { kind: "windows"; windows: UsageWindow[]; updated_at: string }
  | { kind: "daily"; windows: []; models: DailyModelUsage[]; updated_at: string | null };
export function dailyTokenLimits(value?: string): Record<string, number>;
export function shapeDailyModels(rows: unknown, limits?: Record<string, number>): DailyModelUsage[];
export function readAgentUsage(query: Query, now?: number, jarvisName?: string): Promise<Record<string, AgentUsageEntry>>;
