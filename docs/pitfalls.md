# Подводные камни MBOX

Перенесено из CLAUDE.md 15.10.2026: раздел весил ~31 КБ (около 9 тыс. токенов) и грузился в каждую сессию каждого агента,
в том числе в каждый чат с Claude из MBOX. В CLAUDE.md осталось оглавление; перед правкой зоны из списка читай её пункт здесь.

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
   (`storage_settings`, `/api/mbox/storage/*`) — общие модули прод/dev, таблицы создаются при старте, доступ владельцу и
   участникам (участникам — только папки их проектов, см. п. 19). S3 — Yandex Object Storage с подписью SigV4 на `node:crypto` без SDK (сверена с эталонами AWS);
   секрет ключа шифруется `pgp_sym_encrypt` тем же `MBOX_SECRET_KEY`. Загрузка идёт потоком через сервер
   (`POST /storage/upload?key=`, до 512 МБ), скачивание — временной подписанной ссылкой.
15. **MBOX Desktop несёт интерфейс в себе (с 0.1.12).** Окно грузит `mbox://app/` из `mbox-desktop/ui`
   (собирает `scripts/build-desktop-ui.mjs`, входит в `npm run dist`), а не сайт: мост к диску, агентам и SSH
   доступен только коду приложения. `/api/*` и `/downloads/*` главный процесс проксирует на `MBOX_URL` с cookie
   сессии; вебсокет страница открывает прямо на сервер (`src/lib/serverOrigin.ts`), cookie к нему добавляет
   `localUi.js`. Правка `src/` доходит до приложения только с новой версией (автообновление из
   `public/downloads/latest.yml`). `MBOX_UI=remote` — старый режим загрузки сайта (удобно для HMR).
   Изменения `mbox-desktop/main.js` требуют перезапуска приложения, перезагрузки страницы мало.

16. **Чаты консоли (props.thread).** «Новый чат» в `AgentChat.tsx` заводит id чата, его несут вопрос и ответ.
   Список с названиями и архивом — таблица `chat_threads` (`server/chat-threads.mjs`, `/api/mbox/agent/threads`,
   прод и dev). Наблюдатели Claude/Codex продолжают сессию CLI внутри чата (`claude --resume`, `codex exec resume`,
   соответствие чат → сессия в `~/.mbox/chat-sessions-*.json`, `scripts/chat-threads.mjs`) и не вклеивают историю
   заново; в `props.work` ответа — `context_tokens`/`context_window` для индикатора нагрузки. Джарвис берёт историю
   только из своего чата. Наблюдателей держит живыми `mbox-desktop/main.js` (сторож раз в минуту + перезапуск
   после падения); ручная остановка из интерфейса снимает агента со сторожа.
17. **Доступ к заметкам.** `notes.owner_user_id` + `access_level` (`private` по умолчанию | `project` | `all`).
   Уровень, проект, ссылки и удаление меняет только владелец. Инструменты Джарвиса получают `viewer` и видят
   заметки по тем же правилам. Будущие таблицы MBOX — по той же модели.
18. **Таблицы и Word в локальных папках.** Операции `read_table`/`write_cells`/`read_doc`/`write_data` очереди
   `workspace_ops` выполняет страница (`src/app/workbench/officeOps.ts`, exceljs/mammoth — те же, что во вкладке);
   `write_docx` сервер превращает в `write_data` через `server/docx.mjs` (markdown-таблицы в Word не переносятся).
   MCP: `note_*`, `workspace_edit_file`, `workspace_read_table` (`styles=true` — оформление), `workspace_write_cells`,
   `workspace_format_cells` (заливка/шрифт/рамки; едет той же операцией `write_cells` с полем `format`), `workspace_read_document`,
   `workspace_write_docx`; `show=true` открывает документ вкладкой у человека. Под наблюдателем MCP не дописывает
   к ответам пуш и напоминание (`MBOX_MCP_PUSH=off`) — это были лишние токены на каждом вызове.

19. **Участники (role member) и проекты.** Всё делится по проектам (`project_memberships`). Хранилище S3 — один бакет,
   у проекта папка `projects/<id>/`; участник видит и пишет только в папках своих проектов и в `notes/<id>/` доступных
   заметок (`storageAccessFor` в прод-сервере, то же в `vite.config.ts`; настройки бакета — только владельцу). Джарвис
   у участника — по флагу `users.jarvis_enabled` (админка «Команда»), видит только его проекты (`allowed_project_ids`).
   Каждый аккаунт запускает свой Claude/Codex CLI: наблюдатель под логином участника отвечает на его сообщения (сервер отдаёт ему только их), наблюдатель владельца пропускает `props.mbox_owner === false`. Агенты принадлежат аккаунту: `agent_presence` уникальна по `(owner_user_id, agent_name)` (миграция сама при старте: `server/agent-presence.mjs`), запуски помечены `props.mbox_user_id`, ростер и фазы — по аккаунту. У участника в `MBOX_USERNAME`/`MBOX_PASSWORD` (или `MBOX_TOKEN`) должны быть его данные.
   Новый маршрут для участника — в `memberRouteAllowed`, иначе 403.
20. **Контекст фокуса в чате.** Чипы над полем ввода — активная вкладка и вторая область (`chatFocus` в Workbench);
   уходят в `props.context` сообщения. Наблюдатели добавляют их в промпт (`focusLines` в `scripts/chat-threads.mjs`),
   Джарвис — в системный промпт. Новый вид вкладки, о котором агенту стоит знать, — добавить в `chatFocus`.
21. **Редактор таблиц** — `SheetEditor.tsx` (виртуальная сетка поверх листа exceljs) для .xlsx/.csv из локальных папок
   (`LocalOfficeDocument`) и из хранилища (`StorageSheetDocument`, вкладка `s3sheet:<ключ>`). exceljs формулы не
   считает — `formulaEval.ts` пересчитывает их после каждой правки и пишет result в файл; незнакомая функция
   оставляет результат, посчитанный Excel.

22. **Ошибки и тело запроса в прод-API.** `readBody` ограничен `MBOX_MAX_BODY_MB` (50 МБ, 413) и отвечает 400 на
   битый JSON; необработанное исключение уходит через `sendError`: ошибки ввода Postgres — 400, конфликты — 409,
   недоступная база — 503, остальное — 500 `internal_error` с записью в лог (раньше всё было 503 с текстом SQL).
   Вход: после 5 неудач с одного адреса на один логин — 429 с растущей паузой (в памяти процесса).
   Сокеты участников (`role` не `owner`) получают события без `detail`/`notification`/`step` — заголовки из чужих
   проектов туда не уходят. Заголовок `x-mbox-agent` принимается только от владельца. `PATCH /todos/:id` проверяет
   статус/приоритет и не даёт перехватить чужой активный лиз (409). Всё это только в `server/mbox-server.mjs`,
   dev-API в `vite.config.ts` не повторяет.

23. **Документы, таблицы, поиск, присутствие.** «Таблицы | Документы» — один раздел (`TablesView` + `DocumentsView`).
   Документы — Univer Docs на листах A4, снимок хранится как есть (`documents.snapshot`), Markdown для поиска/агентов
   строит `server/doc-snapshot.mjs`; таблицы — Univer Sheets, текст ячеек индексируется в `tables.text_content`
   (`server/table-ops.mjs`). MCP: `doc_search/read/write/edit`, `table_search/read/write_cells/append_rows/create`.
   Поиск в шапке (Ctrl+K) — `Spotlight.tsx` + `server/spotlight.mjs` (`/api/mbox/spotlight?q=`): заметки со всеми вкладками,
   документы, таблицы, проекты, задачи, память, артефакты; права как у остальных ручек. Присутствие — `server/presence.mjs`
   (комнаты `note:|table:|doc:ID` в памяти, проверка доступа при входе) и `usePresence` на клиенте; правки агента
   объявляются через `announceAgentEdit`. Курсоры коллег в Univer Docs используют внутренние сервисы
   (`@univerjs/docs-ui`, `NodePositionConvertToCursor`) — при обновлении Univer проверять.

24. **Скорость ответа агента.** Наблюдатель Claude держит «тёплый» процесс CLI на чат (`warmPool` в
   `scripts/claude-inbox-watcher.mjs`, `--input-format stream-json`): следующее сообщение дописывается в stdin, MCP и навыки
   заново не грузятся. Ход завершается по событию `result`, не по выходу процесса. Процесс гасится через 10 минут простоя
   (`MBOX_WATCH_WARM_IDLE_MS`), при смене модели/усилия, ротации сессии и синхронизации навыков; `MBOX_WATCH_WARM=0` — старый
   режим «процесс на сообщение». В чате действие агента — одна строка `ChainLine` (статус → итог), цепочка шагов раскрывается;
   статус появляется сразу при отправке, до ответа сервера (временный id `pending:`).

25. **Установка наблюдателей на чужом ПК и отключение агентов.** `scripts/mbox-agent.mjs` — один файл (только Node 20+):
   `install --url --user --token` скачивает набор (`GET /api/mbox/agent-kit`, `server/accounts.mjs`, белый список файлов `scripts/`),
   ставит MCP-зависимости, настраивает автозапуск (Windows — Startup `.vbs`, macOS — LaunchAgent, Linux — systemd --user) и держит
   наблюдателей под аккаунтом (`run`; `status|enable|disable|update|uninstall`). Агент выключен, если он выключен в `config.json` или в
   настройках MBOX: `users.agent_prefs` (`GET/PUT /api/mbox/account/agents`, «Настройки → Команда → Агенты на этом компьютере»); служба
   опрашивает это раз в 10 с. Интерфейс (`src/lib/agentPrefs.ts`) прячет выключенного агента из чата, а MBOX Desktop (`mbox-desktop/main.js`,
   `agents-config.json`) останавливает его и не поднимает при старте. `Dockerfile.mbox` копирует `scripts/` — без этого набор не отдастся.

26. **Приглашения, вход и вход в CLI.** Друзья попадают в MBOX только по ссылке `/invite/<токен>` (`server/accounts.mjs`:
   `handlePublicInvite`, `/admin/invites`; страница `src/pages/InviteScreen.tsx`, управление — «Настройки → Команда → Приглашения»).
   В приглашении выбираются проекты, число использований, срок и флаг Джарвиса (`account_invites.jarvis_enabled`, по умолчанию выключен);
   место занимается атомарно, отзыв — `revoked_at`. Логин нечувствителен к регистру (`lower(username)`), дефолтного «Admin» нигде нет:
   скрипты и наблюдатели требуют `MBOX_TOKEN` либо `MBOX_USERNAME` + `MBOX_PASSWORD`. Смена пароля — `POST /account/password`
   (закрывает остальные сессии), `GET /account/security` сообщает, что у аккаунта всё ещё пароль из сида.
   Вход в локальные Claude Code / Codex: `scripts/cli-auth.mjs` (`claude auth status|login`, `codex login status|login`), состояние
   присылает служба `mbox-agent` (`PUT /account/agents/cli`, каждые 5 с, она же забирает запрос «войти/выйти»; хранится в `users.agent_cli`),
   в MBOX Desktop то же через мост `cliStatus/cliLogin/cliLogout`. Кнопка — `CliAuthBanner` над чатом. Без входа служба не поднимает наблюдателя.
   Dev-API в `vite.config.ts` этих ручек не повторяет.

27. **Свой MBOX и Desktop у коллег.** `node scripts/selfhost-setup.mjs` + `docker-compose.selfhost.yml` поднимают базу и приложение
   (инструкция — `docs/self-host.md`); владельца создаёт `ensureInitialOwner` из `MBOX_ADMIN_USERNAME/PASSWORD`, пока у сидового владельца
   пароль по умолчанию. Сид «Admin» создаётся только если в базе нет ни одного владельца. MBOX Desktop: после входа главный процесс сам
   выпускает личный токен (`ensureDesktopCredentials`, хранится под `safeStorage`, отзывается при выходе) и запускает наблюдателей под этим
   аккаунтом; сервер выбирается на экране входа («другой сервер», `server.json` в userData, `MBOX_URL` главнее), обновления приложения — всегда
   с основного сервера. Наблюдателям Desktop по-прежнему нужен системный Node.js; MCP-инструменты MBOX у них есть только при полном наборе
   (`mbox-agent install`), в Desktop у чужого ПК их зависимостей нет.

28. **Документы: права и общий доступ.** `documents.access_mode` (`edit|view` для тех, кто видит документ по уровню доступа) и
   `document_shares` (поимённо, `view|edit`). Права считает `permissionsFor` в `server/documents.mjs`: GET отдаёт `is_owner`/`can_edit`/`role`,
   PATCH/DELETE без права правки — 403 `read_only`; доступ меняет и выдаёт только владелец (`/documents/:id/shares`, справочник людей —
   `/api/mbox/directory`). Редактор читателя — `readOnly`. Джарвис правит документы теми же правилами (`update_document`).
   Джарвис умеет документы и таблицы (`search/read/create/update_document`, `search_tables/read_table/write_table_cells`) и браузер владельца
   (`browser_*` через `runBrowserOp`, группа `browser`). Совместное редактирование — по-прежнему снимками с присутствием коллег; настоящего OT/CRDT нет.
   Просмотр и правка файлов: `PdfViewer.tsx` (pdf.js legacy), `ImageEditor.tsx`, `StorageImage.tsx` — см. §10.14 доктрины.

29. **Интеграции (внешние API с ключами).** `server/integrations.mjs`, «Настройки → Интеграции» (только владелец). Готовые: `topvisor`,
   `yandex_webmaster`, `yandex_metrica` — ключи берутся из тех же настроек, что и у SEO-мастера (`seo_settings`) или из переменных окружения
   (`TOPVISOR_API_KEY`, `TOPVISOR_USER_ID`, `YANDEX_WEBMASTER_TOKEN`, `YANDEX_METRICA_TOKEN`…); любое своё API — таблица `integrations`
   (адрес только https и не внутренний, способ входа bearer/oauth/header/basic/query, ключ под `pgp_sym_encrypt`). Агенты и Джарвис ходят через
   MBOX: MCP `integration_list` / `integration_call`, инструменты Джарвиса с теми же именами (группа `integrations`); путь — только относительный,
   без `..`, ответ режется до 60 000 знаков. Topvisor отвечает HTTP 200 и при неверном ключе — ошибку ищем в `errors` тела.

30. **Gmail.** Во встроенном браузере Google не пускает во вход («браузер или приложение небезопасны») — и подделкой браузера это не лечится, так что
   почта подключена по официальному OAuth (`server/gmail.mjs`): владелец вносит Client ID/секрет «Веб-приложения» Google Cloud в «Настройки → Интеграции →
   Gmail», нажимает «Подключить» — согласие идёт в обычном браузере, адрес возврата `/api/mbox/oauth/google/callback` (единственный GET без сессии;
   подлинность — одноразовый `oauth_states.state`, 10 минут). Постоянный токен и секрет клиента — `oauth_connections` под `pgp_sym_encrypt`. Агентам:
   MCP `gmail_search/read/draft/send`, Джарвису — те же (группа `mail`); отправка только по прямой просьбе, по умолчанию — черновик. Экран согласия Google
   должен быть «В производство», иначе токен живёт 7 дней.
   Тот же вход открывает Документы, Таблицы и Диск владельца (`server/google-docs.mjs`, права `GOOGLE_SCOPES.docs`; старое подключение только к почте
   надо переподключить): MCP/Джарвис `gdoc_search/read/append/replace/create/import`, сервисы `google_drive|google_docs|google_sheets` в `integration_call`.
   Редактор Google Документов внутри MBOX показать нельзя (Google запрещает встраивание и вход во встроенном браузере) — «Открыть в Google» уходит в системный браузер.
   Не путать с `read_google_doc` и др. (сервисный аккаунт агента, `docs/gdocs-mcp.md`).

31. **Агент в браузере: курсор, настоящий ввод, просьба о помощи.** Набор функций внутри страницы — `mbox-desktop/agent-kit.js` (курсор с подписью и кругом
   клика, `locate`, `blockers` — капча/вход/код/защита от ботов/cookie/paywall, `extract`, `findText`, `checkWait`), действия в `mbox-desktop/browser.js`
   (`agentAction`): настоящие события мыши и клавиатуры через `sendInputEvent`/`insertText` (click/double/right/hover/drag/type/press/wait/back/forward/reload/
   new_tab/move_cursor; пароли, карты и коды агент не печатает — `sensitive_field`). Человек управляет агентом из вкладки: пауза/продолжить/стоп
   (`setAgentControl`, ответы `paused_by_human`/`stopped_by_human`). Агент застрял → MCP `browser_ask_help` (Джарвис — тоже): над страницей панель «Агент просит
   помощи» с комментарием, элемент в `agent_inbox` (`item_type=help`) и уведомление; агент ждёт ответа длинными запросами до 40 с (`browser_wait_help`);
   состояние просьб — в памяти процесса (`server/browser-agent.mjs`, `/api/mbox/browser/help*`, только владелец). Новый файл десктопа обязан быть в `files`
   `mbox-desktop/package.json`, иначе в сборке модуля нет. Версия MBOX Desktop с `agentControl` в мосту — 0.1.58+.
   Надёжность (10.10.2026): `browser_op` уходит во ВСЕ окна владельца, поэтому окно перед исполнением просит право — `POST /api/mbox/browser/agent/<id>/claim`
   (`browserAgent.ts`, первое выигрывает, окно с фокусом просит сразу, остальные через 350 мс), а ответ принимается только от владельца права (`?window=`);
   без этого два окна MBOX (установленное + dev) оба кликали, ответ брался у случайного — «элемент не найден» при сработавшем клике, снимок чужой
   страницы. Надёжнее claim — адресная доставка: окно с мостом шлёт `browser_window` (при подключении, фокусе, раз в 20 с), сервер отдаёт `browser_op`
   одному окну (в фокусе, иначе смотревшему последним; `sendBrowserOp`), окна старых версий без объявления команд не получают. Курсор строится
   через DOM API, не `innerHTML`: Google Docs (Trusted Types) падал на каждом клике. `navigate`/клик/Enter ждут конец загрузки (`settle`), скриншот при отказе `capturePage` идёт через отладчик. Застревание: 3 неудачи подряд →
   в ответе `stuck` (требование звать `browser_ask_help`); окно уже 1000×500 → в снимке `narrow_viewport`. Курсор агента не гаснет 5 минут, помнится
   в `cursorMemory` и возвращается после перехода (`dom-ready`). MCP-пуш `pendingMessages` показывает полный текст сообщения раз в 10 минут, между — одной строкой.

32. **Агенты и хранилище S3.** Облачные и локальные агенты работают с S3 через MCP `storage_list|read|write|mkdir|link|delete` (ручки
   `/api/mbox/storage/read` и `/write` в `server/storage.mjs`, остальное — прежние `objects|folder|link|object`), Джарвис — через группу `storage`
   (`storage_list|read|write|link`, `storageForAgent` в процессе, права — `storageAccessFor`). Читаются txt/md/json/csv/код, .docx (mammoth),
   .xlsx (`extractText`) и картинки до 5 МБ; pdf и прочее — только ссылкой. Запись — текст/base64 до 25 МБ, `overwrite=false` по умолчанию.
   Участник видит и пишет только `projects/<его id>/` и доступные заметки; настройки бакета и ключи агентам не отдаются.

33. **Личные пространства, роли owner и member.** `users.role` без CHECK. Режим «у каждого свой MBOX» (`server/spaces.mjs`, флаг
   `spaces_v1` в `mbox_flags`): `projectScopeFor` не отдаёт «всё» никому, включая владельца, — видны проекты из `project_memberships`;
   создатель проекта сразу его участник (`addProjectMember`). Пока флага нет, владелец видит всё, как раньше. Включение — кнопка в
   «Настройки → Команда» или `node scripts/migrate-spaces.mjs [--dry]`: владелец становится участником всех проектов, записи без проекта
   (память, решения, артефакты) переезжают в проект «Общее»; выключение — та же кнопка, данные не меняются. Роли admin нет. Владелец
   инстанса распоряжается командой (`ownerOnly` в `server/accounts.mjs`, проекты участникам он раздаёт только из своих —
   `manageableProjects`) и личным: секреты, локальные папки, бакет, SEO-мастер, Gmail/Google, готовые API.
   **Навык = инструкция агенту (SKILL.md), инструмент = подключение к API. Больше ничего.** Навык принадлежит автору (`skill_owners`),
   личный по умолчанию; автор открывает его всей команде (`skill_settings.is_base`), выбранным людям (`skill_access`) или публикует в
   магазине (`server/skill-store.mjs`: установка навыка = доступ к навыку автора, инструмент = шаблон API без ключа, ключ у каждого свой).
   Права — `server/skill-access.mjs`. Агент создаёт навык через `write_skill_files` (личный), публикует — `skill_store_publish`.
   Инструменты — только API (`integrations.owner_user_id`, NULL — владелец; раздел «Инструменты»); программы и MCP (бот, фид, браузеры)
   — справочные карточки в «Навыки → Программы и MCP». Значки навыков и API — `server/item-icons.mjs` (своя картинка или плитка с инициалами).
   Файлы S3 открываются вкладкой `s3file:<ключ>` (`StorageFileDocument`: картинка, PDF, видео, Word, правка текста), таблицы — `s3sheet:`.
   У каждого аккаунта своё: браузер и агент в нём (`/browser/agent|help`, операции и просьбы сверяются с `user.id`).
   Закладки MBOX Desktop: `serverState.ensureOn()` перепроверяет связь с сервером раз в 10 с, если проба при старте не прошла.
34. **Рабочее пространство и презентации.** Раздел «Рабочее пространство» (rail `tables`) — переключатель Заметки | Таблицы |
   Документы | Презентации (`SheetsDocsMode`, событие `SHEETS_MODE_EVENT`); «Папки» — Это устройство | Облако S3 (`FoldersView`).
   Презентация — JSON `{ version, size?, theme, slides[{ elements }] }` (слайд 960×540 или свой `size`, вертикальный из PDF),
   `server/presentations.mjs`; картинки слайдов — в `presentation_assets`, в JSON только ссылка `/api/mbox/presentations/:id/assets/:n`
   (data:-ссылки сервер выносит сам). Вкладка `slides:<id>` (`PresentationDocument`: миниатюры, холст с react-moveable, колесо — масштаб,
   рука/стрелка, показ, PPTX через pptxgenjs, PDF печатью, импорт PDF). Агент: MCP `presentation_list|create|read|slide|write|set_template`,
   правит слайд за слайдом — открытая вкладка подсвечивает изменённый слайд. Навык `skills/presentations`. Панель значков в шапках
   редакторов — общий `IconToolbar` (им же сделана панель заметок).

35. **Telegram-боты.** `server/telegram-bot.mjs` (таблицы `telegram_bots|accounts|chats|messages|invites|agent_requests`, вебхук
   `/api/mbox/telegram/hook/<id>` без сессии, подлинность — секрет бота в заголовке), панель «Настройки → Команда → Telegram-боты»
   (`TelegramBotPanel.tsx`). Ботов у аккаунта несколько; чат принадлежит боту и выбирает проекты/компании. **Бота в чат добавляет только
   владелец:** `telegram_accounts` держит его привязанный Telegram (ссылка `t.me/<бот>?start=<код>`, 15 минут), чужое добавление
   (`my_chat_member.from`) — бот выходит. Кнопка «Добавить в чат» даёт `t.me/<бот>?startgroup=<код>` с выбранными проектами
   (`telegram_invites`): Telegram сам шлёт в группу `/start <код>`, чат сразу активен. Без флага отвечает Джарвис любому участнику
   чата (в проектах чата); `-claude|-claudelocal|-gpt|-gptlocal` (серверный/локальный агент, явный выбор; `-claude` и `-gpt` — серверные, «--» и старые «-claudecloud» тоже понимаются) — только привязанный
   владелец: вопрос уходит в `agent_inbox` (`props.to`, `mbox_user_id`, `thread`), готовый ответ (`props.re|in_reply_to`) забирает
   `pollAgentRequests` раз в 3 с. Офлайн-агенту (`agent_presence`, 2 минуты) вопрос не ставится — бот подсказывает второй вариант.
   Владелец командой `/allow @username` (или ответом на сообщение) в группе даёт участнику доступ к агентам в этом чате (`telegram_allowed`,
   `/disallow` отзывает; агенту в тексте велено держаться проектов чата). Вопросы агентам кладутся в проект наблюдателя (MBOX_PROJECT,
   по умолчанию MBOX): наблюдатель берёт только его, а при spaces_v1 записи без проекта ему не отдаются. Ответ на сообщение агента без флага продолжает разговор с этим агентом (`telegram_agent_messages` помнит, чьё сообщение; только
   владельцу и разрешённым, остальным отвечает Джарвис; `/ask` в ответе — явно Джарвис). Джарвису в `props.system_note` кладётся справка о
   маршрутизации, иначе на «почему ответил ты» он выдумывает. Личка с ботом — только владельцу. Вопрос Джарвису обязан иметь `project_id`, иначе история диалога (фильтр по проектам) его не
   видит и модель отвечает «уточните» — так было до 14.10.2026. Dev-API в `vite.config.ts` этих ручек не повторяет.

36. **Ноды (Ubuntu-серверы с Claude Code и Codex).** `server/nodes.mjs` (таблица `agent_nodes`, `/api/mbox/nodes*`, только владелец),
   панель «Настройки → Сервер → Ноды» (`NodesPanel.tsx`), скрипт установки `server/node-agent-install.sh`, SSH — пакет `ssh2`. Человек вводит
   адрес, логин и пароль; сервер снимает отпечаток ключа хоста (`/probe`), человек подтверждает его — он закрепляется в `host_key_sha256` и
   проверяется при каждом подключении (чужой ключ — пароль до такого сервера не уходит). Один раз по паролю (в памяти процесса, нигде не
   хранится; для не-root — `sudo -S` через stdin) скрипт ставит пользователя `mboxagent` с НАШИМ ed25519-ключом (приватный — в БД под
   `pgp_sym_encrypt`), Node 22, Claude Code, Codex, набор агента (`agentKitFiles()` из `accounts.mjs`), службы `mbox-node-claude|codex` (агенты
   `Claude-<имя>` / `Codex-<имя>`, `MBOX_PROJECT=MBOX`) и два скрипта в `/usr/local/sbin` (`mbox-node-ctl`, `mbox-node-uninstall`) с узким
   правилом sudo. Дальше сервер ходит на ноду только как `mboxagent` по ключу: проверка (`claude auth status`, `codex login status`), вход,
   обновление набора, перезапуск, удаление. Отдельный токен аккаунта на каждую ноду (`account_tokens`, отзывается при удалении). Вход в
   CLI — терминал SSH: `claude auth login` (ссылка → человек вставляет код) и `codex login --device-auth` (ссылка + код); после входа служба
   включается сама. Внутренние адреса (loopback, link-local, метаданные) запрещены (`MBOX_NODES_ALLOW_LOOPBACK=1` — только для тестов).
   Установка идёт в памяти процесса: после перезапуска сервера «installing» превращается в ошибку. Из Telegram: `-claude@имя`, `-gpt@имя`.
   Вход в Claude/Codex на ноде остаётся у `mboxagent` и после удаления ноды (пользователь не удаляется: `userdel -r mboxagent`).

37. **Дизайн-системы проекта.** `server/design-systems.mjs` (таблица `design_systems`, `/api/mbox/design-systems`, прод и dev): одна страница HTML на систему,
   хранится как есть, права как у презентаций (владелец записи, участники проекта, все; удалять и менять доступ — только владелец записи). Показ — вкладка `design:<id>`
   (`DesignSystemDocument.tsx`): iframe `sandbox` без `allow-same-origin`, скрипты в рамке выключены, пока человек не включит молнией. Создаётся и загружается из
   карточки проекта («Материалы → Дизайн-системы»). Агенты: MCP `design_system_list|read|write`; правка открытой вкладки подхватывается по `entity_changed`.

38. **MCP по HTTP (ChatGPT и другие удалённые клиенты).** `server/mcp-http.mjs`, адрес `https://<домен>/mcp` (до проверки сессии, рядом с VK-ботом в `createServer`).
   Шлюз не дублирует инструменты: на сессию (`Mcp-Session-Id`) запускает `scripts/mbox-mcp-server.mjs` дочерним процессом с ключом звонящего
   и гонит через него JSON-RPC; права проверяет обычный API по этому ключу. Ключ — личный токен аккаунта (`/account/tokens`, «Настройки → Аккаунт → MCP для ChatGPT»),
   в заголовке `Authorization: Bearer` или в адресе `/mcp/<ключ>`. Наружу отдаётся не всё: `DEFAULT_HTTP_TOOLS` (память, задачи, заметки, документы, таблицы, дизайн-системы,
   поиск), без браузера, локальных папок, почты, Google, интеграций, записи в хранилище и навыков; свой набор — `MBOX_MCP_HTTP_TOOLS=имя,имя` или `all`. Не больше 3 сессий
   на аккаунт и 12 всего, простой 15 минут закрывает сессию, 20 неверных ключей с адреса за 10 минут — 429. Потока от сервера нет (GET — 405). Процессы живут в контейнере
   `mbox-ui`, поэтому правки `scripts/mbox-mcp-server.mjs` доходят до HTTP-клиентов вместе с обычным деплоем сервера.


## Контракт агента и облачные агенты (перенесено из CLAUDE.md при слиянии 2026-10-19)

**Что главное и куда писать** (то же лежит в `agent_contract`: `rules_priority`, `where_to_write`,
`source_of_truth`, `small_changes`):
- Приоритет правил: прямая просьба владельца → CLAUDE.md (проекта и глобальный) → контракт и навыки MBOX →
  системный промпт клиента. При конфликте побеждает меньший номер.
- Память двух видов не смешивать: предпочтения и роль владельца — в файловую память клиента
  (`~/.claude/projects/...`); факты проекта, итоги работы, решения — в MBOX (`record_memory` с `project` и
  `todo_id`, `record_decision` — только когда выбирали из нескольких вариантов). Задачи только в todos.
- Источники при расхождении: код и git — как есть сейчас; todo — что делать и в каком статусе; заметка и
  память — почему так решили. Заметка спорит с кодом — верить коду и поправить заметку.
- Мелкая правка в 1–2 файла: `claim_task` → правка → один `finish_task` (память, запуск, inbox и статус сразу).

**Облачные агенты (ClaudeCloud, CodexCloud) контейнер не трогает.** Они работают из своей копии
`/home/mboxagent/mbox` (службы `mbox-cloud-claude`/`mbox-cloud-codex`), и копию обновляет только
`bash /opt/mbox/deploy/cloud-agents/install.sh`. Правки `scripts/` (MCP-сервер `mbox-mcp-server.mjs`, наблюдатели,
`focus-excerpt.mjs`, `fragment-edit.mjs`, `workspace-resolve.mjs`) доходят до облачных агентов только после
`install.sh` + `systemctl restart mbox-cloud-claude mbox-cloud-codex`. До 2026-10-06 этот шаг пропускали, и
ClaudeCloud жил на старом MCP-сервере, хотя прод был свежим.

