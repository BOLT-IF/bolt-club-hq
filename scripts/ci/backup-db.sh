#!/usr/bin/env bash
# Weekly encrypted pg_dump (PLAN §11.1, §16). Runs in .github/workflows/backup.yml.
#
# Usage: backup-db.sh <out-dir> [utc-timestamp]
#
# Requires: DATABASE_URL (the Neon connection string) and BACKUP_ENCRYPTION_KEY (a secret).
# Output:   <out-dir>/bolt-club-hq-<timestamp>.sql.enc, AES-256-CBC with a PBKDF2-derived key.
#
# The key is read from the environment only, never from an argument, so it does not show up
# in `ps` output or the shell history. The repo is private, but a dump still holds personal
# data, so the file is never written in plain text.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: backup-db.sh <out-dir> [utc-timestamp]" >&2
  exit 2
fi
OUT_DIR="$1"
STAMP="${2:-$(date -u +%Y%m%dT%H%M%SZ)}"

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "backup-db: BACKUP_ENCRYPTION_KEY is not set; refusing to write an unencrypted dump." >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "backup-db: DATABASE_URL is not set." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/bolt-club-hq-$STAMP.sql.enc"

# pg_dump writes plain SQL (--no-owner keeps the restore portable). The pipe never touches disk
# unencrypted. The key goes to openssl through the environment (-pass env:).
pg_dump --no-owner --no-privileges "$DATABASE_URL" \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -pass env:BACKUP_ENCRYPTION_KEY -out "$OUT"

echo "backup-db: wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)."
