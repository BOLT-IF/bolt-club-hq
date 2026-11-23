#!/usr/bin/env bash
# Tests for scripts/ci/check-migrations.sh (S0.5 "Tests first").
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CI="$HERE/.."
FIX="$HERE/fixtures/migrations"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

echo "check-migrations.sh"

expect_status "linear migration chain passes" 0 -- \
  bash "$CI/check-migrations.sh" "$FIX/ok"

# Two migrations that both descend from 0000 create two heads, which fails.
expect_status "two migration heads fail" 1 -- \
  bash "$CI/check-migrations.sh" "$FIX/two-heads"
expect_contains "failure reports both heads" "0001_branch_a"

# The real repo has no migrations yet. The check must still pass (an empty chain is valid).
REPO_MIG="$CI/../../db/migrations"
expect_status "empty real migrations folder passes" 0 -- \
  bash "$CI/check-migrations.sh" "$REPO_MIG"

finish
