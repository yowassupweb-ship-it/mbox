// Типы для импорта server/browser-agent.mjs из vite.config.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

export const BROWSER_AGENT_ACTIONS: string[];
export function handleBrowserAgentApi(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  readBody: (req: IncomingMessage) => Promise<any>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  user: { id: string };
  owner: boolean;
  actor: string;
  clients: Iterable<unknown>;
}): Promise<boolean>;
