#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/../.." && pwd)
JOURNAL=${1:-}
RECOVERY_POINT=${2:-}
ISOLATED_TARGET=${3:-}
MIGRATION_ADAPTER=${4:-}
EVIDENCE_OUTPUT=${5:-}
CANDIDATE_ENV=${6:-}

if [ -z "$JOURNAL" ] || [ -z "$RECOVERY_POINT" ] || [ -z "$ISOLATED_TARGET" ] || [ -z "$MIGRATION_ADAPTER" ] || [ -z "$EVIDENCE_OUTPUT" ] || [ -z "$CANDIDATE_ENV" ]; then
  echo "Usage: $0 <journal> <approved-release-recovery-point> <isolated-target> <migration-adapter> <evidence-output> <candidate-env>" >&2
  exit 2
fi
[ ! -e "$EVIDENCE_OUTPUT" ] || { echo "Evidence output already exists; refusing overwrite" >&2; exit 2; }

case "$MIGRATION_ADAPTER" in
  /*) ;;
  *) echo "Migration adapter must be an absolute executable path" >&2; exit 2 ;;
esac
[ -x "$MIGRATION_ADAPTER" ] || { echo "Migration adapter is not executable" >&2; exit 2; }

node "$ROOT_DIR/scripts/release/release-cli.mjs" assert-state "$JOURNAL" APPROVED >/dev/null
PROJECT=$(node "$ROOT_DIR/scripts/release/release-cli.mjs" candidate-project "$JOURNAL")
BACKUP_ID=$(node "$ROOT_DIR/scripts/release/release-cli.mjs" backup-id "$JOURNAL")
node "$ROOT_DIR/scripts/release/verify-candidate-env.mjs" "$CANDIDATE_ENV" "$PROJECT" >/dev/null
node "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" point-health "$RECOVERY_POINT" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >/dev/null
"$ROOT_DIR/scripts/restore-check.sh" "$RECOVERY_POINT" "$ISOLATED_TARGET" >/dev/null

umask 027
TEMP_EVIDENCE=$(mktemp "${TMPDIR:-/tmp}/dsdst-migration-preflight.XXXXXX")
TEMP_RESULT=$(mktemp "${TMPDIR:-/tmp}/dsdst-migration-preflight-result.XXXXXX")
cleanup() { rm -f "$TEMP_EVIDENCE" "$TEMP_RESULT"; }
trap cleanup EXIT INT TERM

"$MIGRATION_ADAPTER"   --mode preflight   --restored-root "$ISOLATED_TARGET"   --recovery-point "$RECOVERY_POINT"   --candidate-env "$CANDIDATE_ENV"   --candidate-project "$PROJECT"   --backup-id "$BACKUP_ID"   >"$TEMP_EVIDENCE"
node "$ROOT_DIR/scripts/release/release-cli.mjs" preflight-passed "$JOURNAL" "$TEMP_EVIDENCE" >"$TEMP_RESULT"
install -m 0640 "$TEMP_RESULT" "$EVIDENCE_OUTPUT"
echo "Migration preflight passed on isolated restored data; candidate DB was not touched."
