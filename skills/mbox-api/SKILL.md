---
name: mbox-api
description: Прямой доступ к боевому API MBOX (mbox.shar-os.ru) через curl — для ручек, которых нет в MCP-сервере mbox-prod: memories, folders, artifacts, graph edges, secrets, server metrics, history. Использовать, когда MCP mbox-prod недоступен или нужен эндпоинт вне его набора.
---

# MBOX API напрямую

Сначала пробуй MCP `mbox-prod` — он покрывает projects, todos, context, inbox, runs, decisions,
relations, history, approved secrets. Этот навык нужен для остального.

## Сессия

Учётка — переменные окружения `MBOX_URL`, `MBOX_USERNAME`, `MBOX_PASSWORD` (их задают наблюдатели MBOX
и MCP-конфиг агента) или `.mcp.json` в корне рабочей директории.
Не печатать пароль в вывод.

```bash
BASE=https://mbox.shar-os.ru
COOKIE=/tmp/mbox.cookie   # реально: в scratchpad-директорию сессии

curl -s -c "$COOKIE" -X POST "$BASE/api/mbox/auth/login" \
  -H 'content-type: application/json' \
  -d '{"username":"Admin","password":"..."}' >/dev/null
```

Дальше все запросы с `-b "$COOKIE"` и заголовком `-H 'x-mbox-agent: Claude'` — он попадает в
`audit_events.actor`, без него запись будет от `system`.

## Ручки

Все под `/api/mbox`. Поиск по коллекциям — параметр `?q=`.

| Метод и путь | Назначение |
| --- | --- |
| `GET /agent/structure` | канонический контракт: сущности, статусы, приоритеты, порядок работы |
| `GET /agent/context?project=MBOX` | один компактный снапшот проекта — начинать с него |
| `GET /agent/next-task?project=MBOX&agent=Claude` | взять и зализить следующую задачу |
| `GET,POST /memories`, `PATCH,DELETE /memories/:id` | записи памяти, полнотекст по `search_vector` |
| `GET,POST /folders`, `PATCH,DELETE /folders/:id` | дерево папок |
| `GET,POST /artifacts`, `PATCH,DELETE /artifacts/:id` | артефакты |
| `GET,POST /projects`, `PATCH,DELETE /projects/:id` | проекты вместе с todo и связями |
| `POST /todos`, `PATCH,DELETE /todos/:id`, `POST /todos/:id/claim` | задачи и лизы |
| `GET,POST /graph/edges`, `DELETE /graph/edges/:id` | связи проектов |
| `GET,POST /agent/inbox`, `PATCH /agent/inbox/:id` | инбокс агентов |
| `GET,POST /agent/runs`, `PATCH /agent/runs/:id` | сессии работы агентов |
| `GET,POST /decisions` | журнал решений |
| `GET,POST /secrets`, `PATCH /secrets/:id` | защищённые записи (пароль только пишется, не читается) |
| `GET /agent/approved-secrets?project=MBOX` | расшифрованные секреты, одобренные человеком |
| `GET /history` | последние 200 событий аудита |
| `GET /server` | последняя метрика сервера |
| `GET /agents` | статус подключённых агентов |
| `WS /realtime` | `entity_changed`, `server_tick` каждые 5 сек |

## Правила

- `PATCH` работает по семантике `COALESCE(NULLIF($n,''), column)`: пустая строка = «не менять».
  Чтобы очистить текстовое поле, придётся слать пробел или менять SQL.
- Перевод todo в `done`/`archived` автоматически снимает лиз (`claimed_by`, `claimed_until`).
- Структурные факты — в `props` (JSONB) у проекта или todo, свободный текст — в `note`.
- Секреты никогда не отдаются списком в открытом виде; только через `approved-secrets` и только
  после того, как человек выставил `agent_share_state = 'approved'`.
- Прод-БД — единственный источник правды по задачам MBOX. Не дублировать их в файлы репозитория.
