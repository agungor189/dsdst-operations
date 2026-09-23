#!/usr/bin/env sh
set -eu

: "${RECOVERY_MANIFEST_HMAC_KEY:?RECOVERY_MANIFEST_HMAC_KEY is required}"

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/compose.prod.yml"
ENV_FILE=${ENV_FILE:-$ROOT_DIR/.env}
BACKUP_ROOT=${OPERATIONS_BACKUP_DIR:-$ROOT_DIR/backups}
SOURCE_SET=${SOURCE_SET_MANIFEST:-$ROOT_DIR/config/v2-16-source-set.json}
OFFSITE_ENABLED=${RECOVERY_OFFSITE_ENABLED:-${CLOUD_BACKUP_ENABLED:-false}}
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUFFIX=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(4).toString("hex"))')
RECOVERY_ID="rp-${STAMP}-${SUFFIX}"

mkdir -p "$BACKUP_ROOT/recovery-points" "$BACKUP_ROOT/evidence/recovery-points"
BACKUP_ROOT=$(CDPATH='' && cd -- "$BACKUP_ROOT" && pwd)
PARTIAL="$BACKUP_ROOT/recovery-points/${RECOVERY_ID}.partial"
FINAL="$BACKUP_ROOT/recovery-points/$RECOVERY_ID"
LOCK="$BACKUP_ROOT/.backup.lock"
PHASE=initialization

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Another recovery-point run holds $LOCK" >&2
  exit 1
fi

cleanup_lock() {
  rmdir "$LOCK" 2>/dev/null || true
}

record_failure() {
  exit_code=${1:-1}
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -d "$PARTIAL" ]; then
    node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" record-failure \
      "$PARTIAL" "$RECOVERY_ID" "$STARTED_AT" "$completed_at" "$PHASE" "Recovery point creation failed" >/dev/null || true
    if [ ! -e "$FINAL" ]; then mv "$PARTIAL" "$FINAL"; fi
  fi
  cleanup_lock
  exit "$exit_code"
}

trap 'record_failure 130' HUP INT TERM
trap cleanup_lock EXIT

mkdir -p "$PARTIAL/provenance"

PHASE=source-set
if ! SOURCE_SET_RELEASE=$(node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" source-set-release "$SOURCE_SET"); then
  record_failure 1
fi
EXPECTED_SOURCE_SET_RELEASE="$SOURCE_SET_RELEASE" SOURCE_SET_MANIFEST="$SOURCE_SET" \
  node "$ROOT_DIR/scripts/verify-source-set.mjs" --allow-operations-descendant > "$PARTIAL/provenance/source-set-observation.json" \
  || record_failure 1
cp "$SOURCE_SET" "$PARTIAL/provenance/source-set.json"

PHASE=runtime-provenance
node "$ROOT_DIR/scripts/collect-runtime-provenance.mjs" "$COMPOSE_FILE" "$ENV_FILE" \
  > "$PARTIAL/provenance/runtime.json" \
  || record_failure 1

PHASE=online-snapshots
export OPERATIONS_BACKUP_DIR="$BACKUP_ROOT"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile tools run --rm \
  -e RECOVERY_ID="$RECOVERY_ID" operations-toolbox \
  sh /operations/scripts/recovery/create-snapshot.sh \
  || record_failure 1

PHASE=local-verification
COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" build \
  "$PARTIAL" "$RECOVERY_ID" "$STARTED_AT" "$COMPLETED_AT" "$OFFSITE_ENABLED" >/dev/null \
  || record_failure 1
mv "$PARTIAL" "$FINAL"

if [ "$OFFSITE_ENABLED" != "true" ]; then
  echo "Recovery point $RECOVERY_ID is locally VERIFIED but INCOMPLETE: encrypted offsite persistence is disabled." >&2
  exit 1
fi

PHASE=offsite-persistence
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile tools run --rm \
  -e RECOVERY_ID="$RECOVERY_ID" operations-toolbox \
  sh /operations/scripts/recovery/offsite-upload.sh \
  || exit 1

PHASE=final-verification
node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" verify --require-accepted "$FINAL" >/dev/null

PHASE=retention
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile tools run --rm \
  operations-toolbox sh /operations/scripts/recovery/apply-retention.sh /backups >/dev/null

chmod -R a-w "$FINAL"
echo "Recovery point SUCCESS: $RECOVERY_ID"
