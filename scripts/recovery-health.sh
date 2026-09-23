#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_ROOT=${OPERATIONS_BACKUP_DIR:-$ROOT_DIR/backups}
exec node --no-warnings "$ROOT_DIR/scripts/recovery/recovery-cli.mjs" health "$BACKUP_ROOT"
