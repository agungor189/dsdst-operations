#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/../.." && pwd)
JOURNAL=${1:-}
ENV_FILE=${2:-}
ISOLATED_RESTORE=${3:-}
HYDRATION_ADAPTER=${4:-}
EVIDENCE_OUTPUT=${5:-}

if [ -z "$JOURNAL" ] || [ -z "$ENV_FILE" ] || [ -z "$ISOLATED_RESTORE" ] || [ -z "$HYDRATION_ADAPTER" ] || [ -z "$EVIDENCE_OUTPUT" ]; then
  echo "Usage: $0 <journal> <candidate-env> <isolated-restore> <hydration-adapter> <hydration-evidence.json>" >&2
  exit 2
fi
[ ! -e "$EVIDENCE_OUTPUT" ] || { echo "Evidence output already exists; refusing overwrite" >&2; exit 2; }
case "$HYDRATION_ADAPTER" in
  /*) ;;
  *) echo "Hydration adapter must be an absolute executable path" >&2; exit 2 ;;
esac
[ -x "$HYDRATION_ADAPTER" ] || { echo "Hydration adapter is not executable" >&2; exit 2; }
[ -d "$ISOLATED_RESTORE" ] || { echo "Isolated restore directory does not exist" >&2; exit 2; }

node "$ROOT_DIR/scripts/release/release-cli.mjs" assert-state "$JOURNAL" PREFLIGHT_PASSED >/dev/null
PROJECT=$(node "$ROOT_DIR/scripts/release/release-cli.mjs" candidate-project "$JOURNAL")
BACKUP_ID=$(node "$ROOT_DIR/scripts/release/release-cli.mjs" backup-id "$JOURNAL")
node "$ROOT_DIR/scripts/release/verify-candidate-env.mjs" "$ENV_FILE" "$PROJECT" >/dev/null

docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
  -f "$ROOT_DIR/compose.prod.yml" -f "$ROOT_DIR/compose.release-candidate.yml" \
  create --no-build

umask 027
TEMP_EVIDENCE=$(mktemp "${TMPDIR:-/tmp}/dsdst-candidate-hydration.XXXXXX")
cleanup() { rm -f "$TEMP_EVIDENCE"; }
trap cleanup EXIT INT TERM

"$HYDRATION_ADAPTER" \
  --project "$PROJECT" \
  --isolated-restore "$ISOLATED_RESTORE" \
  --backup-id "$BACKUP_ID" \
  --candidate-env "$ENV_FILE" \
  --forbid-production-volumes \
  >"$TEMP_EVIDENCE"
node "$ROOT_DIR/scripts/release/verify-hydration-evidence.mjs" "$TEMP_EVIDENCE" "$BACKUP_ID" >/dev/null
install -m 0640 "$TEMP_EVIDENCE" "$EVIDENCE_OUTPUT"
echo "Candidate volumes hydrated from the isolated recovery point; old production volumes were not mounted."
