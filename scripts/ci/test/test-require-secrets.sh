#!/usr/bin/env bash
# Tests for scripts/ci/require-secrets.sh and scripts/ci/smoke.sh (S0.5 "Tests first").
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CI="$HERE/.."
# shellcheck source=lib.sh
. "$HERE/lib.sh"

echo "require-secrets.sh + smoke.sh"

# Guard: with no secrets, the job must SKIP (exit 0) and say so, never fail CI.
expect_status "no secrets set: guard skips with exit 0" 0 -- \
  env -u DATABASE_URL bash "$CI/require-secrets.sh" deploy
expect_contains "skip notice names a missing secret" "DATABASE_URL"

# All secrets set: guard passes and says it will run.
expect_status "all secrets set: guard proceeds with exit 0" 0 -- \
  env DATABASE_URL=y bash "$CI/require-secrets.sh" deploy
expect_contains "proceed notice" "proceeding"

# Partially set (multi-secret job): still skip, and name only the missing secrets.
expect_status "partial secrets: skip" 0 -- \
  env -u BACKUP_BUCKET_TOKEN DATABASE_URL=y BACKUP_ENCRYPTION_KEY=k bash "$CI/require-secrets.sh" backup
expect_contains "partial: names the missing BACKUP_BUCKET_TOKEN" "BACKUP_BUCKET_TOKEN"

# Unknown job names fail closed, so a typo can't silently skip a job.
expect_status "unknown job name fails" 2 -- \
  bash "$CI/require-secrets.sh" bogus-job

# The guard's verdict goes to GITHUB_OUTPUT as ready=true|false. Workflows gate on that,
# not on the exit code: a skip exits 0 (green) but must still say ready=false.
# Regression: workflows used `if require-secrets.sh; then ready=true`, so a skip (exit 0)
# set ready=true and deploy ran without secrets on every push to main.
OUT="$(mktemp "${TMPDIR:-/tmp}/s05-ghout.XXXXXX")"
: > "$OUT"
expect_status "skip writes ready=false" 0 -- \
  env -u DATABASE_URL GITHUB_OUTPUT="$OUT" bash "$CI/require-secrets.sh" deploy
if grep -qx "ready=false" "$OUT" && ! grep -q "ready=true" "$OUT"; then
  ok "skip: GITHUB_OUTPUT has ready=false only"
else
  not_ok "skip: GITHUB_OUTPUT has ready=false only" "got: $(tr '\n' ' ' < "$OUT")"
fi

: > "$OUT"
expect_status "proceed writes ready=true" 0 -- \
  env DATABASE_URL=y GITHUB_OUTPUT="$OUT" \
  bash "$CI/require-secrets.sh" deploy
if grep -qx "ready=true" "$OUT"; then
  ok "proceed: GITHUB_OUTPUT has ready=true"
else
  not_ok "proceed: GITHUB_OUTPUT has ready=true" "got: $(tr '\n' ' ' < "$OUT")"
fi
rm -f "$OUT"

# No workflow may gate on the exit code again: each must call the guard bare and read
# steps.guard.outputs.ready.
for wf in deploy backup restore-drill lighthouse; do
  file="$HERE/../../../.github/workflows/$wf.yml"
  if grep -q "if bash scripts/ci/require-secrets.sh" "$file"; then
    not_ok "$wf.yml does not gate on the guard's exit code"
  else
    ok "$wf.yml does not gate on the guard's exit code"
  fi
done

# Smoke test: a healthy origin passes, an unhealthy one fails.
# Serve a tiny local HTTP server is heavy; instead, drive smoke.sh through a file:// fixture
# by pointing it at a stub curl on PATH.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/s05-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
# Stub: answers /healthz with STUB_HEALTH_BODY and the SPA root with an HTML shell.
url="${@: -1}"
case "$url" in
  *healthz*) printf '%s' "${STUB_HEALTH_BODY:-}"; [ -n "${STUB_HEALTH_BODY:-}" ] && exit 0 || exit 22 ;;
  *) printf '%s' '<!doctype html><div id="root"></div>'; exit 0 ;;
esac
EOF
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

expect_status "smoke passes on healthy /healthz and SPA" 0 -- \
  env STUB_HEALTH_BODY='{"status":"ok"}' bash "$CI/smoke.sh" https://bolt-club-hq.example.workers.dev
expect_status "smoke fails when /healthz is not ok" 1 -- \
  env STUB_HEALTH_BODY='{"status":"down"}' bash "$CI/smoke.sh" https://bolt-club-hq.example.workers.dev
expect_status "smoke fails when /healthz is unreachable" 1 -- \
  env STUB_HEALTH_BODY='' bash "$CI/smoke.sh" https://bolt-club-hq.example.workers.dev

finish
