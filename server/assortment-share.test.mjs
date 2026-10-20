// Доступ к «Ассортименту» по ссылке и паролю: белый список вызовов, уровни инструментов, чат только там, где выдан.
// Сквозной сценарий (база, вход, сессии, чат, отзыв ссылок) прогнан отдельно на настоящем Postgres (PGlite), см. docs/assortment.md.
import assert from "node:assert/strict";
import test from "node:test";
import { accessOf, isAllowed } from "./assortment-share.mjs";
import { ASSORTMENT_TOOLS, canUseTool, toolLevel } from "./assortment-tools.mjs";
import { learningsAddPrinciple, learningsLog, learningsRecent, parseSalesCsv, moscowDay } from "./assortment-store.mjs";
import { chatAvailable } from "./assortment-chat.mjs";
import { runDailyTick } from "./assortment-scheduler.mjs";

const view = { mode: "view", chat: false }, viewChat = { mode: "view", chat: true }, manage = { mode: "manage", chat: false }, manageChat = { mode: "manage", chat: true };

test("белый список: просмотр читает отчёт и состояние, запись оценок только при управлении", () => {
  for (const share of [view, viewChat, manage, manageChat]) {
    assert.equal(isAllowed(share, "GET", "report").ok, true);
    assert.equal(isAllowed(share, "GET", "status").ok, true);
    assert.equal(isAllowed(share, "POST", "tool").ok, true, "какие инструменты — решает уровень доступа");
  }
  assert.deepEqual(isAllowed(view, "POST", "feedback"), { ok: false, reason: "read_only_share" });
  assert.equal(isAllowed(manage, "POST", "feedback").ok, true);
});

test("всё остальное закрыто даже для управления: ссылки, настройки, обновление, обход пути", () => {
  for (const [method, rest] of [["GET", "shares"], ["POST", "shares/link"], ["GET", "tools"], ["POST", "refresh"], ["GET", "report/../shares"], ["GET", "status//x"], ["DELETE", "report"], ["PUT", "feedback"], ["GET", ""]]) {
    assert.deepEqual(isAllowed(manageChat, method, rest), { ok: false, reason: "not_allowed_in_share" }, `${method} ${rest}`);
  }
});

test("чат доступен только ссылке или логину, у которых он выдан", () => {
  for (const [method, rest] of [["GET", "chat"], ["POST", "chat"], ["DELETE", "chat"]]) {
    assert.deepEqual(isAllowed(view, method, rest), { ok: false, reason: "chat_disabled" });
    assert.deepEqual(isAllowed(manage, method, rest), { ok: false, reason: "chat_disabled" });
    assert.equal(isAllowed(viewChat, method, rest).ok, true);
    assert.equal(isAllowed(manageChat, method, rest).ok, true);
  }
  assert.equal(isAllowed(manageChat, "PUT", "chat").ok, false);
});

test("уровни инструментов: просмотр не пишет, управление не трогает владельческое", () => {
  assert.equal(accessOf(view), "read");
  assert.equal(accessOf(manage), "manage");
  const levels = Object.fromEntries(ASSORTMENT_TOOLS.map((t) => [t.name, t.level]));
  for (const name of ["assortment_summary", "assortment_insights", "assortment_conflicts", "assortment_learnings"]) assert.equal(levels[name], "read");
  for (const name of ["assortment_rate", "assortment_exclude", "assortment_include", "assortment_learn_now", "assortment_record_learning"]) assert.equal(levels[name], "manage");
  for (const name of ["assortment_reset_learned", "assortment_import_sales", "assortment_refresh"]) assert.equal(levels[name], "owner");
  assert.equal(canUseTool("read", "assortment_rate"), false);
  assert.equal(canUseTool("manage", "assortment_rate"), true);
  assert.equal(canUseTool("manage", "assortment_import_sales"), false);
  assert.equal(canUseTool("owner", "assortment_import_sales"), true);
  assert.equal(canUseTool("owner", "assortment_unknown"), false);
  assert.equal(toolLevel("assortment_unknown"), null);
  assert.equal(new Set(ASSORTMENT_TOOLS.map((t) => t.name)).size, ASSORTMENT_TOOLS.length, "имена не повторяются");
});

test("чат доступен только при наличии ключа модели", () => {
  assert.equal(chatAvailable({}), false);
  assert.equal(chatAvailable({ GEMINI_API_KEY: "k" }), true);
  assert.equal(chatAvailable({ GROQ_API_KEY: "k" }), true);
});

test("продажи из CSV: разделитель и русские заголовки, повторы суммируются, мусор пропускается", () => {
  assert.deepEqual(parseSalesCsv("ID тура;Продано\n1;5\n2;7\n1;2\nx;3\n3;abc"), { 1: 7, 2: 7 });
  assert.deepEqual(parseSalesCsv("id,sold\n10,4"), { 10: 4 });
  assert.throws(() => parseSalesCsv("a;b\n1;2"), /id и sold/);
  assert.deepEqual(parseSalesCsv(""), {});
});

test("журнал выученного: принцип обновляется, а не дублируется; записи журнала сверху", () => {
  const seed = "# Выученное\n\n## Принципы\n\n## Журнал\n";
  const now = new Date("2026-10-20T09:00:00Z");
  let doc = learningsAddPrinciple(seed, "Новый год и каникулы", "Это разные поводы", now);
  assert.match(doc, /- \*\*Новый год и каникулы\.\*\* Это разные поводы _\(2026-10-20\)_/);
  doc = learningsAddPrinciple(doc, "Новый год и каникулы", "Уточнение", now);
  assert.equal((doc.match(/Новый год и каникулы/g) || []).length, 1);
  assert.ok(doc.includes("Уточнение") && !doc.includes("Это разные поводы"));
  doc = learningsAddPrinciple(doc, "Второй", "текст", now);
  assert.ok(doc.indexOf("Второй") < doc.indexOf("## Журнал"));
  doc = learningsLog(doc, "оценка", "c:1-2: отклонено", "Комментарий: «x»", { now });
  doc = learningsLog(doc, "оценка", "c:3-4: отклонено", "Комментарий: «y»", { now });
  assert.ok(doc.indexOf("c:3-4") < doc.indexOf("c:1-2"), "новые записи сверху");
  assert.equal(learningsLog(doc, "оценка", "c:3-4: отклонено", "", { dedupe: "c:3-4: отклонено", now }), doc, "повтор не пишется");
  assert.equal(learningsRecent(doc, 1).length, 1);
  assert.throws(() => learningsAddPrinciple(doc, "", "x"), /заголовок/);
});

test("планировщик: ночью не обновляет, при снимке за сегодня не обновляет, недавняя попытка откладывает", async () => {
  const today = moscowDay(new Date("2026-10-20T08:00:00Z"));
  const withSnapshot = async () => ({ rows: [{ 1: 1 }] });
  const without = async () => ({ rows: [] });
  assert.deepEqual(await runDailyTick(without, { now: new Date("2026-10-20T01:00:00Z"), log() {} }), { attempted: false }, "до 05:00 по Москве");
  assert.deepEqual(await runDailyTick(withSnapshot, { now: new Date("2026-10-20T08:00:00Z"), log() {} }), { attempted: false }, "снимок за сегодня есть");
  const now = new Date("2026-10-20T08:00:00Z");
  assert.deepEqual(await runDailyTick(without, { now, lastAttempt: now.getTime() - 60_000, log() {} }), { attempted: false }, "повтор не чаще раза в 30 минут");
  assert.equal(today, "2026-10-20");
});

test("чат: агент получает только инструменты своего уровня, ошибка инструмента возвращается модели, ответ сохраняется", async () => {
  const { chatTurn } = await import("./assortment-chat.mjs");
  const saved = [];
  const query = async (sql, params = []) => {
    if (/FROM \(SELECT id, role, content FROM assortment_chat_messages/.test(sql)) return { rows: [] };
    if (/FROM assortment_state/.test(sql)) return { rows: [] };
    if (/INSERT INTO assortment_chat_messages/.test(sql)) { saved.push([params[2], params[3]]); return { rows: [] }; }
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  };
  const seen = [];
  const completer = async (messages, tools) => {
    seen.push({ names: tools.map((t) => t.function.name), last: messages[messages.length - 1] });
    if (seen.length === 1) return { content: "", tool_calls: [{ id: "c1", function: { name: "assortment_rate", arguments: JSON.stringify({ key: "c:1-2", label: "no" }) } }] };
    return { content: "Оценку поставить не могу: у вас режим просмотра." };
  };
  const result = await chatTurn(query, { share: { id: "7", label: "тест" }, access: "read", thread: "abcdefgh12", text: "поставь оценку", completer });
  assert.equal(result.reply, "Оценку поставить не могу: у вас режим просмотра.");
  assert.deepEqual(result.tools, ["assortment_rate"]);
  assert.ok(seen[0].names.includes("assortment_summary") && !seen[0].names.some((n) => ["assortment_rate", "assortment_exclude", "assortment_refresh", "assortment_import_sales", "assortment_reset_learned"].includes(n)), "в режиме просмотра инструментов записи нет");
  assert.match(seen[1].last.content, /Ошибка: .*просмотр/, "ошибка уровня доступа вернулась модели, а не выполнилась запись");
  assert.deepEqual(saved.map((x) => x[0]), ["поставь оценку", "Оценку поставить не могу: у вас режим просмотра."]);
  const manage = [];
  await chatTurn(query, { share: { id: "7", label: "тест" }, access: "manage", thread: "abcdefgh12", text: "привет", completer: async (m, tools) => { manage.push(tools.map((t) => t.function.name)); return { content: "ок" }; } });
  assert.ok(manage[0].includes("assortment_rate") && manage[0].includes("assortment_exclude") && !manage[0].includes("assortment_refresh") && !manage[0].includes("assortment_import_sales"), "при управлении запись есть, владельческого нет");
});

test("чат с Claude или GPT: вопрос уходит облачному агенту с рамкой, ответ читается только по своей записи", async () => {
  const { handleAssortmentChat, cloudQuestion } = await import("./assortment-chat.mjs");
  const inbox = [];
  const messages = [];
  const query = async (sql, params = []) => {
    if (/FROM users WHERE role = 'owner'/.test(sql)) return { rows: [{ id: "1" }] };
    if (/FROM projects WHERE name = 'MBOX'/.test(sql)) return { rows: [{ id: "1" }] };
    if (/INSERT INTO agent_inbox/.test(sql)) { const row = { id: String(100 + inbox.length), title: params[0], body: params[1], props: JSON.parse(params[2]), project: params[3] }; inbox.push(row); return { rows: [{ id: row.id }] }; }
    if (/INSERT INTO assortment_chat_messages/.test(sql)) { messages.push(params); return { rows: [] }; }
    if (/count\(\*\) FILTER/.test(sql)) return { rows: [{ hour: 0, day: 0 }] };
    if (/AND NOT EXISTS/.test(sql)) return { rows: [] };
    if (/SELECT 1 FROM agent_inbox WHERE id = \$1/.test(sql)) { const q = inbox.find((r) => r.id === params[0] && String(r.props.share_id) === params[1] && `ash${r.props.share_id}-abcdefgh12` === params[2]); return { rows: q ? [{}] : [] }; }
    if (/props->>'in_reply_to' = \$1/.test(sql)) return { rows: inbox.filter((r) => r.answer && r.id === params[0]).map((r) => ({ body: r.answer, item_type: "answer" })) };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 70)}`);
  };
  const call = async (method, path, body, share) => {
    const res = {};
    await handleAssortmentChat({ req: { method }, res, url: new URL(path, "http://x"), query, readBody: async () => body || {}, sendJson: (r, status, out) => { r.status = status; r.body = out; }, share, access: "read", route: path.includes("/answer") ? "answer" : "" });
    return res;
  };
  const claude = { id: "7", mode: "view", chat: true, chat_agent: "claude", label: "тест" };
  let r = await call("POST", "/c", { thread: "abcdefgh12", text: "Что с Татарстаном?" }, claude);
  assert.equal(r.status, 202);
  assert.equal(r.body.pending, true);
  const q = inbox[0];
  assert.equal(q.props.to, "ClaudeCloud");
  assert.equal(q.project, "1", "вопрос привязан к проекту MBOX: без него наблюдатель облачного агента очередь не видит");
  assert.equal(q.props.source, "assortment-share");
  assert.equal(q.props.thread, "ash7-abcdefgh12");
  assert.match(q.body, /режим: просмотр/);
  assert.match(q.body, /не вызывай инструменты записи/);
  assert.match(q.body, /Что с Татарстаном\?/);
  r = await call("GET", `/c/answer?thread=abcdefgh12&ref=${r.body.ref}`, null, claude);
  assert.deepEqual([r.status, r.body.done], [200, false]);
  q.answer = "В Татарстане 37 туров при среднем 14.";
  r = await call("GET", `/c/answer?thread=abcdefgh12&ref=${q.id}`, null, claude);
  assert.deepEqual([r.body.done, r.body.reply], [true, "В Татарстане 37 туров при среднем 14."]);
  assert.ok(messages.some((m) => m[1] === "abcdefgh12" && m[2] === "assistant" || m[2] === "В Татарстане 37 туров при среднем 14."), "ответ сохранён в историю");
  r = await call("GET", `/c/answer?thread=abcdefgh12&ref=${q.id}`, null, { ...claude, id: "8" });
  assert.equal(r.status, 404, "чужая ссылка не читает записи этой");
  r = await call("GET", "/c/answer?thread=abcdefgh12&ref=1;drop", null, claude);
  assert.equal(r.status, 400);
  const codex = { ...claude, chat_agent: "codex" };
  await call("POST", "/c", { thread: "abcdefgh12", text: "привет" }, codex);
  assert.equal(inbox[1].props.to, "CodexCloud");
  assert.match(cloudQuestion("x", "manage"), /режим: управление/);
});

test("шаги цепочки для страницы: только инструменты ассортимента, вывод укорочен, чужие шаги агента не выходят наружу", async () => {
  const { publicStep } = await import("./assortment-chat.mjs");
  const own = publicStep({ name: "mcp__mbox-prod__assortment_summary", input: "{}", output: "x".repeat(5000), is_error: false, ms: 120 });
  assert.equal(own.name, "assortment_summary");
  assert.ok(own.output.length <= 1201);
  assert.equal(publicStep({ name: "assortment_insights", input: "{}", output: "ok" }).name, "assortment_insights");
  for (const name of ["mcp__mbox-prod__note_read", "mcp__mbox-prod__gmail_search", "Read", "Bash", "shell_command", "", undefined]) assert.equal(publicStep({ name, input: "секрет", output: "секрет" }), null, String(name));
});
