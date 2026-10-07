import { useSyncExternalStore } from "react";
import { fetchJson } from "../lib/api";

export type UsageWindow = { id: string; label: string; used_percent: number; resets_at?: number; expired?: boolean };
export type AgentUsage = { windows: UsageWindow[]; updated_at: string };

const POLL_MS = 60_000;
let usage: Record<string, AgentUsage> = {};
const listeners = new Set<() => void>();
let timer = 0;

async function load() {
  try {
    const data = await fetchJson<{ usage?: Record<string, AgentUsage> }>("/api/mbox/agent/usage");
    usage = data.usage || {};
    listeners.forEach((listener) => listener());
  } catch { /* старый сервер без ручки или нет сети — кружка просто не будет */ }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void load();
    timer = window.setInterval(() => void load(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.clearInterval(timer);
  };
}

/** Лимиты подписок агентов по каталожному имени («Claude», «ChatGPT»); обновляются раз в минуту, одним опросом на всё окно. */
export function useAgentUsage() {
  return useSyncExternalStore(subscribe, () => usage, () => usage);
}

/** Лимиты агента по любому его имени: «Codex», «ChatGPT» и «chatgpt-cloud» → ChatGPT. */
export function usageOf(map: Record<string, AgentUsage>, agentName: string): AgentUsage | undefined {
  const name = agentName.toLowerCase();
  if (name.includes("claude")) return map.Claude;
  if (name.includes("chatgpt") || name.includes("codex")) return map.ChatGPT;
  return undefined;
}
