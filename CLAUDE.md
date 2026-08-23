# MBOX

Личная система памяти, проектов и задач с доступом для AI-агентов. Prod: https://mbox.shar-os.ru

Стек: React 19 + Vite 6 (без роутера), Node `http` без фреймворка, PostgreSQL 16, Caddy, Docker Compose.
UI на русском, код и API на английском.

## Карта репозитория

| Путь | Что это |
| --- | --- |
| `src/main.tsx` | **весь** фронтенд: 2200 строк, все экраны, формы, граф, инспекторы |
| `src/styles.css` | 2400 строк, единственный стиль-файл |
| `src/components/` | только TopBar, BottomNav, FolderTree |
| `server/mbox-server.mjs` | **прод**-API + статика + WebSocket |
| `vite.config.ts` | **dev**-API как vite-middleware — вторая, отдельная реализация тех же ручек |
| `schema/mbox_postgres.sql` | схема + сиды; одновременно init-скрипт и «миграции» |
| `scripts/mbox-mcp-server.mjs` | MCP-сервер `mbox-prod` — то, через что агенты ходят в MBOX |
| `public/` | закоммиченный прод-билд, который отдаёт `server/mbox-server.mjs` |
| `docs/entity-model.md` | сущности и уровни доступа |

## Команды

```bash
npm run dev                 # vite + dev-API из vite.config.ts, порт 5173
npm start                   # прод-сервер: public/ + API, порт 3000 (MBOX_PORT)
npm run build               # vite build --outDir public --emptyOutDir false
npm run mbox:docker:up      # локальный postgres + app
npm run mbox:db:tunnel      # ssh-туннель к боевой БД (нужен paramiko + MBOX_SSH_*)
node scripts/seed-mbox-project.mjs   # ПЕРЕЗАПИСЫВАЕТ все todo проекта MBOX
node scripts/publish-repo-structure.mjs [проект]  # публикует git ls-files в props.repo_structure — так Джарвис находит файлы через find_file, не имея доступа к файловой системе
```

Тестов нет. Проверка типов вручную: `npx tsc --noEmit`.

`.env.local` (в .gitignore) держит `DATABASE_URL` и `MBOX_REMOTE_DATABASE`. `.env`/`.env.local`
читаются самописным парсером в `server/mbox-server.mjs:88` и `vite.config.ts`, не через dotenv.

Модели Джарвиса — все опциональны через env, без ключа соответствующая возможность просто не
включается (без деградации остального):
- `GEMINI_API_KEY`/`GEMINI_MODEL` — основной "прораб".
- `GROQ_API_KEY`/`GROQ_MODEL`/`GROQ_MODEL_JUNIOR` — резервный прораб + младший агент для скиллов.
- `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_MODEL` — Workers AI, сжимает историю
  диалога в компактную сводку перед отправкой прорабу на длинных разговорах (todo #195). Без этих
  двух значений история просто идёт целиком, как раньше. Token — в дашборде Cloudflare
  (My Profile → API Tokens → Create Token, права `Workers AI:Read`), Account ID — на странице
  любого домена/Workers в том же дашборде, справа в сайдбаре.

## Ключевые подводные камни

1. **API написан дважды.** `vite.config.ts` и `server/mbox-server.mjs` — независимые реализации.
   Они уже разошлись: в dev-версии нет `agent_runs`, `agent_inbox`, `decision_log`, `/todos/:id/claim`,
   `/agent/next-task`, `/agent/context`, секретов и установки `mbox.actor` для аудита; зато есть
   `/api/mbox/status`, которого нет в проде. **Правя ручку, правь обе или сознательно решай, что нет.**
   Пример сознательного решения: `kind='telegram_channel'` в `refreshDataSourceById` реализован
   только в `server/mbox-server.mjs` (это то, что реально дёргает архивариус в проде) — в
   `vite.config.ts` его нет. На самом деле копии три — `scripts/mbox-archivist.mjs` (резервный
   cron, REST-клиент без доступа к БД) третья. Полный вынос в shared-модуль не сделан осознанно
   (todo #161): у копий разная механика доступа к данным (прямой `pg.Client` / vite dev middleware
   / чистый REST), реальный вынос — отдельная архитектурная задача. Вместо этого —
   `npm run check:mirror` (`scripts/check-triple-mirror.mjs`): сверяет набор инструментов Джарвиса
   (`JARVIS_TOOLS`) и веток диспетчера между тремя файлами, ловит забытые зеркалирования. На
   2026-08-23 сознательно не зеркалированы в `mbox-archivist.mjs`: `get_memory_actions`,
   `list_memory_links` (нужны новые REST GET-ручки, которых сейчас нет вообще), `analyze_posts`
   (тяжёлый инструмент, вряд ли нужен в резервном cron).
2. **Прод отдаёт закоммиченный билд.** Изменение в `src/` не попадёт в прод без `npm run build` и
   коммита `public/`. `--emptyOutDir false` не чистит старые хеш-бандлы — мусор в `public/assets`
   накапливается, удалять руками.
3. **Миграций нет.** `schema/mbox_postgres.sql` идемпотентен (`CREATE TABLE IF NOT EXISTS`,
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Новое поле = дописать и `CREATE TABLE`, и `ALTER`,
   иначе боевая БД не обновится.
4. **Соединение на каждый запрос.** `query()` создаёт новый `pg.Client` и закрывает его. Пула нет;
   `/api/mbox/projects` делает 3 таких коннекта. Не размножать вызовы в циклах.
5. **Аудит через GUC.** Триггер `write_audit_event()` пишет в `audit_events` актора из
   `current_setting('mbox.actor')`, который прод-API ставит из заголовка `x-mbox-agent` через
   `AsyncLocalStorage`. Запрос мимо `query()` запишется как `system`.
6. **`props` — главное место для структурных фактов.** У проектов и todo есть `props JSONB`.
   Свободный текст идёт в `note`/`content`, факты — в `props`, чтобы их читали другие агенты.
7. **Уникальность todo.** `idx_todos_project_title` — уникальный индекс по `(project_id, title)`.
   Одинаковые заголовки в одном проекте не вставятся.
8. **Артефакты не лежат в папках.** `artifacts.folder_id` у всех NULL; дерево в UI группирует их по
   `category`, совпадающей с именем папки. `/api/mbox/folders` считает вес обоими способами.
9. **Присутствие агентов — отдельная таблица.** `agent_presence` заполняется только через
   `POST /api/mbox/agent/ping`; MCP-сервер шлёт `session_start` при старте и `heartbeat` раз в 60 с.
   `/api/mbox/agents` собирает список из `agent_presence` + `audit_events.actor` + `agent_runs`.
   Ничего не хардкодить: агент появляется в UI, как только сходил в API.

## Работа агента с MBOX

MCP-сервер `mbox-prod` подключён в `../../.mcp.json` (агент `Claude`). Инструменты:
`describe_structure`, `get_agent_context`, `get_next_task`, `claim_task`, `set_task_status`,
`create_task`, `create_project_relation`, `create_inbox_item`, `create_agent_run`, `record_decision`,
`list_recent_history`, `list_project_context`, `get_project_access`.

Контракт (задан в `agentStructure` внутри `server/mbox-server.mjs:21`):
- до работы — `describe_structure` → `get_agent_context(MBOX)` → `get_next_task`;
- во время — держать `note` задачи актуальной, факты в `props`, связи проектов в `graph_edges`;
- после — выставить статус; если работа шла не от существующей todo, завести её постфактум или
  записать `record_decision`.

Статусы: `open` Новая, `next` Следующая, `doing` В работе, `blocked` Заблокирована,
`review` На проверке, `done` Готово, `archived` Архив. Приоритеты: `low|normal|high|urgent`.

Задачи по самому MBOX живут в todo проекта `MBOX` в боевой БД, не в локальных файлах.

Лизинг задач: `claimed_by` / `claimed_until` / `heartbeat_at`. `claim` берёт задачу на 45 минут,
повторный `claim` тем же агентом продлевает, чужой активный лиз даёт 409.

## Деплой

`docker-compose.production.yml`: `app` (Dockerfile.mbox, node 22, `npm start`) + `caddy` (TLS на
`MBOX_DOMAIN`, проксирует на `mbox-ui:3000`) во внешней сети `mbox-net`. Postgres живёт вне этого
compose — контейнер `mbox-postgres`. `scripts/server_metrics_collector.sh` крутится на хосте и
раз в 5 секунд пишет `server_metrics` (хранит последние 720 записей).

## Безопасность — известные слабые места

Не «чинить мимоходом», но помнить и предупреждать при работе рядом:
- `schema/mbox_postgres.sql:334` сидит `Admin` паролем `change-me-before-use` — это только сид для
  свежей установки; на проде пароль уже сменён (проверено 2026-08-22: bcrypt-хеш реальный, не
  дефолтный), но при разворачивании новой копии не забыть сменить сразу;
- ключ шифрования секретов падает в `MBOX_SECRET_KEY || DATABASE_URL || "mbox-local-key"` — на
  проде `MBOX_SECRET_KEY` выставлен явно (проверено 2026-08-22), но при смене `DATABASE_URL` без
  явного `MBOX_SECRET_KEY` на новой копии расшифровка сломается тихо;
- cookie-аутентификация без CSRF-токена, защита `HttpOnly; Secure; SameSite=Lax`. Проверено
  2026-08-22: мутирующих GET-ручек в mbox-server.mjs нет (все мутации — POST/PATCH/DELETE), поэтому
  `SameSite=Lax` перекрывает CSRF для актуальных браузеров без отдельного токена — сознательное
  решение не добавлять токен, а не недосмотр. Пересмотреть, если появится мутирующий GET или нужна
  поддержка совсем старых браузеров без SameSite;
- `scripts/mbox_ssh_tunnel.py` ходит с `AutoAddPolicy()` и паролем из окружения.

## Стиль

- Русский в UI-строках и сообщениях пользователю, английский в идентификаторах, API и SQL.
- Комментариев в коде почти нет — не добавлять без нужды.
- Никаких новых зависимостей без спроса: сервер намеренно на голом `node:http`.
