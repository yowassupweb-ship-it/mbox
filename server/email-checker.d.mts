import type { IncomingMessage, ServerResponse } from "node:http";

export type EmailCheckerResult = {
  provider: string;
  checked_at: string;
  summary: Record<string, unknown>;
  validation: { errors: unknown[]; warnings: unknown[] };
  links: Record<string, unknown>;
  links_failed: Array<{ url: string; status?: number; note: string }>;
  links_auth: string[];
  text_issues: Array<{ type?: string; message?: string; context?: string; suggestions: string[] }>;
  text_failed: string;
};

export function checkEmailHtml(html: string): Promise<EmailCheckerResult>;

export function handleEmailCheckerApi(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => unknown;
}): Promise<boolean>;
