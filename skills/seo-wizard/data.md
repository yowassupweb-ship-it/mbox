# Данные SEO Wizard

Главные таблицы:

- `seo_runs`: каждый серверный прогон, статус источников, ошибки.
- `seo_urls`: реестр страниц, тип, раздел, sitemap/search flags, title/H1/canonical.
- `seo_page_snapshots`: HTTP/Obscura-снимки страниц.
- `seo_issues`: находки детекторов с fingerprint, статусом, доказательствами и потенциалом.
- `seo_packages`: компактные пакеты для сессий.
- `seo_changes`: журнал внедрений и измерений.

Пакет содержит:

- `freshness`: какие источники обновлены или не настроены;
- `summary`: числовая сводка;
- `candidates`: найденные задачи;
- `pending_decisions`: решения человека;
- `obscura_checks`: что открыть в браузере локальной сессией.

Рабочие таблицы и отчёты (экран SEO Wizard и MCP `seo_read_view`) считаются сервером поверх этих данных (`server/seo-views.mjs`):
`registry`, `index`, `filters`, `links`, `cannibal`, `quality`, `competitors`, `ctr`, `opportunities`, `positions`, `serp`, `demand`, `traffic`, `outreach`, `queue`, `decisions`, `changes`, `report10`, `report20`, `report25`, `sessions`, `packages`, `runs`, `issues`, `scenarios`.
Пустая таблица приходит с `empty` — там написано, какой источник не подключён; это не «проблем нет».
Решения владельца по URL (оставить / 301 / canonical / noindex / убрать из sitemap) пишутся в `seo_urls.decision` и в журнал решений.

**Потенциал запросов** (`seo_read_view` → `positions`, секция `query_potential`): для каждого запроса из Topvisor считается спрос (Wordstat, раз в месяц на запрос), клики сейчас и в топ-3, прирост и ожидаемый прирост с поправкой на достижимость, уровень A/B/C/D. Строки без спроса (`—`) значат «Wordstat не собран», а не «потенциала нет». В заметке секции стоит дата позиций: если она старше 3 дней, по таблице решений не принимай (правило свежести в `SKILL.md`). Спрос приходит из Yandex Search API (ключ сервисного аккаунта), а не из старого `api.wordstat.yandex.net`.
