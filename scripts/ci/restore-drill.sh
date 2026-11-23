#!/usr/bin/env bash
# Monthly restore drill (PLAN §13 "Scheduled", §15 "Money disputes"). Runs in restore-drill.yml.
#
# Usage: restore-drill.sh <dump-dir>
#
# Restores the LATEST encrypted dump into a throwaway database and runs a smoke query.
# A backup that has never been restored is not a backup, so this job fails loudly.
#
# Requires:
#   BACKUP_ENCRYPTION_KEY   same key that backup-db.sh used
#   RESTORE_TARGET_URL      an EMPTY, throwaway database. Must differ from DATABASE_URL.
#   DATABASE_URL            (optional) the live database, used only to refuse a bad target.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: restore-drill.sh <dump-dir>" >&2
  exit 2
fi
DIR="$1"

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "restore-drill: BACKUP_ENCRYPTION_KEY is not set." >&2
  exit 1
fi
if [ -z "${RESTORE_TARGET_URL:-}" ]; then
  echo "restore-drill: RESTORE_TARGET_URL is not set (point it at a throwaway database)." >&2
  exit 1
fi
# Never restore over the live database. This is the one mistake that cannot be undone.
if [ -n "${DATABASE_URL:-}" ] && [ "$RESTORE_TARGET_URL" = "$DATABASE_URL" ]; then
  echo "restore-drill: RESTORE_TARGET_URL equals DATABASE_URL. Refusing to restore over live data." >&2
  exit 1
fi

# File names carry a UTC timestamp (YYYYMMDDTHHMMSSZ), so a lexical sort is chronological.
LATEST="$(find "$DIR" -maxdepth 1 -name 'bolt-club-hq-*.sql.enc' -print 2>/dev/null | sort | tail -n 1)"
if [ -z "$LATEST" ]; then
  echo "restore-drill: no encrypted dump found in $DIR." >&2
  exit 1
fi
echo "restore-drill: restoring latest dump $(basename "$LATEST")"

# Decrypt and restore in one pipeline with pipefail: a wrong key fails the whole drill,
# because openssl exits non-zero before psql can report success.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_ENCRYPTION_KEY -in "$LATEST" \
  | psql "$RESTORE_TARGET_URL" -v ON_ERROR_STOP=1 -q

# Smoke query: the restored database must answer, and report a table count.
COUNT="$(psql "$RESTORE_TARGET_URL" -v ON_ERROR_STOP=1 -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
case "$COUNT" in
  ''|*[!0-9]*)
    echo "restore-drill: smoke query returned no count (got '$COUNT')." >&2
    exit 1
    ;;
esac

echo "restore-drill: OK. Restored $(basename "$LATEST"); public tables=$COUNT."
