#!/usr/bin/env bash
# Tests for scripts/ci/check-owns.sh (S0.5 "Tests first").
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CI="$HERE/.."
FIX="$HERE/fixtures/owns"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

echo "check-owns.sh"

# A PR diff that stays inside the story's Owns list passes.
expect_status "S9.8 diff inside Owns passes" 0 -- \
  bash "$CI/check-owns.sh" "$FIX/stories.md" S9.8 "$FIX/diff-ok.txt"

# A fixture PR diff that breaks its Owns list fails the check, and names the offending file.
expect_status "S9.8 diff outside Owns fails" 1 -- \
  bash "$CI/check-owns.sh" "$FIX/stories.md" S9.8 "$FIX/diff-breaks-owns.txt"
expect_contains "failure names the offending path" "src/worker/core/leak.ts"

# Same rule against the real S0.5 entry in docs/STORIES.md.
STORIES="$CI/../../docs/STORIES.md"
expect_status "S0.5 real owns: workflows, scripts/ci, docs/ops and DECISIONS pass" 0 -- \
  bash "$CI/check-owns.sh" "$STORIES" S0.5 "$FIX/diff-s05-ok.txt"
expect_status "S0.5 real owns: db/schema change fails" 1 -- \
  bash "$CI/check-owns.sh" "$STORIES" S0.5 "$FIX/diff-s05-breaks-owns.txt"

# Area docs and per-story e2e specs are on the shared allow-list for every story.
expect_status "docs/areas and tests/e2e are shared" 0 -- \
  bash "$CI/check-owns.sh" "$FIX/stories.md" S9.8 "$FIX/diff-shared-ok.txt"

# A trailing "*" in an Owns entry is a prefix match (STORIES uses `close*`, `claims*`, ...).
expect_status "glob Owns: files under the prefix pass" 0 -- \
  bash "$CI/check-owns.sh" "$FIX/stories.md" S9.7 "$FIX/diff-glob-ok.txt"
expect_status "glob Owns: a sibling outside the prefix fails" 1 -- \
  bash "$CI/check-owns.sh" "$FIX/stories.md" S9.7 "$FIX/diff-glob-breaks.txt"
expect_contains "glob failure names the offending path" "src/worker/rsvp/claim.ts"

# A story whose Owns is "the whole repo" (S0.1) is unrestricted.
expect_status "whole-repo Owns is unrestricted" 0 -- \
  bash "$CI/check-owns.sh" "$FIX/stories.md" S9.9 "$FIX/diff-breaks-owns.txt"

# An unknown story id is an error, not a silent pass.
expect_status "unknown story id fails closed" 2 -- \
  bash "$CI/check-owns.sh" "$FIX/stories.md" S99.9 "$FIX/diff-ok.txt"

finish
