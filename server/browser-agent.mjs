// Агент во встроенном браузере MBOX Desktop: видит, какая страница открыта у владельца, читает её поля
// и действует на ней с подсветкой — человек видит, что и где агент делает. Импортируют mbox-server.mjs
// и vite.config.ts.
//
// Путь: MCP browser_* → POST /api/mbox/browser/agent → вебсокет browser_op в окна того же пользователя →
// страница MBOX Desktop (src/app/workbench/browserAgent.ts) → главный процесс (mbox-desktop/browser.js)
// выполняет действие во вкладке → POST /api/mbox/browser/agent/<id>/result → ответ агенту.
// Очередь в базе не нужна: действие имеет смысл, только пока окно открыто, и ждёт его один запрос.

import { randomUUID } from "node:crypto";

export const BROWSER_AGENT_ACTIONS = [
  "tabs", "status", "snapshot", "fill", "click", "double_click", "right_click", "hover", "move_cursor", "drag", "type", "press", "wait",
  "highlight", "navigate", "back", "forward", "reload", "new_tab", "scroll", "screenshot", "select_text", "extract", "find_text", "blockers",
];
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

// Окна с мостом к браузеру присылают browser_window раз в ~20 с и при смене фокуса (src/app/workbench/browserAgent.ts).
// Свежее объявление — окно живо. Команду получает ровно одно: то, на которое смотрят, иначе то, что смотрели последним.
// Окна старых версий не объявляются и команд больше не получают, пока есть хоть одно объявившееся (раньше они кликали наравне).
const WINDOW_FRESH_MS = 60_000;

function sendBrowserOp(clients, userId, message) {
  const mine = [...clients].filter((client) => client.readyState === 1 && client.mboxUserId === String(userId));
  const announced = mine
    .filter((client) => client.browserWindow && Date.now() - client.browserWindow.at < WINDOW_FRESH_MS)
    .sort((a, b) => Number(b.browserWindow.focused) - Number(a.browserWindow.focused) || b.browserWindow.focusedAt - a.browserWindow.focusedAt || b.browserWindow.at - a.browserWindow.at);
  if (announced.length) {
    announced[0].send(JSON.stringify(message));
    return 1;
  }
  return sendToUser(clients, userId, message);
}

/** Одно действие в браузере пользователя; ждёт ответа окна до 25 с. Общая часть для HTTP-ручки (MCP) и Джарвиса. */
export async function runBrowserOp({ clients, userId, action, tab = "", args = {}, actor = "Агент", note = "" }) {
  if (!BROWSER_AGENT_ACTIONS.includes(action)) return { ok: false, error: `unknown_action:${action}` };
  const id = randomUUID();
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "timeout" }); }, WAIT_MS);
    pending.set(id, { resolve, timer, claimedBy: "" });
  });
  const delivered = sendBrowserOp(clients, userId, { type: "browser_op", id, action, tab: String(tab || ""), args: args && typeof args === "object" ? args : {}, actor: String(actor).slice(0, 60), note: String(note).slice(0, 300) });
  if (!delivered) {
    const entry = pending.get(id);
    if (entry) { clearTimeout(entry.timer); pending.delete(id); }
    return { ok: false, error: "no_window", message: "MBOX не открыт ни в одном окне владельца — браузер недоступен." };
  }
  return result;
}

/** Маршруты /api/mbox/browser/agent*. Только владелец: браузер — его сессии и куки на его машине. */
export async function handleBrowserAgentApi({ req, res, url, readBody, sendJson, user, owner, actor, clients }) {
  if (!url.pathname.startsWith("/api/mbox/browser/agent")) return false;
  if (!owner) { sendJson(res, 403, { error: "owner_required" }); return true; }

  // Действие уходит во все окна владельца, а исполнить его должно ровно одно: иначе два окна MBOX Desktop (установленное и
  // dev, разные размеры и разные входы на сайты) оба кликают и навигируют, а ответ берётся от того, кто успел первым —
  // отсюда «элемент не найден» при сработавшем клике, снимки чужой страницы и 401 вместо вошедшей сессии.
  // Окно с мостом к браузеру перед исполнением просит право (claim); первое получает его, остальные молчат.
  const claimMatch = url.pathname.match(/^\/api\/mbox\/browser\/agent\/([0-9a-f-]{36})\/claim$/);
  if (claimMatch && req.method === "POST") {
    const entry = pending.get(claimMatch[1]);
    const body = await readBody(req);
    const windowId = String(body.window || "").slice(0, 80) || "unknown";
    if (!entry) { sendJson(res, 200, { ok: true, won: false, reason: "gone" }); return true; }
    if (!entry.claimedBy) entry.claimedBy = windowId;
    sendJson(res, 200, { ok: true, won: entry.claimedBy === windowId });
    return true;
  }

  const resultMatch = url.pathname.match(/^\/api\/mbox\/browser\/agent\/([0-9a-f-]{36})\/result$/);
  if (resultMatch && req.method === "POST") {
    const entry = pending.get(resultMatch[1]);
    const body = await readBody(req);
    // Окно без моста к браузеру (сайт в обычном браузере, телефон) отвечает skip — ждём настоящее. Если право на
    // действие уже взято, принимаем ответ только от его владельца (окна старых версий не просят право и не шлют window).
    const answeredBy = String(url.searchParams.get("window") || "");
    const foreign = Boolean(entry?.claimedBy) && entry.claimedBy !== answeredBy;
    if (entry && !body.skip && !foreign) {
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
      pending.set(id, { resolve, timer, claimedBy: "" });
    });
    const delivered = sendBrowserOp(clients, user.id, {
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

// ─── Просьба о помощи ───────────────────────────────────────────────────────────────────────────────────────────────────
// Агент застрял (капча, вход, код из SMS, непонятная форма) и просит человека: в окне MBOX у вкладки появляется панель
// «Агент просит помощи» с полем комментария и кнопками «Готово, продолжай» / «Остановить». Агент ждёт ответа короткими
// долгими запросами (до 40 с за раз), а человеку просьба видна и в списке «Ждут решения» (agent_inbox), в том числе с телефона.

const helps = new Map();
const HELP_TTL_MS = 6 * 60 * 60 * 1000;
const HELP_MAX_WAIT_S = 40;

const helpView = (item) => ({ id: item.id, status: item.status, message: item.message, reason: item.reason, need: item.need, agent: item.agent, tab: item.tab, created_at: item.createdAt, resolved_at: item.resolvedAt || null });

export function createHelp({ clients, userId, agent, reason, need = "", tab = "", url = "", query, broadcast }) {
  for (const [id, item] of helps) if (Date.now() - item.createdAt > HELP_TTL_MS) helps.delete(id);
  const item = { id: randomUUID(), userId: String(userId), agent: String(agent || "Агент").slice(0, 60), reason: String(reason || "нужна помощь").slice(0, 400), need: String(need || "").slice(0, 600), tab: String(tab || ""), url: String(url || "").slice(0, 300), status: "pending", message: "", createdAt: Date.now(), waiters: new Set(), inboxId: null };
  helps.set(item.id, item);
  const delivered = sendToUser(clients, userId, { type: "browser_help", help: { ...helpView(item), url: item.url } });
  // В очередь «Ждут решения»: видно и без открытого браузера, не пропадает при закрытом окне.
  query?.(
    `INSERT INTO agent_inbox(agent_name, item_type, title, body, priority, requires_human, props)
     VALUES ($1, 'help', $2, $3, 'high', true, $4::jsonb) RETURNING id::text`,
    [item.agent, `Агенту нужна помощь в браузере: ${item.reason}`.slice(0, 200), [item.need, item.url && `Страница: ${item.url}`].filter(Boolean).join("\n"), JSON.stringify({ browser_help_id: item.id, to: "Человек" })],
  ).then((result) => { item.inboxId = result.rows[0]?.id || null; broadcast?.("entity_changed", { entity: "agent_inbox", action: "create", actor: item.agent, detail: item.reason, silent: false }); }).catch(() => {});
  return { ...helpView(item), delivered };
}

export function waitHelp(id, seconds = HELP_MAX_WAIT_S) {
  const item = helps.get(id);
  if (!item) return Promise.resolve({ id, status: "unknown", message: "Просьба не найдена (сервер перезапускался или она устарела). Создай новую." });
  if (item.status !== "pending") return Promise.resolve(helpView(item));
  const limit = Math.min(Math.max(Number(seconds) || HELP_MAX_WAIT_S, 1), HELP_MAX_WAIT_S) * 1000;
  return new Promise((resolve) => {
    const waiter = (view) => { clearTimeout(timer); item.waiters.delete(waiter); resolve(view); };
    const timer = setTimeout(() => { item.waiters.delete(waiter); resolve({ ...helpView(item), status: "pending", hint: "Человек ещё не ответил. Вызови browser_wait_help снова или продолжай другую работу." }); }, limit);
    item.waiters.add(waiter);
  });
}

export function resolveHelp({ id, userId, action, message, query, clients }) {
  const item = helps.get(id);
  if (!item || item.userId !== String(userId)) return null;
  if (item.status !== "pending") return helpView(item);
  item.status = action === "stop" ? "stopped" : action === "cancel" ? "cancelled" : "done";
  item.message = String(message || "").slice(0, 1000);
  item.resolvedAt = Date.now();
  const view = helpView(item);
  for (const waiter of [...item.waiters]) waiter(view);
  if (item.inboxId) query?.("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.inboxId]).catch(() => {});
  sendToUser(clients, userId, { type: "browser_help_resolved", help: view });
  return view;
}

export const listHelps = (userId) => [...helps.values()].filter((item) => item.userId === String(userId) && item.status === "pending").map(helpView);

/** Маршруты /api/mbox/browser/help*: создать, ждать, ответить. Только владелец. */
export async function handleBrowserHelpApi({ req, res, url, readBody, sendJson, owner, user, actor, clients, query, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/browser/help")) return false;
  if (!owner) { sendJson(res, 403, { error: "owner_required" }); return true; }
  if (url.pathname === "/api/mbox/browser/help" && req.method === "GET") { sendJson(res, 200, { helps: listHelps(user.id) }); return true; }
  if (url.pathname === "/api/mbox/browser/help" && req.method === "POST") {
    const body = await readBody(req);
    sendJson(res, 201, createHelp({ clients, userId: user.id, agent: actor, reason: body.reason, need: body.need, tab: body.tab, url: body.url, query, broadcast }));
    return true;
  }
  const match = url.pathname.match(/^\/api\/mbox\/browser\/help\/([0-9a-f-]{36})(\/resolve)?$/);
  if (!match) return false;
  if (!match[2] && req.method === "GET") { sendJson(res, 200, await waitHelp(match[1], Number(url.searchParams.get("wait")) || 1)); return true; }
  if (match[2] && req.method === "POST") {
    const body = await readBody(req);
    const view = resolveHelp({ id: match[1], userId: user.id, action: String(body.action || "done"), message: body.message, query, clients });
    sendJson(res, view ? 200 : 404, view || { error: "not_found" });
    return true;
  }
  return false;
}
