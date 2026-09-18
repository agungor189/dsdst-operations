#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
COMPOSE_FILE="$ROOT_DIR/compose.prod.yml"

check() {
  service=$1
  url=$2
  attempts=30
  while [ "$attempts" -gt 0 ]; do
    if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$service" \
      wget -qO- "$url" >/dev/null 2>&1; then
      echo "$service: healthy"
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 2
  done
  echo "$service: unhealthy ($url)" >&2
  return 1
}

check_command() {
  service=$1
  command=$2
  attempts=30
  while [ "$attempts" -gt 0 ]; do
    if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$service" \
      "$command" >/dev/null 2>&1; then
      echo "$service: healthy"
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 2
  done
  echo "$service: unhealthy ($command)" >&2
  return 1
}

check dsdst-panel "http://127.0.0.1:3000/api/public/health"
check dsdst-warehouse "http://127.0.0.1:3006/health"
check dsdst-kit-studio "http://127.0.0.1:3012/api/health"
check_command dsdst-customer-hub "customer-hub-healthcheck"
check label-printer "http://127.0.0.1:3000/api/health"
check warehouse-label-renderer "http://127.0.0.1:3010/health"
