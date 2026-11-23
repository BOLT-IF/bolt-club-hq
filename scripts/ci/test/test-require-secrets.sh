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
  env -u CLOUDFLARE_API_TOKEN -u DATABASE_URL bash "$CI/require-secrets.sh" deploy
expect_contains "skip notice names a missing secret" "CLOUDFLARE_API_TOKEN"

# All secrets set: guard passes and says it will run.
expect_status "all secrets set: guard proceeds with exit 0" 0 -- \
  env CLOUDFLARE_API_TOKEN=x CLOUDFLARE_ACCOUNT_ID=a DATABASE_URL=y bash "$CI/require-secrets.sh" deploy
expect_contains "proceed notice" "proceeding"

# Partially set: still skip, and name only the missing secrets.
expect_status "partial secrets: skip" 0 -- \
  env -u DATABASE_URL CLOUDFLARE_API_TOKEN=x CLOUDFLARE_ACCOUNT_ID=a bash "$CI/require-secrets.sh" deploy
expect_contains "partial: names the missing DATABASE_URL" "DATABASE_URL"

# Unknown job names fail closed, so a typo can't silently skip a job.
expect_status "unknown job name fails" 2 -- \
  bash "$CI/require-secrets.sh" bogus-job

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
