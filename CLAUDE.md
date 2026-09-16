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
| `server/jarvis.mjs` | **весь Джарвис**: инструменты, маршрутизация по группам, агентный цикл, модели, источники данных; импортируется и прод-сервером, и `vite.config.ts` |
| `server/env.mjs` | загрузка `.env`/`.env.local` — импортируется первым, до `jarvis.mjs` |
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
- `GROQ_API_KEY`/`GROQ_MODEL`/`GROQ_MODEL_JUNIOR` — резервный прораб + резервная модель навыков.
  Навыки (`skillComplete`) идут на Gemini, `GROQ_MODEL_JUNIOR` включается только когда Gemini
  недоступен — раньше было наоборот, навыки всегда шли на младшую oss-модель.
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
   Исключение — Джарвис: с 2026-09-15 он живёт в одном `server/jarvis.mjs` (todo #258). Прод-сервер и
   `vite.config.ts` импортируют модуль и передают ему доступ к данным через `configureJarvis({ query,
   broadcastRealtime, rankMemories, recordMemoryAction })`; типы для TS — `server/jarvis.d.mts`.
   `scripts/mbox-archivist.mjs` своего агентного цикла больше не имеет: пропущенный вопрос он отдаёт
   серверу через `POST /api/mbox/agent/inbox/:id/answer`. `check:mirror` удалён — сверять нечего.
   Модуль читает ключи моделей из `process.env` при загрузке, поэтому `server/env.mjs` обязан
   импортироваться раньше него.
2. **Прод отдаёт закоммиченный билд.** Изменение в `src/` не попадёт в прод без `npm run build` и
   коммита `public/`. `--emptyOutDir false` не чистит старые хеш-бандлы — мусор в `public/assets`
   накапливается, удалять руками.
3. **Миграций нет.** `schema/mbox_postgres.sql` идемпотентен (`CREATE TABLE IF NOT EXISTS`,
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Новое поле = дописать и `CREATE TABLE`, и `ALTER`,
   иначе боевая БД не обновится.
4. **Пул соединений.** `query()` в обеих реализациях берёт соединение из `pg.Pool` (`max: 8`).
   Раньше в `server/mbox-server.mjs` был `new pg.Client()` на каждый вызов: на проде с локальной
   базой это незаметно, но при локальном запуске через ssh-туннель каждое подключение стоило ~2 с
   и экран грузился больше десяти секунд. Актор аудита ставится сессионно (`set_config`) на взятом
   из пула соединении — безопасно, потому что каждый запрос с актором выставляет свой перед
   обращением, а `audit_events` пишется только на мутациях. Всё равно не размножать вызовы в
   циклах: `/api/mbox/projects` делает 3 запроса к базе.
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
10. **Автоответ Джарвиса.** `POST /agent/inbox` будит Джарвиса на `item_type: "question"` от
   `Человек`/`Claude` без чужого `props.to` и на `item_type: "answer"` от `Человек` с
   `props.to = Джарвис` (кнопки «Требуют ответа»). Служебные `agent_error`/`agent_response` его не
   будят. Пока он думает, вопрос в статусе `doing`; архивариус отдаёт серверу только `open` старше
   минуты и `doing` старше 10 минут, не старше суток. Инструменты отдают `#ID`; в запрос модели идут
   только нужные группы инструментов (`TOOL_GROUPS`, догрузка — мета-инструмент `request_tools`).
11. **Поиск по памяти.** `GET /api/mbox/memories?q=` (строка поиска в UI) и `search_memory`
   Джарвиса ищут слова по отдельности с отрезанными окончаниями (`searchTerms` из `server/jarvis.mjs`),
   а не всю строку одной подстрокой. Остальные UI-ручки (`projects`, `artifacts`, `decisions`, …) пока
   ищут целой подстрокой.
12. **Отладка Джарвиса через MCP.** `list_inbox` (тексты и трейс инструментов), `get_inbox_item`
   (сообщение + ответы + ошибки), `get_jarvis_errors`. На сервере — фильтры `GET /agent/inbox`
   (`agent`, `item_type`, `q`, `before_id`, `limit`) и `GET /agent/inbox/:id`.
13. **Локальные папки (MBOX Desktop).** Файлы живут на компьютере, сервер их не видит. Общий модуль
   `server/workspaces.mjs` (подключён и в прод, и в `vite.config.ts`; таблицы создаёт сам при старте):
   реестр `workspaces` (присылает приложение вместе с git-сводкой), очередь `workspace_ops` (Джарвис и
   MCP-инструменты `workspace_*` ставят операцию, страница в Electron забирает её раз в 2 с через
   `src/app/workbench/localWorkspace.ts` и выполняет через мост `window.mboxDesktop.workspace`) и история
   `workspace_file_versions` (правки из MBOX, агентов и замеченные наблюдателем за диском). Мост принимает
   только ключ папки + относительный путь; запись в `.git` и исполняемые файлы (.exe/.cmd/.ps1…) отклоняется
   в `mbox-desktop/main.js`. Без запущенного приложения операции с файлами недоступны (`workspace_offline`).
14. **Заметки и хранилище S3.** `server/notes.mjs` (таблица `notes`, `/api/mbox/notes`) и `server/storage.mjs`
   (`storage_settings`, `/api/mbox/storage/*`) — общие модули прод/dev, таблицы создаются при старте, доступ только
   владельцу. S3 — Yandex Object Storage с подписью SigV4 на `node:crypto` без SDK (сверена с эталонами AWS);
   секрет ключа шифруется `pgp_sym_encrypt` тем же `MBOX_SECRET_KEY`. Загрузка идёт потоком через сервер
   (`POST /storage/upload?key=`, до 512 МБ), скачивание — временной подписанной ссылкой.
15. **MBOX Desktop несёт интерфейс в себе (с 0.1.12).** Окно грузит `mbox://app/` из `mbox-desktop/ui`
   (собирает `scripts/build-desktop-ui.mjs`, входит в `npm run dist`), а не сайт: мост к диску, агентам и SSH
   доступен только коду приложения. `/api/*` и `/downloads/*` главный процесс проксирует на `MBOX_URL` с cookie
   сессии; вебсокет страница открывает прямо на сервер (`src/lib/serverOrigin.ts`), cookie к нему добавляет
   `localUi.js`. Правка `src/` доходит до приложения только с новой версией (автообновление из
   `public/downloads/latest.yml`). `MBOX_UI=remote` — старый режим загрузки сайта (удобно для HMR).
   Изменения `mbox-desktop/main.js` требуют перезапуска приложения, перезагрузки страницы мало.

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

На сервере `/opt/mbox` — не git-клон (на 2026-09-17 `.git` там нет): деплой — распаковать `git archive` поверх
(`.env`, `archivist.env`, `.jarvis-session` в архив не входят и не затираются), затем
`docker compose -f docker-compose.production.yml build app && ... up -d app`.

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
  поддержка совсем старых браузеров без SameSite. С 2026-09-07 флаг `Secure` ставится не всегда, а
  только когда запрос пришёл по HTTPS (`x-forwarded-proto` от Caddy либо TLS-сокет) — см.
  `sessionCookie()` в `server/mbox-server.mjs`. На проде поведение то же, что и было; правка нужна
  локальному запуску `npm start` на `http://localhost:3000`, где браузер молча выбрасывал
  Secure-cookie, и после «успешного» логина весь UI оставался пустым. `SameSite=Lax` — то самое,
  что закрывает CSRF, — стоит по-прежнему всегда;
- `scripts/mbox_ssh_tunnel.py` ходит с `AutoAddPolicy()` и паролем из окружения.

## Стиль

- Русский в UI-строках и сообщениях пользователю, английский в идентификаторах, API и SQL.
- Комментариев в коде почти нет — не добавлять без нужды.
- Никаких новых зависимостей без спроса: сервер намеренно на голом `node:http`.
