import { createHash } from "node:crypto";

const DEFAULT_GROUP_ID = "223347696";
const DEFAULT_GROUP_NAME = "club223347696";
const DEFAULT_SUBSCRIPTION_URL = "https://vk.ru/app5898182_-53145183#s=3819494";
const DEFAULT_TOUR_URL = "https://vs-travel.ru/tour?id=";
const MAX_TOURS = 9;

function plain(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function parsePayload(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function splitKeys(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,+;|\s]+/);
  return values.map((item) => String(item).trim()).filter((item) => /^[A-Za-z0-9_-]{1,80}$/.test(item));
}

export function buildTourDialogUrl(keys, source = "post", groupName = DEFAULT_GROUP_NAME) {
  const normalized = [...new Set(splitKeys(keys))].slice(0, MAX_TOURS);
  if (!normalized.length) throw new Error("tour_keys_required");
  const ref = `${normalized.length === 1 ? "tour" : "tours"}:${normalized.join(",")}`;
  const query = new URLSearchParams({ ref });
  if (source) query.set("ref_source", String(source).slice(0, 80));
  return `https://vk.me/${groupName}?${query}`;
}

export function extractTourKeys(event) {
  const object = event?.object || {};
  const message = object.message || object;
  const payload = parsePayload(message.payload || object.payload);
  const sources = [
    payload?.tour_keys,
    payload?.tour_key,
    payload?.tours,
    payload?.tour,
    message.start_payload,
    message.ref,
    object.ref,
    event.ref,
  ];
  const keys = [];
  for (const source of sources) {
    if (source == null) continue;
    const normalized = String(Array.isArray(source) ? source.join(",") : source).replace(/^(?:vk_)?tours?(?:_key)?[:=_-]/i, "");
    keys.push(...splitKeys(normalized));
  }
  const text = String(message.text || "").trim();
  const textMatch = text.match(/^(?:(?:покажи|тур(?:ы)?|tour(?:s)?|tour_key)\s*[:=#-]?\s*)?([0-9]+(?:\s*[,;+]\s*[0-9]+)*)$/i);
  if (textMatch) keys.push(...splitKeys(textMatch[1]));
  return [...new Set(keys)].slice(0, MAX_TOURS);
}

function daysBetween(start, end) {
  if (!start || !end) return 1;
  const from = new Date(`${start}T00:00:00Z`);
  const to = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return 1;
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
}

function dayLabel(value) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

function money(value) {
  return new Intl.NumberFormat("ru-RU").format(Number(value) || 0);
}

export function makeTourCard(row, tourBaseUrl = DEFAULT_TOUR_URL) {
  const days = daysBetween(row.date_start, row.date_end);
  return {
    key: String(row.tour_id),
    title: String(row.tour_name || "Тур"),
    route: String(row.route_name || "Маршрут уточняется"),
    days,
    price: Number(row.price_from) || 0,
    url: `${tourBaseUrl}${encodeURIComponent(String(row.tour_id))}`,
    text: [
      `Название тура: ${row.tour_name || "Тур"}`,
      `Маршрут: ${row.route_name || "Маршрут уточняется"}`,
      `Количество дней: ${days} ${dayLabel(days)}`,
      `Стоимость: от ${money(row.price_from)} ₽`,
      `Перейти: ${tourBaseUrl}${encodeURIComponent(String(row.tour_id))}`,
    ].join("\n"),
  };
}

export async function loadTours(query, keys, tourBaseUrl = DEFAULT_TOUR_URL) {
  if (!keys.length) return [];
  const result = await query(
    `SELECT DISTINCT ON (tour_id)
            tour_id, tour_name, route_name, date_start::text, date_end::text, price_from
       FROM tour_sheets
      WHERE tour_id = ANY($1::text[])
        AND (date_end IS NULL OR date_end >= CURRENT_DATE)
        AND free_places > 0
      ORDER BY tour_id, date_start ASC NULLS LAST, price_from ASC`,
    [keys],
  );
  const order = new Map(keys.map((key, index) => [key, index]));
  return result.rows.map((row) => makeTourCard(row, tourBaseUrl)).sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));
}

export function buildBotReply(cards, subscriptionUrl = DEFAULT_SUBSCRIPTION_URL) {
  if (!cards.length) {
    return {
      message: `Не нашёл доступный тур по этому ключу. Подпишитесь на рассылку ВКонтакте — там появляются новые туры: ${subscriptionUrl}`,
      keyboard: {
        inline: true,
        buttons: [[{ action: { type: "open_link", link: subscriptionUrl, label: "Подписаться" } }]],
      },
    };
  }
  const buttons = cards.map((card) => ({
    action: { type: "open_link", link: card.url, label: cards.length === 1 ? "Перейти" : `Перейти: ${card.title}`.slice(0, 40) },
  }));
  buttons.push({ action: { type: "open_link", link: subscriptionUrl, label: "Подписаться на рассылку" } });
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return {
    message: `${cards.map((card) => card.text).join("\n\n———\n\n")}\n\nПодпишитесь на рассылку ВКонтакте, чтобы не пропускать новые туры: ${subscriptionUrl}`,
    keyboard: { inline: true, buttons: rows },
  };
}

function randomId(event) {
  const source = String(event?.event_id || event?.object?.message?.conversation_message_id || Date.now());
  return createHash("sha256").update(source).digest().readUInt32BE(0) & 0x7fffffff;
}

export async function sendVkMessage({ fetchImpl = fetch, token, apiVersion, peerId, event, reply }) {
  const body = new URLSearchParams({
    access_token: token,
    v: apiVersion,
    peer_id: String(peerId),
    random_id: String(randomId(event)),
    message: reply.message,
    keyboard: JSON.stringify(reply.keyboard),
  });
  const response = await fetchImpl("https://api.vk.com/method/messages.send", { method: "POST", body });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error?.error_msg || `VK API ${response.status}`);
  return result.response;
}

export async function processVkEvent({ event, query, fetchImpl = fetch, config }) {
  if (event?.type !== "message_new") return { ignored: true };
  const message = event.object?.message || event.object || {};
  const peerId = message.peer_id || message.from_id;
  if (!peerId) return { ignored: true };
  const keys = extractTourKeys(event);
  const cards = await loadTours(query, keys, config.tourBaseUrl);
  const reply = buildBotReply(cards, config.subscriptionUrl);
  await sendVkMessage({ fetchImpl, token: config.token, apiVersion: config.apiVersion, peerId, event, reply });
  return { peerId: String(peerId), keys, cards };
}

export function vkTourBotConfig(env = process.env) {
  return {
    groupId: String(env.VK_BOT_GROUP_ID || DEFAULT_GROUP_ID),
    subscriptionUrl: String(env.VK_BOT_SUBSCRIPTION_URL || env.VK_BOT_COMMUNITY_URL || DEFAULT_SUBSCRIPTION_URL),
    tourBaseUrl: String(env.VK_BOT_TOUR_URL || DEFAULT_TOUR_URL),
    token: String(env.VK_BOT_TOKEN || ""),
    secret: String(env.VK_BOT_SECRET || ""),
    confirmationCode: String(env.VK_BOT_CONFIRMATION_CODE || ""),
    apiVersion: String(env.VK_BOT_API_VERSION || "5.199"),
  };
}

export async function handleVkTourBot({ req, res, url, query, readBody, env = process.env, fetchImpl = fetch, logger = console }) {
  if (!["/vk/callback", "/api/vk/callback"].includes(url.pathname)) return false;
  if (req.method !== "POST") {
    plain(res, 405, "method not allowed");
    return true;
  }
  const config = vkTourBotConfig(env);
  const event = await readBody(req);
  if (event.group_id && String(event.group_id) !== config.groupId) {
    plain(res, 403, "forbidden");
    return true;
  }
  if (event.type === "confirmation") {
    if (!config.confirmationCode) {
      plain(res, 503, "vk confirmation is not configured");
      return true;
    }
    plain(res, 200, config.confirmationCode);
    return true;
  }
  if (!config.secret || !config.token) {
    logger.error("VK bot: callback received, but bot credentials are not configured");
    plain(res, 503, "vk bot is not configured");
    return true;
  }
  if (String(event.secret || "") !== config.secret) {
    logger.warn(`VK bot: rejected ${String(event.type || "unknown")} callback (secret mismatch)`);
    plain(res, 403, "forbidden");
    return true;
  }
  logger.info(`VK bot: accepted ${String(event.type || "unknown")} callback`);
  plain(res, 200, "ok");
  void processVkEvent({ event, query, fetchImpl, config }).catch((error) => logger.error(`VK bot: ${error.message}`));
  return true;
}
