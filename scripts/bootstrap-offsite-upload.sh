#!/usr/bin/env sh
set -eu

: "${BOOTSTRAP_ID:?BOOTSTRAP_ID is required}"
: "${RECOVERY_ENCRYPTION_PASSPHRASE:?RECOVERY_ENCRYPTION_PASSPHRASE is required}"
: "${RECOVERY_MANIFEST_HMAC_KEY:?RECOVERY_MANIFEST_HMAC_KEY is required}"

REMOTE=${RECOVERY_OFFSITE_RCLONE_REMOTE:-${CLOUD_BACKUP_RCLONE_REMOTE:-}}
PREFIX=${RECOVERY_OFFSITE_PREFIX:-${CLOUD_BACKUP_PREFIX:-production}/recovery-points}
TIMEOUT=${CLOUD_BACKUP_TIMEOUT_SECONDS:-900}
POINT="/backups/bootstrap-points/${BOOTSTRAP_ID}"
STAGING="/backups/bootstrap-offsite-staging"

[ -n "$REMOTE" ] || { echo "Bootstrap offsite remote is not configured" >&2; exit 1; }
mkdir -p "$STAGING"
PAYLOAD="$STAGING/${BOOTSTRAP_ID}.payload.tar.gz.enc"
MANIFEST="$STAGING/${BOOTSTRAP_ID}.manifest.json.enc"
CANDIDATE="$STAGING/${BOOTSTRAP_ID}.manifest.final.json"
REDACTED_CONFIG="$STAGING/${BOOTSTRAP_ID}.rclone.redacted.conf"
REMOTE_ROOT="${REMOTE%/}/${PREFIX#/}/legacy-bootstrap/${BOOTSTRAP_ID}"
PAYLOAD_REMOTE="$REMOTE_ROOT/payload.tar.gz.enc"
MANIFEST_REMOTE="$REMOTE_ROOT/manifest.json.enc"

cleanup() { rm -f "$PAYLOAD" "$MANIFEST" "$CANDIDATE" "$REDACTED_CONFIG"; }
trap cleanup EXIT INT TERM

rclone config redacted > "$REDACTED_CONFIG"
CONFIG_FINGERPRINT="sha256:$(sha256sum "$REDACTED_CONFIG" | awk '{print $1}')"
rm -f "$REDACTED_CONFIG"

(
  cd "$POINT"
  tar -czf - payload provenance
) | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:RECOVERY_ENCRYPTION_PASSPHRASE -out "$PAYLOAD"

PAYLOAD_HASH=$(sha256sum "$PAYLOAD" | awk '{print $1}')
PAYLOAD_SIZE=$(wc -c < "$PAYLOAD" | tr -d ' ')
rclone copyto "$PAYLOAD" "$PAYLOAD_REMOTE" --retries 3 --low-level-retries 5 --timeout "${TIMEOUT}s"
REMOTE_HASH=$(rclone cat "$PAYLOAD_REMOTE" --timeout "${TIMEOUT}s" | sha256sum | awk '{print $1}')
[ "$REMOTE_HASH" = "$PAYLOAD_HASH" ] || { echo "Bootstrap encrypted payload hash differs offsite" >&2; exit 1; }

PERSISTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node --no-warnings /operations/scripts/bootstrap-cli.mjs stage-offsite-final \
  "$POINT" "$CANDIDATE" "$REMOTE_ROOT" "$CONFIG_FINGERPRINT" \
  "$PAYLOAD_REMOTE" "$PAYLOAD_HASH" "$PAYLOAD_SIZE" "$PERSISTED_AT" "$MANIFEST_REMOTE" >/dev/null

openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:RECOVERY_ENCRYPTION_PASSPHRASE -in "$CANDIDATE" -out "$MANIFEST"
MANIFEST_HASH=$(sha256sum "$MANIFEST" | awk '{print $1}')
rclone copyto "$MANIFEST" "$MANIFEST_REMOTE" --retries 3 --low-level-retries 5 --timeout "${TIMEOUT}s"
REMOTE_MANIFEST_HASH=$(rclone cat "$MANIFEST_REMOTE" --timeout "${TIMEOUT}s" | sha256sum | awk '{print $1}')
[ "$REMOTE_MANIFEST_HASH" = "$MANIFEST_HASH" ] || { echo "Bootstrap encrypted manifest hash differs offsite" >&2; exit 1; }

node --no-warnings /operations/scripts/bootstrap-cli.mjs promote-offsite-final "$POINT" "$CANDIDATE" >/dev/null
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:RECOVERY_ENCRYPTION_PASSPHRASE -in "$CANDIDATE" -out "$MANIFEST"
MANIFEST_HASH=$(sha256sum "$MANIFEST" | awk '{print $1}')
rclone copyto "$MANIFEST" "$MANIFEST_REMOTE" --retries 3 --low-level-retries 5 --timeout "${TIMEOUT}s"
REMOTE_MANIFEST_HASH=$(rclone cat "$MANIFEST_REMOTE" --timeout "${TIMEOUT}s" | sha256sum | awk '{print $1}')
[ "$REMOTE_MANIFEST_HASH" = "$MANIFEST_HASH" ] || { echo "Bootstrap final manifest hash differs offsite" >&2; exit 1; }

node --no-warnings /operations/scripts/bootstrap-cli.mjs finalize "$POINT" "$CANDIDATE" >/dev/null
printf 'Bootstrap offsite persistence SUCCESS: %s\n' "$BOOTSTRAP_ID"
