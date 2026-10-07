import { useSyncExternalStore } from "react";
import { fetchJson } from "../lib/api";
import { agentFamily, isCloudAgent } from "../lib/agents";

export type UsageWindow = { id: string; label: string; used_percent: number; resets_at?: number; expired?: boolean };
export type DailyModelUsage = { model: string; tokens_today: number; calls_today: number; limit_tokens?: number; used_percent?: number };
/** Подписка (Claude Code, Codex) — окна 5 ч и неделя; Джарвис — суточный расход бесплатных API по моделям. */
export type AgentUsage =
  | { kind?: "windows"; windows: UsageWindow[]; updated_at: string }
  | { kind: "daily"; windows: []; models: DailyModelUsage[]; updated_at: string | null };

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

/**
 * Лимиты конкретного агента. Своя запись есть у облачных (ClaudeCloud, CodexCloud — своя подписка на сервере) и у Джарвиса;
 * локальные Claude и Codex под любым именем («Codex» через MCP, «ChatGPT» наблюдателя) делят подписку этого компьютера.
 * Облачному без своей записи чужую подписку не подставляем — лучше ничего, чем чужие цифры.
 */
export function usageOf(map: Record<string, AgentUsage>, agentName: string): AgentUsage | undefined {
  if (map[agentName]) return map[agentName];
  if (isCloudAgent(agentName)) return undefined;
  const family = agentFamily(agentName)?.key;
  if (family === "claude") return map.Claude;
  if (family === "codex") return map.ChatGPT;
  if (family === "jarvis") return Object.values(map).find((entry) => entry.kind === "daily");
  return undefined;
}
