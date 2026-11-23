#!/usr/bin/env bash
# Post-deploy smoke test (S0.5 Deploy: "wrangler deploy, then migrations, then a smoke test").
#
# Usage: smoke.sh <base-url>
#
# Checks that /healthz reports status "ok" and that the SPA root serves an HTML shell from the
# same origin (PLAN §11.1: one Worker serves API and assets). Fails the deploy otherwise.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: smoke.sh <base-url>" >&2
  exit 2
fi
BASE="${1%/}"

health="$(curl -fsS --max-time 20 "$BASE/healthz" || true)"
if ! printf '%s' "$health" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  echo "smoke: $BASE/healthz did not report status ok. Body: ${health:-<no response>}" >&2
  exit 1
fi
echo "smoke: /healthz ok."

shell="$(curl -fsS --max-time 20 "$BASE/" || true)"
if ! printf '%s' "$shell" | grep -q 'id="root"'; then
  echo "smoke: $BASE/ did not serve the SPA shell." >&2
  exit 1
fi
echo "smoke: SPA shell served from $BASE."
