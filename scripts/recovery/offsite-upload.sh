#!/usr/bin/env sh
set -eu

: "${RECOVERY_ID:?RECOVERY_ID is required}"
: "${RECOVERY_ENCRYPTION_PASSPHRASE:?RECOVERY_ENCRYPTION_PASSPHRASE is required when offsite is enabled}"
: "${RECOVERY_MANIFEST_HMAC_KEY:?RECOVERY_MANIFEST_HMAC_KEY is required}"

REMOTE=${RECOVERY_OFFSITE_RCLONE_REMOTE:-${CLOUD_BACKUP_RCLONE_REMOTE:-}}
PREFIX=${RECOVERY_OFFSITE_PREFIX:-${CLOUD_BACKUP_PREFIX:-production}/recovery-points}
TIMEOUT=${CLOUD_BACKUP_TIMEOUT_SECONDS:-900}
POINT="/backups/recovery-points/${RECOVERY_ID}"
STAGING="/backups/offsite-staging"

if [ -z "$REMOTE" ]; then
  node --no-warnings /operations/scripts/recovery/recovery-cli.mjs offsite-failed "$POINT" "Offsite rclone remote is not configured" || true
  exit 1
fi

mkdir -p "$STAGING"
PAYLOAD="$STAGING/${RECOVERY_ID}.payload.tar.gz.enc"
MANIFEST="$STAGING/${RECOVERY_ID}.manifest.json.enc"
CANDIDATE="$STAGING/${RECOVERY_ID}.manifest.final.json"
REDACTED_CONFIG="$STAGING/${RECOVERY_ID}.rclone.redacted.conf"
REMOTE_ROOT="${REMOTE%/}/${PREFIX#/}/${RECOVERY_ID}"
PAYLOAD_REMOTE="$REMOTE_ROOT/payload.tar.gz.enc"
MANIFEST_REMOTE="$REMOTE_ROOT/manifest.json.enc"

fail_offsite() {
  message=$1
  node --no-warnings /operations/scripts/recovery/recovery-cli.mjs offsite-failed "$POINT" "$message" || true
  rm -f "$PAYLOAD" "$MANIFEST" "$CANDIDATE" "$REDACTED_CONFIG"
  exit 1
}

rclone config redacted > "$REDACTED_CONFIG" \
  || fail_offsite "Offsite rclone configuration fingerprint failed"
REMOTE_CONFIG_FINGERPRINT="sha256:$(sha256sum "$REDACTED_CONFIG" | awk '{print $1}')"
rm -f "$REDACTED_CONFIG"

(
  cd "$POINT"
  tar -czf - payload provenance
) | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:RECOVERY_ENCRYPTION_PASSPHRASE -out "$PAYLOAD" \
  || fail_offsite "Recovery payload encryption failed"

PAYLOAD_HASH=$(sha256sum "$PAYLOAD" | awk '{print $1}')
PAYLOAD_SIZE=$(wc -c < "$PAYLOAD" | tr -d ' ')
rclone copyto "$PAYLOAD" "$PAYLOAD_REMOTE" --retries 3 --low-level-retries 5 --timeout "${TIMEOUT}s" \
  || fail_offsite "Encrypted recovery payload upload failed"
REMOTE_HASH=$(rclone cat "$PAYLOAD_REMOTE" --timeout "${TIMEOUT}s" | sha256sum | awk '{print $1}') \
  || fail_offsite "Encrypted recovery payload persistence check failed"
[ "$REMOTE_HASH" = "$PAYLOAD_HASH" ] || fail_offsite "Encrypted recovery payload hash differs offsite"

PERSISTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node --no-warnings /operations/scripts/recovery/recovery-cli.mjs stage-offsite-final \
  "$POINT" "$CANDIDATE" "$REMOTE_ROOT" "$REMOTE_CONFIG_FINGERPRINT" \
  "$PAYLOAD_REMOTE" "$PAYLOAD_HASH" "$PAYLOAD_SIZE" \
  "$PERSISTED_AT" "$MANIFEST_REMOTE" >/dev/null \
  || fail_offsite "Final recovery manifest staging failed"

openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:RECOVERY_ENCRYPTION_PASSPHRASE \
  -in "$CANDIDATE" -out "$MANIFEST" \
  || fail_offsite "Recovery manifest encryption failed"
MANIFEST_HASH=$(sha256sum "$MANIFEST" | awk '{print $1}')
MANIFEST_SIZE=$(wc -c < "$MANIFEST" | tr -d ' ')
rclone copyto "$MANIFEST" "$MANIFEST_REMOTE" --retries 3 --low-level-retries 5 --timeout "${TIMEOUT}s" \
  || fail_offsite "Encrypted recovery manifest upload failed"
REMOTE_MANIFEST_HASH=$(rclone cat "$MANIFEST_REMOTE" --timeout "${TIMEOUT}s" | sha256sum | awk '{print $1}') \
  || fail_offsite "Encrypted recovery manifest persistence check failed"
[ "$REMOTE_MANIFEST_HASH" = "$MANIFEST_HASH" ] || fail_offsite "Encrypted recovery manifest hash differs offsite"

node --no-warnings /operations/scripts/recovery/recovery-cli.mjs promote-offsite-final "$POINT" "$CANDIDATE" >/dev/null \
  || fail_offsite "Final recovery verification failed before SUCCESS publication"

openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:RECOVERY_ENCRYPTION_PASSPHRASE \
  -in "$CANDIDATE" -out "$MANIFEST" \
  || fail_offsite "Final SUCCESS manifest encryption failed"
MANIFEST_HASH=$(sha256sum "$MANIFEST" | awk '{print $1}')
rclone copyto "$MANIFEST" "$MANIFEST_REMOTE" --retries 3 --low-level-retries 5 --timeout "${TIMEOUT}s" \
  || fail_offsite "Final SUCCESS manifest upload failed"
REMOTE_MANIFEST_HASH=$(rclone cat "$MANIFEST_REMOTE" --timeout "${TIMEOUT}s" | sha256sum | awk '{print $1}') \
  || fail_offsite "Final SUCCESS manifest persistence check failed"
[ "$REMOTE_MANIFEST_HASH" = "$MANIFEST_HASH" ] || fail_offsite "Final SUCCESS manifest hash differs offsite"

node --no-warnings /operations/scripts/recovery/recovery-cli.mjs finalize "$POINT" "$CANDIDATE" >/dev/null \
  || fail_offsite "Final local recovery verification failed"

rm -f "$PAYLOAD" "$MANIFEST" "$CANDIDATE" "$REDACTED_CONFIG"
