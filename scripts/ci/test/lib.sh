#!/usr/bin/env bash
# Minimal assertion helpers for the scripts/ci tests. No external dependencies.

PASS=0
FAIL=0
LAST_OUT=""

ok() {
  PASS=$((PASS + 1))
  echo "  ok   - $1"
}

not_ok() {
  FAIL=$((FAIL + 1))
  echo "  FAIL - $1"
  if [ -n "${2:-}" ]; then echo "         $2"; fi
}

# expect_status NAME EXPECTED_EXIT -- COMMAND...
# Runs COMMAND, records its combined output in LAST_OUT, and compares the exit code.
expect_status() {
  local name="$1" want="$2"
  shift 2
  if [ "${1:-}" = "--" ]; then shift; fi
  local status=0
  LAST_OUT=$("$@" 2>&1) || status=$?
  if [ "$status" -eq "$want" ]; then
    ok "$name"
  else
    not_ok "$name" "expected exit $want, got $status. Output: $(printf '%s' "$LAST_OUT" | tail -n 5 | tr '\n' ' ')"
  fi
}

# expect_contains NAME NEEDLE: checks LAST_OUT (from the previous expect_status).
expect_contains() {
  case "$LAST_OUT" in
    *"$2"*) ok "$1" ;;
    *) not_ok "$1" "output does not contain: $2" ;;
  esac
}

# finish: prints totals; exit status is non-zero when any assertion failed.
finish() {
  echo "  passed=$PASS failed=$FAIL"
  [ "$FAIL" -eq 0 ]
}
