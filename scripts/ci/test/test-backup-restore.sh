#!/usr/bin/env bash
# Tests for scripts/ci/backup-db.sh and scripts/ci/restore-drill.sh (S0.5 "Tests first").
# Postgres binaries are replaced by stubs on PATH, so the tests run without a database.
# Encryption uses the real openssl, so the round trip is genuine.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CI="$HERE/.."
# shellcheck source=lib.sh
. "$HERE/lib.sh"

echo "backup-db.sh + restore-drill.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/s05-backup.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

STUBS="$WORK/bin"
mkdir -p "$STUBS" "$WORK/dumps"

# Stub pg_dump: prints a small plain-SQL dump. STUB_TABLE picks the table so two dumps differ.
cat > "$STUBS/pg_dump" <<'EOF'
#!/usr/bin/env bash
echo "CREATE TABLE \"${STUB_TABLE:-member}\" (\"id\" integer PRIMARY KEY);"
echo "INSERT INTO \"${STUB_TABLE:-member}\" VALUES (1);"
EOF

# Stub psql: logs its arguments and stdin, and answers any query with 1.
cat > "$STUBS/psql" <<'EOF'
#!/usr/bin/env bash
LOG="${STUB_LOG:?}"
echo "psql $*" >> "$LOG"
input="$(cat)"
if [ -n "$input" ]; then printf '%s\n' "$input" >> "$LOG.sql"; fi
echo 1
exit 0
EOF
chmod +x "$STUBS/pg_dump" "$STUBS/psql"

export PATH="$STUBS:$PATH"
export BACKUP_ENCRYPTION_KEY="test-key-not-a-secret"
export DATABASE_URL="postgres://u:p@localhost:5432/club_test"
export STUB_LOG="$WORK/psql.log"
export RESTORE_TARGET_URL="postgres://u:p@localhost:5432/club_restore"

# --- backup-db.sh -------------------------------------------------------------

expect_status "backup writes an encrypted dump" 0 -- \
  bash "$CI/backup-db.sh" "$WORK/dumps" "20261101T030000Z"
OLD="$WORK/dumps/bolt-club-hq-20261101T030000Z.sql.enc"
if [ -f "$OLD" ]; then ok "encrypted file is named by UTC timestamp"
else not_ok "encrypted file is named by UTC timestamp" "missing $OLD"; fi

if [ -f "$OLD" ] && ! grep -q 'CREATE TABLE' "$OLD"; then
  ok "dump is not stored in plain text"
else
  not_ok "dump is not stored in plain text" "file missing or plain SQL visible in $OLD"
fi

expect_status "backup refuses to run without an encryption key" 1 -- \
  env -u BACKUP_ENCRYPTION_KEY bash "$CI/backup-db.sh" "$WORK/dumps" "20261101T030000Z"

# A newer dump, from a different table, so the drill can prove which one it restored.
expect_status "second (newer) backup writes" 0 -- \
  env STUB_TABLE=event bash "$CI/backup-db.sh" "$WORK/dumps" "20261201T030000Z"

# --- restore-drill.sh ---------------------------------------------------------

rm -f "$STUB_LOG" "$STUB_LOG.sql"
expect_status "restore drill succeeds on the latest dump" 0 -- \
  bash "$CI/restore-drill.sh" "$WORK/dumps"
expect_contains "drill reports the latest dump by name" "20261201T030000Z"

# The latest dump's SQL, not the older one's, must reach psql.
if grep -q 'CREATE TABLE "event"' "$STUB_LOG.sql" 2>/dev/null; then
  ok "restore feeds the decrypted latest dump to psql"
else
  not_ok "restore feeds the decrypted latest dump to psql" "psql stdin: $(cat "$STUB_LOG.sql" 2>/dev/null)"
fi

# The smoke query runs after the restore, against the restore target.
if grep -q 'club_restore' "$STUB_LOG" && grep -q 'SELECT' "$STUB_LOG"; then
  ok "smoke query runs against the restore target"
else
  not_ok "smoke query runs against the restore target" "psql log: $(cat "$STUB_LOG" 2>/dev/null)"
fi

# An empty dump folder is an error, not a silent pass.
mkdir -p "$WORK/empty"
expect_status "drill fails when no dump exists" 1 -- \
  bash "$CI/restore-drill.sh" "$WORK/empty"

# A wrong key cannot decrypt, so the drill fails.
expect_status "drill fails with the wrong key" 1 -- \
  env BACKUP_ENCRYPTION_KEY=wrong bash "$CI/restore-drill.sh" "$WORK/dumps"

finish
