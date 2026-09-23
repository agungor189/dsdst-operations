#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT_DIR/.env}
RECOVERY_ID=${1:-}
TARGET=${2:-}
BACKUP_ROOT=${OPERATIONS_BACKUP_DIR:-$ROOT_DIR/backups}

if [ -z "$RECOVERY_ID" ] || [ -z "$TARGET" ]; then
  echo "Usage: $0 <recovery-point-id> <isolated-target-directory>" >&2
  exit 2
fi
case "$RECOVERY_ID" in
  rp-[a-zA-Z0-9._-]*) ;;
  *) echo "Invalid recovery-point ID" >&2; exit 1 ;;
esac

export OPERATIONS_BACKUP_DIR="$BACKUP_ROOT"
docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/compose.prod.yml" --profile tools run --rm \
  -e RECOVERY_ID="$RECOVERY_ID" operations-toolbox sh -eu -c '
    : "${RECOVERY_ENCRYPTION_PASSPHRASE:?RECOVERY_ENCRYPTION_PASSPHRASE is required}"
    remote=${RECOVERY_OFFSITE_RCLONE_REMOTE:-${CLOUD_BACKUP_RCLONE_REMOTE:-}}
    prefix=${RECOVERY_OFFSITE_PREFIX:-${CLOUD_BACKUP_PREFIX:-production}/recovery-points}
    [ -n "$remote" ] || { echo "Offsite rclone remote is not configured" >&2; exit 1; }
    point="/backups/recovery-points/${RECOVERY_ID}"
    work="${point}.fetching"
    [ ! -e "$point" ] || { echo "Local recovery point already exists" >&2; exit 1; }
    rm -rf "$work"
    mkdir -p "$work"
    root="${remote%/}/${prefix#/}/${RECOVERY_ID}"
    rclone copyto "$root/manifest.json.enc" "$work/manifest.json.enc"
    rclone copyto "$root/payload.tar.gz.enc" "$work/payload.tar.gz.enc"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
      -pass env:RECOVERY_ENCRYPTION_PASSPHRASE -in "$work/manifest.json.enc" -out "$work/manifest.json"
    expected=$(node -e "const m=require(process.argv[1]);process.stdout.write(m.offsite.payload.sha256)" "$work/manifest.json")
    observed=$(sha256sum "$work/payload.tar.gz.enc" | awk "{print \$1}")
    [ "$expected" = "$observed" ] || { echo "Encrypted offsite payload hash mismatch" >&2; exit 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
      -pass env:RECOVERY_ENCRYPTION_PASSPHRASE -in "$work/payload.tar.gz.enc" \
      | tar -xzf - -C "$work"
    rm -f "$work/manifest.json.enc" "$work/payload.tar.gz.enc"
    mv "$work" "$point"
  '

"$ROOT_DIR/scripts/restore-check.sh" "$BACKUP_ROOT/recovery-points/$RECOVERY_ID" "$TARGET"
