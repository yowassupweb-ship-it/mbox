type Row = Record<string, any>;

export const BROWSER_STATE_SCHEMA_SQL: string;
export function ensureBrowserStateSchema(query: (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }>): Promise<void>;
export function handleBrowserStateApi(input: {
  req: any;
  res: any;
  url: URL;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }>;
  readBody: (req: any) => Promise<Row>;
  sendJson: (res: any, status: number, body: unknown) => void;
  allowed: boolean;
  userId?: unknown;
  secretKey: string;
}): Promise<boolean>;
