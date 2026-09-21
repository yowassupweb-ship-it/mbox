export function ensureAccountsSchema(query: (...args: any[]) => Promise<any>): Promise<void>;

export function handleAccountsApi(context: {
  req: any;
  res: any;
  url: URL;
  query: (...args: any[]) => Promise<any>;
  readBody: (req: any) => Promise<any>;
  sendJson: (res: any, status: number, body: unknown) => unknown;
  user: { id: string; role: string };
}): Promise<boolean>;
