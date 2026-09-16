#!/usr/bin/env sh
set -eu

DB_USER="${POSTGRES_USER:-mbox}"
DB_NAME="${POSTGRES_DB:-mbox}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-mbox-postgres}"
INTERVAL="${MBOX_METRICS_INTERVAL:-5}"
RETENTION="${MBOX_METRICS_RETENTION:-720}"

log() {
  printf '%s %s\n' "$(date -Is 2>/dev/null || date)" "$*" >&2
}

resolve_postgres_container() {
  if docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1; then
    printf '%s\n' "$POSTGRES_CONTAINER"
    return 0
  fi
  docker ps --format '{{.Names}}' 2>/dev/null \
    | awk '/(^|[-_])mbox-postgres($|[-_])|postgres/ { print; exit }'
}

cpu_percent() {
  first="$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5}' /proc/stat)"
  sleep 0.2
  second="$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5}' /proc/stat)"
  awk -v a="$first" -v b="$second" '
    BEGIN {
      split(a, x, " "); split(b, y, " ");
      total = y[1] - x[1]; idle = y[2] - x[2];
      if (total <= 0) print 0;
      else printf "%.1f", 100 * (total - idle) / total;
    }'
}

docker_containers_json() {
  if ! command -v docker >/dev/null 2>&1; then
    printf '[]'
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    docker ps --format '{{json .}}' 2>/dev/null | jq -s '.' 2>/dev/null || printf '[]'
    return 0
  fi
  printf '[]'
}

while true; do
  if ! command -v docker >/dev/null 2>&1; then
    log "docker command not found; waiting"
    sleep "$INTERVAL"
    continue
  fi

  CONTAINER="$(resolve_postgres_container || true)"
  if [ -z "$CONTAINER" ]; then
    log "postgres container not found; waiting"
    sleep "$INTERVAL"
    continue
  fi

  HOSTNAME_VALUE="$(hostname)"
  LOAD_1="$(awk '{print $1}' /proc/loadavg)"
  MEM_TOTAL_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  MEM_AVAILABLE_KB="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  MEM_USED_MB="$(( (MEM_TOTAL_KB - MEM_AVAILABLE_KB) / 1024 ))"
  MEM_TOTAL_MB="$(( MEM_TOTAL_KB / 1024 ))"
  DISK_TOTAL_MB="$(df -m "${MBOX_METRICS_DISK_PATH:-/}" | awk 'NR==2 {print $2}')"
  DISK_USED_MB="$(df -m "${MBOX_METRICS_DISK_PATH:-/}" | awk 'NR==2 {print $3}')"
  CPU_PERCENT="$(cpu_percent)"
  CONTAINERS="$(docker_containers_json)"

  if ! docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null <<SQL
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
  SELECT id FROM server_metrics ORDER BY captured_at DESC LIMIT ${RETENTION}
);
SQL
  then
    log "failed to write metrics through container ${CONTAINER}; retrying"
  fi

  sleep "$INTERVAL"
done
