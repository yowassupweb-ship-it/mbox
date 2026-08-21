/**
 * Разовая чистка: удаляет уже вставленные исторические посты без текста (фото/видео без подписи) —
 * они дают пустой content и неразличимый заголовок "Пост от <дата>", владелец попросил убрать этот
 * мусор. import-historical-posts.mjs теперь их не создаёт вовсе (см. importPost), это только чистка
 * того, что успело залиться до фикса.
 *
 * Запуск: node scripts/cleanup-empty-posts.mjs
 */
const baseUrl = process.env.MBOX_URL || "https://mbox.shar-os.ru";
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;

let cookie = "";
async function login() {
  const response = await fetch(`${baseUrl}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function main() {
  await login();
  const data = await (await fetch(`${baseUrl}/api/mbox/memories`, { headers: { cookie } })).json();
  const empty = (data.memories || []).filter((m) => m.entity_type === "post" && (m.tags || []).includes("historical") && !String(m.content || "").trim());
  console.log(`found ${empty.length} empty historical posts`);
  let removed = 0;
  let done = 0;
  const CONCURRENCY = 2;
  async function worker(queue) {
    for (const memory of queue) {
      try {
        const response = await fetch(`${baseUrl}/api/mbox/memories/${memory.id}`, { method: "DELETE", headers: { cookie } });
        if (response.ok) removed += 1;
      } catch { /* transient network blip — skip, rerun script to catch stragglers */ }
      done += 1;
      if (done % 50 === 0) console.log(`progress: ${done}/${empty.length}`);
    }
  }
  const chunks = Array.from({ length: CONCURRENCY }, () => []);
  empty.forEach((memory, index) => chunks[index % CONCURRENCY].push(memory));
  await Promise.all(chunks.map(worker));
  console.log(JSON.stringify({ found: empty.length, removed }));
}

await main();
