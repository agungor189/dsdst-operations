#!/usr/bin/env sh
set -eu

: "${RECOVERY_MANIFEST_HMAC_KEY:?RECOVERY_MANIFEST_HMAC_KEY is required}"

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
    : "${RECOVERY_MANIFEST_HMAC_KEY:?RECOVERY_MANIFEST_HMAC_KEY is required}"
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
    node --no-warnings /operations/scripts/recovery/recovery-cli.mjs verify-manifest-file \
      "$work/manifest.json" "$RECOVERY_ID" "$root" >/dev/null
    rclone config redacted > "$work/rclone.redacted.conf"
    current_config_fingerprint="sha256:$(sha256sum "$work/rclone.redacted.conf" | awk "{print \$1}")"
    recorded_config_fingerprint=$(node -e "const m=require(process.argv[1]);process.stdout.write(m.offsite.config_fingerprint)" "$work/manifest.json")
    [ "$current_config_fingerprint" = "$recorded_config_fingerprint" ] \
      || { echo "Current rclone configuration does not match the recovery manifest" >&2; exit 1; }
    rm -f "$work/rclone.redacted.conf"
    expected=$(node -e "const m=require(process.argv[1]);process.stdout.write(m.offsite.payload.sha256)" "$work/manifest.json")
    expected_payload_path=$(node -e "const m=require(process.argv[1]);process.stdout.write(m.offsite.payload.path)" "$work/manifest.json")
    expected_manifest_path=$(node -e "const m=require(process.argv[1]);process.stdout.write(m.offsite.integrity_evidence.path)" "$work/manifest.json")
    [ "$expected_payload_path" = "$root/payload.tar.gz.enc" ] || { echo "Fetched manifest payload location mismatch" >&2; exit 1; }
    [ "$expected_manifest_path" = "$root/manifest.json.enc" ] || { echo "Fetched manifest integrity location mismatch" >&2; exit 1; }
    observed=$(sha256sum "$work/payload.tar.gz.enc" | awk "{print \$1}")
    [ "$expected" = "$observed" ] || { echo "Encrypted offsite payload hash mismatch" >&2; exit 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
      -pass env:RECOVERY_ENCRYPTION_PASSPHRASE -in "$work/payload.tar.gz.enc" \
      | tar -xzf - -C "$work"
    rm -f "$work/manifest.json.enc" "$work/payload.tar.gz.enc"
    mv "$work" "$point"
  '

"$ROOT_DIR/scripts/restore-check.sh" "$BACKUP_ROOT/recovery-points/$RECOVERY_ID" "$TARGET"
