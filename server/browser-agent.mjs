// Агент во встроенном браузере MBOX Desktop: видит, какая страница открыта у владельца, читает её поля
// и действует на ней с подсветкой — человек видит, что и где агент делает. Импортируют mbox-server.mjs
// и vite.config.ts.
//
// Путь: MCP browser_* → POST /api/mbox/browser/agent → вебсокет browser_op в окна того же пользователя →
// страница MBOX Desktop (src/app/workbench/browserAgent.ts) → главный процесс (mbox-desktop/browser.js)
// выполняет действие во вкладке → POST /api/mbox/browser/agent/<id>/result → ответ агенту.
// Очередь в базе не нужна: действие имеет смысл, только пока окно открыто, и ждёт его один запрос.

import { randomUUID } from "node:crypto";

export const BROWSER_AGENT_ACTIONS = ["tabs", "snapshot", "fill", "click", "highlight", "navigate", "scroll", "screenshot", "select_text"];
const WAIT_MS = 25_000;
const pending = new Map();

function sendToUser(clients, userId, message) {
  const text = JSON.stringify(message);
  let delivered = 0;
  for (const client of clients) {
    if (client.readyState === 1 && client.mboxUserId === String(userId)) {
      client.send(text);
      delivered += 1;
    }
  }
  return delivered;
}

/** Маршруты /api/mbox/browser/agent*. Только владелец: браузер — его сессии и куки на его машине. */
export async function handleBrowserAgentApi({ req, res, url, readBody, sendJson, user, owner, actor, clients }) {
  if (!url.pathname.startsWith("/api/mbox/browser/agent")) return false;
  if (!owner) { sendJson(res, 403, { error: "owner_required" }); return true; }

  const resultMatch = url.pathname.match(/^\/api\/mbox\/browser\/agent\/([0-9a-f-]{36})\/result$/);
  if (resultMatch && req.method === "POST") {
    const entry = pending.get(resultMatch[1]);
    const body = await readBody(req);
    // Окно без моста к браузеру (сайт в обычном браузере, телефон) отвечает skip — ждём настоящее.
    if (entry && !body.skip) {
      pending.delete(resultMatch[1]);
      clearTimeout(entry.timer);
      entry.resolve(body);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/mbox/browser/agent" && req.method === "POST") {
    const body = await readBody(req);
    const action = String(body.action || "");
    if (!BROWSER_AGENT_ACTIONS.includes(action)) { sendJson(res, 400, { error: `unknown_action:${action}` }); return true; }
    const id = randomUUID();
    const result = new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "timeout" }); }, WAIT_MS);
      pending.set(id, { resolve, timer });
    });
    const delivered = sendToUser(clients, user.id, {
      type: "browser_op",
      id,
      action,
      tab: String(body.tab || ""),
      args: body.args && typeof body.args === "object" ? body.args : {},
      actor: String(actor || "Агент").slice(0, 60),
      note: String(body.note || "").slice(0, 300),
    });
    if (!delivered) {
      const entry = pending.get(id);
      if (entry) { clearTimeout(entry.timer); pending.delete(id); }
      sendJson(res, 409, { ok: false, error: "no_window", message: "MBOX не открыт ни в одном окне владельца — браузер недоступен." });
      return true;
    }
    const answer = await result;
    sendJson(res, answer.ok === false ? 409 : 200, answer);
    return true;
  }
  return false;
}
