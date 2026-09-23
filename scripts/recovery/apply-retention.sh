#!/usr/bin/env sh
set -eu

: "${RECOVERY_MANIFEST_HMAC_KEY:?RECOVERY_MANIFEST_HMAC_KEY is required}"

BACKUP_ROOT=${1:-/backups}
PLAN=$(node --no-warnings /operations/scripts/recovery/recovery-cli.mjs retention-plan "$BACKUP_ROOT")
REDACTED_CONFIG=$(mktemp)
trap 'rm -f "$REDACTED_CONFIG"' EXIT HUP INT TERM
rclone config redacted > "$REDACTED_CONFIG"
CURRENT_CONFIG_FINGERPRINT="sha256:$(sha256sum "$REDACTED_CONFIG" | awk '{print $1}')"

printf '%s' "$PLAN" | node -e '
let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
  const plan=JSON.parse(input);for(const id of plan.delete) process.stdout.write(`${id}\n`);
});
' | while IFS= read -r recovery_id; do
  [ -n "$recovery_id" ] || continue
  point="$BACKUP_ROOT/recovery-points/$recovery_id"
  offsite_location=$(node --no-warnings /operations/scripts/recovery/recovery-cli.mjs retention-offsite-location "$point")
  recorded_config_fingerprint=$(node --no-warnings /operations/scripts/recovery/recovery-cli.mjs retention-offsite-config-fingerprint "$point")
  [ -n "$offsite_location" ] || { echo "Recorded offsite location is missing for $recovery_id" >&2; exit 1; }
  [ "$CURRENT_CONFIG_FINGERPRINT" = "$recorded_config_fingerprint" ] \
    || { echo "Current rclone configuration does not match the recorded offsite location for $recovery_id" >&2; exit 1; }
  rclone purge "$offsite_location"
  remaining=$(rclone lsf "$offsite_location")
  [ -z "$remaining" ] || { echo "Recorded offsite location still contains objects for $recovery_id" >&2; exit 1; }
  node --no-warnings /operations/scripts/recovery/recovery-cli.mjs retention-delete \
    "$BACKUP_ROOT" "$recovery_id" "$offsite_location" "$CURRENT_CONFIG_FINGERPRINT" >/dev/null
done

printf '%s\n' "$PLAN"
