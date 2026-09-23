#!/usr/bin/env sh
set -eu

: "${BOOTSTRAP_ID:?BOOTSTRAP_ID is required}"
POINT="/backups/bootstrap-points/${BOOTSTRAP_ID}.partial"

archive_regular_files() {
  source_dir=$1
  destination=$2
  list_file=$(mktemp)
  (
    cd "$source_dir"
    find . -type f -print0 | LC_ALL=C sort -z > "$list_file"
    tar --null --no-recursion --files-from="$list_file" -czf "$destination"
  )
  rm -f "$list_file"
}

mkdir -p \
  "$POINT/payload/panel" \
  "$POINT/payload/kit" \
  "$POINT/payload/label" \
  "$POINT/payload/customer-hub" \
  "$POINT/provenance"

node --no-warnings /operations/scripts/recovery/sqlite-online-backup.mjs \
  /sources/panel-data/dsdst_panel.db "$POINT/payload/panel/database.sqlite"
node --no-warnings /operations/scripts/recovery/sqlite-online-backup.mjs \
  /sources/kit-data/dsdst-kit-studio.db "$POINT/payload/kit/database.sqlite"
node --no-warnings /operations/scripts/recovery/sqlite-online-backup.mjs \
  /sources/customer-hub-data/customer-hub.db "$POINT/payload/customer-hub/database.sqlite"

archive_regular_files /sources/panel-uploads "$POINT/payload/panel/uploads.tar.gz"
archive_regular_files /sources/kit-uploads "$POINT/payload/kit/uploads.tar.gz"
archive_regular_files /sources/labels "$POINT/payload/label/state.tar.gz"
archive_regular_files /sources/customer-hub-data/attachments "$POINT/payload/customer-hub/attachments.tar.gz"
