#!/usr/bin/env sh
set -eu

: "${RECOVERY_ID:?RECOVERY_ID is required}"
: "${RECOVERY_ENCRYPTION_PASSPHRASE:?RECOVERY_ENCRYPTION_PASSPHRASE is required when offsite is enabled}"

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
REMOTE_ROOT="${REMOTE%/}/${PREFIX#/}/${RECOVERY_ID}"
PAYLOAD_REMOTE="$REMOTE_ROOT/payload.tar.gz.enc"
MANIFEST_REMOTE="$REMOTE_ROOT/manifest.json.enc"

fail_offsite() {
  message=$1
  node --no-warnings /operations/scripts/recovery/recovery-cli.mjs offsite-failed "$POINT" "$message" || true
  rm -f "$PAYLOAD" "$MANIFEST"
  exit 1
}

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
node --no-warnings /operations/scripts/recovery/recovery-cli.mjs offsite-success \
  "$POINT" "$PAYLOAD_REMOTE" "$PAYLOAD_HASH" "$PAYLOAD_SIZE" "$PERSISTED_AT" >/dev/null

openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -pass env:RECOVERY_ENCRYPTION_PASSPHRASE \
  -in "$POINT/manifest.json" -out "$MANIFEST" \
  || fail_offsite "Recovery manifest encryption failed"
MANIFEST_HASH=$(sha256sum "$MANIFEST" | awk '{print $1}')
MANIFEST_SIZE=$(wc -c < "$MANIFEST" | tr -d ' ')
rclone copyto "$MANIFEST" "$MANIFEST_REMOTE" --retries 3 --low-level-retries 5 --timeout "${TIMEOUT}s" \
  || fail_offsite "Encrypted recovery manifest upload failed"
REMOTE_MANIFEST_HASH=$(rclone cat "$MANIFEST_REMOTE" --timeout "${TIMEOUT}s" | sha256sum | awk '{print $1}') \
  || fail_offsite "Encrypted recovery manifest persistence check failed"
[ "$REMOTE_MANIFEST_HASH" = "$MANIFEST_HASH" ] || fail_offsite "Encrypted recovery manifest hash differs offsite"

cat > "$POINT/offsite-receipt.json" <<EOF
{
  "state": "PERSISTED",
  "persisted_at": "$PERSISTED_AT",
  "payload": {"path": "$PAYLOAD_REMOTE", "sha256": "$PAYLOAD_HASH", "size_bytes": $PAYLOAD_SIZE},
  "manifest": {"path": "$MANIFEST_REMOTE", "sha256": "$MANIFEST_HASH", "size_bytes": $MANIFEST_SIZE},
  "encryption": {"format": "openssl-aes-256-cbc-pbkdf2", "iterations": 600000, "key_material": "EXTERNAL"}
}
EOF
chmod 640 "$POINT/offsite-receipt.json"
rm -f "$PAYLOAD" "$MANIFEST"
