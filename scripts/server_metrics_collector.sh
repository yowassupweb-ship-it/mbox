#!/usr/bin/env sh
set -eu

DB_USER="${POSTGRES_USER:-mbox}"
DB_NAME="${POSTGRES_DB:-mbox}"

while true; do
  HOSTNAME_VALUE="$(hostname)"
  LOAD_1="$(awk '{print $1}' /proc/loadavg)"
  MEM_TOTAL_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  MEM_AVAILABLE_KB="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  MEM_USED_MB="$(( (MEM_TOTAL_KB - MEM_AVAILABLE_KB) / 1024 ))"
  MEM_TOTAL_MB="$(( MEM_TOTAL_KB / 1024 ))"
  DISK_TOTAL_MB="$(df -m / | awk 'NR==2 {print $2}')"
  DISK_USED_MB="$(df -m / | awk 'NR==2 {print $3}')"
  CPU_PERCENT="$(top -bn1 | awk '/Cpu\\(s\\)/ {print 100 - $8; found=1} END {if (!found) print 0}')"
  CONTAINERS="$(docker ps --format '{{json .}}' 2>/dev/null | jq -s '.' 2>/dev/null || printf '[]')"

  docker exec -i mbox-postgres psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO server_metrics (
  hostname,
  load_1,
  cpu_percent,
  memory_used_mb,
  memory_total_mb,
  disk_used_mb,
  disk_total_mb,
  docker_containers
) VALUES (
  \$q\$${HOSTNAME_VALUE}\$q\$,
  '$LOAD_1',
  '$CPU_PERCENT',
  '$MEM_USED_MB',
  '$MEM_TOTAL_MB',
  '$DISK_USED_MB',
  '$DISK_TOTAL_MB',
  \$json\$${CONTAINERS}\$json\$::jsonb
);

DELETE FROM server_metrics
WHERE id NOT IN (
  SELECT id FROM server_metrics ORDER BY captured_at DESC LIMIT 720
);
SQL
  sleep "${MBOX_METRICS_INTERVAL:-5}"
done
