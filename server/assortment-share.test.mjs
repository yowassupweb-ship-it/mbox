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
  for (const name of ["assortment_rate", "assortment_exclude", "assortment_include", "assortment_learn_now", "assortment_refresh", "assortment_record_learning"]) assert.equal(levels[name], "manage");
  for (const name of ["assortment_reset_learned", "assortment_import_sales"]) assert.equal(levels[name], "owner");
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
