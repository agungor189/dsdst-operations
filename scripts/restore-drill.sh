#!/usr/bin/env sh
set -eu

: "${RECOVERY_MANIFEST_HMAC_KEY:?RECOVERY_MANIFEST_HMAC_KEY is required}"

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_ROOT=${OPERATIONS_BACKUP_DIR:-$ROOT_DIR/backups}
ENV_FILE=${ENV_FILE:-$ROOT_DIR/.env}
DRILL_TYPE=monthly-service-level
FULL=false

if [ "${1:-}" = "--full" ]; then
  FULL=true
  DRILL_TYPE=quarterly-full
  shift
fi

RECOVERY_POINT=${1:-}
if [ -z "$RECOVERY_POINT" ]; then
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
FAILURE_STAGE=""
EVIDENCE_WRITTEN=false
STACK_ATTEMPTED=false
PROJECT="dsdst-recovery-$(printf '%s' "$DRILL_ID" | tr '[:upper:]_' '[:lower:]-' | cut -c1-48)"

compose() {
  COMPOSE_PROJECT_NAME="$PROJECT" RESTORE_ROOT="$TARGET" \
    docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.recovery.yml" "$@"
}

record_evidence() {
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" drill-evidence \
    "$RECOVERY_POINT" "$EVIDENCE" "$DRILL_TYPE" "$STARTED_AT" "$completed_at" \
    "$RESULT" "$ERROR_MESSAGE" "$FAILURE_STAGE" >/dev/null; then
    evidence_status=0
  else
    evidence_status=$?
  fi
  EVIDENCE_WRITTEN=true
  return "$evidence_status"
}

cleanup_stack() {
  if [ "$STACK_ATTEMPTED" = "true" ]; then
    if compose down --volumes --remove-orphans >/dev/null 2>&1; then
      cleanup_status=0
    else
      cleanup_status=$?
    fi
    STACK_ATTEMPTED=false
    return "$cleanup_status"
  fi
  return 0
}

on_exit() {
  exit_status=$?
  cleanup_stack || true
  if [ "$EVIDENCE_WRITTEN" != "true" ]; then
    record_evidence || true
  fi
  trap - EXIT HUP INT TERM
  exit "$exit_status"
}

run_read_only_smoke() {
  compose exec -T dsdst-panel wget -qO- http://127.0.0.1:3000/api/public/health >/dev/null
  compose exec -T dsdst-warehouse wget -qO- http://127.0.0.1:3006/health >/dev/null
  compose exec -T dsdst-kit-studio wget -qO- http://127.0.0.1:3012/api/health >/dev/null
  compose exec -T dsdst-customer-hub customer-hub-healthcheck >/dev/null
  compose exec -T label-printer wget -qO- http://127.0.0.1:3000/api/health >/dev/null
  compose exec -T warehouse-label-renderer wget -qO- http://127.0.0.1:3010/health >/dev/null
}

trap on_exit EXIT HUP INT TERM

if ! node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" point-health "$RECOVERY_POINT" "$STARTED_AT" >/dev/null; then
  ERROR_MESSAGE="RPO freshness exceeds 60 minutes"
  FAILURE_STAGE="RPO"
  exit 1
fi

if ! "$ROOT_DIR/scripts/restore-check.sh" "$RECOVERY_POINT" "$TARGET" >/dev/null; then
  ERROR_MESSAGE="Isolated restore verification failed"
  FAILURE_STAGE="RESTORE"
  exit 1
fi

mkdir -p "$TARGET/scratch/panel-backups" "$TARGET/scratch/customer-hub-backups"
IMAGE_ENV="$TARGET/recovery-images.env"
node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" image-env "$RECOVERY_POINT" > "$IMAGE_ENV"
set -a
. "$IMAGE_ENV"
set +a
export COMPOSE_PROJECT_NAME="$PROJECT" RESTORE_ROOT="$TARGET"

STACK_ATTEMPTED=true
if ! compose up -d --no-build --wait \
  dsdst-panel dsdst-warehouse dsdst-kit-studio dsdst-customer-hub label-printer warehouse-label-renderer; then
  ERROR_MESSAGE="Isolated recovery stack failed health checks"
  FAILURE_STAGE="HEALTH"
  exit 1
fi

if ! run_read_only_smoke; then
  ERROR_MESSAGE="Isolated recovery stack failed read-only smoke checks"
  FAILURE_STAGE="SMOKE"
  exit 1
fi

if [ "$FULL" = "true" ]; then
  node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" verify --require-accepted "$RECOVERY_POINT" >/dev/null \
    || { ERROR_MESSAGE="Quarterly deep recovery verification failed"; FAILURE_STAGE="FULL_VALIDATION"; exit 1; }
fi

if ! cleanup_stack; then
  ERROR_MESSAGE="Isolated recovery stack teardown failed"
  FAILURE_STAGE="TEARDOWN"
  exit 1
fi
RESULT=SUCCESS
if ! record_evidence; then
  RESULT=FAILED
  echo "$DRILL_TYPE drill FAILED: RPO or RTO target missed" >&2
  exit 1
fi

echo "$DRILL_TYPE drill SUCCESS: $RECOVERY_ID"
echo "Evidence: $EVIDENCE"
