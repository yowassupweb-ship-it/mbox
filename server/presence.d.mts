type Row = Record<string, any>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;

export function createPresenceHub(input: {
  query: Query;
  scopeFor: (user: any) => Promise<{ all?: boolean; projectIds?: string[] }>;
}): {
  attach: (socket: any) => void;
  announce: (payload: Record<string, unknown>) => void;
  size: (doc: string) => number;
};
export function announceAgentEdit(
  broadcast: ((type: string, payload: Record<string, unknown>) => void) | undefined,
  input: { doc: string; name: string; range?: string; sheet?: string },
): void;
