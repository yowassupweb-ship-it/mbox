import { useEffect, useSyncExternalStore } from "react";
import { fetchJson } from "./api";

/** Какие локальные агенты включены у аккаунта. Нет подписки на Claude Code или ChatGPT — выключается в настройках. */
export type AgentFamily = "claude" | "codex";
export type AgentPrefs = Record<AgentFamily, { enabled: boolean }>;

const DEFAULTS: AgentPrefs = { claude: { enabled: true }, codex: { enabled: true } };
const CACHE_KEY = "mbox.agentPrefs";

function cached(): AgentPrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CACHE_KEY) || "null");
    if (raw?.claude && raw?.codex) return { claude: { enabled: raw.claude.enabled !== false }, codex: { enabled: raw.codex.enabled !== false } };
  } catch { /* кэш необязателен */ }
  return DEFAULTS;
}

let current: AgentPrefs = typeof window === "undefined" ? DEFAULTS : cached();
let loaded = false;
const listeners = new Set<() => void>();

/** Настройки уже пришли с сервера (а не взяты из кэша): только им можно доверять при управлении процессами. */
export const agentPrefsLoaded = () => loaded;

function publish(next: AgentPrefs) {
  current = next;
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
  listeners.forEach((listener) => listener());
}

export async function refreshAgentPrefs() {
  try {
    const data = await fetchJson<{ agents: AgentPrefs }>("/api/mbox/account/agents");
    if (data.agents) loaded = true;
    if (data.agents) publish({ claude: { enabled: data.agents.claude?.enabled !== false }, codex: { enabled: data.agents.codex?.enabled !== false } });
  } catch { /* старый сервер: всё включено */ }
}

export async function setAgentEnabled(family: AgentFamily, enabled: boolean) {
  publish({ ...current, [family]: { enabled } });
  try {
    const data = await fetchJson<{ agents: AgentPrefs }>("/api/mbox/account/agents", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ [family]: enabled }) });
    publish({ claude: { enabled: data.agents.claude?.enabled !== false }, codex: { enabled: data.agents.codex?.enabled !== false } });
  } catch {
    publish({ ...current, [family]: { enabled: !enabled } });
    throw new Error("agent_prefs_failed");
  }
}

/** Подписка на настройки агентов; перечитывает их при открытии и при возврате к окну. */
export function useAgentPrefs(): AgentPrefs {
  useEffect(() => {
    void refreshAgentPrefs();
    const onFocus = () => void refreshAgentPrefs();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => DEFAULTS);
}
