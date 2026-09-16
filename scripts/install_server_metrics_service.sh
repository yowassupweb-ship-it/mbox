#!/usr/bin/env sh
set -eu

SERVICE_NAME="${MBOX_METRICS_SERVICE_NAME:-mbox-server-metrics}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
COLLECTOR="${SCRIPT_DIR}/server_metrics_collector.sh"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="${MBOX_METRICS_ENV_FILE:-${REPO_DIR}/.env.production}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

if [ ! -x "$COLLECTOR" ]; then
  chmod +x "$COLLECTOR"
fi

cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=MBOX server metrics collector
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
EnvironmentFile=-${ENV_FILE}
Environment=MBOX_METRICS_INTERVAL=5
ExecStart=${COLLECTOR}
Restart=always
RestartSec=5
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME"
