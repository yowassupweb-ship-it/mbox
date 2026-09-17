# Навыки агентов MBOX

Навыки, которыми Claude и Codex пользуются при работе с MBOX: `SKILL.md`, правила, шаблоны и скрипты. **Источник правды — сервер MBOX**: папка входит в образ, `/api/mbox/agent/skills/packages` отдаёт пакеты, MCP `mbox-prod` читает их инструментами `list_skills` и `get_skill`.

| Навык | Что делает |
| --- | --- |
| `route-to-operator` | Корпоративная версия программы тура «Вокруг света» из менеджерской программы newmanager.vs |
| `email-campaign` | HTML-рассылки «Вокруг света» из проверенных блоков для UniSender |
| `mbox-api` | Прямой доступ к API MBOX для ручек, которых нет в MCP |
| `a11y-audit`, `apply-aesthetic`, `brandkit`, `data-dashboard`, `design-code`, `design-component`, `design-doctrine`, `design-qa`, `design-review`, `design-tokens`, `figma-integration`, `governance`, `image-to-code`, `migrate-design-system`, `performance`, `prototype`, `redesign`, `token-build`, `ux-writing` | UX/UI Agent Skills (19 шт., карточки в `server/ux-ui-skill-catalog.mjs`). Пакет — только `SKILL.md`: файлы `rules/…` и `scripts/…`, на которые они ссылаются, в исходной установке отсутствовали |

## Как навык попадает к агенту

- **Наблюдатель Claude** (`scripts/claude-inbox-watcher.mjs`, в том числе из MBOX Desktop) при запуске и раз в час вызывает `scripts/sync-skills.mjs`: скачивает пакеты с сервера и ставит их в `~/.claude/skills/<id>` и `~/.codex/skills/<id>`, а в запросе к Claude перечисляет навыки. Поэтому Claude в консоли MBOX видит навыки на любой машине.
- **Вручную:** `npm run mbox:skills-sync` (нужны `MBOX_URL` и `MBOX_PASSWORD`; без них — из этой папки). Проверка без записи: `node scripts/sync-skills.mjs --dry-run`.
- **Без установки:** MCP `list_skills` и `get_skill` читают `SKILL.md` и правила прямо с сервера. Скрипты навыка так не запустить — для них нужна установка.

Установленная копия помечена файлом `.mbox-skill.json` и перезаписывается, когда пакет на сервере меняется. Папки навыков, поставленные не из MBOX, синхронизация не трогает.

## Навык открывает вкладки в MBOX

Шаг сценария может открыть человеку вкладку: MCP `open_tab` (или `POST /api/mbox/ui/open`). Цели — HTML-форма или .md из пакета (`skill-file:<id>/<файл>`), файл или папка на компьютере (`path:…`, MBOX Desktop), артефакт, запись памяти, задача, внешняя ссылка. Страница пакета работает в песочнице и получает `window.mbox`: `mbox.send(text)` отправляет результат в чат агенту, открывшему форму, `mbox.close()` закрывает вкладку, `localStorage` хранится у MBOX. Пример — `email-campaign/brief-builder.html`. Коллекция блоков писем — `skill-blocks:<id>` (письма из `templates/manifest.json`).

В каталоге (`server/skill-catalog.mjs`) у навыка есть `pages` — вкладки навыка; первая открывается кнопкой «Запустить» в списке навыков. Навык с формой стартует так: человек жмёт «Запустить» или просит агента — открывается форма — человек заполняет и отправляет — агент продолжает в чате.

## Как менять навык

0. **Быстро, без деплоя:** MCP `edit_skill_file` / `write_skill_file` (или `PUT /api/mbox/agent/skills/packages/<id>/files?file=<путь>`) — правка сразу на сервере, с историей версий (`GET …/<id>/history?file=`). Действует, пока файл в репозитории не поменяли: новая версия из репозитория снова главная. Перенести правки в репозиторий — `npm run mbox:skills-pull`, затем коммит.
1. Правь файлы здесь, в `skills/<id>/`. Не правь установленную копию в `~/.claude/skills` — она перезапишется.
2. Запусти проверки навыка: `node skills/route-to-operator/scripts/selftest.mjs`, `node skills/email-campaign/scripts/test-preflight.mjs`, `node skills/email-campaign/scripts/test-catalog.mjs`.
3. Коммит и деплой. Наблюдатели подтянут новую версию при перезапуске или в течение часа.
4. Новый навык — папка `skills/<id>/` (`id` — латиница, цифры, дефис) с `SKILL.md` и frontmatter `name`, `description`, плюс запись в `server/skill-catalog.mjs`, чтобы он появился на странице «Навыки».

## Правила пакета

- **Никаких секретов и личных данных.** Пакет получают все агенты. Доступы живут в рабочей папке человека; в пакете — только шаблон (`route-to-operator/newmanager.env.example`).
- **Результаты — не в папку навыка.** Навык пишет в рабочую папку человека (`%USERPROFILE%\Desktop\Mbox\…`), иначе синхронизация сотрёт результаты.
- **Пути в инструкциях — относительные к папке навыка**, без `C:\Users\…`.
- Скрытые файлы и папки (`.*`) в пакет не попадают.
