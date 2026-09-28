import assert from "node:assert/strict";
import test from "node:test";
import { buildBotReply, buildTourDialogUrl, extractCoverUrl, extractTourKeys, handleAppShow, handleVkTourBot, verifyLaunchParams, loadTours, makeTourCard, processVkEvent } from "./vk-tour-bot.mjs";

const realFeedTour = {
  tour_id: "512",
  tour_name: "Незнакомая Кострома",
  route_name: "Кострома – Закулисье театра им. Островского – Костромской ювелирный завод (проезд на ж/д экспрессе «Ласточка»)",
  date_start: "2026-11-03",
  date_end: "2026-11-03",
  price_from: 5500,
};

test("extractTourKeys принимает один тур и группу", () => {
  assert.deepEqual(extractTourKeys({ object: { message: { text: "тур 512" } } }), ["512"]);
  assert.deepEqual(extractTourKeys({ object: { message: { payload: JSON.stringify({ tour_keys: ["512", "603"] }) } } }), ["512", "603"]);
  assert.deepEqual(extractTourKeys({ object: { message: { ref: "tours:512,603" } } }), ["512", "603"]);
});

test("ссылка из поста открывает диалог и передаёт один тур или группу через ref", () => {
  assert.equal(buildTourDialogUrl("512"), "https://vk.me/club223347696?ref=tour%3A512&ref_source=post");
  assert.equal(buildTourDialogUrl(["512", "603"]), "https://vk.me/club223347696?ref=tours%3A512%2C603&ref_source=post");
});

test("кнопка «Начать» после перехода по ссылке несёт ключи в ref", () => {
  const event = { object: { message: { text: "Начать", payload: JSON.stringify({ command: "start" }), ref: "tours:512,603", ref_source: "post" } } };
  assert.deepEqual(extractTourKeys(event), ["512", "603"]);
});

test("сообщение без ключа получает подсказку, а не «не нашёл»", () => {
  assert.match(buildBotReply([], undefined, []).message, /^Пришлите номер тура/);
  assert.match(buildBotReply([], undefined, ["999"]).message, /^Не нашёл/);
});

test("карточка реального тура 512 содержит согласованный набор полей", () => {
  const card = makeTourCard(realFeedTour);
  assert.equal(card.days, 1);
  assert.equal(card.price, 5500);
  assert.equal(card.url, "https://vs-travel.ru/tour?id=512");
  assert.match(card.text, /^Незнакомая Кострома\n/);
  assert.match(card.text, /Маршрут: Кострома/);
  assert.match(card.text, /Продолжительность: 1 день/);
  assert.match(card.text, /Стоимость: от 5\s500 ₽/);
  assert.doesNotMatch(card.text, /https?:/);
});

test("обложка тура берётся из og:image страницы тура", () => {
  const html = '<meta property="og:image" content="/tourimages/2026/08/cover-md.jpg" />';
  assert.equal(extractCoverUrl(html, "https://vs-travel.ru/tour?id=512"), "https://vs-travel.ru/tourimages/2026/08/cover-md.jpg");
  assert.equal(extractCoverUrl("<html></html>", "https://vs-travel.ru/tour?id=512"), "");
});

test("loadTours сохраняет порядок группы ключей", async () => {
  const rows = [
    { ...realFeedTour, tour_id: "603", tour_name: "Для влюблённых в Кострому", date_end: "2026-11-05" },
    realFeedTour,
  ];
  const cards = await loadTours(async (_sql, params) => {
    assert.deepEqual(params, [["512", "603"]]);
    return { rows };
  }, ["512", "603"]);
  assert.deepEqual(cards.map((card) => card.key), ["512", "603"]);
});

test("ответ для группы содержит карточки и CTA подписки", () => {
  const reply = buildBotReply([makeTourCard(realFeedTour), makeTourCard({ ...realFeedTour, tour_id: "603" })]);
  assert.match(reply.message, /———/);
  assert.doesNotMatch(reply.message, /https?:/);
  for (const item of reply.format.items) assert.equal(reply.message.slice(item.offset, item.offset + item.length), "Незнакомая Кострома");
  assert.equal(reply.format.items.length, 2);
  assert.equal(reply.keyboard.buttons.flat().length, 3);
  assert.equal(reply.keyboard.buttons.flat().at(-1).action.link, "https://vk.ru/app5898182_-53145183#s=3819494");
});

test("сквозной обработчик читает фид и отправляет ответ VK без сохранения лида", async () => {
  let sent;
  const result = await processVkEvent({
    event: { type: "message_new", event_id: "event-512", object: { message: { peer_id: 42, text: "512" } } },
    query: async () => ({ rows: [realFeedTour] }),
    fetchImpl: async (url, options) => {
      sent = { url, body: options.body };
      return { ok: true, json: async () => ({ response: 101 }) };
    },
    config: {
      token: "test-token",
      apiVersion: "5.199",
      subscriptionUrl: "https://vk.ru/app5898182_-53145183#s=3819494",
      tourBaseUrl: "https://vs-travel.ru/tour?id=",
      photos: false,
    },
  });
  assert.deepEqual(result.keys, ["512"]);
  assert.equal(result.cards[0].title, "Незнакомая Кострома");
  assert.equal(sent.url, "https://api.vk.com/method/messages.send");
  assert.match(sent.body.get("message"), /Стоимость: от 5\s500 ₽/);
  assert.equal(sent.body.get("peer_id"), "42");
});

test("Callback API подтверждает сервер по group_id без secret в первом запросе VK", async () => {
  const response = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  const handled = await handleVkTourBot({
    req: { method: "POST" },
    res: response,
    url: new URL("https://mbox.shar-os.ru/vk/callback"),
    query: async () => ({ rows: [] }),
    readBody: async () => ({ type: "confirmation", group_id: 223347696 }),
    env: {
      VK_BOT_GROUP_ID: "223347696",
      VK_BOT_TOKEN: "test-token",
      VK_BOT_SECRET: "callback-secret",
      VK_BOT_CONFIRMATION_CODE: "confirm-me",
    },
  });
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.equal(response.body, "confirm-me");
});

const vkExampleLaunch = "?vk_user_id=494075&vk_app_id=6736218&vk_is_app_user=1&vk_are_notifications_enabled=1&vk_language=ru&vk_access_token_settings=&vk_platform=android&sign=htQFduJpLxz7ribXRZpDFUH-XEUhC9rBPTJkjUFEkRA";
const appConfig = { appId: "6736218", appSecret: "wvl68m4dR1UpLrVRli", groupId: "223347696", token: "test-token", apiVersion: "5.199", tourBaseUrl: "https://vs-travel.ru/tour?id=", photos: false };

test("подпись запуска мини-приложения сверена с официальным примером VK", () => {
  assert.equal(verifyLaunchParams(vkExampleLaunch, appConfig.appSecret).vk_user_id, "494075");
  assert.equal(verifyLaunchParams(vkExampleLaunch.replace("494075", "1"), appConfig.appSecret), null);
  assert.equal(verifyLaunchParams(vkExampleLaunch, ""), null);
});

function vkStub(allowed, calls) {
  return async (url, options) => {
    const method = String(url).split("/method/")[1];
    calls.push({ method, body: options?.body });
    const response = method === "messages.isMessagesFromGroupAllowed" ? { is_allowed: allowed ? 1 : 0 } : 101;
    return { ok: true, json: async () => ({ response }) };
  };
}

test("мини-приложение сразу шлёт туры, если человек уже разрешил сообщения", async () => {
  const calls = [];
  const result = await handleAppShow({ body: { launch: vkExampleLaunch, tours: "512,603" }, query: async () => ({ rows: [realFeedTour] }), config: appConfig, fetchImpl: vkStub(true, calls), logger: { info() {}, error() {}, warn() {} } });
  assert.deepEqual(result.body, { result: "sent", url: "https://vk.me/club223347696", count: 1 });
  const send = calls.find((call) => call.method === "messages.send");
  assert.equal(send.body.get("peer_id"), "494075");
});

test("мини-приложение ведёт в диалог с ref, если сообщения не разрешены", async () => {
  const calls = [];
  const result = await handleAppShow({ body: { launch: vkExampleLaunch, tours: "tours=512,603" }, query: async () => ({ rows: [] }), config: appConfig, fetchImpl: vkStub(false, calls) });
  assert.equal(result.body.result, "start");
  assert.equal(result.body.url, "https://vk.me/club223347696?ref=tours%3A512%2C603&ref_source=app");
  assert.equal(calls.some((call) => call.method === "messages.send"), false);
});

test("мини-приложение без верной подписи ничего не отправляет", async () => {
  const calls = [];
  const result = await handleAppShow({ body: { launch: vkExampleLaunch.replace("494075", "1"), tours: "512" }, query: async () => ({ rows: [] }), config: appConfig, fetchImpl: vkStub(true, calls) });
  assert.equal(result.status, 403);
  assert.equal(calls.length, 0);
});
