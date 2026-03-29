#!/usr/bin/env bash
# PEvO app database backup script.
# Dumps the pevo_app database, keeps the last 7 daily backups.
#
# Usage:
#   ./scripts/backup.sh
#
# Cron (daily at 03:00):
#   0 3 * * * /path/to/pevo/scripts/backup.sh >> /var/log/pevo-backup.log 2>&1
#
# Restore:
#   gunzip -c /var/backups/pevo/pevo_app_YYYYMMDD_HHMMSS.sql.gz | psql "$APP_DATABASE_URL"
#   Or via Docker Compose:
#   gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U pevo pevo_app
#
# Environment:
#   BACKUP_DIR       — where to store dumps (default: /var/backups/pevo)
#   BACKUP_KEEP_DAYS — number of daily backups to retain (default: 7)
#   APP_DATABASE_URL — PostgreSQL connection string (or set PGHOST/PGUSER/PGDATABASE)

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pevo}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_FILE="$BACKUP_DIR/pevo_app_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# If running inside Docker Compose, connect to the postgres service
if [ -n "${APP_DATABASE_URL:-}" ]; then
  DB_URL="$APP_DATABASE_URL"
else
  DB_URL="postgresql://${PGUSER:-pevo}:${PGPASSWORD:-}@${PGHOST:-localhost}:${PGPORT:-5432}/${PGDATABASE:-pevo_app}"
fi

echo "[$(date -Iseconds)] Starting backup..."
echo "  Target: $DUMP_FILE"

pg_dump "$DB_URL" --no-owner --no-privileges | gzip > "$DUMP_FILE"

FILE_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "  Size:   $FILE_SIZE"

# Prune old backups
DELETED=0
find "$BACKUP_DIR" -name "pevo_app_*.sql.gz" -type f -mtime +"$KEEP_DAYS" -print -delete | while read -r f; do
  echo "  Pruned: $(basename "$f")"
  DELETED=$((DELETED + 1))
done

REMAINING=$(find "$BACKUP_DIR" -name "pevo_app_*.sql.gz" -type f | wc -l)
echo "  Backups retained: $REMAINING"
echo "[$(date -Iseconds)] Backup complete."
