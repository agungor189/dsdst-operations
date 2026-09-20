#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
OPERATIONS_REPO=${OPERATIONS_CONTEXT:-$ROOT_DIR}
PANEL_REPO=${PANEL_CONTEXT:-$ROOT_DIR/../panel-kit-yonetimi}
WAREHOUSE_REPO=${WAREHOUSE_CONTEXT:-$ROOT_DIR/../Dsdst-Warehouse}
KIT_REPO=${KIT_STUDIO_CONTEXT:-$ROOT_DIR/../dsdst-kit-studio}
LABEL_REPO=${LABEL_PRINTER_CONTEXT:-$ROOT_DIR/../Label-Printer}
CUSTOMER_HUB_REPO=${CUSTOMER_HUB_CONTEXT:-$ROOT_DIR/../dsdst-customer-hub}
OPERATIONS_CONTEXT="$OPERATIONS_REPO" PANEL_CONTEXT="$PANEL_REPO" WAREHOUSE_CONTEXT="$WAREHOUSE_REPO" \
  KIT_STUDIO_CONTEXT="$KIT_REPO" LABEL_PRINTER_CONTEXT="$LABEL_REPO" CUSTOMER_HUB_CONTEXT="$CUSTOMER_HUB_REPO" \
  node "$ROOT_DIR/scripts/verify-source-set.mjs"
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
CUSTOMER_HUB_CONTEXT=${CUSTOMER_HUB_CONTEXT:-$ROOT_DIR/../dsdst-customer-hub}
JWT_SECRET=operations-e2e-jwt-secret-not-production
ENCRYPTION_SECRET=operations-e2e-encryption-not-production
PANEL_API_HASH_SECRET=operations-e2e-hash-secret-not-production
E2E_WAREHOUSE_API_KEY=operations-e2e-api-key-not-production
WAREHOUSE_API_KEY=operations-e2e-api-key-not-production
E2E_KIT_STUDIO_API_KEY=operations-e2e-kit-api-key-not-production
E2E_LABEL_PRINTER_API_KEY=operations-e2e-label-api-key-not-production
KIT_STUDIO_API_KEY=operations-e2e-kit-api-key-not-production
LABEL_PRINTER_API_KEY=operations-e2e-label-api-key-not-production
LABEL_RENDERER_API_KEY=operations-e2e-renderer-key-not-production
CUSTOMER_HUB_ENCRYPTION_KEY=0707070707070707070707070707070707070707070707070707070707070707
CUSTOMER_HUB_APP_ORIGIN=http://dsdst-customer-hub:3100
CUSTOMER_HUB_SESSION_SECURE=false
PANEL_BACKUP_DIR=panel_backups
CUSTOMER_HUB_BACKUP_DIR=customer_hub_backups
COOKIE_SECURE=false
TRUST_PROXY_HOPS=0
WAREHOUSE_PRINT_DRY_RUN=true
EOF
docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
  -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.e2e.yml" \
  up --build --abort-on-container-exit --exit-code-from operations-e2e operations-e2e
