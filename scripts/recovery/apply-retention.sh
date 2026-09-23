#!/usr/bin/env sh
set -eu

BACKUP_ROOT=${1:-/backups}
REMOTE=${RECOVERY_OFFSITE_RCLONE_REMOTE:-${CLOUD_BACKUP_RCLONE_REMOTE:-}}
PREFIX=${RECOVERY_OFFSITE_PREFIX:-${CLOUD_BACKUP_PREFIX:-production}/recovery-points}
PLAN=$(node --no-warnings /operations/scripts/recovery/recovery-cli.mjs retention-plan "$BACKUP_ROOT")

printf '%s' "$PLAN" | node -e '
let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
  const plan=JSON.parse(input);for(const id of plan.delete) process.stdout.write(`${id}\n`);
});
' | while IFS= read -r recovery_id; do
  [ -n "$recovery_id" ] || continue
  if [ -n "$REMOTE" ]; then
    rclone purge "${REMOTE%/}/${PREFIX#/}/${recovery_id}"
  fi
  node --no-warnings /operations/scripts/recovery/recovery-cli.mjs retention-delete "$BACKUP_ROOT" "$recovery_id" >/dev/null
done

printf '%s\n' "$PLAN"
