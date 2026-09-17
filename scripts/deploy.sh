#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/compose.prod.yml"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing environment file: $ENV_FILE" >&2
  echo "Copy .env.example to .env and replace every placeholder." >&2
  exit 1
fi

if grep -Eq '(^|=)(replace-with-|ghcr.io/OWNER/)' "$ENV_FILE"; then
  echo "Refusing deployment: unresolved placeholders remain in $ENV_FILE" >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull --ignore-buildable
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build --remove-orphans
ENV_FILE="$ENV_FILE" "$ROOT_DIR/scripts/healthcheck.sh"
