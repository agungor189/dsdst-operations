#!/usr/bin/env sh
set -eu

: "${RESTORED_ROOT:?RESTORED_ROOT is required}"

assert_empty() {
  dir=$1
  mkdir -p "$dir"
  if find "$dir" -mindepth 1 -print -quit | grep -q .; then
    echo "Candidate target is not empty: $dir" >&2
    exit 1
  fi
}

for dir in \
  /target/panel-data /target/panel-uploads \
  /target/kit-data /target/kit-uploads \
  /target/label-data /target/customer-hub-data; do
  assert_empty "$dir"
done

cp "$RESTORED_ROOT/panel/data/dsdst_panel.db" /target/panel-data/dsdst_panel.db
cp "$RESTORED_ROOT/kit/data/dsdst-kit-studio.db" /target/kit-data/dsdst-kit-studio.db
cp "$RESTORED_ROOT/customer-hub/data/customer-hub.db" /target/customer-hub-data/customer-hub.db

cp -R "$RESTORED_ROOT/panel/uploads/." /target/panel-uploads/
cp -R "$RESTORED_ROOT/kit/uploads/." /target/kit-uploads/
cp -R "$RESTORED_ROOT/label/data/." /target/label-data/
mkdir -p /target/customer-hub-data/attachments
cp -R "$RESTORED_ROOT/customer-hub/data/attachments/." /target/customer-hub-data/attachments/

node --no-warnings /operations/scripts/bootstrap-seed-service-keys.mjs \
  /target/panel-data/dsdst_panel.db

printf 'Candidate bootstrap hydration completed.\n'
