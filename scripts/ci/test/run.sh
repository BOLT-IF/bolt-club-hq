#!/usr/bin/env bash
# Runs every scripts/ci test suite. Exits non-zero if any suite fails.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
status=0
for suite in "$HERE"/test-*.sh; do
  bash "$suite" || status=1
  echo
done
exit "$status"
