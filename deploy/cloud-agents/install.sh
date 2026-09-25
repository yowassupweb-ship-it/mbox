#!/usr/bin/env bash
# Облачные агенты MBOX: Claude Code и Codex CLI на сервере под пользователем mboxagent.
# Тот же наблюдатель, что и на компьютере владельца (scripts/claude-inbox-watcher.mjs,
# scripts/codex-chat-watcher.mjs), но под именами ClaudeCloud / CodexCloud и с kind=cloud_agent.
# ClaudeCloud забирает неадресованные вопросы владельца вместо Gemini-Джарвиса (JARVIS_AUTOREPLY=off),
# CodexCloud отвечает на @CodexCloud. Повторный запуск безопасен: обновляет рабочую копию и службы.
#
# Запуск: bash /opt/mbox/deploy/cloud-agents/install.sh   (root, из /opt/mbox)
set -euo pipefail

AGENT_USER=mboxagent
AGENT_HOME=/home/$AGENT_USER
WORKDIR=$AGENT_HOME/mbox
ENV_FILE=/etc/mbox/cloud-agents.env
SRC=/opt/mbox

id "$AGENT_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$AGENT_USER"

# Codex — пакет @openai/codex. Пакет codex-cli в npm — чужой заброшенный проект 2014 года.
npm uninstall -g codex-cli >/dev/null 2>&1 || true
command -v codex >/dev/null 2>&1 && codex --version 2>/dev/null | grep -qi codex || npm install -g @openai/codex

# Claude Code — родной установщик в домашний каталог агента (от root bypassPermissions не работает).
if [ ! -x "$AGENT_HOME/.local/bin/claude" ]; then
  su - "$AGENT_USER" -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi

# Рабочая копия репозитория без секретов сервера и без дистрибутивов desktop.
mkdir -p "$WORKDIR"
rsync -a --delete \
  --exclude '.env' --exclude 'archivist.env' --exclude 'public/downloads/' --exclude 'node_modules/' \
  --exclude 'mbox.tar.gz' --exclude 'out/' \
  "$SRC/" "$WORKDIR/"
chown -R "$AGENT_USER:$AGENT_USER" "$WORKDIR"
# npm install, а не npm ci: lock-файл проекта расходится с package.json (так же ставит Dockerfile.mbox).
su - "$AGENT_USER" -c "cd '$WORKDIR' && npm install --omit=dev --no-audit --no-fund >/dev/null"

# Общий env агентов: логин в MBOX берём у архивариуса, токен Claude вписывает владелец.
mkdir -p /etc/mbox
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "MBOX_URL=https://mbox.shar-os.ru"
    grep -E '^MBOX_(USERNAME|PASSWORD)=' "$SRC/archivist.env" || true
    echo "MBOX_PROJECT=MBOX"
    echo "# claude setup-token (под любым пользователем с подпиской) -> вставить сюда"
    echo "CLAUDE_CODE_OAUTH_TOKEN="
  } > "$ENV_FILE"
fi
chown root:"$AGENT_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

install -m 644 "$SRC/deploy/cloud-agents/mbox-cloud-claude.service" /etc/systemd/system/
install -m 644 "$SRC/deploy/cloud-agents/mbox-cloud-codex.service" /etc/systemd/system/
systemctl daemon-reload

echo
echo "Готово. Дальше:"
echo "  1) токен Claude:  claude setup-token  -> CLAUDE_CODE_OAUTH_TOKEN=... в $ENV_FILE"
echo "  2) вход Codex:    su - $AGENT_USER -c 'codex login --device-auth'"
echo "  3) запуск:        systemctl enable --now mbox-cloud-claude mbox-cloud-codex"
echo "  4) логи:          journalctl -u mbox-cloud-claude -f"
