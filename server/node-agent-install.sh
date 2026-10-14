#!/usr/bin/env bash
# Установка ноды MBOX на Ubuntu/Debian: Node.js, Claude Code, Codex CLI, наблюдатели агентов как службы systemd.
# Запускает сервер MBOX по SSH один раз под root (или через sudo) — см. server/nodes.mjs. Повторный запуск безопасен.
#
#   bash node-agent-install.sh <env-файл> <каталог-набора>
#
# env-файл (удаляется скриптом): NODE_NAME, MBOX_URL, MBOX_TOKEN, SSH_PUBKEY, MBOX_PROJECT.
# Строки "##STEP текст" читает сервер для показа хода установки, "##FAIL текст" — причина отказа.
#
# После установки сервер управляет нодой только от имени пользователя mboxagent по своему SSH-ключу;
# root ему не нужен: перезапуск служб и удаление идут через два скрипта в /usr/local/sbin по узкому правилу sudo.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

ENV_FILE="${1:?нужен env-файл}"
KIT_DIR="${2:?нужен каталог набора}"
# shellcheck disable=SC1090
. "$ENV_FILE"
rm -f "$ENV_FILE"
: "${NODE_NAME:?}" "${MBOX_URL:?}" "${MBOX_TOKEN:?}" "${SSH_PUBKEY:?}"
MBOX_PROJECT="${MBOX_PROJECT:-MBOX}"

AGENT_USER=mboxagent
AGENT_HOME=/home/$AGENT_USER
KIT="$AGENT_HOME/mbox-agent"
ENV_TARGET=/etc/mbox/node-agent.env

step() { echo "##STEP $*"; }
fail() { echo "##FAIL $*"; exit "${2:-1}"; }

[ "$(id -u)" = 0 ] || fail "Скрипту нужны права root" 10
[ -r /etc/os-release ] || fail "Не удалось определить систему" 11
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "Поддерживаются Ubuntu и Debian, а здесь ${PRETTY_NAME:-неизвестная система}" 11 ;;
esac
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || fail "На ноде не запущен systemd: службы агентов поставить не получится" 12

step "Системные пакеты"
apt-get update -qq >/dev/null
apt-get install -y -qq curl ca-certificates gnupg sudo >/dev/null

step "Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v npm >/dev/null 2>&1 || fail "После установки Node.js нет npm" 13

step "Пользователь $AGENT_USER"
id "$AGENT_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$AGENT_USER"
# '*' — пароля нет, но учётная запись не заблокирована: вход по ключу работает и на строгих настройках sshd.
usermod -p '*' "$AGENT_USER"
install -d -m 700 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME/.ssh"
AUTH="$AGENT_HOME/.ssh/authorized_keys"
touch "$AUTH"
grep -qxF "$SSH_PUBKEY" "$AUTH" || echo "$SSH_PUBKEY" >> "$AUTH"
chown "$AGENT_USER:$AGENT_USER" "$AUTH"
chmod 600 "$AUTH"
install -d -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME/workspace"

step "Codex CLI"
# Пакет codex-cli в npm — чужой заброшенный проект; нужен @openai/codex.
npm uninstall -g codex-cli >/dev/null 2>&1 || true
if ! (command -v codex >/dev/null 2>&1 && codex --version 2>/dev/null | grep -qi codex); then
  npm install -g @openai/codex >/dev/null 2>&1 || fail "Не удалось установить Codex CLI (npm install -g @openai/codex)" 14
fi

step "Claude Code"
if [ ! -x "$AGENT_HOME/.local/bin/claude" ]; then
  su - "$AGENT_USER" -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null 2>&1 || fail "Не удалось установить Claude Code (curl -fsSL https://claude.ai/install.sh | bash)" 15
fi

step "Агент MBOX"
install -d -o "$AGENT_USER" -g "$AGENT_USER" "$KIT" "$KIT/scripts"
cp -f "$KIT_DIR/package.json" "$KIT/package.json"
cp -f "$KIT_DIR"/scripts/* "$KIT/scripts/"
chown -R "$AGENT_USER:$AGENT_USER" "$KIT"
su - "$AGENT_USER" -c "cd '$KIT' && npm install --omit=dev --no-audit --no-fund --silent" >/dev/null 2>&1 || fail "Не удалось поставить зависимости агента (npm install)" 16

step "Службы"
install -d -m 755 /etc/mbox
{
  echo "MBOX_URL=$MBOX_URL"
  echo "MBOX_TOKEN=$MBOX_TOKEN"
  echo "MBOX_PROJECT=$MBOX_PROJECT"
} > "$ENV_TARGET"
chown root:"$AGENT_USER" "$ENV_TARGET"
chmod 640 "$ENV_TARGET"

cat > /etc/systemd/system/mbox-node-claude.service <<EOF
[Unit]
Description=MBOX node agent Claude-$NODE_NAME (Claude Code CLI)
After=network-online.target
Wants=network-online.target

[Service]
User=$AGENT_USER
WorkingDirectory=$KIT
EnvironmentFile=$ENV_TARGET
Environment=MBOX_AGENT_NAME=Claude-$NODE_NAME
Environment=MBOX_AGENT_ALIASES=claude-$NODE_NAME
Environment=MBOX_AGENT_KIND=cloud_agent
Environment=MBOX_WATCH_UNADDRESSED=false
Environment=MBOX_WATCH_BACKLOG=false
Environment=CLAUDE_WATCH_MODEL=sonnet
Environment=CLAUDE_WATCH_EFFORT=low
Environment=CLAUDE_COMMAND=$AGENT_HOME/.local/bin/claude
Environment=CLAUDE_WATCH_WORKDIR=$AGENT_HOME/workspace
Environment=PATH=$AGENT_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node scripts/claude-inbox-watcher.mjs
Restart=always
TimeoutStopSec=10
RestartSec=10
MemoryMax=1600M

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/mbox-node-codex.service <<EOF
[Unit]
Description=MBOX node agent Codex-$NODE_NAME (Codex CLI)
After=network-online.target
Wants=network-online.target

[Service]
User=$AGENT_USER
WorkingDirectory=$KIT
EnvironmentFile=$ENV_TARGET
Environment=MBOX_AGENT_NAME=Codex-$NODE_NAME
Environment=CODEX_CHAT_ALIASES=Codex-$NODE_NAME,codex-$NODE_NAME
Environment=MBOX_AGENT_KIND=cloud_agent
Environment=MBOX_WATCH_BACKLOG=false
Environment=CODEX_WATCH_EFFORT=low
Environment=CODEX_WATCH_WORKDIR=$AGENT_HOME/workspace
Environment=PATH=$AGENT_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node scripts/codex-chat-watcher.mjs
Restart=always
TimeoutStopSec=10
RestartSec=10
MemoryMax=1200M

[Install]
WantedBy=multi-user.target
EOF

# Управление службами и удаление — только через эти два скрипта (правило sudo ниже разрешает ровно их).
cat > /usr/local/sbin/mbox-node-ctl <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
action="${1:-}"
agent="${2:-}"
case "$agent" in
  claude|codex) units=("mbox-node-$agent.service") ;;
  all) units=(mbox-node-claude.service mbox-node-codex.service) ;;
  *) echo "агент: claude | codex | all" >&2; exit 2 ;;
esac
case "$action" in
  enable) systemctl enable --now "${units[@]}" ;;
  disable) systemctl disable --now "${units[@]}" ;;
  start|stop|restart) systemctl "$action" "${units[@]}" ;;
  status) for unit in "${units[@]}"; do echo "$unit $(systemctl is-active "$unit" 2>/dev/null || true) $(systemctl is-enabled "$unit" 2>/dev/null || true)"; done ;;
  *) echo "действие: enable | disable | start | stop | restart | status" >&2; exit 2 ;;
esac
EOF
chmod 755 /usr/local/sbin/mbox-node-ctl

cat > /usr/local/sbin/mbox-node-uninstall <<'EOF'
#!/usr/bin/env bash
# Снимает всё, что поставил MBOX: службы, набор агента, правило sudo и наш SSH-ключ. Пользователя mboxagent
# и вход в Claude/Codex не трогает: если нода больше не нужна совсем, удалите его командой userdel -r mboxagent.
set -uo pipefail
systemctl disable --now mbox-node-claude.service mbox-node-codex.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/mbox-node-claude.service /etc/systemd/system/mbox-node-codex.service
systemctl daemon-reload || true
rm -rf /etc/mbox/node-agent.env /home/mboxagent/mbox-agent
sed -i '/ mbox-node-@NODE@$/d' /home/mboxagent/.ssh/authorized_keys 2>/dev/null || true
rm -f /etc/sudoers.d/mbox-node /usr/local/sbin/mbox-node-ctl /usr/local/sbin/mbox-node-uninstall
EOF
sed -i "s/@NODE@/$NODE_NAME/g" /usr/local/sbin/mbox-node-uninstall
chmod 755 /usr/local/sbin/mbox-node-uninstall

echo "$AGENT_USER ALL=(root) NOPASSWD: /usr/local/sbin/mbox-node-ctl, /usr/local/sbin/mbox-node-uninstall" > /etc/sudoers.d/mbox-node
chmod 440 /etc/sudoers.d/mbox-node
visudo -cf /etc/sudoers.d/mbox-node >/dev/null || { rm -f /etc/sudoers.d/mbox-node; fail "Правило sudo не прошло проверку visudo" 17; }

systemctl daemon-reload
# Нода уже была в работе (повторная установка): подхватываем новые файлы и токен.
systemctl try-restart mbox-node-claude.service mbox-node-codex.service >/dev/null 2>&1 || true

echo "##DONE"
