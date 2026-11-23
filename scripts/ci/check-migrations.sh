#!/usr/bin/env bash
# Single-migration-chain check (PLAN §11.4: ONE initial migration; DoD item 3).
#
# Usage: check-migrations.sh <migrations-dir>
#
# drizzle-kit writes meta/_journal.json. Each entry is a migration; entries are applied in
# order, so the chain must be a straight line. Two heads (two entries that both descend from
# the same parent) mean two branches of schema history, which must not merge silently.
#
# Here "parent" is simply the previous idx. drizzle-kit only produces a linear journal, so any
# journal that contains a duplicate idx, a gap, or a tag that has no matching .sql file is also
# rejected: those are the ways two branches leave a broken chain behind.
#
# Exit codes: 0 pass (including an empty folder), 1 broken chain, 2 usage or unreadable journal.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: check-migrations.sh <migrations-dir>" >&2
  exit 2
fi
DIR="$1"
JOURNAL="$DIR/meta/_journal.json"

# No journal yet is an empty chain. It is valid, because S0.2 writes the first migration.
if [ ! -f "$JOURNAL" ]; then
  if [ -z "$(find "$DIR" -maxdepth 1 -name '*.sql' 2>/dev/null)" ]; then
    echo "check-migrations: no migrations yet in $DIR (empty chain, ok)."
    exit 0
  fi
  echo "check-migrations: $DIR has .sql files but no meta/_journal.json." >&2
  exit 1
fi

if ! jq -e '.entries | type == "array"' "$JOURNAL" >/dev/null 2>&1; then
  echo "check-migrations: $JOURNAL is not valid drizzle journal JSON." >&2
  exit 2
fi

entries="$(jq -r '.entries[] | "\(.idx)\t\(.tag)"' "$JOURNAL")"
count="$(printf '%s\n' "$entries" | grep -c . || true)"

if [ "$count" -eq 0 ]; then
  echo "check-migrations: journal has no entries (empty chain, ok)."
  exit 0
fi

problems=0

# Every idx must be unique, and the sequence must run 0..n-1 with no gap.
dupes="$(printf '%s\n' "$entries" | cut -f1 | sort | uniq -d)"
if [ -n "$dupes" ]; then
  echo "check-migrations: two migrations share idx $(echo "$dupes" | tr '\n' ' ')" >&2
  printf '%s\n' "$entries" | awk -F'\t' -v d="$dupes" 'index(" " d " ", " " $1 " ") { print "  - idx " $1 ": " $2 }' >&2
  problems=1
fi

expected=0
while IFS=$'\t' read -r idx tag; do
  if [ "$idx" -ne "$expected" ]; then
    echo "check-migrations: gap in chain: expected idx $expected, found $idx ($tag)." >&2
    problems=1
    break
  fi
  expected=$((expected + 1))
done < <(printf '%s\n' "$entries" | sort -n -k1,1)

# Every tag must have its SQL file. A missing file is a broken chain.
while IFS=$'\t' read -r _ tag; do
  if [ ! -f "$DIR/$tag.sql" ]; then
    echo "check-migrations: journal lists $tag but $DIR/$tag.sql is missing." >&2
    problems=1
  fi
done <<< "$entries"

# Two heads: the journal has two entries whose timestamps descend from the same prior entry.
# A head is a migration with no successor. Duplicate sibling tags at the same position show up
# as two tags sharing a numeric prefix (0001_a and 0001_b), which the chain cannot order.
prefixes="$(printf '%s\n' "$entries" | cut -f2 | sed -E 's/^([0-9]+)_.*/\1/' | sort | uniq -d)"
if [ -n "$prefixes" ]; then
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    echo "check-migrations: two heads at migration number $p:" >&2
    printf '%s\n' "$entries" | cut -f2 | grep -E "^${p}_" | sed 's/^/  - /' >&2
  done <<< "$prefixes"
  problems=1
fi

if [ "$problems" -ne 0 ]; then
  echo "check-migrations: migration chain is broken. Migrations go through the integrator queue." >&2
  exit 1
fi

echo "check-migrations: single chain of $count migration(s)."
