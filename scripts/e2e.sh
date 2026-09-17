#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsdst-e2e.XXXXXX")
PROJECT_NAME="dsdst-e2e-$$"
ENV_FILE="$RUNTIME_DIR/e2e.env"

cleanup() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
    -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.e2e.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT INT TERM

umask 077
cat >"$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=$PROJECT_NAME
PANEL_CONTEXT=${PANEL_CONTEXT:-$ROOT_DIR/../panel-kit-yonetimi}
WAREHOUSE_CONTEXT=${WAREHOUSE_CONTEXT:-$ROOT_DIR/../Dsdst-Warehouse}
KIT_STUDIO_CONTEXT=${KIT_STUDIO_CONTEXT:-$ROOT_DIR/../dsdst-kit-studio}
LABEL_PRINTER_CONTEXT=${LABEL_PRINTER_CONTEXT:-$ROOT_DIR/../Label-Printer}
JWT_SECRET=operations-e2e-jwt-secret-not-production
ENCRYPTION_SECRET=operations-e2e-encryption-not-production
PANEL_API_HASH_SECRET=operations-e2e-hash-secret-not-production
E2E_WAREHOUSE_API_KEY=operations-e2e-api-key-not-production
WAREHOUSE_API_KEY=operations-e2e-api-key-not-production
KIT_STUDIO_API_KEY=operations-e2e-api-key-not-production
LABEL_RENDERER_API_KEY=operations-e2e-renderer-key-not-production
PANEL_BACKUP_DIR=$RUNTIME_DIR/panel-backups
COOKIE_SECURE=false
TRUST_PROXY_HOPS=0
WAREHOUSE_PRINT_DRY_RUN=true
EOF
mkdir -p "$RUNTIME_DIR/panel-backups"

docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
  -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.e2e.yml" \
  up --build --abort-on-container-exit --exit-code-from operations-e2e operations-e2e
