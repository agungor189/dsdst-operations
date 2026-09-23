#!/usr/bin/env sh
set -eu

: "${RECOVERY_MANIFEST_HMAC_KEY:?RECOVERY_MANIFEST_HMAC_KEY is required}"

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
ALLOW_LOCAL_ONLY=false
if [ "${1:-}" = "--allow-local-only" ]; then
  ALLOW_LOCAL_ONLY=true
  shift
fi
RECOVERY_POINT=${1:-}
BACKUP_ROOT=${OPERATIONS_BACKUP_DIR:-$ROOT_DIR/backups}
RESTORE_ROOT=${RECOVERY_RESTORE_ROOT:-$BACKUP_ROOT/restore-staging}

if [ -z "$RECOVERY_POINT" ]; then
  echo "Usage: $0 [--allow-local-only] <recovery-point-directory> [isolated-target-directory]" >&2
  exit 2
fi

case "$RECOVERY_POINT" in
  /*) ;;
  *) RECOVERY_POINT="$ROOT_DIR/$RECOVERY_POINT" ;;
esac

[ -d "$RECOVERY_POINT" ] || { echo "Recovery point does not exist: $RECOVERY_POINT" >&2; exit 1; }
[ -f "$RECOVERY_POINT/manifest.json" ] || { echo "Recovery manifest is missing: $RECOVERY_POINT" >&2; exit 1; }

RECOVERY_ID=$(basename "$RECOVERY_POINT")
TARGET=${2:-$RESTORE_ROOT/$RECOVERY_ID}
mkdir -p "$RESTORE_ROOT"
RESTORE_ROOT=$(CDPATH='' && cd -- "$RESTORE_ROOT" && pwd)
case "$TARGET" in
  /*) ;;
  *) TARGET="$RESTORE_ROOT/$TARGET" ;;
esac
case "$TARGET" in
  "$RESTORE_ROOT"/*) ;;
  *) echo "Restore target must be inside isolated root $RESTORE_ROOT" >&2; exit 1 ;;
esac

if [ "$ALLOW_LOCAL_ONLY" = "true" ]; then
  set -- --allow-local-only "$RECOVERY_POINT" "$TARGET"
else
  set -- "$RECOVERY_POINT" "$TARGET"
fi
for candidate in \
  "${PANEL_DATA_DIR:-}" "${PANEL_UPLOADS_DIR:-}" \
  "${KIT_STUDIO_DATA_DIR:-}" "${KIT_STUDIO_UPLOADS_DIR:-}" \
  "${LABEL_PRINTER_DATA_DIR:-}" "${CUSTOMER_HUB_DATA_DIR:-}"; do
  case "$candidate" in
    /*) set -- "$@" "$candidate" ;;
  esac
done

node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" restore "$@"
echo "Restore verification completed in isolated target: $TARGET"
