#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/compose.prod.yml"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
DB_BACKUP=${1:-}
DATA_ARCHIVE=${2:-}

if [ -z "$DB_BACKUP" ] || [ -z "$DATA_ARCHIVE" ]; then
  echo "Usage: $0 <panel-backup.db> <app-data.tar.gz>" >&2
  exit 1
fi

case "$DB_BACKUP" in
  "$ROOT_DIR"/backups/panel/*) ;;
  *) echo "Database backup must be under $ROOT_DIR/backups/panel" >&2; exit 1 ;;
esac
case "$DATA_ARCHIVE" in
  "$ROOT_DIR"/backups/*) ;;
  *) echo "Data archive must be under $ROOT_DIR/backups" >&2; exit 1 ;;
esac

[ -f "$DB_BACKUP" ] || { echo "Missing database backup: $DB_BACKUP" >&2; exit 1; }
[ -f "$DATA_ARCHIVE" ] || { echo "Missing data archive: $DATA_ARCHIVE" >&2; exit 1; }

DB_NAME=$(basename "$DB_BACKUP")
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e CHECK_DB="/backups/$DB_NAME" dsdst-panel \
  node -e 'const Database=require("better-sqlite3"); const db=new Database(process.env.CHECK_DB,{readonly:true,fileMustExist:true}); const result=db.pragma("integrity_check"); db.close(); if(result.length!==1||result[0].integrity_check!=="ok"){console.error(result);process.exit(1)} console.log("SQLite integrity: ok")'

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile tools run --rm \
  operations-toolbox sh -c "tar -tzf /backups/$(basename "$DATA_ARCHIVE") >/dev/null"
echo "Archive integrity: ok"
echo "Restore check completed without changing production data."

