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
RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dsdst-e2e-local.XXXXXX")
NODE24_BIN=${NODE24_BIN:-$(npx -y node@24 -p 'process.execPath')}
KIT_NODE_BIN=${KIT_NODE_BIN:-$(command -v node)}
CUSTOMER_HUB_NODE_BIN=${CUSTOMER_HUB_NODE_BIN:-$NODE24_BIN}
E2E_SKIP_AUXILIARY_HUB=${E2E_SKIP_AUXILIARY_HUB:-0}
BASE_PORT=$((43000 + ($$ % 1000)))
PANEL_PORT=$BASE_PORT
WAREHOUSE_PORT=$((BASE_PORT + 1))
LABEL_PORT=$((BASE_PORT + 2))
RENDERER_PORT=$((BASE_PORT + 3))
KIT_PORT=$((BASE_PORT + 4))
CUSTOMER_HUB_PORT=$((BASE_PORT + 5))
API_KEY=operations-e2e-api-key-not-production
KIT_API_KEY=operations-e2e-kit-api-key-not-production
LABEL_API_KEY=operations-e2e-label-api-key-not-production
RENDERER_KEY=operations-e2e-renderer-key-not-production
PIDS=""

cleanup() {
  status=$?
  for pid in $PIDS; do kill "$pid" >/dev/null 2>&1 || true; done
  for pid in $PIDS; do wait "$pid" >/dev/null 2>&1 || true; done
  if [ "$status" -ne 0 ]; then
    for log in "$RUNTIME_DIR"/*.log; do
      [ -f "$log" ] || continue
      echo "--- $(basename "$log") ---" >&2
      tail -80 "$log" >&2
    done
  fi
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT INT TERM

wait_for() {
  name=$1
  url=$2
  attempts=60
  while [ "$attempts" -gt 0 ]; do
    if curl --fail --silent --max-time 2 "$url" >/dev/null; then return 0; fi
    attempts=$((attempts - 1))
    sleep 0.5
  done
  echo "$name did not become healthy; logs are in $RUNTIME_DIR" >&2
  return 1
}

mkdir -p "$RUNTIME_DIR/panel-backups" "$RUNTIME_DIR/kit-uploads" "$RUNTIME_DIR/label-data"
if [ "$E2E_SKIP_AUXILIARY_HUB" != "1" ]; then
  mkdir -p "$RUNTIME_DIR/customer-hub-data/attachments"
fi

(cd "$PANEL_REPO" && exec env \
  NODE_ENV=test E2E_ALLOW_SEED=true DB_PATH="$RUNTIME_DIR/panel.db" \
  E2E_WAREHOUSE_API_KEY="$API_KEY" E2E_KIT_STUDIO_API_KEY="$KIT_API_KEY" E2E_LABEL_PRINTER_API_KEY="$LABEL_API_KEY" \
  PANEL_API_HASH_SECRET=operations-e2e-hash-secret-not-production \
  JWT_SECRET=operations-e2e-jwt-secret-not-production \
  ENCRYPTION_SECRET=operations-e2e-encryption-not-production \
  "$NODE24_BIN" node_modules/tsx/dist/cli.mjs scripts/seedOperationsE2E.ts) >"$RUNTIME_DIR/seed.log" 2>&1

(cd "$LABEL_REPO" && exec env NODE_ENV=production LABEL_RENDERER_PORT="$RENDERER_PORT" \
  LABEL_RENDERER_API_KEY="$RENDERER_KEY" DATA_DIR="$RUNTIME_DIR/label-data" \
  "$NODE24_BIN" warehouse-renderer.mjs) >"$RUNTIME_DIR/renderer.log" 2>&1 &
PIDS="$PIDS $!"

(cd "$PANEL_REPO" && exec env NODE_ENV=production PORT="$PANEL_PORT" DB_PATH="$RUNTIME_DIR/panel.db" \
  BACKUP_DIR="$RUNTIME_DIR/panel-backups" JWT_SECRET=operations-e2e-jwt-secret-not-production \
  ENCRYPTION_SECRET=operations-e2e-encryption-not-production \
  PANEL_API_HASH_SECRET=operations-e2e-hash-secret-not-production \
  LABEL_RENDERER_URL="http://127.0.0.1:$RENDERER_PORT" LABEL_RENDERER_API_KEY="$RENDERER_KEY" \
  WAREHOUSE_PRINT_DRY_RUN=true WAREHOUSE_PRINT_WORKER_INTERVAL_MS=500 \
  "$NODE24_BIN" node_modules/tsx/dist/cli.mjs server.ts) >"$RUNTIME_DIR/panel.log" 2>&1 &
PIDS="$PIDS $!"

wait_for renderer "http://127.0.0.1:$RENDERER_PORT/health"
wait_for panel "http://127.0.0.1:$PANEL_PORT/api/public/health"

if [ "$E2E_SKIP_AUXILIARY_HUB" != "1" ]; then
  (cd "$CUSTOMER_HUB_REPO" && exec env NODE_ENV=test PORT="$CUSTOMER_HUB_PORT" \
    DATABASE_PATH="$RUNTIME_DIR/customer-hub-data/customer-hub.db" ATTACHMENTS_DIR="$RUNTIME_DIR/customer-hub-data/attachments" \
    PANEL_BASE_URL="http://127.0.0.1:$PANEL_PORT" APP_ORIGIN="http://127.0.0.1:$CUSTOMER_HUB_PORT" \
    CUSTOMER_HUB_ENCRYPTION_KEY=0707070707070707070707070707070707070707070707070707070707070707 \
    SESSION_SECURE=false MOCK_ADAPTERS_ENABLED=true \
    "$CUSTOMER_HUB_NODE_BIN" dist-server/server/index.js) >"$RUNTIME_DIR/customer-hub.log" 2>&1 &
  PIDS="$PIDS $!"
fi

(cd "$LABEL_REPO" && exec env NODE_ENV=production PORT="$LABEL_PORT" DATA_DIR="$RUNTIME_DIR/label-data" \
  PANEL_API_URL="http://127.0.0.1:$PANEL_PORT" PANEL_API_KEY="$LABEL_API_KEY" COOKIE_SECURE=false \
  "$NODE24_BIN" server.mjs) >"$RUNTIME_DIR/label.log" 2>&1 &
PIDS="$PIDS $!"

(cd "$WAREHOUSE_REPO" && exec env NODE_ENV=production PORT="$WAREHOUSE_PORT" \
  PANEL_API_BASE_URL="http://127.0.0.1:$PANEL_PORT" WAREHOUSE_API_KEY="$API_KEY" \
  LABEL_RENDERER_URL="http://127.0.0.1:$RENDERER_PORT" LABEL_RENDERER_API_KEY="$RENDERER_KEY" COOKIE_SECURE=false \
  "$NODE24_BIN" server-dist/index.js) >"$RUNTIME_DIR/warehouse.log" 2>&1 &
PIDS="$PIDS $!"

(cd "$KIT_REPO" && exec env NODE_ENV=production PORT="$KIT_PORT" DB_PATH="$RUNTIME_DIR/kit.db" \
  UPLOAD_DIR="$RUNTIME_DIR/kit-uploads" PANEL_API_URL="http://127.0.0.1:$PANEL_PORT" PANEL_API_KEY="$KIT_API_KEY" \
  ALLOWED_ORIGINS="http://127.0.0.1:$KIT_PORT" \
  "$KIT_NODE_BIN" dist-server/server/index.js) >"$RUNTIME_DIR/kit.log" 2>&1 &
PIDS="$PIDS $!"

wait_for label-printer "http://127.0.0.1:$LABEL_PORT/api/health"
wait_for warehouse "http://127.0.0.1:$WAREHOUSE_PORT/health"
wait_for kit-studio "http://127.0.0.1:$KIT_PORT/api/health"
if [ "$E2E_SKIP_AUXILIARY_HUB" != "1" ]; then
  wait_for customer-hub "http://127.0.0.1:$CUSTOMER_HUB_PORT/api/health"
fi

env PANEL_URL="http://127.0.0.1:$PANEL_PORT" WAREHOUSE_URL="http://127.0.0.1:$WAREHOUSE_PORT" \
  LABEL_PRINTER_URL="http://127.0.0.1:$LABEL_PORT" KIT_STUDIO_URL="http://127.0.0.1:$KIT_PORT" \
  CUSTOMER_HUB_URL="http://127.0.0.1:$CUSTOMER_HUB_PORT" WAREHOUSE_SERVICE_KEY="$API_KEY" \
  E2E_SKIP_AUXILIARY_HUB="$E2E_SKIP_AUXILIARY_HUB" \
  "$NODE24_BIN" --test "$ROOT_DIR/tests/operations.e2e.mjs"
