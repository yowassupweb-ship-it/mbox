type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export declare const BUG_SEVERITIES: Record<"low" | "normal" | "high", string>;
export type BugMemoryRow = { title: string; content: string; tags: string[]; metadata: Record<string, unknown> };
export declare function bugReportRow(input?: Record<string, unknown>, options?: { reporter?: string; source?: string }): BugMemoryRow;
export declare function insertBugReport(query: Query, row: BugMemoryRow, projectId?: unknown): Promise<string>;
