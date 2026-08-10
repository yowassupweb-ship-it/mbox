import fs from "node:fs";
import { Client } from "pg";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const index = line.indexOf("=");
  if (index > 0) process.env[line.slice(0, index)] = line.slice(index + 1);
}

const todos = [
  ["Перевести интерфейс на боевые данные без демо", "Все основные разделы читают Postgres через /api/mbox/*, демо-данные не подмешиваются.", "done", "high"],
  ["Держать todo проекта MBOX в базе", "Все дальнейшие задачи по MBOX хранить в projects/todos для проекта MBOX.", "doing", "urgent"],
  ["Сущности проекта: todo, git, деплой, стек, доступ", "Проект раскладывается на отдельные сущности для AI-агентов.", "done", "high"],
  ["Авторизация без регистрации", "Вход через учетные записи users, регистрация отключена.", "done", "high"],
  ["Добавление логинов и паролей", "В разделе Доступ есть кнопка добавления защищенной записи, пароль шифруется.", "done", "high"],
  ["Серверная вкладка realtime", "Показывать CPU, RAM, диск, контейнеры и время метрики.", "done", "normal"],
  ["Убрать подложку за верхним поиском", "Оставить стеклянной только поисковую таблетку.", "done", "normal"],
  ["Развить редактирование todo с телефона и ПК", "Todo открываются как заметки: заголовок, статус, приоритет, тело заметки, проектная принадлежность.", "doing", "high"],
  ["WebSocket realtime для интерфейса", "Добавлен /api/mbox/realtime, heartbeat server_tick и entity_changed после ручных изменений.", "done", "high"],
  ["Перевести домен на HTTPS", "Caddy держит 80/443, HTTP редиректит на HTTPS, app работает во внутренней docker-сети.", "done", "high"],
  ["Контекстное меню дерева", "ПКМ по дереву: цвет, создание, удаление. Клик по строке открывает просмотр.", "done", "urgent"],
  ["Вернуть графическую вкладку графа", "Граф стал интерактивной картой с drag/zoom и кликабельными узлами.", "done", "high"],
];

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const project = await client.query("SELECT id FROM projects WHERE name = 'MBOX'");
const projectId = project.rows[0]?.id;
if (!projectId) throw new Error("MBOX project is missing");

await client.query("DELETE FROM todos WHERE project_id = $1", [projectId]);
for (const [title, note, status, priority] of todos) {
  await client.query(
    "INSERT INTO todos(project_id, title, note, status, priority, access_level) VALUES ($1, $2, $3, $4, $5, 'private')",
    [projectId, title, note, status, priority],
  );
}

await client.query(
  `INSERT INTO memories(title, content, entity_type, access_level, tags, metadata)
   VALUES ($1, $2, 'project', 'private', $3, $4)
   ON CONFLICT DO NOTHING`,
  [
    "Проект MBOX",
    "Рабочая система памяти и артефактов MBOX. Проект хранит todo, git, деплой, стек, доступы и состояние сервера в PostgreSQL.",
    ["MBOX", "project", "memory"],
    { project_id: String(projectId) },
  ],
);

const summary = await client.query("SELECT count(*)::int AS todos FROM todos WHERE project_id = $1", [projectId]);
console.log(JSON.stringify({ mbox_todos: summary.rows[0].todos }));
await client.end();
