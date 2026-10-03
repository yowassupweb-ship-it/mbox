type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export declare function ensureAgentPresenceSchema(query: Query): Promise<void>;
