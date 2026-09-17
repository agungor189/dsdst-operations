#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' && cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/compose.prod.yml"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$ROOT_DIR/backups/panel"

# better-sqlite3's online backup API creates a transactionally consistent copy.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
  -e BACKUP_TARGET="/backups/manual-${STAMP}.db" dsdst-panel \
  node -e 'const Database=require("better-sqlite3"); const db=new Database(process.env.DB_PATH,{readonly:true}); db.backup(process.env.BACKUP_TARGET).then(()=>{db.close(); console.log(process.env.BACKUP_TARGET)}).catch((error)=>{console.error(error);process.exit(1)})'

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile tools run --rm \
  operations-toolbox sh -c "tar -czf /backups/app-data-${STAMP}.tar.gz -C /sources panel-uploads kit-data kit-uploads labels"

echo "Backup completed: $STAMP"
