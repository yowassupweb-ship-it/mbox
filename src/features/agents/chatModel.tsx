import { effectiveStatus, liveRunOf, CLOUD_AGENTS } from "../../lib/agents";
import { formatSince } from "../../lib/format";
import { type AgentActivity, type AgentInboxItem, type AgentRun } from "../../types";
import { formatWorkTokens } from "./chatChain";
import { type LogLine } from "./chatTypes";

/** Ведущее @Имя в начале сообщения — раньше был отдельный ростер кнопок для выбора адресата,
 * теперь то же самое просто печатается в тексте (см. подсказки по @) и парсится отсюда. */
export function parseMention(raw: string): string {
  const match = raw.trim().match(/^@(\S+)/);
  return match ? match[1] : "";
}

export const HUMAN = "Человек";
export const READ_KEY = "mbox.chat.readAt";
// agent_error здесь не случайно: когда наблюдатель агента спотыкается, ошибка ложилась в инбокс,
// но в переписке не показывалась вообще — человек сидел перед пустым чатом и считал, что «ничего
// не происходит», хотя ответ давно провалился. Молчание неотличимо от работы, и это хуже ошибки.
export const CONVERSATION = new Set(["question", "answer", "agent_message", "agent_response", "chat", "agent_error"]);

/** На какое сообщение отвечает запись: кнопка «Ответить» пишет props.re, наблюдатели агентов — in_reply_to. */
export function repliedId(item: AgentInboxItem) {
  return String(item.props?.re ?? item.props?.in_reply_to ?? "");
}

export function snippet(text: string, max = 140) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Разговор с одним агентом: сообщения человека ему (props.to или ведущее @Имя) и ответы этого агента
 * человеку. Реплики агента, адресованные другому агенту, сюда не попадают.
 */
/**
 * Чат, к которому относится сообщение (props.thread). Пусто — старый общий чат.
 *
 * Зачем чаты: агенты Claude и Codex продолжают сессию своего CLI внутри чата и не перечитывают
 * историю заново, а новый чат начинается с чистого контекста. Раньше в каждый запрос вклеивались
 * десятки последних реплик всей консоли, и лимит подписки уходил на чтение чужих разговоров.
 */
export function threadOfItem(item: AgentInboxItem) {
  return typeof item.props?.thread === "string" ? item.props.thread : "";
}

export function newThreadId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export type ChatThread = { id: string; title: string; custom_title?: boolean; last_at: string; messages: number; peer: string | null; last_agent: string | null; last_work?: LogLine["work"] | null };

/** Сколько занимает контекст сессии агента в чате: последний ответ с этой цифрой. */
export type ContextLoad = { tokens: number; window: number; agent: string };

export function contextLoadText(load: ContextLoad) {
  const percent = load.window ? Math.round((load.tokens / load.window) * 100) : 0;
  return `${formatWorkTokens(load.tokens)}${load.window ? ` из ${formatWorkTokens(load.window)} · ${percent}%` : ""}`;
}

/**
 * Облачный напарник вкладки: у Claude — ClaudeCloud, у ChatGPT — CodexCloud (deploy/cloud-agents на сервере).
 * Во вкладке агента чат бывает локальным или облачным — это собеседник, записанный в чате (thread.peer).
 */
export function cloudPeerOf(peer: string) {
  const name = peer.toLowerCase();
  if (name === "claude") return CLOUD_AGENTS.claude;
  if (name === "chatgpt" || name === "codex") return CLOUD_AGENTS.codex;
  return "";
}

/** Каталог моделей публикуют «Claude» и «ChatGPT»; облачные агенты — те же CLI и берут тот же набор. */
export function catalogAgent(name: string) {
  const key = name.toLowerCase();
  if (key === CLOUD_AGENTS.claude.toLowerCase()) return "claude";
  if (key === CLOUD_AGENTS.codex.toLowerCase()) return "chatgpt";
  return key;
}

export function peerNames(peer: string) {
  const name = peer.toLowerCase();
  const local = name === "chatgpt" ? ["chatgpt", "codex"] : [name];
  const cloud = cloudPeerOf(peer).toLowerCase();
  return cloud ? [...local, cloud] : local;
}

export function threadMatchesPeer(thread: ChatThread, peer: string) {
  if (!peer) return true;
  const names = peerNames(peer);
  return names.includes(String(thread.peer || "").toLowerCase()) || names.includes(String(thread.last_agent || "").toLowerCase());
}

export function belongsToPeer(item: AgentInboxItem, peer: string) {
  const names = new Set(peerNames(peer));
  const to = String(item.props?.to ?? "").toLowerCase();
  if (item.agent_name === HUMAN) return to ? names.has(to) : names.has(parseMention(item.body || item.title).toLowerCase());
  return names.has(item.agent_name.toLowerCase()) && (!to || names.has(to) || to === HUMAN.toLowerCase());
}

/**
 * Что агент делает прямо сейчас. Считается из живых сессий и присутствия, а не выдумывается.
 * Живой = по сессии стучит heartbeat; брошенный running не выдаётся за работу (см. lib/agents).
 */
export function agentState(agent: AgentActivity, runs: AgentRun[]) {
  const live = liveRunOf(runs, agent.name);
  if (live) return { key: "working", label: "отвечает", detail: live.goal };
  const status = effectiveStatus(agent);
  // phase — живой сигнал, который агент сам присылает через POST /agent/ping (не выдумываем
  // "думает" статично: если фазы нет, значит агент сейчас реально ничего не делает).
  if (status === "active" && agent.phase) return { key: "working", label: agent.phase, detail: "" };
  if (status === "active") return { key: "active", label: "на связи", detail: "ждёт задачу" };
  if (status === "idle") return { key: "idle", label: "ожидает", detail: formatSince(agent.last_seen) };
  return { key: "offline", label: "отключён", detail: formatSince(agent.last_seen) };
}

/**
 * Ошибка наблюдателя как её видит человек: «codex.exe завершился с кодом 1. Исчерпан лимит подписки:
 * {"type":"error","message":"…"}» превращается в текст из message, а код выхода уходит в подробности.
 */
export function humanizeAgentError(text: string) {
  let message = text.trim();
  let detail = "";
  const exit = message.match(/^(\S+ завершился с кодом -?\d+)\.\s*/);
  if (exit) { detail = exit[1]; message = message.slice(exit[0].length); }
  const from = message.indexOf("{");
  const to = message.lastIndexOf("}");
  if (from >= 0 && to > from) {
    try {
      const parsed = JSON.parse(message.slice(from, to + 1)) as { message?: unknown; error?: { message?: unknown } };
      const inner = typeof parsed.message === "string" ? parsed.message : typeof parsed.error?.message === "string" ? parsed.error.message : "";
      if (inner) {
        const lead = message.slice(0, from).trim().replace(/:$/, "");
        message = lead ? `${lead}.\n${inner}` : inner;
      }
    } catch { /* не JSON — оставляем как есть */ }
  }
  const seen = new Set<string>();
  message = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[\w:.-]+\]\s*\{.*\}$/.test(line) && !/^\S+ завершился с кодом -?\d+\.?$/.test(line))
    .filter((line) => (seen.has(line) ? false : (seen.add(line), true)))
    .join("\n");
  return { message, detail };
}

/** Что сервер разрешает выбрать в поле ввода — см. jarvisModels в server/jarvis.mjs. */
export type JarvisCatalog = {
  /** У моделей Claude и ChatGPT свой набор уровней effort — его публикует CLI на машине владельца. */
  models: Array<{ id: string; label: string; provider: string; role: string; agent?: string; efforts?: string[]; default_effort?: string }>;
  efforts: Array<{ id: string; label: string; hint: string }>;
  effortLabels: Record<string, { label: string; hint: string }>;
  /** Что сработает, если человек ничего не выбрал — показываем это же в поле ввода. */
  defaultModel: string;
  defaults: Record<string, string>;
  defaultEffort: string;
  /** Откуда взят набор моделей каждого агента: live — прислал его CLI, иначе запасной список из кода сервера. */
  sources: Record<string, { source?: string; fetched_at?: string; live?: boolean }>;
};

/** Подпись под списком моделей: свежий ли каталог и что делать, если нет. */
export function catalogNote(info?: { fetched_at?: string; live?: boolean }) {
  if (!info) return "";
  if (!info.live) return "Запасной список: агент ещё не присылал свои модели. Запустите агента — список обновится сам.";
  const at = info.fetched_at ? new Date(info.fetched_at) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const when = at.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const stale = Date.now() - at.getTime() > 36 * 3600_000;
  return stale ? `Список от ${when} давно не обновлялся. Запустите агента, чтобы подтянуть новые модели.` : `Список из CLI агента, ${when}.`;
}
