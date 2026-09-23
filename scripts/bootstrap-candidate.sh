#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
ACTION=${1:-}
BOOTSTRAP_POINT=${2:-}
ENV_FILE=${3:-}
EVIDENCE_DIR=${4:-}

if [ "$ACTION" = "stop" ]; then
  ENV_FILE=${2:-}
  [ -n "$ENV_FILE" ] || { echo "Usage: $0 stop <candidate-env>" >&2; exit 2; }
  PROJECT=$(grep '^RELEASE_CANDIDATE_PROJECT=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
  node "$ROOT_DIR/scripts/release/verify-candidate-env.mjs" "$ENV_FILE" "$PROJECT" >/dev/null
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.release-candidate.yml" stop
  echo "Bootstrap candidate stopped; isolated volumes retained."
  exit 0
fi

if [ "$ACTION" != "run" ] || [ -z "$BOOTSTRAP_POINT" ] || [ -z "$ENV_FILE" ] || [ -z "$EVIDENCE_DIR" ]; then
  echo "Usage: $0 run <accepted-bootstrap-point> <candidate-env> <evidence-dir> | stop <candidate-env>" >&2
  exit 2
fi

PROJECT=$(grep '^RELEASE_CANDIDATE_PROJECT=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
node "$ROOT_DIR/scripts/release/verify-candidate-env.mjs" "$ENV_FILE" "$PROJECT" >/dev/null
case "$PROJECT" in
  dsdst-candidate-v2-18-bootstrap-*) ;;
  *) echo "Bootstrap candidate project must start with dsdst-candidate-v2-18-bootstrap-" >&2; exit 2 ;;
esac

HMAC_KEY=$(grep '^RECOVERY_MANIFEST_HMAC_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
[ -n "$HMAC_KEY" ] || { echo "Candidate env is missing RECOVERY_MANIFEST_HMAC_KEY" >&2; exit 2; }
export RECOVERY_MANIFEST_HMAC_KEY="$HMAC_KEY"
HMAC_KEY_ID=$(grep '^RECOVERY_MANIFEST_HMAC_KEY_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
[ -z "$HMAC_KEY_ID" ] || export RECOVERY_MANIFEST_HMAC_KEY_ID="$HMAC_KEY_ID"
unset HMAC_KEY HMAC_KEY_ID
node "$ROOT_DIR/scripts/bootstrap-cli.mjs" verify "$BOOTSTRAP_POINT" --require-accepted >/dev/null

TOOLBOX_IMAGE=$(grep '^OPERATIONS_TOOLBOX_IMAGE=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
[ -n "$TOOLBOX_IMAGE" ] || { echo "Candidate env is missing OPERATIONS_TOOLBOX_IMAGE" >&2; exit 2; }

mkdir -p "$EVIDENCE_DIR"
EVIDENCE_DIR=$(CDPATH='' && cd -- "$EVIDENCE_DIR" && pwd)
RUNTIME_EVIDENCE="$EVIDENCE_DIR/runtime-provenance.json"
SUMMARY_EVIDENCE="$EVIDENCE_DIR/bootstrap-candidate-verification.json"
[ ! -e "$RUNTIME_EVIDENCE" ] && [ ! -e "$SUMMARY_EVIDENCE" ] || { echo "Bootstrap candidate evidence already exists; refusing overwrite" >&2; exit 2; }

compose() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.release-candidate.yml" "$@"
}

if compose ps -aq | grep -q .; then
  echo "Bootstrap candidate project already has containers; refusing ambiguous reuse" >&2
  exit 1
fi

RESTORE_ROOT=${OPERATIONS_BACKUP_DIR:-"$ROOT_DIR/backups"}/restore-staging
RESTORE_TARGET="$RESTORE_ROOT/${PROJECT}-bootstrap"
if [ -e "$RESTORE_TARGET" ]; then
  echo "Bootstrap restore staging target already exists: $RESTORE_TARGET" >&2
  exit 1
fi

cleanup_failed() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$RESTORE_TARGET"
  fi
  exit "$status"
}
trap cleanup_failed EXIT HUP INT TERM

compose config --quiet
compose pull
compose create --no-build

node "$ROOT_DIR/scripts/bootstrap-cli.mjs" restore "$BOOTSTRAP_POINT" "$RESTORE_TARGET" >/dev/null

docker run --rm \
  --mount "type=volume,src=${PROJECT}-panel-data,dst=/target/panel-data" \
  --mount "type=volume,src=${PROJECT}-panel-uploads,dst=/target/panel-uploads" \
  --mount "type=volume,src=${PROJECT}-kit-data,dst=/target/kit-data" \
  --mount "type=volume,src=${PROJECT}-kit-uploads,dst=/target/kit-uploads" \
  --mount "type=volume,src=${PROJECT}-label-data,dst=/target/label-data" \
  --mount "type=volume,src=${PROJECT}-customer-hub-data,dst=/target/customer-hub-data" \
  --mount "type=bind,src=${RESTORE_TARGET},dst=/restore,readonly" \
  --mount "type=bind,src=${ROOT_DIR}/scripts,dst=/operations/scripts,readonly" \
  -e RESTORED_ROOT=/restore \
  "$TOOLBOX_IMAGE" sh /operations/scripts/bootstrap-hydrate-volumes.sh

compose up -d --no-build --wait \
  dsdst-panel dsdst-warehouse dsdst-kit-studio dsdst-customer-hub label-printer warehouse-label-renderer

# Critical health and read-only connectivity checks.
compose exec -T dsdst-panel wget -qO- http://127.0.0.1:3000/api/public/health >/dev/null
compose exec -T dsdst-warehouse wget -qO- http://127.0.0.1:3006/health >/dev/null
compose exec -T dsdst-kit-studio wget -qO- http://127.0.0.1:3012/api/health >/dev/null
compose exec -T dsdst-customer-hub customer-hub-healthcheck >/dev/null
compose exec -T label-printer wget -qO- http://127.0.0.1:3000/api/health >/dev/null
compose exec -T warehouse-label-renderer wget -qO- http://127.0.0.1:3010/health >/dev/null
compose exec -T dsdst-warehouse wget -qO- http://dsdst-panel:3000/api/public/health >/dev/null
compose exec -T dsdst-warehouse wget -qO- http://warehouse-label-renderer:3010/health >/dev/null
compose exec -T dsdst-kit-studio wget -qO- http://dsdst-panel:3000/api/public/health >/dev/null
compose exec -T label-printer wget -qO- http://dsdst-panel:3000/api/public/health >/dev/null
compose exec -T dsdst-customer-hub node -e "fetch('http://dsdst-panel:3000/api/public/health').then(r=>{if(!r.ok)process.exit(2)}).catch(()=>process.exit(2))"

DSDST_PROVENANCE_PROJECT="$PROJECT" \
DSDST_PROVENANCE_COMPOSE_OVERLAY="$ROOT_DIR/compose.release-candidate.yml" \
node "$ROOT_DIR/scripts/collect-runtime-provenance.mjs" "$ROOT_DIR/compose.prod.yml" "$ENV_FILE" > "$RUNTIME_EVIDENCE"

node "$ROOT_DIR/scripts/bootstrap-cli.mjs" verify-candidate \
  "$BOOTSTRAP_POINT" "$RUNTIME_EVIDENCE" "$ROOT_DIR/config/v2-18-source-set.json" >/dev/null

node - "$BOOTSTRAP_POINT" "$RUNTIME_EVIDENCE" "$SUMMARY_EVIDENCE" <<'NODE'
const fs = require('node:fs');
const [point, runtimePath, output] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(`${point}/manifest.json`, 'utf8'));
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
fs.writeFileSync(output, JSON.stringify({
  evidence_version: 'dsdst.v2-18-bootstrap-candidate.v1',
  bootstrap_id: manifest.bootstrap_id,
  candidate_status: 'VERIFIED_EXACT_V2_18',
  runtime_capture_id: runtime.capture_id,
  captured_at: runtime.captured_at,
  health: 'PASS',
  smoke: {status: 'PASS', mode: 'READ_ONLY'},
  connectivity: 'PASS',
  production_mutated: false,
  route_mutated: false,
}, null, 2) + '\n', {mode: 0o640});
NODE

rm -rf "$RESTORE_TARGET"
trap - EXIT HUP INT TERM
printf 'Bootstrap candidate VERIFIED: %s\n' "$PROJECT"
printf 'Runtime evidence: %s\n' "$RUNTIME_EVIDENCE"
printf 'Summary evidence: %s\n' "$SUMMARY_EVIDENCE"
