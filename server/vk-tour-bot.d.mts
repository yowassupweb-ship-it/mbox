import type { IncomingMessage, ServerResponse } from "node:http";

export type VkTourCard = {
  key: string;
  title: string;
  route: string;
  days: number;
  price: number;
  url: string;
  text: string;
};

export function extractTourKeys(event: unknown): string[];
export function buildTourDialogUrl(keys: string | string[], source?: string, groupName?: string): string;
export function makeTourCard(row: Record<string, unknown>, tourBaseUrl?: string): VkTourCard;
export function loadTours(query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>, keys: string[], tourBaseUrl?: string): Promise<VkTourCard[]>;
export function buildBotReply(cards: VkTourCard[], communityUrl?: string): { message: string; keyboard: Record<string, unknown> };
export function processVkEvent(options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function vkTourBotConfig(env?: NodeJS.ProcessEnv): Record<string, string>;
export function handleVkTourBot(options: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  readBody: (req: IncomingMessage) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "error">;
}): Promise<boolean>;
