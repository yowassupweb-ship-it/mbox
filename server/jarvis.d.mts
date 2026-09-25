// Типы для импорта server/jarvis.mjs из vite.config.ts.
type Row = Record<string, any>;

export type TourSheetItem = { tour_id: string; sheet_id: string; tour_name: string; route_name: string; date_start: string | null; date_end: string | null; free_places: number; price_from: number };

export type JarvisDeps = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;
  broadcastRealtime: (type: string, payload?: Record<string, unknown>) => void;
  rankMemories: (search: string, options?: { minScore?: number; limit?: number; projectId?: string; project?: string; tags?: string[]; recencyDays?: number }) => Promise<Row[]>;
  recordMemoryAction: (input: { memoryId?: unknown; actor?: string; action?: string; note?: string; metadata?: unknown }) => Promise<unknown>;
};

export type JarvisTool = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export function configureJarvis(deps: JarvisDeps): void;
export const JARVIS_NAME: string;
export const JARVIS_TOOLS: JarvisTool[];
export const jarvisPhase: Map<string, { phase: string; at: number }>;
export const activeJarvisRequests: Map<string, AbortController>;
export function setAgentPhase(agentName: string, phase: string): void;
export function getAgentPhase(agentName: string): string | null;
export function groqComplete(messages: Row[], tools?: unknown[] | null, purpose?: string, signal?: AbortSignal, attempt?: number, model?: string, effort?: string): Promise<Row>;
export function geminiComplete(messages: Row[], tools?: unknown[] | null, purpose?: string, signal?: AbortSignal, effort?: string, model?: string, withThinking?: boolean): Promise<Row>;
export function bulkUpsertTourSheets(sourceId: string, items: TourSheetItem[]): Promise<{ upserted: number; removed: number }>;
export function refreshDataSourceById(id: string, options?: { inboxId?: unknown }): Promise<{ ok: boolean; summary: string; error?: string }>;
export function runJarvisTool(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }> }, name: string | undefined, rawArgs: string | undefined, projectList: { id: string; name: string }[], inboxId?: unknown, viewer?: { userId: string; all: boolean; projectIds: string[] } | null): Promise<string>;
export function searchTerms(query: unknown): string[];
export function replyAsJarvis(item: { id: unknown; project_id?: unknown; title?: unknown; body?: unknown; props?: Record<string, unknown> }): Promise<void>;

export type JarvisEffort = { id: string; label: string; hint: string };
export type JarvisModel = { id: string; provider: string; label: string; role: string; available: boolean; agent?: string; efforts?: string[]; default_effort?: string };
export const JARVIS_EFFORTS: JarvisEffort[];
export function jarvisModels(): Promise<{ models: JarvisModel[]; efforts: JarvisEffort[]; effort_labels: Record<string, { label: string; hint: string }>; default_model: string; defaults: Record<string, string>; sources: Record<string, { source: string; fetched_at?: string; live: boolean }>; default_effort: string }>;
export function publishAgentModels(body: unknown): Promise<{ agent: string; models: number; default_model: string }>;
export function describeRateLimit(info: { provider?: string; model?: string; wait_seconds?: number; detail?: string } | null, prefix?: string): string;
