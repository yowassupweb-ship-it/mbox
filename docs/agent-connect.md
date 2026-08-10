# Подключение второго агента (Codex / ChatGPT) к MBOX

MBOX-агенты ходят в прод через один и тот же stdio-MCP-сервер `scripts/mbox-mcp-server.mjs`.
Чтобы два агента (Claude Code + Codex) работали одновременно, каждый запускает **свой** экземпляр
сервера с **разным** `MBOX_AGENT_NAME`. Тогда в `agent_presence` появляются две строки, и оба
видны в хедере и в разделе agents.

## Общие переменные окружения

| Переменная | Значение |
| --- | --- |
| `MBOX_URL` | `https://mbox.shar-os.ru` |
| `MBOX_USERNAME` | `Admin` |
| `MBOX_PASSWORD` | `TrapTrap9!` (пароль MBOX-веба, НЕ SSH-пароль сервера) |
| `MBOX_AGENT_NAME` | уникально на агента: `Claude`, `Codex`, `ChatGPT`… |
| `MBOX_AGENT_CLIENT` | свободная метка клиента |

Требуется установленный `mbox/node_modules` (`npm install` в `mbox/`).

## Вариант A — Codex CLI (OpenAI), рекомендуется

Codex CLI поддерживает stdio-MCP через `~/.codex/config.toml`:

```toml
[mcp_servers.mbox-prod]
command = "node"
args = ["E:/Projects/Mbox/mbox/scripts/mbox-mcp-server.mjs"]
env = { MBOX_URL = "https://mbox.shar-os.ru", MBOX_USERNAME = "Admin", MBOX_PASSWORD = "TrapTrap9!", MBOX_AGENT_NAME = "Codex", MBOX_AGENT_CLIENT = "Codex CLI" }
```

Перезапустить Codex → проверить `mbox-prod` в списке MCP → инструменты `describe_structure`,
`get_next_task`, `claim_task`, `set_task_status`, `create_task`, `record_decision`, `create_inbox_item` и т.д.

## Вариант B — ChatGPT (веб/десктоп, custom connector)

ChatGPT-коннекторы принимают только **удалённый** MCP (HTTP/SSE), а наш сервер — stdio. Нужен
мост stdio→SSE (напр. `mcp-proxy`) на публично доступном URL под HTTPS. Это отдельная работа;
для быстрого старта используйте Вариант A.

## Протокол совместной работы (чтобы не топтаться друг по другу)

1. **Перед работой:** `describe_structure` → `get_agent_context(MBOX)` — увидеть чужие активные
   runs, inbox и последние decisions.
2. **Брать задачу через лизинг:** `get_next_task` → `claim_task(id)`. Claim держит задачу 45 минут;
   если её уже заклеймил другой агент — вернётся 409, берите другую. Свой claim продлевается повторным вызовом.
3. **Во время работы:** держать `note` задачи актуальной, факты — в `props`; открыть `create_agent_run`
   с `touched_files`. Присутствие пингуется автоматически (session_start + heartbeat раз в 60с).
4. **Координация между агентами:** `create_inbox_item` для передачи/вопроса, `record_decision`
   для общих решений. Другой агент читает это через `get_agent_context`.
5. **После работы:** `set_task_status` (`review`/`done`); если работали не от существующей todo —
   завести её постфактум или записать decision.

Хедер MBOX теперь показывает реальный ростер (active/idle/в работе) — по нему видно, кто на связи
и кто что делает прямо сейчас.
