#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_ROOT=${OPERATIONS_BACKUP_DIR:-$ROOT_DIR/backups}
ENV_FILE=${ENV_FILE:-$ROOT_DIR/.env}
DRILL_TYPE=monthly-isolated
FULL=false

if [ "${1:-}" = "--full" ]; then
  FULL=true
  DRILL_TYPE=quarterly-full
  shift
fi

RECOVERY_POINT=${1:-}
AUTO_SELECTED=false
if [ -z "$RECOVERY_POINT" ]; then
  AUTO_SELECTED=true
  RECOVERY_POINT=$(node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" latest-success "$BACKUP_ROOT")
fi

case "$RECOVERY_POINT" in
  /*) ;;
  *) RECOVERY_POINT="$ROOT_DIR/$RECOVERY_POINT" ;;
esac

RECOVERY_ID=$(basename "$RECOVERY_POINT")
DRILL_ID="drill-$(date -u +%Y%m%dT%H%M%SZ)-$RECOVERY_ID"
RESTORE_ROOT=${RECOVERY_RESTORE_ROOT:-$BACKUP_ROOT/restore-staging}
TARGET="$RESTORE_ROOT/$DRILL_ID"
EVIDENCE="$BACKUP_ROOT/evidence/drills/$DRILL_ID.json"
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RESULT=FAILED
ERROR_MESSAGE=""
PROJECT="dsdst-recovery-$(printf '%s' "$DRILL_ID" | tr '[:upper:]_' '[:lower:]-' | cut -c1-48)"

record_evidence() {
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" drill-evidence \
    "$RECOVERY_POINT" "$EVIDENCE" "$DRILL_TYPE" "$STARTED_AT" "$completed_at" "$RESULT" "$ERROR_MESSAGE" >/dev/null || true
}

cleanup_stack() {
  if [ "$FULL" = "true" ]; then
    COMPOSE_PROJECT_NAME="$PROJECT" RESTORE_ROOT="$TARGET" \
      docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.recovery.yml" \
      down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}

trap 'cleanup_stack; record_evidence' EXIT

if [ "$AUTO_SELECTED" = "true" ] && ! node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" health "$BACKUP_ROOT" >/dev/null; then
  ERROR_MESSAGE="RPO freshness exceeds 60 minutes"
  exit 1
fi

if ! "$ROOT_DIR/scripts/restore-check.sh" "$RECOVERY_POINT" "$TARGET" >/dev/null; then
  ERROR_MESSAGE="Isolated restore verification failed"
  exit 1
fi

if [ "$FULL" = "true" ]; then
  mkdir -p "$TARGET/scratch/panel-backups" "$TARGET/scratch/customer-hub-backups"
  IMAGE_ENV="$TARGET/recovery-images.env"
  node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" image-env "$RECOVERY_POINT" > "$IMAGE_ENV"
  set -a
  . "$IMAGE_ENV"
  set +a
  export COMPOSE_PROJECT_NAME="$PROJECT" RESTORE_ROOT="$TARGET"
  if ! docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.recovery.yml" \
    up -d --no-build --wait dsdst-panel dsdst-warehouse dsdst-kit-studio dsdst-customer-hub label-printer warehouse-label-renderer; then
    ERROR_MESSAGE="Isolated recovery stack failed health checks"
    exit 1
  fi
  for service in dsdst-panel dsdst-kit-studio dsdst-customer-hub label-printer warehouse-label-renderer; do
    docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.recovery.yml" ps -q "$service" | grep -q . \
      || { ERROR_MESSAGE="Isolated recovery stack is missing $service"; exit 1; }
  done
fi

RESULT=SUCCESS
echo "$DRILL_TYPE drill SUCCESS: $RECOVERY_ID"
echo "Evidence: $EVIDENCE"
