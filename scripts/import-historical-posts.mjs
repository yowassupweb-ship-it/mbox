/**
 * Разовый бул-импорт исторического архива канала (tg_history/posts_dataset.jsonl, 4716 постов)
 * в MBOX как memories/entity_type='post', в папку "Посты" (folder id захардкожен — известна из
 * ручной проверки, не создаётся заново). НЕ автоматизировано в архивариусе намеренно: это разовая
 * миграция, а не периодическая задача.
 *
 * Дедуп через уникальный индекс idx_memories_telegram_post (source_id, message_id) — source_id
 * здесь константа 'historical-import' (не привязано к реальному data_sources.id, потому что
 * источник telegram_channel ещё не заведён). Повторный запуск скрипта безопасен: дубли ловятся
 * 23505 и пропускаются, не падают всем скриптом.
 *
 * Node fetch отправляет UTF-8 корректно по умолчанию — в отличие от PowerShell 5.1
 * Invoke-RestMethod, который без явной кодировки портит кириллицу (см. SKILL.md).
 *
 * Запуск: node scripts/import-historical-posts.mjs
 */
import { readFileSync } from "node:fs";

const baseUrl = process.env.MBOX_URL || "https://mbox.shar-os.ru";
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;
const FOLDER_ID = "21";
const PROJECT_ID = "4";
const CONCURRENCY = 5;

if (!password) {
  console.error("MBOX_PASSWORD is required");
  process.exit(1);
}

let cookie = "";
async function login() {
  const response = await fetch(`${baseUrl}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function importPost(post) {
  const text = String(post.text || "").trim();
  // Пост без подписи (только фото/видео) даёт пустой content и неотличимый заголовок "Пост от
  // <дата>" — таких десятки на один день, они забивали папку неразличимым мусором без единого
  // слова текста. Пропускаем: реакции этих постов теряются для процентильной статистики, но
  // владелец явно попросил убрать "пустые паттерны", это сознательный компромисс, не баг.
  if (!text) return "skipped-empty";
  const postedAt = post.date ? new Date(post.date).toISOString() : null;
  const title = text.slice(0, 80) || `Пост от ${postedAt ? postedAt.slice(0, 10) : "?"}`;
  const metadata = {
    source_id: "historical-import",
    message_id: String(post.id),
    posted_at: postedAt,
    has_photo: Boolean(post.has_photo),
    media_type: post.media_type || "",
    reactions_total: Number(post.reactions_total) || 0,
    reactions_breakdown: post.reactions_breakdown || {},
  };
  const response = await fetch(`${baseUrl}/api/mbox/memories`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      folder_id: FOLDER_ID,
      project_id: PROJECT_ID,
      title,
      content: text,
      entity_type: "post",
      access_level: "agents",
      tags: ["imported", "historical"],
      metadata,
    }),
  });
  if (response.ok) return "inserted";
  // Уникальный индекс idx_memories_telegram_post ловит повтор — сервер оборачивает ЛЮБУЮ ошибку
  // (server/mbox-server.mjs, httpServer catch) в 503 с error.message, не в 409, и текст сообщения
  // Postgres — "duplicate key value violates unique constraint ...", не код "23505" (тот только
  // в error.code, не в message). Читаем тело РОВНО один раз, иначе node fetch падает с
  // "Body has already been read".
  const bodyText = await response.text();
  if (bodyText.includes("duplicate key")) return "duplicate";
  throw new Error(`#${post.id}: ${response.status} ${bodyText}`);
}

async function main() {
  await login();
  const lines = readFileSync(new URL("../../tg_history/posts_dataset.jsonl", import.meta.url), "utf8")
    .split("\n").filter(Boolean);
  const posts = lines.map((line) => JSON.parse(line));

  let inserted = 0;
  let duplicates = 0;
  let skippedEmpty = 0;
  let failed = 0;
  let done = 0;

  async function worker(queue) {
    for (const post of queue) {
      try {
        const result = await importPost(post);
        if (result === "duplicate") duplicates += 1;
        else if (result === "skipped-empty") skippedEmpty += 1;
        else inserted += 1;
      } catch (error) {
        failed += 1;
        console.error(`failed #${post.id}: ${error.message}`);
      }
      done += 1;
      if (done % 200 === 0) console.log(`progress: ${done}/${posts.length}`);
    }
  }

  const chunks = Array.from({ length: CONCURRENCY }, () => []);
  posts.forEach((post, index) => chunks[index % CONCURRENCY].push(post));
  await Promise.all(chunks.map(worker));

  console.log(JSON.stringify({ total: posts.length, inserted, duplicates, skippedEmpty, failed }));
}

await main();
