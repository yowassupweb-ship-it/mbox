import { REALTIME_OPEN_EVENT, sendRealtime } from "../../hooks/useRealtime";
import { browserBridge } from "./BrowserDocument";

/**
 * Агент во встроенном браузере (см. server/browser-agent.mjs). Сервер присылает по вебсокету browser_op,
 * страница передаёт его главному процессу MBOX Desktop (browser.js выполняет действие во вкладке с
 * подсветкой) и отправляет ответ обратно. Окно без моста к браузеру (сайт, телефон) отвечает skip —
 * сервер ждёт настоящее окно.
 */
export const BROWSER_OP_EVENT = "mbox:browser-op";

type BrowserOp = { id: string; action: string; tab: string; args: Record<string, unknown>; actor: string; note: string };
type AgentBridge = { agent?: (key: string, action: string, args: Record<string, unknown>, actor: string, note: string) => Promise<Record<string, unknown>> };

// Идентификатор окна: сервер рассылает действие во все окна владельца, а исполнить его должно одно (см. claim в browser-agent.mjs).
const WINDOW_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `w${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

async function reply(id: string, body: Record<string, unknown>) {
  await fetch(`/api/mbox/browser/agent/${id}/result?window=${encodeURIComponent(WINDOW_ID)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
}

/** Право исполнить действие. Окно, на которое смотрит человек, просит сразу, остальные — чуть позже, поэтому выигрывает видимое. */
async function claim(id: string) {
  if (typeof document !== "undefined" && !document.hasFocus()) await new Promise((resolve) => setTimeout(resolve, 350));
  try {
    const response = await fetch(`/api/mbox/browser/agent/${id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ window: WINDOW_ID }) });
    // Старый сервер без claim отвечает ошибкой — тогда действуем как раньше.
    if (!response.ok) return true;
    return (await response.json())?.won !== false;
  } catch {
    return true;
  }
}

async function run(op: BrowserOp) {
  const bridge = browserBridge() as (ReturnType<typeof browserBridge> & AgentBridge) | undefined;
  if (!bridge?.agent) return reply(op.id, { skip: true });
  if (!(await claim(op.id))) return;
  try {
    const result = await bridge.agent(op.tab, op.action, op.args || {}, op.actor, op.note);
    // Браузера ещё нет, а агент просит открыть страницу — открываем вкладку так же, как open_tab.
    if (op.action === "navigate" && result?.error === "no_tab" && typeof op.args?.url === "string") {
      window.dispatchEvent(new CustomEvent("mbox:open-tab", { detail: { kind: "url", url: op.args.url, actor: op.actor, reply_to: op.actor, title: "", note: op.note } }));
      return reply(op.id, { ok: true, opened: true, url: op.args.url, hint: "Открыл новую вкладку браузера в MBOX. Через пару секунд вызовите browser_snapshot." });
    }
    await reply(op.id, result ? { ...result, window: WINDOW_ID.slice(0, 8) } : { ok: false, error: "empty_result" });
  } catch (cause) {
    await reply(op.id, { ok: false, error: cause instanceof Error ? cause.message : String(cause) });
  }
}

let installed = false;
let focusedAt = 0;

/**
 * Окно сообщает серверу, что у него есть браузер и смотрят ли на него сейчас: команды агента уходят одному такому окну
 * (server/browser-agent.mjs). Без этого каждая команда исполнялась во всех открытых окнах MBOX (установленном и dev).
 */
function announceWindow() {
  const bridge = browserBridge() as (ReturnType<typeof browserBridge> & AgentBridge) | undefined;
  if (!bridge?.agent) return;
  const focused = document.hasFocus() && document.visibilityState === "visible";
  if (focused) focusedAt = Date.now();
  sendRealtime({ type: "browser_window", id: WINDOW_ID, focused, focusedAt });
}

/** Слушатель ставится один раз на окно — Workbench вызывает при монтировании. */
export function installBrowserAgent() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(BROWSER_OP_EVENT, (event) => { void run((event as CustomEvent<BrowserOp>).detail); });
  window.addEventListener(REALTIME_OPEN_EVENT, announceWindow);
  window.addEventListener("focus", announceWindow);
  window.addEventListener("blur", announceWindow);
  document.addEventListener("visibilitychange", announceWindow);
  window.setInterval(announceWindow, 20_000);
  announceWindow();
}
