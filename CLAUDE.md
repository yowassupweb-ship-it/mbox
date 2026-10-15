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
| `docs/design-doctrine.md` | доктрина дизайна: токены, темы, компоненты, правила UI — читать перед любой правкой стилей |

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

Полный текст каждого пункта — [docs/pitfalls.md](docs/pitfalls.md). **Перед правкой зоны из списка прочитай её пункт целиком.**

1. API написан дважды — `vite.config.ts` и `server/mbox-server.mjs` независимы: **правя ручку, правь обе**.
2. Прод отдаёт закоммиченный билд — изменение в `src/` попадает на прод только с коммитом собранного `public/`.
3. Миграций нет — новое поле дописывать и в `CREATE TABLE`, и `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` в `schema/mbox_postgres.sql`.
4. Пул соединений
5. Аудит через GUC
6. `props` — главное место для структурных фактов
7. Уникальность todo
8. Артефакты не лежат в папках
9. Присутствие агентов — отдельная таблица
10. Автоответ Джарвиса
11. Поиск по памяти
12. Отладка Джарвиса через MCP
13. Локальные папки (MBOX Desktop)
14. Заметки и хранилище S3
15. MBOX Desktop несёт интерфейс в себе (с 0.1.12)
16. Чаты консоли (props.thread)
17. Доступ к заметкам
18. Таблицы и Word в локальных папках
19. Участники (role member) и проекты
20. Контекст фокуса в чате
21. Редактор таблиц
22. Ошибки и тело запроса в прод-API
23. Документы, таблицы, поиск, присутствие
24. Скорость ответа агента
25. Установка наблюдателей на чужом ПК и отключение агентов
26. Приглашения, вход и вход в CLI
27. Свой MBOX и Desktop у коллег
28. Документы: права и общий доступ
29. Интеграции (внешние API с ключами)
30. Gmail
31. Агент в браузере: курсор, настоящий ввод, просьба о помощи
32. Агенты и хранилище S3
33. Личные пространства, роли owner и member
34. Рабочее пространство и презентации
35. Telegram-боты
36. Ноды (Ubuntu-серверы с Claude Code и Codex)
37. Дизайн-системы проекта
38. MCP по HTTP (ChatGPT и другие удалённые клиенты)
## Работа агента с MBOX

**Вся работа записывается в MBOX через MCP `mbox-prod` — обязательно.** Любая программа, скрипт, правка, сборка или релиз,
сделанные агентом, должны оставить след в MBOX: задача (`create_task`/`set_task_status`, факты в `props`, ход — в `note`),
запуск (`create_agent_run`) и/или решение (`record_decision`). Работа, которой нет в MBOX, считается несделанной. Если MCP
недоступен — сказать об этом человеку в начале работы, а не молча работать мимо MBOX.

MCP-сервер `mbox-prod` подключён на уровне пользователя (`claude mcp add mbox-prod -s user`, `~/.claude.json`): запускает
`~/.mbox/agent/scripts/mbox-mcp-server.mjs` из набора `mbox-agent` с `MBOX_URL`, `MBOX_TOKEN` аккаунта и `MBOX_AGENT_NAME=Claude`.
Проверка — `claude mcp get mbox-prod`. Инструменты:
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

`blocked` ставит только владелец. Агент, которому нужны ответ или данные владельца, статус не меняет: задача остаётся в
`next`/`open`, вопрос уходит в `create_inbox_item` с `requires_human=true` (раздел «Требуют внимания»).

Задачи по самому MBOX живут в todo проекта `MBOX` в боевой БД, не в локальных файлах.

**Номер задачи — в каждый коммит.** Пиши `#N` в сообщении коммита: `Closes #N` закрывает todo, просто `#N` привязывает
коммит (`todo_commits`, `server/todo-commits.mjs`, `POST /api/mbox/todos/commits`). Задача с коммитом, но не закрытая, попадает в
`needs_closing` в `get_agent_context` — закрой её (проверив, что работа сделана) или объясни в `note`, чего не хватает. Хук
`scripts/git-hooks/post-commit` включает `node scripts/install-git-hooks.mjs` (нужен `MBOX_TOKEN`).

**Агент по сроку.** У задачи планировщика `props.automation = {agent, prompt, time}`: в день срока (в `time`) сервер кладёт задание
в `agent_inbox` выбранному агенту (`dueTaskAutomations` в `server/planner.mjs`, тот же тик, что и у событий календаря;
запуск на срок один — `todo_automation_runs`). Повторяющаяся задача после запуска сама переезжает на следующий срок, остальные
агент закрывает сам. У событий календаря то же самое — `automation` события.

Лизинг задач: `claimed_by` / `claimed_until` / `heartbeat_at`. `claim` берёт задачу на 45 минут,
повторный `claim` тем же агентом продлевает, чужой активный лиз даёт 409.

## Навыки агентов

Навыки Claude и Codex (`SKILL.md`, правила, шаблоны, скрипты) хранятся в `skills/` и выкатываются вместе с сервером — см. [skills/README.md](skills/README.md). Установленные копии в `~/.claude/skills` и `~/.codex/skills` ставит и перезаписывает `scripts/sync-skills.mjs` (наблюдатель Claude — сам, при старте и раз в час); правки — только в `skills/`, потом деплой. Каталог для страницы «Навыки» — `server/skill-catalog.mjs` (`pages` — вкладки навыка, первая — «Запустить»). Агенты правят файлы навыков на лету (MCP `edit_skill_file`, база `skill_file_versions`, `server/skill-overrides.mjs`; в репозиторий — `npm run mbox:skills-pull`) и открывают вкладки в интерфейсе владельца (MCP `open_tab` → `POST /api/mbox/ui/open` → вебсокет только окнам этого пользователя, `server/ui-open.mjs`, `src/app/workbench/agentTabs.ts`).

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
- Размеры шрифта, веса и радиусы — только токенами из `src/styles/tokens.css` (`--text-2xs…2xl`, `--text-reading`,
  `--weight-normal|medium|semibold|bold`, `--radius-xs…xl|pill`), числа в компонентах не писать. Шрифт — Inter,
  моноширинный — `--font-mono`; пиксельного шрифта больше нет (`--font-pixel` — алиас на Inter).
- Геометрия «macOS + VS Code» — слой `src/styles/hig.css` (подключён последним): кнопки, поля в одну строку, чипы,
  вкладки — пилюли; карточки — `--radius-lg`; меню — `--radius-md`. Списки классов там в `:is()`, не в `:where()`:
  у `:where()` нулевая специфичность, и старые правила его перебивают. Белые полупрозрачные цвета — через
  `color-mix(in srgb, var(--text-main) N%, transparent)`, иначе светлая тема ломается.
- Подтверждения и сообщения — `askConfirm`/`showNotice`/`askText` из `src/ui/askText.tsx`, не `window.confirm/alert`.
- Значки файлов и папок — `FileTypeIcon`/`FolderIcon` (`src/app/workbench/FileTypeIcon.tsx`, SVG из пакета
  `material-icon-theme`); новое расширение — дописать в `BY_EXT` и, если нужен новый SVG, в шаблон `import.meta.glob`.
