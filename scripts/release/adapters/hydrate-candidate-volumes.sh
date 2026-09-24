#!/usr/bin/env sh
set -eu

: "${RESTORED_ROOT:?RESTORED_ROOT is required}"
: "${TARGET_UID:?TARGET_UID is required}"
: "${TARGET_GID:?TARGET_GID is required}"

assert_empty() {
  dir=$1
  mkdir -p "$dir"

  if find "$dir" -mindepth 1 -print -quit | grep -q .; then
    echo "Candidate target is not empty: $dir" >&2
    exit 1
  fi
}

for dir in \
  /target/panel-data \
  /target/panel-uploads \
  /target/kit-data \
  /target/kit-uploads \
  /target/label-data \
  /target/customer-hub-data
do
  assert_empty "$dir"
done

cp "$RESTORED_ROOT/panel/data/dsdst_panel.db" \
  /target/panel-data/dsdst_panel.db

cp "$RESTORED_ROOT/kit/data/dsdst-kit-studio.db" \
  /target/kit-data/dsdst-kit-studio.db

cp "$RESTORED_ROOT/customer-hub/data/customer-hub.db" \
  /target/customer-hub-data/customer-hub.db

cp -R "$RESTORED_ROOT/panel/uploads/." \
  /target/panel-uploads/

cp -R "$RESTORED_ROOT/kit/uploads/." \
  /target/kit-uploads/

cp -R "$RESTORED_ROOT/label/data/." \
  /target/label-data/

mkdir -p /target/customer-hub-data/attachments

cp -R "$RESTORED_ROOT/customer-hub/data/attachments/." \
  /target/customer-hub-data/attachments/

# Recovery artifacts are intentionally read-only. Candidate runtime state must
# become writable only inside the isolated candidate volumes.
for dir in \
  /target/panel-data \
  /target/panel-uploads \
  /target/panel-backups \
  /target/kit-data \
  /target/kit-uploads \
  /target/label-data \
  /target/customer-hub-data \
  /target/customer-hub-backups
do
  find "$dir" -type d -exec chmod 0750 {} +
  find "$dir" -type f -exec chmod 0640 {} +
done

chown -R "${TARGET_UID}:${TARGET_GID}" \
  /target/panel-data \
  /target/panel-uploads \
  /target/panel-backups \
  /target/kit-data \
  /target/kit-uploads \
  /target/label-data \
  /target/customer-hub-data \
  /target/customer-hub-backups

echo "Candidate release hydration completed."
