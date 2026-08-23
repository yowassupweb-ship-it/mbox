#!/usr/bin/env node
// Todo #163: ни одного автотеста в проекте, регрессии ловятся только вручную. Это минимальный
// smoke-тест на критичные API-ручки — не юнит-тесты и не покрытие, а быстрая проверка "сервер жив
// и базовые ручки не сломаны" перед/после деплоя. Запуск: node scripts/smoke-test.mjs
// (или npm run smoke-test). MBOX_URL/MBOX_USERNAME/MBOX_PASSWORD — как у остальных скриптов.

const baseUrl = process.env.MBOX_URL || "https://mbox.shar-os.ru";
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;

if (!password) {
  console.error("MBOX_PASSWORD не задан в окружении — нечем логиниться.");
  process.exit(1);
}

let cookie = "";

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  return response;
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check("login", async () => {
  const res = await request("/api/mbox/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  if (res.status !== 200) throw new Error(`ожидал 200, получил ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("нет set-cookie в ответе логина");
  cookie = setCookie.split(";")[0];
  const body = await res.json();
  if (!body.user?.username) throw new Error("в ответе логина нет user.username");
});

check("GET /api/mbox/auth/me", async () => {
  const res = await request("/api/mbox/auth/me");
  if (res.status !== 200) throw new Error(`ожидал 200, получил ${res.status}`);
  const body = await res.json();
  if (!body.user) throw new Error("нет user в ответе");
});

check("GET /api/mbox/projects", async () => {
  const res = await request("/api/mbox/projects");
  if (res.status !== 200) throw new Error(`ожидал 200, получил ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.projects)) throw new Error("projects не массив");
  if (!body.projects.length) throw new Error("projects пустой — подозрительно для прода");
});

check("GET /api/mbox/agent/inbox", async () => {
  const res = await request("/api/mbox/agent/inbox");
  if (res.status !== 200) throw new Error(`ожидал 200, получил ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.inbox)) throw new Error("inbox не массив");
});

check("GET /api/mbox/agents", async () => {
  const res = await request("/api/mbox/agents");
  if (res.status !== 200) throw new Error(`ожидал 200, получил ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.agents)) throw new Error("agents не массив");
});

check("GET /api/mbox/memories", async () => {
  const res = await request("/api/mbox/memories");
  if (res.status !== 200) throw new Error(`ожидал 200, получил ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.memories)) throw new Error("memories не массив");
});

check("GET /api/mbox/server", async () => {
  const res = await request("/api/mbox/server");
  if (res.status !== 200) throw new Error(`ожидал 200, получил ${res.status}`);
});

check("logout", async () => {
  const res = await request("/api/mbox/auth/logout", { method: "POST" });
  if (res.status !== 200) throw new Error(`ожидал 200, получил ${res.status}`);
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

console.log(`\n${checks.length - failed}/${checks.length} прошли`);
process.exit(failed > 0 ? 1 : 0);
