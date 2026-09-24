#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/../.." && pwd)
ACTION=${1:-}
JOURNAL=${2:-}
ENV_FILE=${3:-}
HYDRATION_EVIDENCE=${4:-}

if [ -z "$ACTION" ] || [ -z "$JOURNAL" ] || [ -z "$ENV_FILE" ]; then
  echo "Usage: $0 <config|pull|up|health|stop> <release-journal> <candidate-env-file> [hydration-evidence]" >&2
  exit 2
fi

PROJECT=$(node "$ROOT_DIR/scripts/release/release-cli.mjs" candidate-project "$JOURNAL")
node "$ROOT_DIR/scripts/release/verify-candidate-env.mjs" "$ENV_FILE" "$PROJECT" >/dev/null

set -- docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
  -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.release-candidate.yml"

case "$ACTION" in
  config)
    "$@" config --quiet
    ;;
  pull)
    node "$ROOT_DIR/scripts/release/release-cli.mjs" assert-state "$JOURNAL" PREFLIGHT_PASSED >/dev/null
    "$@" config --quiet
    "$@" pull
    ;;
  up)
    node "$ROOT_DIR/scripts/release/release-cli.mjs" assert-state "$JOURNAL" PREFLIGHT_PASSED >/dev/null
    [ -n "$HYDRATION_EVIDENCE" ] || {
      echo "Candidate up requires verified hydration evidence" >&2
      exit 2
    }
    [ -f "$HYDRATION_EVIDENCE" ] || {
      echo "Hydration evidence does not exist: $HYDRATION_EVIDENCE" >&2
      exit 2
    }
    BACKUP_ID=$(node "$ROOT_DIR/scripts/release/release-cli.mjs" backup-id "$JOURNAL")
    node "$ROOT_DIR/scripts/release/verify-hydration-evidence.mjs"       "$HYDRATION_EVIDENCE" "$BACKUP_ID" >/dev/null
    "$@" config --quiet
    "$@" up -d --no-build --remove-orphans
    ;;
  health)
    node "$ROOT_DIR/scripts/release/release-cli.mjs" assert-state "$JOURNAL" CANDIDATE_UP >/dev/null
    "$@" ps --status running --services
    "$@" exec -T dsdst-panel wget -qO- http://127.0.0.1:3000/api/public/health >/dev/null
    "$@" exec -T dsdst-warehouse wget -qO- http://127.0.0.1:3006/health >/dev/null
    "$@" exec -T dsdst-kit-studio wget -qO- http://127.0.0.1:3012/api/health >/dev/null
    "$@" exec -T dsdst-customer-hub customer-hub-healthcheck >/dev/null
    "$@" exec -T label-printer wget -qO- http://127.0.0.1:3000/api/health >/dev/null
    "$@" exec -T warehouse-label-renderer wget -qO- http://127.0.0.1:3010/health >/dev/null
    echo "candidate critical health: PASS"
    ;;
  stop)
    "$@" stop
    echo "Candidate containers stopped; volumes were retained."
    ;;
  *)
    echo "Unknown candidate action: $ACTION" >&2
    exit 2
    ;;
esac
