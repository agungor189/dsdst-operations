#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
BOOTSTRAP_POINT=${1:-}
ENV_FILE=${2:-}
BACKUP_ROOT=${3:-${OPERATIONS_BACKUP_DIR:-$ROOT_DIR/backups}}

if [ -z "$BOOTSTRAP_POINT" ] || [ -z "$ENV_FILE" ]; then
  echo "Usage: $0 <accepted-bootstrap-point> <bootstrap-candidate-env> [backup-root]" >&2
  exit 2
fi

PROJECT=$(grep '^RELEASE_CANDIDATE_PROJECT=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
node "$ROOT_DIR/scripts/release/verify-candidate-env.mjs" "$ENV_FILE" "$PROJECT" >/dev/null
case "$PROJECT" in
  dsdst-candidate-v2-18-bootstrap-*) ;;
  *) echo "Expected a V2-18 bootstrap candidate project" >&2; exit 2 ;;
esac

HMAC_KEY=$(grep '^RECOVERY_MANIFEST_HMAC_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
HMAC_KEY_ID=$(grep '^RECOVERY_MANIFEST_HMAC_KEY_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
TOOLBOX_IMAGE=$(grep '^OPERATIONS_TOOLBOX_IMAGE=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
if [ -z "$HMAC_KEY" ] || [ -z "$TOOLBOX_IMAGE" ]; then
  echo "Candidate env is missing recovery HMAC key or Operations toolbox image" >&2
  exit 2
fi
export RECOVERY_MANIFEST_HMAC_KEY="$HMAC_KEY"
[ -z "$HMAC_KEY_ID" ] || export RECOVERY_MANIFEST_HMAC_KEY_ID="$HMAC_KEY_ID"
unset HMAC_KEY HMAC_KEY_ID
node "$ROOT_DIR/scripts/bootstrap-cli.mjs" verify "$BOOTSTRAP_POINT" --require-accepted >/dev/null

compose() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.release-candidate.yml" "$@"
}

for service in dsdst-panel dsdst-warehouse dsdst-kit-studio dsdst-customer-hub label-printer warehouse-label-renderer; do
  id=$(compose ps --status running -q "$service")
  [ -n "$id" ] || { echo "Bootstrap candidate service is not running: $service" >&2; exit 1; }
done

mkdir -p "$BACKUP_ROOT/recovery-points" "$BACKUP_ROOT/evidence/recovery-points"
BACKUP_ROOT=$(CDPATH='' && cd -- "$BACKUP_ROOT" && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUFFIX=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(4).toString("hex"))')
RECOVERY_ID="rp-${STAMP}-${SUFFIX}"
PARTIAL="$BACKUP_ROOT/recovery-points/${RECOVERY_ID}.partial"
FINAL="$BACKUP_ROOT/recovery-points/$RECOVERY_ID"
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$PARTIAL/provenance"

cleanup_partial() {
  status=$?
  if [ "$status" -ne 0 ] && [ -d "$PARTIAL" ]; then
    echo "V2-18 candidate recovery creation failed; partial evidence retained at $PARTIAL" >&2
  fi
  exit "$status"
}
trap cleanup_partial EXIT HUP INT TERM

EXPECTED_SOURCE_SET_RELEASE=V2-18 SOURCE_SET_MANIFEST="$ROOT_DIR/config/v2-18-source-set.json" \
  node "$ROOT_DIR/scripts/verify-source-set.mjs" --allow-operations-descendant > "$PARTIAL/provenance/source-set-observation.json"
cp "$ROOT_DIR/config/v2-18-source-set.json" "$PARTIAL/provenance/source-set.json"

DSDST_PROVENANCE_PROJECT="$PROJECT" \
DSDST_PROVENANCE_COMPOSE_OVERLAY="$ROOT_DIR/compose.release-candidate.yml" \
node "$ROOT_DIR/scripts/collect-runtime-provenance.mjs" "$ROOT_DIR/compose.prod.yml" "$ENV_FILE" \
  > "$PARTIAL/provenance/runtime.json"
node "$ROOT_DIR/scripts/bootstrap-cli.mjs" verify-candidate \
  "$BOOTSTRAP_POINT" "$PARTIAL/provenance/runtime.json" "$ROOT_DIR/config/v2-18-source-set.json" >/dev/null

# Snapshot only the isolated bootstrap-candidate volumes. Production volumes are never mounted here.
docker run --rm \
  -e "RECOVERY_ID=$RECOVERY_ID" \
  --mount "type=volume,src=${PROJECT}-panel-data,dst=/sources/panel-data,readonly" \
  --mount "type=volume,src=${PROJECT}-panel-uploads,dst=/sources/panel-uploads,readonly" \
  --mount "type=volume,src=${PROJECT}-kit-data,dst=/sources/kit-data,readonly" \
  --mount "type=volume,src=${PROJECT}-kit-uploads,dst=/sources/kit-uploads,readonly" \
  --mount "type=volume,src=${PROJECT}-label-data,dst=/sources/labels,readonly" \
  --mount "type=volume,src=${PROJECT}-customer-hub-data,dst=/sources/customer-hub-data,readonly" \
  --mount "type=bind,src=${BACKUP_ROOT},dst=/backups" \
  --mount "type=bind,src=${ROOT_DIR}/scripts,dst=/operations/scripts,readonly" \
  "$TOOLBOX_IMAGE" sh /operations/scripts/recovery/create-snapshot.sh

# create-snapshot writes into the same pre-created .partial point.
COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" build \
  "$PARTIAL" "$RECOVERY_ID" "$STARTED_AT" "$COMPLETED_AT" true >/dev/null
mv "$PARTIAL" "$FINAL"

# Encrypt and persist the standard V2-18 recovery point offsite.
docker run --rm --env-file "$ENV_FILE" \
  -e "RECOVERY_ID=$RECOVERY_ID" \
  --mount "type=bind,src=${BACKUP_ROOT},dst=/backups" \
  --mount "type=bind,src=${ROOT_DIR}/scripts,dst=/operations/scripts,readonly" \
  --mount "type=bind,src=${ROOT_DIR}/config,dst=/operations/config,readonly" \
  "$TOOLBOX_IMAGE" sh /operations/scripts/recovery/offsite-upload.sh

node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" verify --require-accepted "$FINAL" >/dev/null

# A real accepted recovery point is not enough: complete the isolated full restore drill.
ENV_FILE="$ENV_FILE" OPERATIONS_BACKUP_DIR="$BACKUP_ROOT" \
RECOVERY_MANIFEST_HMAC_KEY="$RECOVERY_MANIFEST_HMAC_KEY" \
  "$ROOT_DIR/scripts/restore-drill.sh" --full "$FINAL"

compose stop >/dev/null
trap - EXIT HUP INT TERM
chmod -R a-w "$FINAL"
printf 'First accepted exact V2-18 recovery point SUCCESS: %s\n' "$FINAL"
printf 'Bootstrap candidate stopped; its isolated volumes were retained.\n'
