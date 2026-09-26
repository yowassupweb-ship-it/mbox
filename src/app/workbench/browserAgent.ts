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

async function reply(id: string, body: Record<string, unknown>) {
  await fetch(`/api/mbox/browser/agent/${id}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
}

async function run(op: BrowserOp) {
  const bridge = browserBridge() as (ReturnType<typeof browserBridge> & AgentBridge) | undefined;
  if (!bridge?.agent) return reply(op.id, { skip: true });
  try {
    const result = await bridge.agent(op.tab, op.action, op.args || {}, op.actor, op.note);
    // Браузера ещё нет, а агент просит открыть страницу — открываем вкладку так же, как open_tab.
    if (op.action === "navigate" && result?.error === "no_tab" && typeof op.args?.url === "string") {
      window.dispatchEvent(new CustomEvent("mbox:open-tab", { detail: { kind: "url", url: op.args.url, actor: op.actor, reply_to: op.actor, title: "", note: op.note } }));
      return reply(op.id, { ok: true, opened: true, url: op.args.url, hint: "Открыл новую вкладку браузера в MBOX. Через пару секунд вызовите browser_snapshot." });
    }
    await reply(op.id, result ?? { ok: false, error: "empty_result" });
  } catch (cause) {
    await reply(op.id, { ok: false, error: cause instanceof Error ? cause.message : String(cause) });
  }
}

let installed = false;

/** Слушатель ставится один раз на окно — Workbench вызывает при монтировании. */
export function installBrowserAgent() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(BROWSER_OP_EVENT, (event) => { void run((event as CustomEvent<BrowserOp>).detail); });
}
